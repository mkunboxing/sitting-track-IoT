import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabaseServer';
import { verifyDeviceToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  // 1. Verify device authorization header
  const auth = verifyDeviceToken(req);
  if (!auth.authorized) {
    return auth.errorResponse!;
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { success: false, error: 'Database not configured.' },
      { status: 503 }
    );
  }

  const supabase = getSupabaseServerClient();

  try {
    // 2. Find currently active session
    const { data: activeSession, error: fetchError } = await supabase
      .from('sitting_sessions')
      .select('id, started_at')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ success: false, error: fetchError.message }, { status: 500 });
    }

    if (!activeSession) {
      return NextResponse.json({
        success: true,
        active: false,
        message: 'No active session found.',
      });
    }

    // 3. Update heartbeat timestamp
    const nowIso = new Date().toISOString();
    await supabase
      .from('sitting_sessions')
      .update({
        last_heartbeat_at: nowIso,
      })
      .eq('id', activeSession.id);

    return NextResponse.json({
      success: true,
      active: true,
      sessionId: activeSession.id,
      timestamp: nowIso,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: 'Internal error: ' + String(err) },
      { status: 500 }
    );
  }
}
