import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';
import { verifyDeviceToken } from '@/lib/auth';
import { eventBroadcaster } from '@/lib/eventBroadcaster';

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
    // 3. Check for existing active session (ended_at IS NULL)
    const { data: existingActive, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error('[API /sitting/start] Query error:', fetchError);
      return NextResponse.json(
        { success: false, error: fetchError.message },
        { status: 500 }
      );
    }

    // 4. Edge Case Handling: Duplicate START or NodeMCU restarted while sitting
    if (existingActive) {
      console.log(`[API /sitting/start] Active session already exists: ${existingActive.id}. Returning existing session.`);
      return NextResponse.json(
        {
          success: true,
          status: 'already_active',
          message: 'An active session is already in progress.',
          session: existingActive,
        },
        { status: 200 }
      );
    }

    // 5. Create new session with current server timestamp
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

        return NextResponse.json(
          {
            success: true,
            status: 'already_active',
            message: 'An active session was concurrently created.',
            session: fallbackActive,
          },
          { status: 200 }
        );
      }

      console.error('[API /sitting/start] Insert error:', insertError);
      return NextResponse.json(
        { success: false, error: insertError.message },
        { status: 500 }
      );
    }

    console.log(`[API /sitting/start] Started session ${newSession.id} at ${newSession.started_at}`);

    // Broadcast change immediately to all open dashboard tabs (< 20ms)
    eventBroadcaster.broadcast('start', { session: newSession });

    return NextResponse.json(
      {
        success: true,
        status: 'started',
        message: 'Sitting session started successfully.',
        session: newSession,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    console.error('[API /sitting/start] Unexpected error:', err);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
