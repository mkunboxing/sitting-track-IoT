/**
 * Service Worker & Notification Manager
 * ──────────────────────────────────────
 * Handles:
 *  - SW registration & lifecycle
 *  - Notification permission requests
 *  - Relay of SW messages to React state
 *  - Sending control messages to the SW
 */

export type SWMessageHandler = (event: MessageEvent) => void;

class NotificationManager {
  private registration: ServiceWorkerRegistration | null = null;
  private messageHandlers: SWMessageHandler[] = [];

  /**
   * Register the service worker and wire up message passing.
   * Call this once from a useEffect on the page.
   */
  public async register(): Promise<void> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      console.warn('[NotificationManager] Service workers not supported.');
      return;
    }

    try {
      const reg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none', // always fetch fresh SW
      });
      this.registration = reg;

      console.log('[NotificationManager] SW registered:', reg.scope);

      // Handle SW updates silently
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[NotificationManager] New SW version installed.');
            }
          });
        }
      });

      // Listen for messages coming from the SW
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        this.messageHandlers.forEach((handler) => handler(event));
      });
    } catch (e) {
      console.error('[NotificationManager] SW registration failed:', e);
    }
  }

  /** Request notification permission (call after user interaction) */
  public async requestPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied';
    }
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';

    const result = await Notification.requestPermission();
    return result;
  }

  /** Subscribe to messages from the SW */
  public onMessage(handler: SWMessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  /** Post a message to the active service worker */
  public postMessage(msg: Record<string, unknown>): void {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage(msg);
  }

  /** Tell the SW the initial status to avoid false-positive notifications on mount */
  public setInitialStatus(status: string): void {
    this.postMessage({ type: 'SET_PREVIOUS_STATUS', status });
  }

  /** Update the break interval in the SW */
  public setBreakInterval(minutes: number): void {
    this.postMessage({ type: 'SET_BREAK_INTERVAL', minutes });
  }

  /** Reset the break alarm in the SW (e.g. user dismissed it on the page) */
  public resetBreakAlarm(): void {
    this.postMessage({ type: 'RESET_BREAK_ALARM' });
  }

  /** Start SW background polling */
  public startPolling(): void {
    this.postMessage({ type: 'START_POLLING' });
  }

  /** Stop SW background polling */
  public stopPolling(): void {
    this.postMessage({ type: 'STOP_POLLING' });
  }

  /** Show a page-level fallback notification when SW notifications aren't available */
  public showFallbackNotification(title: string, body: string): void {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    ) {
      return;
    }
    try {
      new Notification(title, {
        body,
        icon: '/favicon.ico',
      });
    } catch {
      // Some browsers block this when called from page context — SW version preferred
    }
  }
}

export const notificationManager = new NotificationManager();
