import { getSupabaseServerClient, isSupabaseConfigured } from './supabase';
import { currentPostureStretchSeconds } from './sessionService';
import { calculateSessionOverlapWithInterval, getTimezoneDayBoundaries } from './timeUtils';
import type { SittingSession } from '../types/sitting';

/**
 * Session-state snapshot builder — the shared "current sitting state" query
 * used by BOTH the dashboard's GET /status (via the postureShareSeconds
 * helper moved here verbatim from the route) and the MQTT session-state
 * topic published for the mobile app (lib/sessionStatePublisher.ts).
 *
 * The source of truth is always the existing Supabase sitting_sessions data —
 * this module never writes anything and never opens/closes sessions.
 *
 * Date-awareness: "today" is computed from the moment the snapshot is built
 * (in the configured timezone), so the totals stay correct even when the
 * backend was asleep across midnight — a backend that wakes at 09:00 reports
 * the new date's totals, counting only the post-midnight portion of a session
 * that spans midnight (calculateSessionOverlapWithInterval splits at the
 * boundary; the session itself is never closed at midnight).
 */

/** The app's home timezone for "today" when no per-request timezone exists.
 *  MQTT/mobile has no request context, so this comes from APP_TIMEZONE
 *  (IANA name, e.g. Asia/Kolkata), falling back to the server's local zone. */
export function getAppTimezone(): string {
  const configured = process.env.APP_TIMEZONE?.trim();
  if (configured) return configured;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Split a session's overlap with a time window into relax/attentive seconds.
 * The active session's running posture stretch (not yet flushed to the DB) is
 * included; the share is proportional when a session crosses the window edge
 * (e.g. midnight). Leftover time belongs to unclassified (legacy) sessions.
 *
 * (Moved verbatim from routes/sitting.ts so /status and the MQTT session
 * state always agree; the route imports it from here now.)
 */
export function postureShareSeconds(
  session: SittingSession,
  overlapSeconds: number,
  now: Date
): { relax: number; attentive: number } {
  if (overlapSeconds <= 0) return { relax: 0, attentive: 0 };

  let relax: number;
  let attentive: number;
  let totalDuration: number;

  if (session.ended_at === null) {
    const stretch = currentPostureStretchSeconds(session, now);
    relax = (session.relax_seconds ?? 0) + (session.posture_state === 'relaxing' ? stretch : 0);
    attentive = (session.attentive_seconds ?? 0) + (session.posture_state === 'attentive' ? stretch : 0);
    totalDuration = Math.max(1, Math.floor((now.getTime() - new Date(session.started_at).getTime()) / 1000));
  } else {
    relax = session.relax_seconds ?? 0;
    attentive = session.attentive_seconds ?? 0;
    totalDuration = session.duration_seconds ?? overlapSeconds;
  }

  if (totalDuration <= 0) return { relax: 0, attentive: 0 };
  const share = Math.min(1, overlapSeconds / totalDuration);
  relax = Math.min(overlapSeconds, Math.round(relax * share));
  attentive = Math.min(overlapSeconds - relax, Math.round(attentive * share));
  return { relax, attentive };
}

/** Today's totals as surfaced in the MQTT session-state payload. */
export interface TodayTotals {
  date: string;
  totalSeconds: number;
  sessionCount: number;
  relaxSeconds: number;
  attentiveSeconds: number;
  longestSessionSeconds: number;
}

export interface SessionStateSnapshot {
  deviceId: string;
  /** Backend clock at publish time (ISO) — receivers can detect staleness */
  generatedAt: string;
  /** IANA timezone the today-totals were computed in */
  timezone: string;
  activeSession: SittingSession | null;
  /** now − activeSession.started_at (0 when no active session) */
  activeDurationSeconds: number;
  /** Most recently CLOSED session, whatever day it ended */
  previousSession: SittingSession | null;
  today: TodayTotals;
}

/**
 * Build one session-state snapshot from Supabase. Returns null when Supabase
 * is not configured or the queries fail (caller logs and skips the publish).
 */
export async function buildSessionStateSnapshot(now: Date = new Date()): Promise<SessionStateSnapshot | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = getSupabaseServerClient();
  const timeZone = getAppTimezone();
  const { todayDate, todayStartUtc } = getTimezoneDayBoundaries(now, timeZone, null);

  // 1. Active session (ended_at IS NULL) — same query as /status
  const { data: activeSession, error: activeError } = await supabase
    .from('sitting_sessions')
    .select('*')
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) {
    console.error('[SESSION-STATE] Error fetching active session:', activeError.message);
    return null;
  }

  // 2. Previous (most recently closed) session — whatever day it ended
  const { data: previousSession, error: previousError } = await supabase
    .from('sitting_sessions')
    .select('*')
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousError) {
    console.error('[SESSION-STATE] Error fetching previous session:', previousError.message);
    return null;
  }

  // 3. Today's totals — every session that overlaps [todayStartUtc, now].
  //    ended_at >= todayStart catches anything that ended today; the
  //    ended_at IS NULL arm keeps a midnight-spanning active session in the
  //    new day's numbers (overlap math credits only the post-midnight part).
  const { data: todayCandidates, error: todayError } = await supabase
    .from('sitting_sessions')
    .select('*')
    .or(`ended_at.gte.${todayStartUtc.toISOString()},ended_at.is.null`)
    .order('started_at', { ascending: false });
  if (todayError) {
    console.error('[SESSION-STATE] Error fetching today sessions:', todayError.message);
    return null;
  }

  let totalSeconds = 0;
  let sessionCount = 0;
  let relaxSeconds = 0;
  let attentiveSeconds = 0;
  let longestSessionSeconds = 0;

  for (const session of (todayCandidates ?? []) as SittingSession[]) {
    const overlapSeconds = calculateSessionOverlapWithInterval(
      session.started_at,
      session.ended_at,
      todayStartUtc,
      now
    );
    if (overlapSeconds <= 0) continue;

    sessionCount += 1;
    totalSeconds += overlapSeconds;
    if (overlapSeconds > longestSessionSeconds) longestSessionSeconds = overlapSeconds;

    const split = postureShareSeconds(session, overlapSeconds, now);
    relaxSeconds += split.relax;
    attentiveSeconds += split.attentive;
  }

  const activeDurationSeconds = activeSession
    ? Math.max(0, Math.floor((now.getTime() - new Date(activeSession.started_at).getTime()) / 1000))
    : 0;

  return {
    deviceId: getDeviceId(),
    generatedAt: now.toISOString(),
    timezone: timeZone,
    activeSession: (activeSession as SittingSession | null) ?? null,
    activeDurationSeconds,
    previousSession: (previousSession as SittingSession | null) ?? null,
    today: {
      date: todayDate,
      totalSeconds,
      sessionCount,
      relaxSeconds,
      attentiveSeconds,
      longestSessionSeconds,
    },
  };
}

/**
 * The device identity used for the MQTT session-state topic
 * sitting/device/<deviceId>/session (single-device system — the same id the
 * firmware and the simulator use; override with the DEVICE_ID env var).
 */
export function getDeviceId(): string {
  return process.env.DEVICE_ID?.trim() || 'sitting-tracker-01';
}

/** The MQTT topic the backend publishes the mobile app's session state to. */
export function getSessionStateTopic(): string {
  return `sitting/device/${getDeviceId()}/session`;
}
