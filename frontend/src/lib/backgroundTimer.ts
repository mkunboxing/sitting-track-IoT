/**
 * Background Timer Utility using Dedicated Web Worker
 * ──────────────────────────────────────────────────
 * Why this is needed:
 * Chrome aggressively throttles window.setInterval / window.setTimeout to 1 tick
 * per minute when a tab is in the background or minimized.
 * However, dedicated Web Workers run in a background OS thread and are NOT
 * throttled by Chrome's background tab timers.
 *
 * This ensures time-sensitive updates (telemetry polling, the live tab-title
 * timer) keep ticking like clockwork even if the user is on other tabs,
 * playing games, or in other applications.
 *
 * Supports multiple named timers — call start(name, intervalMs, onTick) and
 * stop(name).
 */

type TickCallback = () => void;

class BackgroundTimer {
  private worker: Worker | null = null;
  private callbacks = new Map<string, TickCallback>();
  private fallbackIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor() {
    if (typeof window === 'undefined') return;

    try {
      // Inline worker blob code - zero network dependency, loads instantly
      const workerCode = `
        let timers = {};
        self.onmessage = function(e) {
          if (!e.data) return;
          if (e.data.action === 'start') {
            const name = e.data.name;
            if (timers[name]) clearInterval(timers[name]);
            timers[name] = setInterval(function() {
              self.postMessage({ name: name });
            }, e.data.interval || 4000);
          } else if (e.data.action === 'stop') {
            const name = e.data.name;
            if (timers[name]) {
              clearInterval(timers[name]);
              delete timers[name];
            }
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl);

      this.worker.onmessage = (e) => {
        const name = e.data?.name;
        const callback = name ? this.callbacks.get(name) : undefined;
        if (callback) callback();
      };

      this.worker.onerror = (err) => {
        console.warn('BackgroundTimer worker error:', err);
      };
    } catch (e) {
      console.warn('Web Worker initialization failed, will use window timer fallback:', e);
    }
  }

  public start(name: string, intervalMs: number, onTick: TickCallback): void {
    this.callbacks.set(name, onTick);

    if (this.worker) {
      this.worker.postMessage({ action: 'start', name, interval: intervalMs });
    } else {
      // Fallback if workers are blocked
      const existing = this.fallbackIntervals.get(name);
      if (existing) clearInterval(existing);
      this.fallbackIntervals.set(name, setInterval(onTick, intervalMs));
    }
  }

  public stop(name: string): void {
    this.callbacks.delete(name);
    if (this.worker) {
      this.worker.postMessage({ action: 'stop', name });
    }
    const fallback = this.fallbackIntervals.get(name);
    if (fallback) {
      clearInterval(fallback);
      this.fallbackIntervals.delete(name);
    }
  }
}

export const backgroundTimer = new BackgroundTimer();
