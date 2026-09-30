import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';
import { calculateSessionOverlapWithInterval, getTimezoneDayBoundaries } from '@/lib/timeUtils';
import { DashboardStatsResponse, DayStats, SittingSession } from '@/types/sitting';

// Force dynamic execution (never cache status API response)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const configured = isSupabaseConfigured();

  // Extract client timezone from query param or header (defaults to UTC if missing)
  const { searchParams } = new URL(req.url);
  const tzParam = searchParams.get('tz') || req.headers.get('x-timezone');
  const offsetParam = searchParams.get('tzOffset') || req.headers.get('x-timezone-offset');
  const tzOffset = offsetParam !== null ? parseInt(offsetParam, 10) : null;

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

    return NextResponse.json(unconfiguredPayload);
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
      return NextResponse.json(
        { success: false, error: recentError.message },
        { status: 500 }
      );
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

    return NextResponse.json(responsePayload);
  } catch (err: unknown) {
    console.error('[API /sitting/status] Internal error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to compute status metrics' },
      { status: 500 }
    );
  }
}
