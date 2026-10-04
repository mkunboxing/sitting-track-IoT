import { getSupabaseServerClient, isSupabaseConfigured } from './supabase';
import { eventBroadcaster } from './eventBroadcaster';
import type { PostureState, SittingSession } from '../types/sitting';

/**
 * Session lifecycle service — the single source of truth for opening and
 * closing sitting sessions. Shared by the MQTT telemetry subscriber
 * (lib/mqttClient.ts → lib/telemetryProcessor.ts) and the dashboard controls
 * on /simulate so every caller behaves identically.
 *
 * Atomicity: the database's partial unique index
 * (idx_sitting_sessions_one_active, WHERE ended_at IS NULL) guarantees at
 * most one active session; the 23505 race handler below resolves the loser.
 *
 * Posture: while a session is active it is always in exactly one posture
 * stretch ('relaxing' or 'attentive'). The running stretch lives in
 * posture_state + posture_changed_at; whenever the posture changes (or the
 * session closes) the completed stretch is flushed into the relax_seconds /
 * attentive_seconds columns so no time is lost.
 */

export type OpenSessionResult =
  | { status: 'started'; session: SittingSession }
  | { status: 'already_active'; session: SittingSession | null; reason: 'pre_existing' | 'race' }
  | { status: 'db_error'; error: string };

export type CloseSessionResult =
  | { status: 'stopped'; session: SittingSession; durationSeconds: number }
  | { status: 'no_active_session' }
  | { status: 'db_error'; error: string };

export type SetPostureResult =
  | { status: 'updated'; session: SittingSession }
  | { status: 'unchanged'; session: SittingSession | null }
  | { status: 'db_error'; error: string };

export const canUseDatabase = (): boolean => isSupabaseConfigured();

/** Minimal shape of a sitting_sessions row needed for posture math */
export interface PostureSessionRow {
  started_at: string;
  posture_state: string | null;
  posture_changed_at: string | null;
  relax_seconds: number | null;
  attentive_seconds: number | null;
}

/**
 * Accumulate the running posture stretch of an active session up to `until`
 * into the completed-second columns. Legacy rows (null posture fields) fall
 * back to started_at and contribute nothing.
 */
export function accumulatePosture(session: PostureSessionRow, until: Date): {
  relaxSeconds: number;
  attentiveSeconds: number;
} {
  const sinceMs = new Date(session.posture_changed_at ?? session.started_at).getTime();
  const stretchSeconds = Math.max(0, Math.floor((until.getTime() - sinceMs) / 1000));

  const relaxSeconds = (session.relax_seconds ?? 0) +
    (session.posture_state === 'relaxing' ? stretchSeconds : 0);
  const attentiveSeconds = (session.attentive_seconds ?? 0) +
    (session.posture_state === 'attentive' ? stretchSeconds : 0);

  return { relaxSeconds, attentiveSeconds };
}

/** Live stretch of the active session's current posture, in seconds */
export function currentPostureStretchSeconds(session: PostureSessionRow, now: Date): number {
  if (session.posture_state === null) return 0;
  const sinceMs = new Date(session.posture_changed_at ?? session.started_at).getTime();
  return Math.max(0, Math.floor((now.getTime() - sinceMs) / 1000));
}

/**
 * Open a sitting session if one does not already exist, starting it in the
 * given posture. Mirrors the previous POST /api/sitting/start logic exactly.
 *
 * `startedAt` overrides the server "now" for started_at/posture_changed_at —
 * the device's confirmed-state first-detection moment, so the firmware's
 * sitting-confirmation window doesn't inflate the recorded duration. Callers
 * without a device-derived moment (dashboard simulate controls) omit it.
 */
export async function openSession(
  posture: PostureState = 'attentive',
  startedAt?: Date
): Promise<OpenSessionResult> {
  const supabase = getSupabaseServerClient();

  try {
    // 1. Check for existing active session (ended_at IS NULL)
    const { data: existingActive, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      return { status: 'db_error', error: fetchError.message };
    }

    // 2. Edge Case Handling: Duplicate START or device restarted while sitting
    if (existingActive) {
      return { status: 'already_active', session: existingActive, reason: 'pre_existing' };
    }

    // 3. Create new session (server clock unless a device-derived start is given;
    //    the posture stretch begins with the session so no time goes unclassified)
    const startIso = (startedAt ?? new Date()).toISOString();
    const { data: newSession, error: insertError } = await supabase
      .from('sitting_sessions')
      .insert([
        {
          started_at: startIso,
          ended_at: null,
          duration_seconds: null,
          posture_state: posture,
          posture_changed_at: startIso,
          relax_seconds: 0,
          attentive_seconds: 0,
        },
      ])
      .select()
      .single();

    if (insertError) {
      // If a race condition triggered the unique index constraint (23505)
      if (insertError.code === '23505') {
        const { data: fallbackActive } = await supabase
          .from('sitting_sessions')
          .select('*')
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .single();

        return { status: 'already_active', session: fallbackActive, reason: 'race' };
      }

      return { status: 'db_error', error: insertError.message };
    }

    // Broadcast change immediately to all open dashboard tabs (< 20ms)
    eventBroadcaster.broadcast('start', { session: newSession });

    return { status: 'started', session: newSession };
  } catch (err: unknown) {
    console.error('[SESSION] Unexpected error opening session:', err);
    return { status: 'db_error', error: 'Internal server error' };
  }
}

/**
 * Transition the active session to a new posture, flushing the completed
 * stretch into the per-posture columns. Opens a session when the device
 * reports a posture while vacant (e.g. straight into relaxing) — `startedAt`
 * backdates that open to the device's first-detection moment (see openSession).
 */
export async function setPosture(posture: PostureState, startedAt?: Date): Promise<SetPostureResult> {
  const supabase = getSupabaseServerClient();

  try {
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      return { status: 'db_error', error: fetchError.message };
    }

    // Posture reported while vacant — start tracking in that posture
    if (!activeSession) {
      const opened = await openSession(posture, startedAt);
      if (opened.status === 'db_error') return opened;
      if (opened.status === 'started') return { status: 'updated', session: opened.session };
      return { status: 'unchanged', session: opened.session };
    }

    // Same posture as the running stretch — nothing to do
    if (activeSession.posture_state === posture) {
      return { status: 'unchanged', session: activeSession };
    }

    // Flush the completed stretch, then switch the running stretch pointer
    const now = new Date();
    const { relaxSeconds, attentiveSeconds } = accumulatePosture(activeSession, now);
    const nowIso = now.toISOString();

    const { data: updatedSession, error: updateError } = await supabase
      .from('sitting_sessions')
      .update({
        posture_state: posture,
        posture_changed_at: nowIso,
        relax_seconds: relaxSeconds,
        attentive_seconds: attentiveSeconds,
      })
      .eq('id', activeSession.id)
      .select()
      .single();

    if (updateError) {
      return { status: 'db_error', error: updateError.message };
    }

    // Lightweight push to all dashboard tabs — carries the new posture and
    // the updated totals so clients can refresh without waiting for a poll.
    eventBroadcaster.broadcastEvent('POSTURE_CHANGE', {
      sessionId: updatedSession.id,
      state: posture,
      relaxSeconds,
      attentiveSeconds,
      postureChangedAt: nowIso,
    });

    return { status: 'updated', session: updatedSession };
  } catch (err: unknown) {
    console.error('[SESSION] Unexpected error setting posture:', err);
    return { status: 'db_error', error: 'Internal server error' };
  }
}

/**
 * Close the active sitting session. Mirrors the previous POST /api/sitting/stop
 * logic, with optional device-derived timing: `endedAt` backdates the close to
 * the vacancy first-detection moment so the firmware's vacancy-confirmation
 * window doesn't inflate the recorded duration. It is clamped to
 * [started_at, now] so a bogus device value can never produce a negative or
 * future-ended session. The running posture stretch is flushed up to the
 * (possibly backdated) end so confirmation-window time never counts as
 * relax/attentive either.
 */
export async function closeActiveSession(endedAt?: Date): Promise<CloseSessionResult> {
  const supabase = getSupabaseServerClient();

  try {
    // 1. Find the currently active session (ended_at IS NULL)
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      return { status: 'db_error', error: fetchError.message };
    }

    // 2. Edge Case Handling: Duplicate STOP or STOP without an active session
    if (!activeSession) {
      return { status: 'no_active_session' };
    }

    // 3. Server is the source of truth for the clock; the device-derived end
    //    moment only shifts the timestamp back within [started_at, now].
    const startMs = new Date(activeSession.started_at).getTime();
    const stopMs = Math.min(Math.max(endedAt?.getTime() ?? Date.now(), startMs), Date.now());
    const stopTime = new Date(stopMs);
    const durationSeconds = Math.max(0, Math.floor((stopMs - startMs) / 1000));

    // Flush the running posture stretch up to the stop time
    const { relaxSeconds, attentiveSeconds } = accumulatePosture(activeSession, stopTime);

    const { data: updatedSession, error: updateError } = await supabase
      .from('sitting_sessions')
      .update({
        ended_at: stopTime.toISOString(),
        duration_seconds: durationSeconds,
        posture_state: null,
        posture_changed_at: null,
        relax_seconds: relaxSeconds,
        attentive_seconds: attentiveSeconds,
      })
      .eq('id', activeSession.id)
      .select()
      .single();

    if (updateError) {
      return { status: 'db_error', error: updateError.message };
    }

    // Broadcast change immediately to all open dashboard tabs (< 20ms)
    eventBroadcaster.broadcast('stop', { session: updatedSession, durationSeconds });

    return { status: 'stopped', session: updatedSession, durationSeconds };
  } catch (err: unknown) {
    console.error('[SESSION] Unexpected error closing session:', err);
    return { status: 'db_error', error: 'Internal server error' };
  }
}

/**
 * When the currently active session started (epoch ms), or null when none is
 * active. Used by the MQTT session-events handler (lib/sessionEvents.ts) to
 * spot stale queued SESSION_ENDED events that predate the active session
 * (device sat again while the backend was offline) — those must not close
 * the newer session.
 */
export async function getActiveSessionStartedAtMs(): Promise<number | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from('sitting_sessions')
      .select('started_at')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return new Date(data.started_at).getTime();
  } catch {
    return null;
  }
}

/**
 * Liveness touch — keeps last_heartbeat_at fresh while a device keeps posting
 * HTTP telemetry (throttled by the caller). The /status endpoint's
 * stale-session auto-close (30s/8h) keeps working unchanged as a backstop.
 */
export async function touchActiveSessionHeartbeat(): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const supabase = getSupabaseServerClient();
    const { data: activeSession } = await supabase
      .from('sitting_sessions')
      .select('id')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!activeSession) return;

    await supabase
      .from('sitting_sessions')
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('id', activeSession.id);
  } catch (err: unknown) {
    console.error('[SESSION] Heartbeat touch failed:', err);
  }
}
