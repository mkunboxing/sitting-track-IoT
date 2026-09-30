/**
 * Sitting Tracker – Background Service Worker
 * ─────────────────────────────────────────────
 * Responsibilities:
 *  1. Poll /api/sitting/status every 6 seconds regardless of tab visibility
 *  2. Fire native showNotification() on state transitions (SITTING / AWAY / BREAK)
 *  3. Post messages to the controlled page so it can play Web Audio sounds
 *
 * Service Workers are NOT throttled by Chrome when the tab is in the background,
 * making this the correct place for background polling + notifications.
 */

const POLL_INTERVAL_MS = 6000;
const BREAK_REMINDER_KEY = 'breakIntervalMin'; // stored in SW via message

let previousStatus = null;       // 'SITTING' | 'AWAY' | null
let pollTimer = null;
let breakIntervalMin = 45;       // default; page sends update via message
let breakAlarmFired = false;
let activeDurationSeconds = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if at least one app tab is currently focused/visible */
async function isAnyTabFocused() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((c) => c.focused);
}

async function postToClients(payload) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(payload);
  }
}

async function showSWNotification(title, body, tag, icon = '/favicon.ico') {
  if (self.Notification && self.Notification.permission === 'granted') {
    try {
      await self.registration.showNotification(title, {
        body,
        icon,
        tag,                 // de-dupes: same tag replaces previous
        renotify: true,
        vibrate: [200, 100, 200],
        requireInteraction: false,
      });
    } catch (e) {
      console.warn('[SW] showNotification failed:', e);
    }
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollStatus() {
  try {
    // Use the page's origin so it works both locally and on Vercel
    const res = await fetch('/api/sitting/status', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });

    if (!res.ok) return;

    const json = await res.json();
    const newStatus = json.status; // 'SITTING' | 'AWAY'
    activeDurationSeconds = json.activeDurationSeconds ?? 0;

    // ── State transition handling ────────────────────────────────────────────
    if (previousStatus !== null && previousStatus !== newStatus) {
      // Only post PLAY_SOUND when no tab is focused (page plays sound when visible)
      const tabFocused = await isAnyTabFocused();

      if (newStatus === 'SITTING') {
        // Session started
        await showSWNotification(
          '\uD83E\uDE91 Sitting Session Started',
          `Your desk session has begun. Stay ergonomic!`,
          'status-sitting'
        );
        if (!tabFocused) {
          await postToClients({ type: 'PLAY_SOUND', sound: 'sitDown' });
        }

        // Reset break alarm tracking on new session
        breakAlarmFired = false;

      } else if (newStatus === 'AWAY') {
        // Session ended / user stood up
        const durationText = formatSeconds(activeDurationSeconds);
        await showSWNotification(
          '\uD83D\uDEB6 Session Ended \u2013 You Stood Up!',
          `Great job! You were sitting for ${durationText}. Keep moving!`,
          'status-away'
        );
        if (!tabFocused) {
          await postToClients({ type: 'PLAY_SOUND', sound: 'standUp' });
        }

        // Reset break alarm for next session
        breakAlarmFired = false;
      }
    }

    previousStatus = newStatus;

    // ── Break reminder (only while SITTING) ─────────────────────────────────
    if (
      newStatus === 'SITTING' &&
      breakIntervalMin > 0 &&
      activeDurationSeconds >= breakIntervalMin * 60 &&
      !breakAlarmFired
    ) {
      breakAlarmFired = true;
      await showSWNotification(
        '\u23F0 Time for a Stretch Break!',
        `You've been sitting for over ${breakIntervalMin} minutes. Stand up, stretch, and hydrate!`,
        'break-reminder'
      );
      // Always post to clients for break reminder (sound + UI update)
      await postToClients({ type: 'PLAY_SOUND', sound: 'breakReminder' });
    }

    // Reset break alarm when user has just stood up (handled above in AWAY branch)
    // Also reset when activeDurationSeconds drops back near 0 (new session detected)
    if (newStatus === 'AWAY') {
      breakAlarmFired = false;
    }

    // Forward full data to page so it can update UI even when in background
    await postToClients({ type: 'STATUS_UPDATE', data: json });

  } catch (e) {
    // Network error – silently ignore (retry next cycle)
    console.warn('[SW] Poll error:', e);
  }
}

function formatSeconds(sec) {
  if (!sec || sec <= 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function startPolling() {
  if (pollTimer) return; // already running
  pollStatus(); // immediate first call
  pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Lifecycle Events ─────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[SW] Installing sitting tracker service worker');
  self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activated');
  event.waitUntil(self.clients.claim()); // take control of existing tabs
  startPolling();
});

// ─── Message Handler (from page) ─────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'START_POLLING':
      startPolling();
      break;

    case 'STOP_POLLING':
      stopPolling();
      break;

    case 'SET_BREAK_INTERVAL':
      // Page sends updated break interval minutes
      breakIntervalMin = typeof msg.minutes === 'number' ? msg.minutes : 45;
      // Reset alarm if interval changed
      breakAlarmFired = false;
      break;

    case 'RESET_BREAK_ALARM':
      breakAlarmFired = false;
      break;

    case 'SET_PREVIOUS_STATUS':
      // Page sends its known status to avoid false-positive alerts on SW startup
      previousStatus = msg.status;
      break;

    default:
      break;
  }
});

// ─── Notification Click ───────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Focus the app tab if it's already open, otherwise open it
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            return client.focus();
          }
        }
        // No existing tab – open one
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
      })
  );
});
