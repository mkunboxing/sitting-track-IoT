import { Router } from 'express';
import { getSupabaseServerClient, isSupabaseConfigured } from '../lib/supabase';
import { eventBroadcaster } from '../lib/eventBroadcaster';
import {
  openSession,
  closeActiveSession,
  setPosture,
  accumulatePosture,
} from '../lib/sessionService';
import { DEVICE_ONLINE_WINDOW_MS, getLatestSensorReading } from '../lib/telemetryStore';
import { calculateSessionOverlapWithInterval, getTimezoneDayBoundaries } from '../lib/timeUtils';
import { postureShareSeconds } from '../lib/sessionState';
import type { DashboardStatsResponse, DayStats, SittingSession } from '../types/sitting';

export const sittingRouter = Router();

/** Normalize a query param (may be string | string[] | ParsedQs) to a single string or null */
function singleQuery(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /status — dashboard metrics in the caller's local timezone
// ─────────────────────────────────────────────────────────────
sittingRouter.get('/status', async (req, res) => {
  // Never cache status API response
  res.set('Cache-Control', 'no-store');

  const configured = isSupabaseConfigured();

  // Extract client timezone from query param or header (defaults to UTC if missing)
  const tzParam = singleQuery(req.query.tz) ?? req.get('x-timezone');
  const offsetParam = singleQuery(req.query.tzOffset) ?? req.get('x-timezone-offset');
  const tzOffset = offsetParam !== null && offsetParam !== undefined ? parseInt(offsetParam, 10) : null;

  const now = new Date();
  const boundaries = getTimezoneDayBoundaries(now, tzParam, tzOffset);
  const { todayStartUtc, sevenDaysAgoUtc, weeklyIntervals } = boundaries;

  // If Supabase is not yet configured, return clean initial/sample state with configured: false
  if (!configured) {
    const mockWeekly: DayStats[] = weeklyIntervals.map((interval) => ({
      date: interval.date,
      dayName: interval.dayName,
      totalSeconds: 0,
      sessionCount: 0,
      relaxSeconds: 0,
      attentiveSeconds: 0,
      unclassifiedSeconds: 0,
    }));

    const unconfiguredPayload: DashboardStatsResponse = {
      status: 'AWAY',
      activeSession: null,
      activeDurationSeconds: 0,
      activeRelaxSeconds: 0,
      activeAttentiveSeconds: 0,
      todayTotalSeconds: 0,
      todayRelaxSeconds: 0,
      todayAttentiveSeconds: 0,
      todaySessionCount: 0,
      todayLongestSessionSeconds: 0,
      todaySessions: [],
      weeklyStats: mockWeekly,
      lastUpdated: now.toISOString(),
      configured: false,
    };

    return res.json(unconfiguredPayload);
  }

  try {
    const supabase = getSupabaseServerClient();

    // 1. Fetch active session if any
    const { data: initialActive, error: activeError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let activeSession = initialActive;

    if (activeError) {
      console.error('[API /sitting/status] Error fetching active session:', activeError);
    }

    // Auto-detect if device was switched off (heartbeat timeout)
    if (activeSession) {
      const lastCheckTime = activeSession.last_heartbeat_at
        ? new Date(activeSession.last_heartbeat_at).getTime()
        : new Date(activeSession.started_at).getTime();

      const timeSinceCheck = now.getTime() - lastCheckTime;
      // If module has been silent for > 30 seconds (and heartbeat was established) or > 8 hours (stale safety).
      // The device's MQTT telemetry (snapshot every 2.5s via EMQX Cloud) touches
      // last_heartbeat_at every 10s, so a live device never trips this; it
      // only fires for a genuinely gone device.
      const isStaleHeartbeat = activeSession.last_heartbeat_at && timeSinceCheck > 30 * 1000;
      const isUnreasonablyOld = timeSinceCheck > 8 * 3600 * 1000;

      if (isStaleHeartbeat || isUnreasonablyOld) {
        const autoEndTime = activeSession.last_heartbeat_at || now.toISOString();
        const startMs = new Date(activeSession.started_at).getTime();
        const endMs = new Date(autoEndTime).getTime();
        const closedDuration = Math.max(0, Math.floor((endMs - startMs) / 1000));

        // Flush the running posture stretch up to last contact before closing
        const postureTotals = accumulatePosture(activeSession, new Date(autoEndTime));

        await supabase
          .from('sitting_sessions')
          .update({
            ended_at: autoEndTime,
            duration_seconds: closedDuration,
            posture_state: null,
            posture_changed_at: null,
            relax_seconds: postureTotals.relaxSeconds,
            attentive_seconds: postureTotals.attentiveSeconds,
          })
          .eq('id', activeSession.id);

        console.log(`[API] Auto-closed abandoned session ${activeSession.id} because module was powered off.`);

        // Push the close to every dashboard tab instantly (otherwise tabs
        // would only learn about it from their next status poll).
        eventBroadcaster.broadcast('stop', {
          session: { ...activeSession, ended_at: autoEndTime, duration_seconds: closedDuration },
          durationSeconds: closedDuration,
        });

        activeSession = null;
      }
    }

    // 2. Fetch all sessions that intersect with the last 7 days (including today)
    // A session intersects if ended_at is null OR ended_at >= sevenDaysAgoUtc
    const { data: recentSessions, error: recentError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .or(`ended_at.gte.${sevenDaysAgoUtc.toISOString()},ended_at.is.null`)
      .order('started_at', { ascending: false });

    if (recentError) {
      console.error('[API /sitting/status] Error fetching recent sessions:', recentError);
      return res.status(500).json({ success: false, error: recentError.message });
    }

    const allSessions: SittingSession[] = recentSessions || [];

    // Calculate active duration and its live relax/attentive split
    let activeDurationSeconds = 0;
    if (activeSession) {
      const activeStart = new Date(activeSession.started_at);
      activeDurationSeconds = Math.max(0, Math.floor((now.getTime() - activeStart.getTime()) / 1000));
    }
    // Full-window overlap ⇒ share = 1 ⇒ exact totals including the running stretch
    const activePosture = activeSession
      ? postureShareSeconds(activeSession, activeDurationSeconds, now)
      : { relax: 0, attentive: 0 };

    // 3. Process Today's metrics in the user's local timezone (handling midnight crossing)
    const todaySessions: SittingSession[] = [];
    let todayTotalSeconds = 0;
    let todayLongestSessionSeconds = 0;
    let todayRelaxSeconds = 0;
    let todayAttentiveSeconds = 0;

    for (const session of allSessions) {
      // Calculate overlap with today's local interval [todayStartUtc, now]
      const overlapSeconds = calculateSessionOverlapWithInterval(
        session.started_at,
        session.ended_at,
        todayStartUtc,
        now
      );

      if (overlapSeconds > 0) {
        todaySessions.push(session);
        todayTotalSeconds += overlapSeconds;

        const postureSplit = postureShareSeconds(session, overlapSeconds, now);
        todayRelaxSeconds += postureSplit.relax;
        todayAttentiveSeconds += postureSplit.attentive;

        // Compare effective duration for today
        if (overlapSeconds > todayLongestSessionSeconds) {
          todayLongestSessionSeconds = overlapSeconds;
        }
      }
    }

    // 4. Compute Weekly Statistics (Past 7 days according to user's timezone)
    const weeklyStats: DayStats[] = weeklyIntervals.map((interval) => {
      let dayTotal = 0;
      let dayCount = 0;
      let dayRelax = 0;
      let dayAttentive = 0;

      for (const session of allSessions) {
        const overlap = calculateSessionOverlapWithInterval(
          session.started_at,
          session.ended_at,
          interval.startUtc,
          interval.endUtc
        );

        if (overlap > 0) {
          dayTotal += overlap;
          dayCount++;

          const postureSplit = postureShareSeconds(session, overlap, now);
          dayRelax += postureSplit.relax;
          dayAttentive += postureSplit.attentive;
        }
      }

      return {
        date: interval.date,
        dayName: interval.dayName,
        totalSeconds: dayTotal,
        sessionCount: dayCount,
        relaxSeconds: dayRelax,
        attentiveSeconds: dayAttentive,
        unclassifiedSeconds: Math.max(0, dayTotal - dayRelax - dayAttentive),
      };
    });

    const latestSensor = getLatestSensorReading(DEVICE_ONLINE_WINDOW_MS);

    const responsePayload: DashboardStatsResponse = {
      status: activeSession
        ? activeSession.posture_state === 'relaxing'
          ? 'RELAXING'
          : 'ATTENTIVE'
        : 'AWAY',
      activeSession: activeSession || null,
      activeDurationSeconds,
      activeRelaxSeconds: activePosture.relax,
      activeAttentiveSeconds: activePosture.attentive,
      todayTotalSeconds,
      todayRelaxSeconds,
      todayAttentiveSeconds,
      todaySessionCount: todaySessions.length,
      todayLongestSessionSeconds,
      todaySessions,
      weeklyStats,
      lastUpdated: now.toISOString(),
      configured: true,
      distanceCm: latestSensor?.distanceCm ?? null,
      distanceUpdatedAt: latestSensor?.updatedAt ?? null,
    };

    return res.json(responsePayload);
  } catch (err: unknown) {
    console.error('[API /sitting/status] Internal error:', err);
    return res.status(500).json({ success: false, error: 'Failed to compute status metrics' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /stream — Server-Sent Events (SSE)
// Web clients connect via `new EventSource('<api>/api/sitting/stream')`.
// When the device telemetry POST transitions the seating state (or the
// dashboard calls POST /api/sitting/simulate), an event is pushed through
// this stream immediately to all clients.
// ─────────────────────────────────────────────────────────────
sittingRouter.get('/stream', (req, res) => {
  eventBroadcaster.addClient(req, res);
});

// ─────────────────────────────────────────────────────────────
// POST /simulate — Development / testing helper endpoint:
// triggers START or STOP directly from the dashboard controls.
// ─────────────────────────────────────────────────────────────
sittingRouter.post('/simulate', async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env',
    });
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action;

    if (action !== 'start' && action !== 'stop' && action !== 'relax' && action !== 'focus') {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Expected "start", "stop", "relax" or "focus"',
      });
    }

    // Posture actions: set the active session's posture (opens one if vacant)
    if (action === 'relax' || action === 'focus') {
      const result = await setPosture(action === 'relax' ? 'relaxing' : 'attentive');

      if (result.status === 'db_error') {
        return res.status(500).json({ success: false, error: result.error });
      }

      return res.json({
        success: true,
        status: result.status,
        message:
          result.status === 'updated'
            ? `Posture set to ${action === 'relax' ? 'relaxing' : 'attentive'}.`
            : 'Posture unchanged.',
        session: result.session ?? null,
      });
    }

    if (action === 'start') {
      const result = await openSession();

      if (result.status === 'db_error') {
        return res.status(500).json({ success: false, error: result.error });
      }

      if (result.status === 'already_active') {
        return res.json({
          success: true,
          status: 'already_active',
          message: 'A session is already active.',
          session: result.session,
        });
      }

      return res.json({
        success: true,
        status: 'started',
        message: 'Simulated sitting session started.',
        session: result.session,
      });
    }

    // action === 'stop'
    const result = await closeActiveSession();

    if (result.status === 'db_error') {
      return res.status(500).json({ success: false, error: result.error });
    }

    if (result.status === 'no_active_session') {
      return res.json({
        success: true,
        status: 'no_active_session',
        message: 'No active session was in progress.',
      });
    }

    return res.json({
      success: true,
      status: 'stopped',
      message: 'Simulated sitting session ended.',
      session: result.session,
    });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: 'Internal server error: ' + String(err),
    });
  }
});

