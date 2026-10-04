'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/Header';
import { StatusCard } from '@/components/StatusCard';
import { MetricsGrid } from '@/components/MetricsGrid';
import { WeeklyChart } from '@/components/WeeklyChart';
import { SessionHistory } from '@/components/SessionHistory';
import { HardwareGuideModal } from '@/components/HardwareGuideModal';
import { ConnectDevice } from '@/components/ConnectDevice';
import { Logo } from '@/components/Logo';
import { DashboardStatsResponse } from '@/types/sitting';
import { soundManager } from '@/lib/soundUtils';
import { notificationManager } from '@/lib/notificationManager';
import { backgroundTimer } from '@/lib/backgroundTimer';
import { formatFriendlyDuration } from '@/lib/timeUtils';
import { apiUrl } from '@/lib/api';
import { AuthUser, fetchCurrentUser, logoutRequest } from '@/lib/authClient';
import { Bell, Flame, ShieldAlert, Sparkles, X, HeartPulse, Volume2, Play, Square } from 'lucide-react';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardStatsResponse | null>(null);
  const [distanceCm, setDistanceCm] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isPolling, setIsPolling] = useState<boolean>(true);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auth: persistent cookie session. The dashboard renders only for a signed-in
  // user; everyone else is redirected to /login. No automatic expiry — logout
  // is explicit (header button or manual session invalidation).
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);

  // Sound & Notification settings
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);
  const previousStatusRef = useRef<string | null>(null);
  const previousDurationRef = useRef<number>(0);
  // Coalesces overlapping background refreshes (2.5s poll + SSE-triggered
  // refetch) so two in-flight GET /status responses can't land out of order.
  // Manual refreshes always run.
  const fetchInFlightRef = useRef<boolean>(false);

  // Break Reminder settings (in minutes: 30, 45, 60 or 0 to disable)
  const [breakIntervalMin, setBreakIntervalMin] = useState<number>(45);
  const [breakAlertDismissed, setBreakAlertDismissed] = useState<boolean>(false);
  const breakAlarmPlayedRef = useRef<boolean>(false);

  // Toggle sound (persisted — survives page refresh)
  const handleToggleSound = () => {
    const nextState = !soundEnabled;
    soundManager.setEnabled(nextState);
    setSoundEnabled(nextState);
    try { window.localStorage.setItem('soundEnabled', String(nextState)); } catch { /* storage unavailable */ }
  };

  // Change the break reminder interval (persisted — survives page refresh)
  const updateBreakInterval = (mins: number) => {
    setBreakIntervalMin(mins);
    setBreakAlertDismissed(false);
    try { window.localStorage.setItem('breakIntervalMin', String(mins)); } catch { /* storage unavailable */ }
  };

  // ── Restore persisted UI settings after mount ──────────────────────────────
  // The page is statically prerendered, so localStorage can only be read
  // client-side in an effect (server-safe); defaults render for one frame.
  useEffect(() => {
    try {
      const savedBreak = window.localStorage.getItem('breakIntervalMin');
      if (savedBreak !== null && [0, 30, 45, 60].includes(Number(savedBreak))) {
        setBreakIntervalMin(Number(savedBreak));
      }
      const savedSound = window.localStorage.getItem('soundEnabled');
      if (savedSound === 'true' || savedSound === 'false') {
        const enabled = savedSound === 'true';
        setSoundEnabled(enabled);
        soundManager.setEnabled(enabled);
      }
    } catch {
      // Private mode / storage disabled — keep defaults
    }
  }, []);

  // Request notifications and unlock audio engine
  const handleEnableAlerts = async () => {
    soundManager.unlock();
    const perm = await notificationManager.requestPermission();
    setNotificationPermission(perm);
  };

  // Helper to append client timezone parameters to status API calls
  const getStatusEndpoint = useCallback(() => {
    const tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
    const tzOffset = typeof window !== 'undefined' ? new Date().getTimezoneOffset().toString() : '0';
    return {
      url: apiUrl(`/api/sitting/status?tz=${encodeURIComponent(tz)}&tzOffset=${tzOffset}`),
      headers: {
        'Cache-Control': 'no-cache',
        'x-timezone': tz,
        'x-timezone-offset': tzOffset,
      },
    };
  }, []);

  // Fetch status and metrics from server (session cookie sent automatically
  // via credentials; a 401 means the session is gone → back to /login)
  const fetchStatus = useCallback(async (isBackground = false) => {
    // Background refreshes (2.5s poll + SSE events) coalesce while one is in
    // flight; manual refreshes always run so the loading state always clears.
    if (isBackground && fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      const { url, headers } = getStatusEndpoint();
      const res = await fetch(url, {
        cache: 'no-store',
        credentials: 'include',
        headers,
      });

      if (res.status === 401) {
        window.location.replace('/login');
        throw new Error('Session expired');
      }
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const json: DashboardStatsResponse = await res.json();
      setData(json);
      setDistanceCm(typeof json.distanceCm === 'number' ? json.distanceCm : null);
      setErrorMessage(null);

      const currentStatus = json.status;
      const prevStatus = previousStatusRef.current;
      const isOccupiedStatus = (s: string | null) => s === 'RELAXING' || s === 'ATTENTIVE';

      // Detect status transitions (posture changes relaxing↔attentive do NOT
      // re-trigger the session start/stop chimes)
      if (prevStatus !== null && prevStatus !== currentStatus) {
        if (isOccupiedStatus(currentStatus) && !isOccupiedStatus(prevStatus)) {
          // 1. Play sit-down sound (plays reliably in background tabs via HTMLAudioElement)
          soundManager.playSitDown();

          // 2. Fire system notification for session start
          notificationManager.notify('🪑 Sitting Session Started', {
            body: `Ultrasonic desk sensor detected you at the desk (${currentStatus === 'RELAXING' ? 'relaxing' : 'attentive'}). Tracking has begun!`,
            tag: 'sitting-status-change',
          });

          // Reset break alarm for the new session
          setBreakAlertDismissed(false);
          breakAlarmPlayedRef.current = false;

        } else if (!isOccupiedStatus(currentStatus) && isOccupiedStatus(prevStatus)) {
          // 1. Play stand-up sound
          soundManager.playStandUp();

          // 2. Calculate duration of the session that just finished
          const durationSec = json.activeDurationSeconds || previousDurationRef.current || 0;
          const durationStr = formatFriendlyDuration(durationSec);

          // 3. Fire system notification for session stop
          notificationManager.notify('🚶 Session Ended – You Stood Up!', {
            body: durationSec > 0
              ? `You were sitting for ${durationStr}. Great work taking a break to stretch!`
              : 'Desk is now vacant. Keep moving and stay active!',
            tag: 'sitting-status-change',
          });

          // Reset break alarm
          setBreakAlertDismissed(false);
          breakAlarmPlayedRef.current = false;
        }
      }

      previousStatusRef.current = currentStatus;
      if (json.activeDurationSeconds) {
        previousDurationRef.current = json.activeDurationSeconds;
      }
    } catch (err: unknown) {
      console.error('Failed to fetch sitting status:', err);
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not reach Sitting Tracker API'
      );
    } finally {
      fetchInFlightRef.current = false;
      if (!isBackground) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial load: resolve the session, then first status fetch + listeners
  useEffect(() => {
    let ignore = false;

    // Register service worker for background OS notifications
    notificationManager.register();

    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }

    // Auto-unlock audio and permission state on user interaction
    const unlockHandler = () => {
      soundManager.unlock();
      if (typeof window !== 'undefined' && 'Notification' in window) {
        setNotificationPermission(Notification.permission);
      }
    };

    window.addEventListener('click', unlockHandler, { passive: true });
    window.addEventListener('touchstart', unlockHandler, { passive: true });
    window.addEventListener('keydown', unlockHandler, { passive: true });

    // Resolve the persistent session cookie first — no user → /login.
    // (The dashboard's data endpoints 401 without it anyway.)
    const boot = async () => {
      const me = await fetchCurrentUser();
      if (ignore) return;
      if (!me) {
        window.location.replace('/login');
        return;
      }
      setUser(me);
      setAuthChecked(true);

      // Initial status fetch (session cookie rides along)
      const endpoint = getStatusEndpoint();
      try {
        const res = await fetch(endpoint.url, {
          cache: 'no-store',
          credentials: 'include',
          headers: endpoint.headers,
        });
        if (ignore) return;
        if (res.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: DashboardStatsResponse = await res.json();
        if (!ignore) {
          setData(json);
          previousStatusRef.current = json.status;
          if (json.activeDurationSeconds) {
            previousDurationRef.current = json.activeDurationSeconds;
          }
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Connection failed');
          setIsLoading(false);
        }
      }
    };
    boot();

    return () => {
      ignore = true;
      window.removeEventListener('click', unlockHandler);
      window.removeEventListener('touchstart', unlockHandler);
      window.removeEventListener('keydown', unlockHandler);
    };
  }, []);

  // ── Real-Time Session Events (Server-Sent Events) ─────────────────────────
  // Instantly refreshes the dashboard the EXACT millisecond the device's
  // telemetry transitions the session. Live distance arrives via the 2.5s
  // poll below, not via SSE. The stream is authenticated with the session
  // cookie and only delivers this user's session events.
  useEffect(() => {
    if (!user) return;

    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connectSSE = () => {
      if (typeof window === 'undefined') return;

      try {
        es = new EventSource(apiUrl('/api/sitting/stream'), { withCredentials: true });

        es.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'POSTURE_CHANGE') {
              // Posture shifted (relaxing ↔ attentive) — refresh metrics and
              // timers instantly, without session start/stop chimes
              fetchStatus(true);
              return;
            }
            if (payload.type === 'STATUS_CHANGE') {
              console.log('[Real-Time Telemetry] Instant event received from device:', payload.action);
              // Trigger instant data refresh, audio chime, and notification (< 20ms)
              fetchStatus(true);
            }
          } catch {
            fetchStatus(true);
          }
        };

        es.onerror = () => {
          es?.close();
          // Auto-reconnect after 3 seconds if disconnected
          reconnectTimeout = setTimeout(connectSSE, 3000);
        };
      } catch (err) {
        console.warn('SSE connection failed, falling back to Web Worker polling:', err);
      }
    };

    connectSSE();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      es?.close();
    };
  }, [fetchStatus, user]);

  // Live polling: every 2.5 seconds via dedicated Web Worker — the primary
  // data channel (session, posture, stats AND the latest distance reported by
  // the device's telemetry POSTs). SSE above adds instant push for session
  // events; this poll reconciles anything missed and triggers the server's
  // stale-session auto-close check. Dedicated Web Workers bypass Chrome's
  // background tab timer throttling completely.
  useEffect(() => {
    if (!user || !isPolling) {
      backgroundTimer.stop('poll');
      return;
    }

    backgroundTimer.start('poll', 2500, () => {
      fetchStatus(true);
    });

    return () => {
      backgroundTimer.stop('poll');
    };
  }, [user, isPolling, fetchStatus]);

  // ── Live tab title ─────────────────────────────────────────────────────────
  // Shows the running session timer (or "Off") in the browser tab strip, so
  // you can glance at the time without opening the page. Driven by the Web
  // Worker because background tabs throttle normal 1s timers to 1/minute.
  // (activeSession is non-null exactly when the backend reports SITTING.)
  const activeSession = data?.activeSession ?? null;
  const titleStatusLabel = data?.status === 'RELAXING' ? 'Relaxing' : 'Sitting';
  useEffect(() => {
    const baseTitle = 'Sitting Time Tracker';

    if (!activeSession) {
      document.title = `⏸ Off · ${baseTitle}`;
      return;
    }

    const startMs = new Date(activeSession.started_at).getTime();
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      const pad = (n: number) => String(n).padStart(2, '0');
      document.title = `⏱ ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)} · ${titleStatusLabel}`;
    };

    tick();
    backgroundTimer.start('title', 1000, tick);
    return () => {
      backgroundTimer.stop('title');
      document.title = baseTitle;
    };
  }, [activeSession, titleStatusLabel]);

  // Break reminder watcher
  const activeDurationSec = data?.activeDurationSeconds ?? 0;
  const isOccupied = data?.status === 'RELAXING' || data?.status === 'ATTENTIVE';
  const breakLimitSec = breakIntervalMin * 60;
  const shouldTriggerBreak = isOccupied && breakIntervalMin > 0 && activeDurationSec >= breakLimitSec;

  useEffect(() => {
    if (shouldTriggerBreak && !breakAlarmPlayedRef.current && !breakAlertDismissed) {
      breakAlarmPlayedRef.current = true;

      // Play alert chime (works in background tabs via HTMLAudioElement)
      soundManager.playBreakReminder();

      // Fire native OS notification
      notificationManager.notify('⏰ Time for a Stretch Break!', {
        body: `You've been sitting for over ${breakIntervalMin} minutes. Take a quick stretch and drink some water.`,
        tag: 'break-reminder',
      });
    }
  }, [shouldTriggerBreak, breakAlertDismissed, breakIntervalMin]);

  // Simulator / manual action handler (authenticated; the session is owned by
  // the logged-in user)
  const handleSimulate = async (action: 'start' | 'stop' | 'relax' | 'focus') => {
    setSimulating(true);
    try {
      const res = await fetch(apiUrl('/api/sitting/simulate'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (res.status === 401) {
        window.location.replace('/login');
        return;
      }

      const resJson = await res.json();
      if (!res.ok || !resJson.success) {
        alert(`Action error: ${resJson.error || 'Failed action'}`);
      } else {
        await fetchStatus(false);
      }
    } catch (err: unknown) {
      alert(`Action failed: ${String(err)}`);
    } finally {
      setSimulating(false);
    }
  };

  // Logout: invalidates the server-side session, clears the cookie, then a
  // full navigation back to the login page
  const handleLogout = async () => {
    await logoutRequest();
    window.location.assign('/login');
  };

  // Session resolution: show a minimal splash until the auth check lands —
  // avoids flashing the full dashboard just before a redirect to /login
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app text-ink">
        <Logo size="md" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-app text-ink">
      {/* Header with live sync, notification permission & sound controls */}
      <Header
        isPolling={isPolling}
        setIsPolling={setIsPolling}
        isLoading={isLoading}
        onRefresh={() => fetchStatus(false)}
        lastUpdated={data?.lastUpdated || ''}
        onOpenHardwareGuide={() => setShowHardwareGuide(true)}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
        notificationPermission={notificationPermission}
        onRequestNotificationPermission={handleEnableAlerts}
        username={user?.username ?? null}
        onLogout={handleLogout}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Enable background alerts banner if notification permission is not yet granted */}
        {notificationPermission !== 'granted' && !bannerDismissed && (
          <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-transparent border border-emerald-500/30 flex items-center justify-between gap-4 shadow-lg shadow-emerald-500/5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-emerald-500/20 text-acc-emerald-soft shrink-0">
                <Bell className="w-5 h-5 animate-bounce" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-acc-emerald-strong">
                  Enable Background Audio &amp; System Notifications
                </h4>
                <p className="text-xs text-ink4 mt-0.5">
                  Allow browser notifications so you hear sound chimes and get alerts when sitting starts, stops, or when it's time for a stretch break even while browsing other tabs.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleEnableAlerts}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs transition-colors shadow active:scale-[0.96]"
              >
                Allow Alerts
              </button>
              <button
                type="button"
                onClick={() => setBannerDismissed(true)}
                className="p-1.5 rounded-lg text-ink4 hover:text-ink-bright hover:bg-chip transition-colors"
                title="Dismiss banner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Error notification banner if any */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-acc-rose-soft text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-acc-rose shrink-0" />
              <span>Unable to sync live telemetry: {errorMessage}</span>
            </div>
            <button
              onClick={() => fetchStatus(false)}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-acc-rose-strong font-medium active:scale-[0.96]"
            >
              Retry
            </button>
          </div>
        )}

        {/* Ergonomic Break Alert Banner (Triggers after sitting duration exceeds threshold) */}
        {shouldTriggerBreak && !breakAlertDismissed && (
          <div className="relative overflow-hidden p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-amber-500/20 via-orange-500/15 to-amber-500/10 border border-amber-500/40 text-acc-amber-strong shadow-xl shadow-amber-500/5 animate-pulse">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/20 text-acc-amber-soft shrink-0">
                  <Flame className="w-6 h-6 animate-bounce" />
                </div>
                <div>
                  <h4 className="text-sm sm:text-base font-bold text-acc-amber-strong flex items-center gap-2">
                    Time for a Stretch Break!
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-400/20 text-acc-amber-soft border border-amber-400/30">
                      {Math.floor(activeDurationSec / 60)}m Sitting
                    </span>
                  </h4>
                  <p className="text-xs text-acc-amber-strong/90 mt-0.5">
                    You have reached your {breakIntervalMin}-minute target. Stand up, take a walk, hydrate, and relax your eyes for 2-3 minutes.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleSimulate('stop')}
                  className="px-3 py-1.5 rounded-xl bg-amber-500 text-zinc-950 font-bold text-xs hover:bg-amber-400 transition-colors shadow active:scale-[0.96]"
                >
                  I Stood Up
                </button>
                <button
                  type="button"
                  onClick={() => setBreakAlertDismissed(true)}
                  className="p-1.5 rounded-lg text-acc-amber hover:text-ink-bright hover:bg-amber-500/20 transition-colors"
                  title="Dismiss alert"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 1. Hero Status Card (Live Sitting State, Stopwatch & Module Off controls) */}
        <StatusCard
          status={data?.status ?? 'AWAY'}
          activeSession={data?.activeSession ?? null}
          onSimulate={handleSimulate}
          simulating={simulating}
          configured={data?.configured ?? true}
          distanceCm={distanceCm}
        />

        {/* Break Target & Ergonomics Quick Selector */}
        <div className="p-4 rounded-2xl bg-panel/40 border border-edge/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-ink3 font-medium">
            <Bell className="w-4 h-4 text-acc-emerald" />
            <span>Ergonomic Break Reminder:</span>
            <span className="text-ink5 hidden sm:inline">• Alert sound and visual toast when threshold reached</span>
          </div>

          <div className="flex items-center gap-1.5">
            {[30, 45, 60].map((mins) => (
              <button
                key={mins}
                type="button"
                onClick={() => updateBreakInterval(mins)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all active:scale-[0.96] ${
                  breakIntervalMin === mins
                    ? 'bg-emerald-500/20 text-acc-emerald-soft border-emerald-500/40 shadow-sm'
                    : 'bg-chip/60 text-ink4 border-edge-strong/60 hover:text-ink2'
                }`}
              >
                Every {mins}m
              </button>
            ))}
            <button
              type="button"
              onClick={() => updateBreakInterval(0)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all active:scale-[0.96] ${
                breakIntervalMin === 0
                  ? 'bg-edge-strong text-ink2 border-chip-strong'
                  : 'bg-chip/60 text-ink5 border-edge-strong/60 hover:text-ink3'
              }`}
            >
              Off
            </button>
          </div>
        </div>

        {/* 2. Key Metrics Grid (2 columns on mobile, 6 columns on desktop) */}
        <MetricsGrid
          todayTotalSeconds={data?.todayTotalSeconds ?? 0}
          activeDurationSeconds={data?.activeDurationSeconds ?? 0}
          isOccupied={isOccupied}
          currentPosture={data?.status ?? 'AWAY'}
          todaySessionCount={data?.todaySessionCount ?? 0}
          todayLongestSessionSeconds={data?.todayLongestSessionSeconds ?? 0}
          todayRelaxSeconds={data?.todayRelaxSeconds ?? 0}
          todayAttentiveSeconds={data?.todayAttentiveSeconds ?? 0}
        />

        {/* 3. Analytics & Historical Logs (Chart + Scrollable Table) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8 items-start">
          {/* Weekly Statistics Visual Bar Chart */}
          <WeeklyChart weeklyStats={data?.weeklyStats ?? []} />

          {/* Today's Session History Log (with max-height and custom scrollbar) */}
          <SessionHistory sessions={data?.todaySessions ?? []} />
        </div>

        {/* 4. Connected Arduino devices ("Connect Device") — sitting data is
            only tracked/shown for devices linked to this account */}
        <ConnectDevice />

        {/* 5. Ergonomics & Desk Health Advice Widget */}
        <div className="p-5 rounded-2xl border border-edge/80 bg-gradient-to-br from-panel/60 via-panel/40 to-app text-xs text-ink4 space-y-3">
          <div className="flex items-center gap-2 text-ink2 font-semibold text-sm">
            <HeartPulse className="w-4 h-4 text-acc-emerald" />
            <span>Ergonomics &amp; Health Best Practices</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-acc-emerald border border-emerald-500/20 ml-auto hidden sm:inline">
              <Sparkles className="w-3 h-3 inline mr-1" />
              Pro Tips
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-ink3">
            <div className="p-3 rounded-xl bg-well/60 border border-edge/60">
              <p className="font-semibold text-ink-bright mb-1">👀 20-20-20 Rule</p>
              <p className="text-[11px] text-ink4 leading-relaxed">
                Every 20 minutes, gaze at an object 20 feet away for at least 20 seconds to prevent digital eye strain.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-well/60 border border-edge/60">
              <p className="font-semibold text-ink-bright mb-1">🧍 Stand Up Cadence</p>
              <p className="text-[11px] text-ink4 leading-relaxed">
                Stand up and stretch for 2 minutes after every 45–60 minutes of sitting to boost circulation and metabolism.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-well/60 border border-edge/60">
              <p className="font-semibold text-ink-bright mb-1">🪑 Posture Check</p>
              <p className="text-[11px] text-ink4 leading-relaxed">
                Keep feet flat on the floor, elbows at 90°, and your top of the screen at eye level.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-edge bg-app py-6 text-xs text-ink5">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Logo size="xs" animated={false} />
            <p className="font-medium text-ink4">
              Sitting Time Tracker <span className="text-ink6">•</span> NodeMCU ESP8266 + HC-SR04 IoT Telemetry
            </p>
          </div>
          {/* Dev simulate controls — tucked in the footer, out of the main dashboard */}
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink6 mr-1">
                Simulate
              </span>
              <button
                type="button"
                onClick={() => handleSimulate('start')}
                disabled={simulating || isOccupied}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-panel text-ink4 border border-edge hover:bg-chip hover:text-ink2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors active:scale-[0.96]"
                title="Simulate a device telemetry POST with state attentive"
              >
                <Play className="w-3 h-3" />
                <span>Sit Down</span>
              </button>
              <button
                type="button"
                onClick={() => handleSimulate('stop')}
                disabled={simulating || !isOccupied}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-panel text-ink4 border border-edge hover:bg-chip hover:text-ink2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors active:scale-[0.96]"
                title="Simulate a device telemetry POST with state vacant"
              >
                <Square className="w-3 h-3" />
                <span>Stand Up</span>
              </button>
            </div>
            <p className="font-mono text-[11px] text-ink6">
              Background Web Worker Active • Live Telemetry 2.5s • Audio Enabled
            </p>
          </div>
        </div>
      </footer>

      {/* Hardware Guide & Testing Modal */}
      <HardwareGuideModal
        isOpen={showHardwareGuide}
        onClose={() => setShowHardwareGuide(false)}
      />
    </div>
  );
}
