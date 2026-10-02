import { Router } from 'express';
import { getSupabaseServerClient, isSupabaseConfigured } from '../lib/supabase';
import { requireDeviceToken } from '../lib/auth';
import { eventBroadcaster } from '../lib/eventBroadcaster';
import { openSession, closeActiveSession } from '../lib/sessionService';
import { calculateSessionOverlapWithInterval, getTimezoneDayBoundaries } from '../lib/timeUtils';
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
    }));

    const unconfiguredPayload: DashboardStatsResponse = {
      status: 'AWAY',
      activeSession: null,
      activeDurationSeconds: 0,
      todayTotalSeconds: 0,
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
      // If module has been silent for > 90 seconds (and heartbeat was established) or > 8 hours (stale safety)
      const isStaleHeartbeat = activeSession.last_heartbeat_at && timeSinceCheck > 90 * 1000;
      const isUnreasonablyOld = timeSinceCheck > 8 * 3600 * 1000;

      if (isStaleHeartbeat || isUnreasonablyOld) {
        const autoEndTime = activeSession.last_heartbeat_at || now.toISOString();
        const startMs = new Date(activeSession.started_at).getTime();
        const endMs = new Date(autoEndTime).getTime();
        const closedDuration = Math.max(0, Math.floor((endMs - startMs) / 1000));

        await supabase
          .from('sitting_sessions')
          .update({
            ended_at: autoEndTime,
            duration_seconds: closedDuration,
          })
          .eq('id', activeSession.id);

        console.log(`[API] Auto-closed abandoned session ${activeSession.id} because module was powered off.`);
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

    // Calculate active duration
    let activeDurationSeconds = 0;
    if (activeSession) {
      const activeStart = new Date(activeSession.started_at);
      activeDurationSeconds = Math.max(0, Math.floor((now.getTime() - activeStart.getTime()) / 1000));
    }

    // 3. Process Today's metrics in the user's local timezone (handling midnight crossing)
    const todaySessions: SittingSession[] = [];
    let todayTotalSeconds = 0;
    let todayLongestSessionSeconds = 0;

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
        }
      }

      return {
        date: interval.date,
        dayName: interval.dayName,
        totalSeconds: dayTotal,
        sessionCount: dayCount,
      };
    });

    const responsePayload: DashboardStatsResponse = {
      status: activeSession ? 'SITTING' : 'AWAY',
      activeSession: activeSession || null,
      activeDurationSeconds,
      todayTotalSeconds,
      todaySessionCount: todaySessions.length,
      todayLongestSessionSeconds,
      todaySessions,
      weeklyStats,
      lastUpdated: now.toISOString(),
      configured: true,
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
// When the NodeMCU calls POST /api/sitting/start or POST /api/sitting/stop,
// an event is pushed through this stream immediately to all clients.
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

    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Expected "start" or "stop"',
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

// ─────────────────────────────────────────────────────────────
// POST /start — device (NodeMCU) opens a sitting session
// ─────────────────────────────────────────────────────────────
sittingRouter.post('/start', requireDeviceToken, async (req, res) => {
  // 1. Check Supabase configuration
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  // 2. Session lifecycle is handled by the shared service (also used by the
  //    WebSocket gateway) — identical duplicate/race handling as before.
  const result = await openSession();

  switch (result.status) {
    case 'db_error':
      console.error('[API /sitting/start] Query/insert error:', result.error);
      return res.status(500).json({ success: false, error: result.error });

    case 'already_active': {
      const message =
        result.reason === 'race'
          ? 'An active session was concurrently created.'
          : 'An active session is already in progress.';
      console.log(`[API /sitting/start] ${message} Returning existing session.`);
      return res.status(200).json({
        success: true,
        status: 'already_active',
        message,
        session: result.session,
      });
    }

    case 'started':
      console.log(`[API /sitting/start] Started session ${result.session.id} at ${result.session.started_at}`);
      return res.status(201).json({
        success: true,
        status: 'started',
        message: 'Sitting session started successfully.',
        session: result.session,
      });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /stop — device (NodeMCU) closes the active sitting session
// ─────────────────────────────────────────────────────────────
sittingRouter.post('/stop', requireDeviceToken, async (req, res) => {
  // 1. Check Supabase configuration
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  // 2. Session lifecycle is handled by the shared service (also used by the
  //    WebSocket gateway) — identical idempotent behavior as before.
  const result = await closeActiveSession();

  switch (result.status) {
    case 'db_error':
      console.error('[API /sitting/stop] Query/update error:', result.error);
      return res.status(500).json({ success: false, error: result.error });

    case 'no_active_session':
      console.log('[API /sitting/stop] No active session found. Ignoring duplicate stop.');
      return res.status(200).json({
        success: true,
        status: 'no_active_session',
        message: 'No active session was in progress. Nothing to stop.',
      });

    case 'stopped':
      console.log(
        `[API /sitting/stop] Stopped session ${result.session.id}. Duration: ${result.durationSeconds} seconds.`
      );
      return res.status(200).json({
        success: true,
        status: 'stopped',
        message: 'Sitting session stopped successfully.',
        session: result.session,
      });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /heartbeat — device keeps the active session alive
// ─────────────────────────────────────────────────────────────
sittingRouter.post('/heartbeat', requireDeviceToken, async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ success: false, error: 'Database not configured.' });
  }

  const supabase = getSupabaseServerClient();

  try {
    // 1. Find currently active session
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('id, started_at')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    if (!activeSession) {
      return res.json({
        success: true,
        active: false,
        message: 'No active session found.',
      });
    }

    // 2. Update heartbeat timestamp
    const nowIso = new Date().toISOString();
    await supabase
      .from('sitting_sessions')
      .update({
        last_heartbeat_at: nowIso,
      })
      .eq('id', activeSession.id);

    return res.json({
      success: true,
      active: true,
      sessionId: activeSession.id,
      timestamp: nowIso,
    });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: 'Internal error: ' + String(err),
    });
  }
});
