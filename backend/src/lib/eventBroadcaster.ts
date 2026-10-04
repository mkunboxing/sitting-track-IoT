import type { Request, Response } from 'express';

/**
 * Real-Time Event Broadcaster for Sitting Tracker
 * ────────────────────────────────────────────────
 * Keeps a registry of active Server-Sent Events (SSE) browser responses.
 * When the NodeMCU ESP8266 or simulator calls /api/sitting/start or /api/sitting/stop,
 * this broadcaster delivers the update to all connected browser tabs in real-time (< 20ms).
 */

type ClientResponse = Response;

/** What in-process listeners (e.g. the MQTT session-state publisher) receive. */
export interface BroadcastListenerInfo {
  /** 'STATUS_CHANGE' (session open/close) or a custom type like 'POSTURE_CHANGE' */
  type: string;
  /** For STATUS_CHANGE broadcasts: the action ('start' | 'stop' | ...) */
  action?: string;
  payload?: Record<string, unknown>;
}

class EventBroadcaster {
  private clients: Set<ClientResponse> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private listeners: Set<(info: BroadcastListenerInfo) => void> = new Set();

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.pingInterval) return;
    // Send a comment ping every 15s to keep HTTP connections alive through proxies
    this.pingInterval = setInterval(() => {
      this.sendRaw(': ping\n\n');
    }, 15000);
  }

  /**
   * Register an SSE client. Writes the event-stream headers and the immediate
   * connection acknowledgment, and cleans up when the connection closes.
   */
  public addClient(req: Request, res: Response): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disables Nginx response buffering
    });
    res.flushHeaders();

    this.clients.add(res);

    // Send immediate connection acknowledgment
    this.write(
      res,
      `event: connected\ndata: {"status":"connected","timestamp":${Date.now()}}\n\n`
    );

    const onClose = () => {
      this.clients.delete(res);
    };
    req.on('close', onClose);

    return onClose;
  }

  /**
   * Register an in-process listener that is notified about every broadcast
   * (SSE clients are unaffected). Returns an unsubscribe function. Used by
   * the MQTT session-state publisher to observe session open/close/posture
   * changes from every pipeline (telemetry, session events, simulate
   * controls, /status stale auto-close) without coupling it into
   * sessionService. Listener errors never break SSE broadcasting.
   */
  public addListener(cb: (info: BroadcastListenerInfo) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notifyListeners(info: BroadcastListenerInfo): void {
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(info);
      } catch (err) {
        console.error('[SSE] Broadcast listener failed:', err);
      }
    }
  }

  /**
   * Broadcast an instant status change notification to all open web dashboard tabs
   */
  public broadcast(
    action: 'start' | 'stop' | 'heartbeat' | 'refresh',
    payload?: Record<string, unknown>
  ): void {
    this.notifyListeners({ type: 'STATUS_CHANGE', action, payload });
    const data = JSON.stringify({
      type: 'STATUS_CHANGE',
      action,
      timestamp: Date.now(),
      ...payload,
    });
    const message = `event: message\ndata: ${data}\n\n`;
    this.sendRaw(message);
  }

  /**
   * Push a lightweight custom event (e.g. live distance telemetry) to all
   * dashboard tabs WITHOUT triggering a status refetch — the payload carries
   * everything the client needs.
   */
  public broadcastEvent(type: string, payload?: Record<string, unknown>): void {
    this.notifyListeners({ type, payload });
    const data = JSON.stringify({ type, timestamp: Date.now(), ...payload });
    this.sendRaw(`event: message\ndata: ${data}\n\n`);
  }

  private write(res: ClientResponse, text: string): void {
    try {
      res.write(text);
    } catch {
      this.clients.delete(res);
    }
  }

  private sendRaw(text: string): void {
    for (const res of Array.from(this.clients)) {
      if (res.destroyed || res.writableEnded) {
        this.clients.delete(res);
        continue;
      }
      this.write(res, text);
    }
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}

export const eventBroadcaster = new EventBroadcaster();
