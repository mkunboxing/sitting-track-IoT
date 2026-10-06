import { getActiveSessionStartedAtMs, openSession, resumePostureAfterAway } from './sessionService';
import { getDeviceOwnerUserId } from './devices';
import { AWAY_GRACE_PERIOD, cancelPendingAway, scheduleAwayClose } from './sessionGrace';
import type { PostureState } from '../types/sitting';

/**
 * Device session events — the reliable session-history path.
 *
 * The QoS 0 telemetry snapshots stay fire-and-forget (a dropped one is
 * reconciled by the next snapshot), which means a session transition that
 * happens while THIS BACKEND is offline (Render deploy, crash, restart) is
 * lost by the telemetry pipeline. The device therefore also publishes
 * CONFIRMED session transitions as discrete QoS 1 events to
 * `sitting/device/<deviceId>/events`:
 *
 *   { "eventId": "<deviceId>-<uptimeMillis>-<epochSecs>",
 *     "type": "SESSION_STARTED" | "SESSION_ENDED",
 *     "deviceId": "sitting-tracker-01",
 *     "state": "relaxing|attentive|vacant",
 *     "timestamp": <epoch secs of the device's confirmed transition> }
 *
 * The backend subscribes with a persistent (non-clean) session, so EMQX
 * queues these while the backend is offline and replays them — in publish
 * order — on reconnect. Supabase stays the permanent history; EMQX is only
 * temporary buffering (bounded by the broker's offline queue limit).
 *
 * Processing is idempotent at three layers, so duplicate QoS 1 deliveries
 * (at-least-once) can never create duplicate sessions:
 *   1. eventId dedupe below (in-memory, covers broker redelivery/replays);
 *   2. openSession only opens when no session is active (unique partial index
 *      + 23505 race handler) — a duplicate/replayed START is a no-op;
 *   3. a stale queued SESSION_ENDED that predates the currently active
 *      session is dropped instead of closing the newer session.
 * The device's own event timestamp (not backend receipt time) is used for
 * started_at/ended_at so replayed events land at their true moments.
 *
 * SESSION_ENDED never closes directly: like the telemetry pipeline's vacant
 * edge, it arms the away grace period (lib/sessionGrace.ts) so a brief
 * absence doesn't split the session — a SESSION_STARTED (this path or a
 * telemetry snapshot) inside the window cancels the pending close and
 * continues the same session.
 */

export type SessionEventType = 'SESSION_STARTED' | 'SESSION_ENDED';

export interface DeviceSessionEvent {
  eventId: string;
  type: SessionEventType;
  state: 'relaxing' | 'attentive' | 'vacant' | null;
  /** epoch seconds of the device's confirmed transition (device clock) */
  timestampSecs: number;
}

export type ParsedSessionEvent =
  | { ok: true; event: DeviceSessionEvent }
  | { ok: false; error: string };

/** Validate + normalize one session-event payload. `deviceId` comes from the topic. */
export function parseSessionEventPayload(body: unknown): ParsedSessionEvent {
  const payload = (body ?? {}) as Record<string, unknown>;

  const eventId = payload.eventId;
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return { ok: false, error: 'eventId must be a non-empty string' };
  }

  const type = payload.type;
  if (type !== 'SESSION_STARTED' && type !== 'SESSION_ENDED') {
    return { ok: false, error: 'type must be "SESSION_STARTED" or "SESSION_ENDED"' };
  }

  const timestamp = Number(payload.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, error: 'timestamp must be a positive epoch-seconds number' };
  }

  let state: DeviceSessionEvent['state'] = null;
  if (payload.state !== undefined && payload.state !== null) {
    if (payload.state !== 'relaxing' && payload.state !== 'attentive' && payload.state !== 'vacant') {
      return { ok: false, error: 'state must be "relaxing", "attentive" or "vacant" when present' };
    }
    state = payload.state;
  }

  // A start event must carry the posture to open the session in
  if (type === 'SESSION_STARTED' && state !== 'relaxing' && state !== 'attentive') {
    return { ok: false, error: 'SESSION_STARTED requires state "relaxing" or "attentive"' };
  }

  return {
    ok: true,
    event: { eventId: eventId.trim(), type, state, timestampSecs: timestamp },
  };
}

/**
 * Seen eventIds → first-seen epoch ms. In-memory only (deliberately — no new
 * storage layer): it closes the QoS 1 redelivery window (lost PUBACK, replay
 * after reconnect) and duplicate simulator sends. Session correctness across
 * process restarts does not depend on it: openSession/closeActiveSession
 * themselves are idempotent against the database.
 */
const processedEventIds = new Map<string, number>();
const DEDUPE_TTL_MS = 60 * 60 * 1000; // keep ids for 1 h
const DEDUPE_MAX_ENTRIES = 1000;

/** Returns false when this eventId was already claimed (duplicate delivery). */
function claimEvent(eventId: string): boolean {
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.set(eventId, Date.now());

  if (processedEventIds.size > DEDUPE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [id, seenAt] of processedEventIds) {
      if (now - seenAt > DEDUPE_TTL_MS) processedEventIds.delete(id);
    }
    while (processedEventIds.size > DEDUPE_MAX_ENTRIES) {
      const oldest = processedEventIds.keys().next().value;
      if (oldest === undefined) break;
      processedEventIds.delete(oldest);
    }
  }
  return true;
}

/**
 * Device clocks can drift a little from the server even with NTP; a queued
 * SESSION_ENDED is only "stale" when the active session clearly started
 * AFTER the event's end moment.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * Handle one message from the events topic. Parses, validates, dedupes by
 * eventId, then drives the SHARED session service (openSession /
 * closeActiveSession) so event-driven sessions behave exactly like
 * telemetry-driven and dashboard-simulated ones — including the SSE
 * broadcasts inside sessionService. Never throws; logs instead, so the MQTT
 * subscriber can call it fire-and-forget.
 */
export async function handleSessionEventMessage(
  topic: string,
  payload: Buffer,
  deviceId: string
): Promise<void> {
  const log = `[SESSION-EVENTS] ${topic}`;

  let json: unknown;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch {
    console.error(`${log}: invalid JSON payload dropped (${payload.toString('utf8').slice(0, 80)})`);
    return;
  }

  const parsed = parseSessionEventPayload(json);
  if (!parsed.ok) {
    console.error(`${log}: invalid event dropped — ${parsed.error}`);
    return;
  }
  const event = parsed.event;

  // Topic is authoritative for identity (same convention as telemetry);
  // the payload's deviceId is advisory — warn on a mismatch.
  const bodyDeviceId = (json as { deviceId?: unknown }).deviceId;
  if (typeof bodyDeviceId === 'string' && bodyDeviceId.trim() !== deviceId) {
    console.warn(`${log}: payload deviceId "${bodyDeviceId}" != topic deviceId "${deviceId}" — using topic`);
  }

  // Claim BEFORE processing: a redelivered event must never double-apply
  // even while the first delivery is still in flight.
  if (!claimEvent(event.eventId)) {
    console.log(`${log}: duplicate event ${event.eventId} (${event.type}) ignored`);
    return;
  }

  // The device's own event timestamp is the truth for session timing —
  // never the backend's receipt time (the event may have sat in EMQX's
  // queue for the whole outage). Only a device clock running AHEAD is
  // clamped (replayed events from the past are the entire point).
  const eventTime = new Date(
    Math.min(event.timestampSecs * 1000, Date.now() + CLOCK_SKEW_TOLERANCE_MS)
  );

  try {
    if (event.type === 'SESSION_STARTED') {
      // A confirmed sit-down inside the away grace window: cancel the pending
      // close and continue the SAME session. The reliable QoS 1 signal covers
      // a dropped QoS 0 sitting snapshot, so this runs even when the
      // telemetry pipeline never saw the return.
      const awayAtMs = cancelPendingAway(deviceId);
      // Stamp the device's linked account onto the replayed/confirmed open —
      // same ownership rule as the telemetry pipeline (null while unlinked)
      const ownerUserId = await getDeviceOwnerUserId(deviceId);

      if (awayAtMs !== null) {
        const result = await resumePostureAfterAway(
          event.state as PostureState,
          eventTime,
          awayAtMs,
          { deviceId, userId: ownerUserId }
        );
        switch (result.status) {
          case 'updated':
            console.log(
              `${log}: ${deviceId} ${event.eventId} — return within away grace, session ${result.session.id} continues (${event.state})`
            );
            break;
          case 'unchanged':
            console.log(`${log}: ${deviceId} ${event.eventId} — return within away grace, session unchanged`);
            break;
          case 'db_error':
            console.error(`${log}: ${deviceId} failed to resume session after away:`, result.error);
            break;
        }
        return;
      }

      const result = await openSession(
        event.state as PostureState,
        eventTime,
        { deviceId, userId: ownerUserId }
      );
      switch (result.status) {
        case 'started':
          console.log(
            `${log}: ${deviceId} ${event.eventId} — session ${result.session.id} opened (${event.state}) at device time ${eventTime.toISOString()}`
          );
          break;
        case 'already_active':
          // Duplicate START / the telemetry pipeline already opened it — safe no-op
          console.log(`${log}: ${deviceId} ${event.eventId} — session already active (${result.reason}), no-op`);
          break;
        case 'db_error':
          console.error(`${log}: ${deviceId} failed to open session:`, result.error);
          break;
      }
      return;
    }

    // SESSION_ENDED — stale guard: a long outage can queue an END event that
    // predates a session opened later (device went vacant, then sat again
    // before the backend came back). Closing "whatever is active" would then
    // kill the NEW session, so the event is dropped before it can arm the
    // away grace for a session that did not exist when it happened.
    const startedAtMs = await getActiveSessionStartedAtMs();
    if (startedAtMs !== null && startedAtMs > eventTime.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
      console.log(`${log}: ${deviceId} ${event.eventId} — stale SESSION_ENDED predates the active session, ignored`);
      return;
    }

    const result = await scheduleAwayClose(deviceId, eventTime.getTime());
    switch (result.status) {
      case 'scheduled':
        // Away grace armed — the device confirmed the vacancy, but a brief
        // absence must not split the session. The close fires at the original
        // away moment only if no sitting detection cancels it in time.
        console.log(
          `${log}: ${deviceId} ${event.eventId} — pending-away close armed (${AWAY_GRACE_PERIOD / 1000}s grace, anchored ${new Date(result.awayAtMs).toISOString()})`
        );
        break;
      case 'no_active_session':
        // Duplicate END / telemetry already closed it — safe no-op
        console.log(`${log}: ${deviceId} ${event.eventId} — no active session, nothing to close`);
        break;
      case 'db_error':
        console.error(`${log}: ${deviceId} failed to arm the away-grace close:`, result.error);
        break;
    }
  } catch (err: unknown) {
    console.error(`${log}: unexpected error processing ${event.eventId}:`, err);
  }
}
