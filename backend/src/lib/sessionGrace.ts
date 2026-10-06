import { closeActiveSession, getActiveSessionId, resumePostureAfterAway } from './sessionService';
import { getLastKnownState } from './telemetryStore';
import { getDeviceOwnerUserId } from './devices';

/**
 * Away grace period — the "pending away" buffer between the device reporting
 * vacancy and the session actually closing.
 *
 * Without it, the moment the sensor reports `vacant` (device-confirmed after
 * its 10 s window) the active session closes — so standing up for a moment
 * (grabbing a charger, walking across the room) splits one sitting into two.
 * With it, a sitting→vacant transition arms a per-device timer; a sitting
 * snapshot or SESSION_STARTED event inside the window cancels the timer and
 * the SAME session continues, otherwise the session closes exactly as before,
 * anchored to the ORIGINAL away moment (not to the expiry), so the recorded
 * duration never includes the grace period.
 *
 * Duplicate/restart safety:
 *   - Duplicate state messages can't re-arm the timer: edge detection only
 *     fires on real transitions, QoS 1 events are deduped by eventId, and a
 *     second schedule while one is pending never extends the 60 s deadline
 *     (it can only refine the anchor to an EARLIER moment — the QoS 1
 *     SESSION_ENDED timestamp is the confirmation moment, up to the
 *     firmware's 10 s window after the telemetry snapshot's stateForMs
 *     anchor, and the telemetry anchor is the truer stand-up time).
 *   - Server restarts lose the in-memory timer by design: the telemetry
 *     store's remembered state is cleared too, so the device's next snapshot
 *     re-fires the vacant edge and re-arms the grace anchored to the
 *     device's stateForMs (how long vacancy has continuously measured —
 *     the true stand-up moment). The /status stale-check remains the
 *     backstop for a device that goes silent mid-grace.
 *   - Expiry only closes the session the grace was armed for (identity
 *     guard), so a manual dashboard stop/start or a stale-check close during
 *     the window is never overridden.
 */

/** How long a vacant device keeps its session open before it is closed. */
export const AWAY_GRACE_PERIOD = 60_000;

interface PendingAway {
  timer: NodeJS.Timeout;
  /** epoch ms of the away moment — closeActiveSession's endedAt anchor */
  awayAtMs: number;
  /** id of the session that was active when the grace armed (expiry guard) */
  sessionId: string;
}

/** deviceId → armed pending-away close. In-memory only (never persisted). */
const pendingAways = new Map<string, PendingAway>();

export type ScheduleAwayCloseResult =
  | { status: 'scheduled'; awayAtMs: number }
  | { status: 'no_active_session' }
  | { status: 'db_error'; error: string };

/**
 * Arm the pending-away close for a device that just went vacant. The first
 * schedule for a pending transition wins the 60 s deadline; a later schedule
 * (the confirming SESSION_ENDED event, a post-gap re-fire of the same
 * vacancy) only refines the endedAt anchor when it detected the vacancy
 * EARLIER. No-op when no session is active (matches the old immediate close's
 * "no active session" behavior).
 */
export async function scheduleAwayClose(
  deviceId: string,
  awayAtMs: number
): Promise<ScheduleAwayCloseResult> {
  const existing = pendingAways.get(deviceId);
  if (existing) {
    if (awayAtMs < existing.awayAtMs) existing.awayAtMs = awayAtMs;
    return { status: 'scheduled', awayAtMs: existing.awayAtMs };
  }

  // Nothing to keep alive — behave like the old immediate close's no-op
  const sessionId = await getActiveSessionId();
  if (sessionId === null) {
    return { status: 'no_active_session' };
  }

  const entry: PendingAway = {
    timer: setTimeout(() => {
      // Deleted BEFORE the async close so a return snapshot processed while
      // the close is in flight sees no pending grace (single-threaded loop:
      // either this fired or cancelPendingAway removed the entry, never both).
      pendingAways.delete(deviceId);
      void expirePendingAway(deviceId, entry.awayAtMs, entry.sessionId);
    }, AWAY_GRACE_PERIOD),
    awayAtMs,
    sessionId,
  };
  // A pending close must never delay process shutdown
  entry.timer.unref();
  pendingAways.set(deviceId, entry);

  return { status: 'scheduled', awayAtMs: entry.awayAtMs };
}

/**
 * Cancel a device's pending-away close because it reported sitting again.
 * Returns the away moment (epoch ms) when one was armed — the caller uses it
 * to continue the SAME session with the away window kept unclassified — or
 * null when no grace was pending (normal sit-down path).
 */
export function cancelPendingAway(deviceId: string): number | null {
  const entry = pendingAways.get(deviceId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingAways.delete(deviceId);
  return entry.awayAtMs;
}

/**
 * The grace expired with no sitting detection: close the session at the
 * original away moment. Never throws (MQTT handlers fire-and-forget).
 */
async function expirePendingAway(
  deviceId: string,
  awayAtMs: number,
  sessionId: string
): Promise<void> {
  const log = `[SESSION-GRACE] ${deviceId}`;

  try {
    // Identity guard: only close the session the grace was armed for — a
    // manual stop/start or stale-check close during the window stands.
    const activeId = await getActiveSessionId();
    if (activeId !== sessionId) {
      console.log(
        `${log}: grace expired — active session changed (armed for ${sessionId}, now ${activeId ?? 'none'}), not closing`
      );
      return;
    }

    const result = await closeActiveSession(new Date(awayAtMs));
    switch (result.status) {
      case 'stopped':
        console.log(
          `${log}: grace expired — session ${result.session.id} closed at the original away moment, duration ${result.durationSeconds}s`
        );
        break;
      case 'no_active_session':
        console.log(`${log}: grace expired — no active session (closed elsewhere), nothing to do`);
        return;
      case 'db_error':
        console.error(`${log}: failed to close session after grace expiry:`, result.error);
        return;
    }

    // Boundary-race recovery: a sitting snapshot processed while the close
    // above was in flight found no pending grace to cancel and its posture
    // write landed on the session being closed. Without this the person is
    // left sitting with no session and no future state edge to open one.
    const lastState = getLastKnownState(deviceId);
    if (lastState === 'relaxing' || lastState === 'attentive') {
      const ownerUserId = await getDeviceOwnerUserId(deviceId);
      const resumed = await resumePostureAfterAway(
        lastState,
        new Date(),
        awayAtMs,
        { deviceId, userId: ownerUserId }
      );
      if (resumed.status === 'updated') {
        console.log(
          `${log}: sitting detected during the close — session ${resumed.session.id} re-opened (${lastState})`
        );
      }
    }
  } catch (err: unknown) {
    console.error(`${log}: unexpected error on grace expiry:`, err);
  }
}
