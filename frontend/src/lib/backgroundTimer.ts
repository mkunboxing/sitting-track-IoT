/**
 * Background Timer Utility using Dedicated Web Worker
 * ──────────────────────────────────────────────────
 * Why this is needed:
 * Chrome aggressively throttles window.setInterval / window.setTimeout to 1 tick
 * per minute when a tab is in the background or minimized.
 * However, dedicated Web Workers run in a background OS thread and are NOT
 * throttled by Chrome's background tab timers.
 * 
 * This ensures the tracker checks telemetry every 4-5 seconds like clockwork,
 * even if the user is on other tabs, playing games, or in other applications.
 */

type TickCallback = () => void;

class BackgroundTimer {
  private worker: Worker | null = null;
  private callback: TickCallback | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;

    try {
      // Inline worker blob code - zero network dependency, loads instantly
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (!e.data) return;
          if (e.data.action === 'start') {
            if (timer) clearInterval(timer);
            const interval = e.data.interval || 4000;
            timer = setInterval(function() {
              self.postMessage('tick');
            }, interval);
          } else if (e.data.action === 'stop') {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl);

      this.worker.onmessage = (e) => {
        if (e.data === 'tick' && this.callback) {
          this.callback();
        }
      };

      this.worker.onerror = (err) => {
        console.warn('BackgroundTimer worker error:', err);
      };
    } catch (e) {
      console.warn('Web Worker initialization failed, will use window timer fallback:', e);
    }
  }

  public start(intervalMs: number, onTick: TickCallback): void {
    this.callback = onTick;

    if (this.worker) {
      this.worker.postMessage({ action: 'start', interval: intervalMs });
    } else {
      // Fallback if workers are blocked
      if (this.fallbackInterval) clearInterval(this.fallbackInterval);
      this.fallbackInterval = setInterval(onTick, intervalMs);
    }
  }

  public stop(): void {
    if (this.worker) {
      this.worker.postMessage({ action: 'stop' });
    }
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
  }
}

export const backgroundTimer = new BackgroundTimer();
