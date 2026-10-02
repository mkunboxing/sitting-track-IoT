/**
 * Service Worker & Native Notification Manager
 * ─────────────────────────────────────────────
 * Provides reliable native system notifications for session events:
 *  - Sitting started (HC-SR04 detected occupant)
 *  - Session stopped / user stood up (with session duration)
 *  - Ergonomic break reminder alerts
 */

class NotificationManager {
  private registration: ServiceWorkerRegistration | null = null;

  public async register(): Promise<void> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    try {
      const reg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      this.registration = reg;
    } catch (e) {
      console.warn('Service Worker registration skipped or failed:', e);
    }
  }

  public async requestPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied';
    }
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';

    try {
      const result = await Notification.requestPermission();
      return result;
    } catch {
      return 'default';
    }
  }

  public getPermission(): NotificationPermission {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
    return Notification.permission;
  }

  /**
   * Display native OS notification with fallback.
   * Service worker showNotification is prioritized because it displays consistently
   * in background tabs in Chrome/macOS.
   */
  public async notify(title: string, options?: {
    body?: string;
    tag?: string;
    icon?: string;
    renotify?: boolean;
    requireInteraction?: boolean;
  }): Promise<void> {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const payload = {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      vibrate: [200, 100, 200],
      renotify: true,
      ...options,
    };

    // 1. Try Service Worker showNotification first
    try {
      if (this.registration && 'showNotification' in this.registration) {
        await this.registration.showNotification(title, payload);
        return;
      }
      if ('serviceWorker' in navigator) {
        const readyReg = await navigator.serviceWorker.ready;
        if (readyReg) {
          this.registration = readyReg;
          await readyReg.showNotification(title, payload);
          return;
        }
      }
    } catch (e) {
      console.warn('SW showNotification error, falling back to window Notification:', e);
    }

    // 2. Fallback to Window Notification constructor
    try {
      new Notification(title, payload);
    } catch (e) {
      console.warn('Window Notification failed:', e);
    }
  }
}

export const notificationManager = new NotificationManager();
