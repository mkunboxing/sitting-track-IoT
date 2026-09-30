import { NextRequest } from 'next/server';
import { eventBroadcaster } from '@/lib/eventBroadcaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events (SSE) Route
 * ──────────────────────────────
 * Web clients connect to this endpoint via `new EventSource('/api/sitting/stream')`.
 * When NodeMCU calls POST /api/sitting/start or POST /api/sitting/stop,
 * an event is pushed through this stream immediately to all clients.
 */
export async function GET(req: NextRequest) {
  let removeClient: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      removeClient = eventBroadcaster.addClient(controller);
    },
    cancel() {
      if (removeClient) {
        removeClient();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disables Nginx response buffering
    },
  });
}
