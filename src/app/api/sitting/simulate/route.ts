import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';

/**
 * Development / Testing helper endpoint:
 * Allows triggering START or STOP directly from the dashboard controls for instant testing.
 */
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local',
      },
      { status: 503 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action !== 'start' && action !== 'stop') {
      return NextResponse.json(
        { success: false, error: 'Invalid action. Expected "start" or "stop"' },
        { status: 400 }
      );
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
        return NextResponse.json({
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
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        status: 'started',
        message: 'Simulated sitting session started.',
        session: newSession,
      });
    }

    if (action === 'stop') {
      const { data: activeSession } = await supabase
        .from('sitting_sessions')
        .select('*')
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!activeSession) {
        return NextResponse.json({
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
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        status: 'stopped',
        message: 'Simulated sitting session ended.',
        session: updatedSession,
      });
    }
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: 'Internal server error: ' + String(err) },
      { status: 500 }
    );
  }
}
