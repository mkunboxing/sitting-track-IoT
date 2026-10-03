import { closeActiveSession, setPosture, touchActiveSessionHeartbeat } from './sessionService';
import {
  getLastKnownState,
  recordTelemetry,
  setLastKnownState,
  shouldTouchHeartbeat,
} from './telemetryStore';
import type { DeviceSeatingState } from './telemetryStore';

/**
 * Shared device-telemetry pipeline — the single ingestion path for seating
 * state snapshots, whatever transport delivered them (HTTP POST /heartbeat,
 * MQTT via the EMQX Cloud subscriber). Every transport gets identical
 * semantics: validate → cache reading → edge-detect → sessionService →
 * throttled heartbeat touch. This module contains no session logic of its
 * own; session open/close/posture lives only in sessionService.ts.
 *
 * Identical snapshots are idempotent here (edge detection compares against
 * the device's last known state), which is what makes running the HTTP and
 * MQTT transports in parallel during the migration safe: whichever copy of a
 * snapshot arrives second is a no-op.
 */

export interface DeviceTelemetrySnapshot {
  distance?: number;
  state?: DeviceSeatingState;
  /** ms the reported state has been continuously measured (device clock) */
  stateForMs?: number;
}

export type ParsedTelemetry =
  | { ok: true; snapshot: DeviceTelemetrySnapshot }
  | { ok: false; error: string };

/**
 * Validate + normalize a telemetry payload. The exact rules (and error
 * strings) the HTTP heartbeat route has always enforced; `timestamp` is
 * accepted but ignored — the server clock stays the source of truth.
 */
export function parseTelemetryPayload(body: unknown): ParsedTelemetry {
  const payload = (body ?? {}) as Record<string, unknown>;
  const snapshot: DeviceTelemetrySnapshot = {};

  const state = payload.state;
  if (state !== undefined) {
    if (state !== 'relaxing' && state !== 'attentive' && state !== 'vacant') {
      return { ok: false, error: 'state must be "relaxing", "attentive" or "vacant" when present' };
    }
    snapshot.state = state;
  }

  if (payload.distance !== undefined) {
    const distance = Number(payload.distance);
    if (!Number.isFinite(distance)) {
      return { ok: false, error: 'distance must be a number when present' };
    }
    snapshot.distance = distance;
  }

  if (payload.stateForMs !== undefined) {
    const stateForMs = Number(payload.stateForMs);
    if (!Number.isFinite(stateForMs) || stateForMs < 0) {
      return { ok: false, error: 'stateForMs must be a non-negative number when present' };
    }
    snapshot.stateForMs = stateForMs;
  }

  if (payload.timestamp !== undefined && !Number.isFinite(Number(payload.timestamp))) {
    return { ok: false, error: 'timestamp must be a number when present' };
  }

  return { ok: true, snapshot };
}

/**
 * How far a device-derived session timestamp may be backdated from server
 * "now". The normal flow only needs the confirmation windows (~5–12.5s);
 * the cap keeps a bogus/lost value from anchoring a session absurdly far in
 * the past (e.g. millis() corruption) — longer outages keep today's behavior
 * (session starts when contact resumes).
 */
const MAX_FIRST_DETECTION_BACKDATE_MS = 300_000;

/**
 * Convert the device's `stateForMs` (how long the reported state has been
 * continuously measured — i.e. when its confirmation window BEGAN) into an
 * absolute first-detection moment anchored to the server clock. Returns
 * undefined when absent (old firmware / heartbeat-only payload) so those
 * flows keep the previous server-"now" timing.
 *
 * `notBeforeMs` (used after a resumed contact gap) stops a device returning
 * still-sitting from backdating a new session into time already covered by
 * the session the stale-check just closed.
 */
function firstDetectedAt(stateForMs: number | undefined, notBeforeMs: number | null): Date | undefined {
  if (stateForMs === undefined) return undefined;
  const nowMs = Date.now();
  const candidate = nowMs - Math.min(stateForMs, MAX_FIRST_DETECTION_BACKDATE_MS);
  const clamped = notBeforeMs !== null ? Math.max(candidate, notBeforeMs) : candidate;
  return new Date(Math.min(clamped, nowMs));
}

export type ProcessTelemetryResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Process one telemetry snapshot through the full pipeline. `source` only
 * shapes the log prefix ("http" | "mqtt"). Returns `{ ok: false, error }`
 * instead of throwing so transports can map failures to their own error
 * reporting (HTTP status codes vs MQTT logs).
 */
export async function processDeviceTelemetry(
  deviceId: string,
  snapshot: DeviceTelemetrySnapshot,
  source: 'http' | 'mqtt'
): Promise<ProcessTelemetryResult> {
  const log = `[TELEMETRY ${source}]`;

  try {
    // 1. Cache the reading for /status (in-memory only, never stored in the DB)
    const { resumedAfterGap, previousContactAt } = recordTelemetry(deviceId, snapshot.distance);

    // 2. Edge-detect the state snapshot → session lifecycle via the shared service
    const state = snapshot.state;
    if (state !== undefined && getLastKnownState(deviceId) !== state) {
      setLastKnownState(deviceId, state);

      if (state === 'vacant') {
        // Anchor the close to when vacancy was FIRST detected (true stand-up
        // moment), not when the confirmation completed / snapshot arrived
        const result = await closeActiveSession(firstDetectedAt(snapshot.stateForMs, null));
        switch (result.status) {
          case 'stopped':
            console.log(`${log} ${deviceId}: vacant — session closed, duration ${result.durationSeconds}s`);
            break;
          case 'no_active_session':
            // Duplicate vacant / session already closed by the stale-check — safe no-op
            console.log(`${log} ${deviceId}: vacant — no active session, nothing to close`);
            break;
          case 'db_error':
            console.error(`${log} ${deviceId}: failed to close session:`, result.error);
            return { ok: false, error: result.error };
        }
      } else {
        // Anchor the open to when sitting was FIRST detected (true sit-down
        // moment), not when the confirmation completed / snapshot arrived.
        // After a resumed contact gap the backdate is clamped to the device's
        // previous contact so it never overlaps an already-closed session.
        const startedAt = firstDetectedAt(snapshot.stateForMs, resumedAfterGap ? previousContactAt : null);
        const result = await setPosture(state, startedAt);
        switch (result.status) {
          case 'updated':
            console.log(`${log} ${deviceId}: ${state} — session ${result.session.id} posture set to ${state}`);
            break;
          case 'unchanged':
            // Session already in this posture — safe no-op
            console.log(`${log} ${deviceId}: ${state} — no posture change needed`);
            break;
          case 'db_error':
            console.error(`${log} ${deviceId}: failed to set posture:`, result.error);
            return { ok: false, error: result.error };
        }
      }
    }

    // 3. Fresh contact → touch last_heartbeat_at (throttled; no-op when no session is active)
    if (shouldTouchHeartbeat(deviceId)) {
      await touchActiveSessionHeartbeat();
    }

    return { ok: true };
  } catch (err: unknown) {
    console.error(`${log} Internal error:`, err);
    return { ok: false, error: 'Internal error: ' + String(err) };
  }
}
