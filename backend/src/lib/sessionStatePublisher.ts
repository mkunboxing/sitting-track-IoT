import { eventBroadcaster } from './eventBroadcaster';
import {
  buildSessionStateSnapshot,
  getAppTimezone,
  type SessionStateSnapshot,
} from './sessionState';
import { getMqttStatus, publishSessionStateMessage, registerOnConnected } from './mqttClient';
import { getTimezoneDayBoundaries } from './timeUtils';

/**
 * MQTT session-state publisher — pushes the current sitting state to
 * sitting/device/<deviceId>/session (retained, QoS 1) for the mobile MQTT
 * app. The payload is built from the SAME Supabase data the dashboard API
 * serves (lib/sessionState.ts) — active session, previous session and
 * date-aware today totals, each with human-readable "HH:MM:SS" duration
 * twins and friendly IST timestamps alongside the original numeric/ISO
 * fields — so MQTT state and dashboard always agree; this module never
 * writes to the database and never opens/closes sessions.
 *
 * Retained + QoS 1: the broker stores the last snapshot per topic, so a
 * mobile app receives the latest state the moment it subscribes — even while
 * this backend is asleep (Render free tier), and duplicates are harmless
 * because the payload is pure state (a re-publish can never create a
 * session; session creation stays behind sessionService's unique-index
 * guards and the session-events eventId dedupe).
 *
 * Republish triggers (each rebuilds the snapshot fresh from Supabase, with
 * "today" computed for the CURRENT date):
 *   1. Session start / end (from every pipeline: telemetry edge-detection,
 *      device session events, dashboard simulate controls, and the /status
 *      stale auto-close) — observed via the SSE broadcaster's listener hook.
 *   2. Posture changes (POSTURE_CHANGE broadcasts).
 *   3. Every successful MQTT (re)connect — covers backend restarts, Render
 *      wake-ups from sleep, and broker reconnects; because the snapshot is
 *      rebuilt for the current date, a backend that slept through midnight
 *      republishes correct new-day totals on wake.
 *   4. Local-midnight rollover (timer in APP_TIMEZONE) — publishes the new
 *      date's totals without touching the still-active session.
 *   5. While a session is ACTIVE, a 60 s refresh keeps the retained
 *      activeDurationSeconds + today's totals ticking (the mobile app can
 *      also compute live duration from started_at itself).
 */

let initialized = false;

/** Publish one fresh snapshot; logs and no-ops when MQTT is off or Supabase fails. */
export async function publishSessionStateUpdate(reason: string): Promise<void> {
  if (!getMqttStatus().enabled) return;

  try {
    const snapshot = await buildSessionStateSnapshot();
    if (!snapshot) return;
    publishSessionStateMessage(snapshot as unknown as Record<string, unknown>);
    setActiveSessionRefresh(snapshot);
  } catch (err) {
    console.error('[SESSION-STATE] Failed to publish session state:', err);
  }
}

// ── Trigger 5: refresh while a session is active ────────────────────────────
const ACTIVE_REFRESH_INTERVAL_MS = 60_000;
let activeRefreshTimer: NodeJS.Timeout | null = null;

function setActiveSessionRefresh(snapshot: SessionStateSnapshot): void {
  const shouldRun = snapshot.activeSession !== null;
  if (shouldRun && activeRefreshTimer === null) {
    activeRefreshTimer = setInterval(() => {
      publishSessionStateUpdate('active_refresh');
    }, ACTIVE_REFRESH_INTERVAL_MS);
  } else if (!shouldRun && activeRefreshTimer !== null) {
    clearInterval(activeRefreshTimer);
    activeRefreshTimer = null;
  }
}

// ── Trigger 4: midnight rollover ─────────────────────────────────────────────
let midnightTimer: NodeJS.Timeout | null = null;

function scheduleMidnightRepublish(): void {
  if (midnightTimer) clearTimeout(midnightTimer);

  const now = new Date();
  // todayEndUtc is 23:59:59.999 local; +1 ms crosses into the new day and
  // +1 s of buffer keeps the snapshot safely inside it.
  const { todayEndUtc } = getTimezoneDayBoundaries(now, getAppTimezone(), null);
  const delay = Math.max(todayEndUtc.getTime() + 1_001 - now.getTime(), 60_000);

  midnightTimer = setTimeout(() => {
    publishSessionStateUpdate('midnight_rollover').finally(() => scheduleMidnightRepublish());
  }, delay);
}

/**
 * Wire all triggers. Idempotent — called once from index.ts after
 * startMqttClient(). Safe even when MQTT is disabled: every publish path
 * checks getMqttStatus().enabled first.
 */
export function initSessionStatePublisher(): void {
  if (initialized) return;
  initialized = true;

  // 3. Backend (re)connected to EMQX → refresh the retained snapshot.
  registerOnConnected(() => {
    publishSessionStateUpdate('mqtt_connect');
  });

  // 1 + 2. Session open/close and posture changes from every pipeline ride
  // on the SSE broadcaster's broadcasts (sessionService and the /status
  // stale auto-close already emit exactly these).
  eventBroadcaster.addListener((info) => {
    const relevant =
      (info.type === 'STATUS_CHANGE' && (info.action === 'start' || info.action === 'stop')) ||
      info.type === 'POSTURE_CHANGE';
    if (relevant) {
      publishSessionStateUpdate(info.type === 'STATUS_CHANGE' ? `session_${info.action}` : 'posture_change');
    }
  });

  scheduleMidnightRepublish();

  // If MQTT connected before init ran (connect fired while this module was
  // still loading), publish once now; otherwise the connect callback covers it.
  const status = getMqttStatus();
  if (status.enabled && status.connected) {
    publishSessionStateUpdate('init');
  }
}
