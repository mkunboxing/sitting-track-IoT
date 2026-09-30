import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';
import { verifyDeviceToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  // 1. Verify device authorization header
  const auth = verifyDeviceToken(req);
  if (!auth.authorized) {
    return auth.errorResponse!;
  }

  // 2. Check Supabase configuration
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      },
      { status: 503 }
    );
  }

  const supabase = getSupabaseServerClient();

  try {
    // 3. Find the currently active session (ended_at IS NULL)
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error('[API /sitting/stop] Query error:', fetchError);
      return NextResponse.json(
        { success: false, error: fetchError.message },
        { status: 500 }
      );
    }

    // 4. Edge Case Handling: Duplicate STOP or STOP received without an active session
    if (!activeSession) {
      console.log('[API /sitting/stop] No active session found. Ignoring duplicate stop.');
      return NextResponse.json(
        {
          success: true,
          status: 'no_active_session',
          message: 'No active session was in progress. Nothing to stop.',
        },
        { status: 200 }
      );
    }

    // 5. Server is the source of truth for timestamps:
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
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 500 }
      );
    }

    console.log(
      `[API /sitting/stop] Stopped session ${updatedSession.id}. Duration: ${durationSeconds} seconds.`
    );

    return NextResponse.json(
      {
        success: true,
        status: 'stopped',
        message: 'Sitting session stopped successfully.',
        session: updatedSession,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error('[API /sitting/stop] Unexpected error:', err);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
