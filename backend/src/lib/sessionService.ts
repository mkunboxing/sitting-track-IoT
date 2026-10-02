import { getSupabaseServerClient, isSupabaseConfigured } from './supabase';
import { eventBroadcaster } from './eventBroadcaster';
import type { SittingSession } from '../types/sitting';

/**
 * Session lifecycle service — the single source of truth for opening and
 * closing sitting sessions. Shared by the HTTP routes (/start, /stop,
 * /simulate) and the WebSocket device gateway so both transports behave
 * identically.
 *
 * Atomicity: the database's partial unique index
 * (idx_sitting_sessions_one_active, WHERE ended_at IS NULL) guarantees at
 * most one active session; the 23505 race handler below resolves the loser.
 */

export type OpenSessionResult =
  | { status: 'started'; session: SittingSession }
  | { status: 'already_active'; session: SittingSession | null; reason: 'pre_existing' | 'race' }
  | { status: 'db_error'; error: string };

export type CloseSessionResult =
  | { status: 'stopped'; session: SittingSession; durationSeconds: number }
  | { status: 'no_active_session' }
  | { status: 'db_error'; error: string };

export const canUseDatabase = (): boolean => isSupabaseConfigured();

/**
 * Open a sitting session if one does not already exist.
 * Mirrors the previous POST /api/sitting/start logic exactly.
 */
export async function openSession(): Promise<OpenSessionResult> {
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

    // 3. Create new session with current server timestamp
    const nowIso = new Date().toISOString();
    const { data: newSession, error: insertError } = await supabase
      .from('sitting_sessions')
      .insert([
        {
          started_at: nowIso,
          ended_at: null,
          duration_seconds: null,
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
 * Close the active sitting session, computing duration from server time.
 * Mirrors the previous POST /api/sitting/stop logic exactly.
 */
export async function closeActiveSession(): Promise<CloseSessionResult> {
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

    // 3. Server is the source of truth for timestamps
    const stopTime = new Date();
    const startTime = new Date(activeSession.started_at);
    const durationSeconds = Math.max(
      0,
      Math.floor((stopTime.getTime() - startTime.getTime()) / 1000)
    );

    const { data: updatedSession, error: updateError } = await supabase
      .from('sitting_sessions')
      .update({
        ended_at: stopTime.toISOString(),
        duration_seconds: durationSeconds,
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
 * Liveness touch — keeps last_heartbeat_at fresh while a device is connected
 * via WebSocket. The /status endpoint's stale-session auto-close (30s/8h)
 * keeps working unchanged as a backstop.
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
