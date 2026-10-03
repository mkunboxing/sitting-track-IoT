import type { PostureState } from '../types/sitting';

/** Seating state as reported by the device (vacant = no active session). */
export type DeviceSeatingState = PostureState | 'vacant';

/**
 * Device telemetry store — in-memory state derived from the ESP8266's MQTT
 * telemetry snapshots (published to sitting/device/<id>/telemetry via EMQX
 * Cloud, ingested by lib/mqttClient.ts). Nothing here is ever written to the
 * database.
 *
 * Three responsibilities:
 * 1. Latest distance reading per device — surfaced by GET /status so the
 *    dashboard shows the last known distance immediately.
 * 2. Last known seating state per device — the MQTT subscriber edge-detects
 *    the device's state snapshots against this, so sessionService is only
 *    called on actual transitions (keeps manual dashboard controls
 *    authoritative and avoids a Supabase query on every 2.5s snapshot).
 * 3. Last-contact tracking — the telemetry snapshot IS the device's
 *    heartbeat: "online" means a snapshot arrived recently, and the
 *    subscriber lets the fresh contact touch last_heartbeat_at at a
 *    throttled cadence (the /status stale-check keeps closing sessions when
 *    snapshots stop arriving, and the MQTT LWT marks devices offline
 *    immediately).
 */

/** A device whose last snapshot is older than this is no longer "online". */
export const DEVICE_ONLINE_WINDOW_MS = 30_000;

interface TelemetryEntry {
  distanceCm: number | null;
  updatedAt: string;
  /** epoch ms of the most recent telemetry POST from this device */
  lastContactAt: number;
}

/** deviceId → latest sensor reading. In-memory only (never stored in the DB). */
const readings = new Map<string, TelemetryEntry>();

/** deviceId → last seating state reported by the device (for edge detection). */
const lastKnownStates = new Map<string, DeviceSeatingState>();

/** deviceId → epoch ms of the last throttled last_heartbeat_at DB write. */
const lastHeartbeatWrites = new Map<string, number>();

/**
 * Record a telemetry snapshot from a device. `distanceCm` may be omitted
 * (heartbeat-only POST) — the previous reading is kept.
 *
 * Returns:
 * - `resumedAfterGap: true` when this snapshot ends a contact gap longer than
 *   DEVICE_ONLINE_WINDOW_MS (device was silent ≥ 30s — power loss, Wi-Fi down,
 *   backend outage). In that case the device's remembered state is cleared so
 *   the route treats its next snapshot as a fresh transition — the HTTP
 *   equivalent of the old WebSocket reconnect state-sync. Without this, a
 *   device that returned still-sitting after the stale-check closed its
 *   session would never re-open one.
 * - `previousContactAt`: epoch ms of the device's previous snapshot (null on
 *   first contact). On a resumed gap this is where the device was last heard —
 *   the route uses it as the lower bound when backdating a session start, so
 *   a device returning still-sitting never backdates a new session into time
 *   already covered (and possibly still recorded) by the previous one.
 */
export function recordTelemetry(
  deviceId: string,
  distanceCm?: number
): { resumedAfterGap: boolean; previousContactAt: number | null } {
  const now = new Date();
  const previous = readings.get(deviceId);
  const lastContactAt = now.getTime();

  const resumedAfterGap =
    previous !== undefined && lastContactAt - previous.lastContactAt > DEVICE_ONLINE_WINDOW_MS;
  if (resumedAfterGap) {
    lastKnownStates.delete(deviceId);
  }

  readings.set(deviceId, {
    distanceCm: typeof distanceCm === 'number' ? distanceCm : (previous?.distanceCm ?? null),
    updatedAt: now.toISOString(),
    lastContactAt,
  });

  return { resumedAfterGap, previousContactAt: previous?.lastContactAt ?? null };
}

/**
 * Most recent sensor reading across devices (single-device system today).
 * Used by /status so a freshly loaded dashboard shows the last known distance
 * immediately. With `maxAgeMs`, readings older than that return null so a
 * device that stopped posting (power loss, Wi-Fi down) is shown as "waiting
 * for sensor…" instead of a frozen distance.
 */
export function getLatestSensorReading(
  maxAgeMs?: number
): { distanceCm: number; updatedAt: string } | null {
  let latest: TelemetryEntry | null = null;
  for (const reading of readings.values()) {
    if (!latest || reading.updatedAt > latest.updatedAt) latest = reading;
  }
  if (!latest) return null;
  if (maxAgeMs !== undefined && Date.now() - latest.lastContactAt > maxAgeMs) return null;
  if (latest.distanceCm === null) return null;
  return { distanceCm: latest.distanceCm, updatedAt: latest.updatedAt };
}

/** Last seating state seen from a device, or null if none received yet. */
export function getLastKnownState(deviceId: string): DeviceSeatingState | null {
  return lastKnownStates.get(deviceId) ?? null;
}

export function setLastKnownState(deviceId: string, state: DeviceSeatingState): void {
  lastKnownStates.set(deviceId, state);
}

/**
 * Heartbeat-write throttle: returns true at most once per `minIntervalMs` per
 * device. Keeps the last_heartbeat_at DB write rate identical to the old
 * WebSocket gateway's 10s ping loop even though snapshots arrive every 2.5s
 * (the /status stale-check threshold is 30s, so a 10s cadence never looks
 * stale between writes).
 */
export function shouldTouchHeartbeat(deviceId: string, minIntervalMs = 10_000): boolean {
  const now = Date.now();
  const last = lastHeartbeatWrites.get(deviceId);
  if (last !== undefined && now - last < minIntervalMs) return false;
  lastHeartbeatWrites.set(deviceId, now);
  return true;
}

/**
 * Mark a device offline in the in-memory store — used by the MQTT subscriber
 * when the broker delivers the device's LWT "offline" status (the device's
 * TCP connection dropped without a clean disconnect). Same effect as the
 * HTTP 30 s contact gap: the cached reading is dropped (the dashboard shows
 * "waiting for sensor…") and the remembered state is cleared so the device's
 * next snapshot is treated as a fresh transition. The active session, if
 * any, is left for the existing /status stale-check to close at
 * last-contact time — unchanged session behavior.
 */
export function markDeviceOffline(deviceId: string): void {
  if (!readings.has(deviceId) && !lastKnownStates.has(deviceId)) return;
  console.log(`[TELEMETRY] ${deviceId}: marked offline (MQTT LWT / broker status)`);
  readings.delete(deviceId);
  lastKnownStates.delete(deviceId);
}

/** Devices that posted a telemetry snapshot within the online window. */
export function getOnlineDeviceIds(): string[] {
  const cutoff = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  return Array.from(readings.entries())
    .filter(([, reading]) => reading.lastContactAt >= cutoff)
    .map(([deviceId]) => deviceId);
}
