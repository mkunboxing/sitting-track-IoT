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
 *
 * Every numeric duration also carries a formatted "HH:MM:SS" twin and every
 * session row carries friendly timestamps (startedAtIst/endedAtIst in
 * APP_TIMEZONE) — additions only; the original numeric/ISO fields stay
 * unchanged so existing consumers keep working.
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
  // Human-readable twins (same values formatted "HH:MM:SS") — added for the
  // mobile app; the numeric fields above remain the source of truth.
  totalHms: string;
  relaxHms: string;
  attentiveHms: string;
  longestHms: string;
}

/**
 * A sitting_sessions row plus display-only twins for the mobile app:
 * friendly timestamps in the app timezone and a formatted duration.
 * (Fields named *Ist because the deployment runs on IST — they are formatted
 * in APP_TIMEZONE, which is set to Asia/Kolkata.) Only ADDED keys — every
 * original row field is untouched.
 */
export interface DisplaySittingSession extends SittingSession {
  startedAtIst: string | null;
  endedAtIst: string | null;
  /** HH:MM:SS twin of the row's duration_seconds (null while a session is active) */
  durationHms: string | null;
}

export interface SessionStateSnapshot {
  deviceId: string;
  /** Backend clock at publish time (ISO) — receivers can detect staleness */
  generatedAt: string;
  /** IANA timezone the today-totals were computed in */
  timezone: string;
  activeSession: DisplaySittingSession | null;
  /** now − activeSession.started_at (0 when no active session) */
  activeDurationSeconds: number;
  /** "HH:MM:SS" twin of activeDurationSeconds */
  activeDurationHms: string;
  /** Most recently CLOSED session, whatever day it ended */
  previousSession: DisplaySittingSession | null;
  today: TodayTotals;
}

/**
 * Seconds → zero-padded "HH:MM:SS" (hours unbounded for >24h values).
 * Returns null for null/undefined/non-finite input.
 */
function formatHms(totalSeconds: number | null | undefined): string | null {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return null;
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * ISO timestamp → user-friendly string in the app timezone
 * (e.g. "Sat, 4 Oct, 10:05 am"). Returns null for null/invalid input.
 */
function formatTimestampFriendly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: getAppTimezone(),
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return null;
  }
}

/** Copy a DB row and attach the display-only twins (originals untouched). */
function withDisplayFields(row: SittingSession): DisplaySittingSession {
  return {
    ...row,
    startedAtIst: formatTimestampFriendly(row.started_at),
    endedAtIst: formatTimestampFriendly(row.ended_at),
    durationHms: formatHms(row.duration_seconds),
  };
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
    activeSession: activeSession ? withDisplayFields(activeSession as SittingSession) : null,
    activeDurationSeconds,
    activeDurationHms: formatHms(activeDurationSeconds) ?? '00:00:00',
    previousSession: previousSession ? withDisplayFields(previousSession as SittingSession) : null,
    today: {
      date: todayDate,
      totalSeconds,
      sessionCount,
      relaxSeconds,
      attentiveSeconds,
      longestSessionSeconds,
      totalHms: formatHms(totalSeconds) ?? '00:00:00',
      relaxHms: formatHms(relaxSeconds) ?? '00:00:00',
      attentiveHms: formatHms(attentiveSeconds) ?? '00:00:00',
      longestHms: formatHms(longestSessionSeconds) ?? '00:00:00',
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
