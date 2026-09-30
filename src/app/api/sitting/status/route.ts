import { NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';
import { calculateSessionOverlapWithInterval } from '@/lib/timeUtils';
import { DashboardStatsResponse, DayStats, SittingSession } from '@/types/sitting';

// Force dynamic execution (never cache status API response)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const configured = isSupabaseConfigured();

  // If Supabase is not yet configured, return clean initial/sample state with configured: false
  if (!configured) {
    const mockWeekly: DayStats[] = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      mockWeekly.push({
        date: d.toISOString().split('T')[0],
        dayName: dayNames[d.getDay()],
        totalSeconds: 0,
        sessionCount: 0,
      });
    }

    const unconfiguredPayload: DashboardStatsResponse = {
      status: 'AWAY',
      activeSession: null,
      activeDurationSeconds: 0,
      todayTotalSeconds: 0,
      todaySessionCount: 0,
      todayLongestSessionSeconds: 0,
      todaySessions: [],
      weeklyStats: mockWeekly,
      lastUpdated: new Date().toISOString(),
      configured: false,
    };

    return NextResponse.json(unconfiguredPayload);
  }

  try {
    const supabase = getSupabaseServerClient();
    const now = new Date();

    // Today's boundaries (in server/local time)
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    // 7 days ago boundary
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    // 1. Fetch active session if any
    const { data: activeSession, error: activeError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeError) {
      console.error('[API /sitting/status] Error fetching active session:', activeError);
    }

    // 2. Fetch all sessions that intersect with the last 7 days (including today)
    // A session intersects if ended_at is null OR ended_at >= sevenDaysAgo
    const { data: recentSessions, error: recentError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .or(`ended_at.gte.${sevenDaysAgo.toISOString()},ended_at.is.null`)
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

    // 3. Process Today's metrics (handling midnight overlap)
    const todaySessions: SittingSession[] = [];
    let todayTotalSeconds = 0;
    let todayLongestSessionSeconds = 0;

    for (const session of allSessions) {
      // Calculate overlap with today [todayStart, now]
      const overlapSeconds = calculateSessionOverlapWithInterval(
        session.started_at,
        session.ended_at,
        todayStart,
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

    // 4. Compute Weekly Statistics (Past 7 days)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyStats: DayStats[] = [];

    for (let i = 6; i >= 0; i--) {
      const dStart = new Date(todayStart);
      dStart.setDate(dStart.getDate() - i);
      const dEnd = new Date(dStart);
      dEnd.setHours(23, 59, 59, 999);

      let dayTotal = 0;
      let dayCount = 0;

      for (const session of allSessions) {
        const overlap = calculateSessionOverlapWithInterval(
          session.started_at,
          session.ended_at,
          dStart,
          dEnd
        );

        if (overlap > 0) {
          dayTotal += overlap;
          dayCount++;
        }
      }

      weeklyStats.push({
        date: dStart.toISOString().split('T')[0],
        dayName: dayNames[dStart.getDay()],
        totalSeconds: dayTotal,
        sessionCount: dayCount,
      });
    }

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
