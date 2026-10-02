import { Router } from 'express';
import { getSupabaseServerClient, isSupabaseConfigured } from '../lib/supabase';
import { requireDeviceToken } from '../lib/auth';
import { eventBroadcaster } from '../lib/eventBroadcaster';
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
      error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env',
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

    const supabase = getSupabaseServerClient();

    if (action === 'start') {
      // Check if session already active
      const { data: existingActive } = await supabase
        .from('sitting_sessions')
        .select('*')
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingActive) {
        return res.json({
          success: true,
          status: 'already_active',
          message: 'A session is already active.',
          session: existingActive,
        });
      }

      const { data: newSession, error } = await supabase
        .from('sitting_sessions')
        .insert([{ started_at: new Date().toISOString() }])
        .select()
        .single();

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      eventBroadcaster.broadcast('start', { session: newSession });

      return res.json({
        success: true,
        status: 'started',
        message: 'Simulated sitting session started.',
        session: newSession,
      });
    }

    // action === 'stop'
    const { data: activeSession } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!activeSession) {
      return res.json({
        success: true,
        status: 'no_active_session',
        message: 'No active session was in progress.',
      });
    }

    const now = new Date();
    const start = new Date(activeSession.started_at);
    const durationSeconds = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));

    const { data: updatedSession, error } = await supabase
      .from('sitting_sessions')
      .update({
        ended_at: now.toISOString(),
        duration_seconds: durationSeconds,
      })
      .eq('id', activeSession.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    eventBroadcaster.broadcast('stop', { session: updatedSession, durationSeconds });

    return res.json({
      success: true,
      status: 'stopped',
      message: 'Simulated sitting session ended.',
      session: updatedSession,
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

  const supabase = getSupabaseServerClient();

  try {
    // 2. Check for existing active session (ended_at IS NULL)
    const { data: existingActive, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error('[API /sitting/start] Query error:', fetchError);
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    // 3. Edge Case Handling: Duplicate START or NodeMCU restarted while sitting
    if (existingActive) {
      console.log(`[API /sitting/start] Active session already exists: ${existingActive.id}. Returning existing session.`);
      return res.status(200).json({
        success: true,
        status: 'already_active',
        message: 'An active session is already in progress.',
        session: existingActive,
      });
    }

    // 4. Create new session with current server timestamp
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

        return res.status(200).json({
          success: true,
          status: 'already_active',
          message: 'An active session was concurrently created.',
          session: fallbackActive,
        });
      }

      console.error('[API /sitting/start] Insert error:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    console.log(`[API /sitting/start] Started session ${newSession.id} at ${newSession.started_at}`);

    // Broadcast change immediately to all open dashboard tabs (< 20ms)
    eventBroadcaster.broadcast('start', { session: newSession });

    return res.status(201).json({
      success: true,
      status: 'started',
      message: 'Sitting session started successfully.',
      session: newSession,
    });
  } catch (err: unknown) {
    console.error('[API /sitting/start] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
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

  const supabase = getSupabaseServerClient();

  try {
    // 2. Find the currently active session (ended_at IS NULL)
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error('[API /sitting/stop] Query error:', fetchError);
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    // 3. Edge Case Handling: Duplicate STOP or STOP received without an active session
    if (!activeSession) {
      console.log('[API /sitting/stop] No active session found. Ignoring duplicate stop.');
      return res.status(200).json({
        success: true,
        status: 'no_active_session',
        message: 'No active session was in progress. Nothing to stop.',
      });
    }

    // 4. Server is the source of truth for timestamps:
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
      console.error('[API /sitting/stop] Update error:', updateError);
      return res.status(500).json({ success: false, error: updateError.message });
    }

    console.log(
      `[API /sitting/stop] Stopped session ${updatedSession.id}. Duration: ${durationSeconds} seconds.`
    );

    // Broadcast change immediately to all open dashboard tabs (< 20ms)
    eventBroadcaster.broadcast('stop', { session: updatedSession, durationSeconds });

    return res.status(200).json({
      success: true,
      status: 'stopped',
      message: 'Sitting session stopped successfully.',
      session: updatedSession,
    });
  } catch (err: unknown) {
    console.error('[API /sitting/stop] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
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
