/**
 * Real-Time Event Broadcaster for Sitting Tracker
 * ────────────────────────────────────────────────
 * Keeps a registry of active Server-Sent Events (SSE) browser streams.
 * When the NodeMCU ESP8266 or simulator calls /api/sitting/start or /api/sitting/stop,
 * this broadcaster delivers the update to all connected browser tabs in real-time (< 20ms).
 */

type ClientStreamController = ReadableStreamDefaultController<Uint8Array>;

class EventBroadcaster {
  private clients: Set<ClientStreamController> = new Set();
  private encoder = new TextEncoder();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.pingInterval) return;
    // Send a comment ping every 15s to keep HTTP connections alive through proxies / Vercel
    this.pingInterval = setInterval(() => {
      this.sendRaw(': ping\n\n');
    }, 15000);
  }

  public addClient(controller: ClientStreamController): () => void {
    this.clients.add(controller);

    // Send immediate connection acknowledgment
    try {
      const initMsg = this.encoder.encode(
        `event: connected\ndata: {"status":"connected","timestamp":${Date.now()}}\n\n`
      );
      controller.enqueue(initMsg);
    } catch {
      this.clients.delete(controller);
    }

    return () => {
      this.clients.delete(controller);
    };
  }

  /**
   * Broadcast an instant status change notification to all open web dashboard tabs
   */
  public broadcast(
    action: 'start' | 'stop' | 'heartbeat' | 'refresh',
    payload?: Record<string, unknown>
  ): void {
    const data = JSON.stringify({
      type: 'STATUS_CHANGE',
      action,
      timestamp: Date.now(),
      ...payload,
    });
    const message = `event: message\ndata: ${data}\n\n`;
    this.sendRaw(message);
  }

  private sendRaw(text: string): void {
    const encoded = this.encoder.encode(text);
    for (const controller of Array.from(this.clients)) {
      try {
        controller.enqueue(encoded);
      } catch {
        this.clients.delete(controller);
      }
    }
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}

// Global singleton to ensure single broadcaster instance in Node.js runtime
declare global {
  var __sittingEventBroadcaster: EventBroadcaster | undefined;
}

export const eventBroadcaster: EventBroadcaster =
  globalThis.__sittingEventBroadcaster ||
  (globalThis.__sittingEventBroadcaster = new EventBroadcaster());
