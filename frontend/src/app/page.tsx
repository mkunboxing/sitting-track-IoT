'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/Header';
import { StatusCard } from '@/components/StatusCard';
import { MetricsGrid } from '@/components/MetricsGrid';
import { WeeklyChart } from '@/components/WeeklyChart';
import { SessionHistory } from '@/components/SessionHistory';
import { HardwareGuideModal } from '@/components/HardwareGuideModal';
import { Logo } from '@/components/Logo';
import { DashboardStatsResponse } from '@/types/sitting';
import { soundManager } from '@/lib/soundUtils';
import { notificationManager } from '@/lib/notificationManager';
import { backgroundTimer } from '@/lib/backgroundTimer';
import { formatFriendlyDuration } from '@/lib/timeUtils';
import { apiUrl } from '@/lib/api';
import { Bell, Flame, ShieldAlert, Sparkles, X, HeartPulse, Volume2 } from 'lucide-react';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardStatsResponse | null>(null);
  const [distanceCm, setDistanceCm] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isPolling, setIsPolling] = useState<boolean>(true);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sound & Notification settings
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);
  const previousStatusRef = useRef<string | null>(null);
  const previousDurationRef = useRef<number>(0);

  // Break Reminder settings (in minutes: 30, 45, 60 or 0 to disable)
  const [breakIntervalMin, setBreakIntervalMin] = useState<number>(45);
  const [breakAlertDismissed, setBreakAlertDismissed] = useState<boolean>(false);
  const breakAlarmPlayedRef = useRef<boolean>(false);

  // Toggle sound
  const handleToggleSound = () => {
    const nextState = !soundEnabled;
    soundManager.setEnabled(nextState);
    setSoundEnabled(nextState);
  };

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

  // Fetch status and metrics from server
  const fetchStatus = useCallback(async (isBackground = false) => {
    try {
      const { url, headers } = getStatusEndpoint();
      const res = await fetch(url, {
        cache: 'no-store',
        headers,
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const json: DashboardStatsResponse = await res.json();
      setData(json);
      setDistanceCm(typeof json.distanceCm === 'number' ? json.distanceCm : null);
      setErrorMessage(null);

      const currentStatus = json.status;
      const prevStatus = previousStatusRef.current;

      // Detect status transitions
      if (prevStatus !== null && prevStatus !== currentStatus) {
        if (currentStatus === 'SITTING') {
          // 1. Play sit-down sound (plays reliably in background tabs via HTMLAudioElement)
          soundManager.playSitDown();

          // 2. Fire system notification for session start
          notificationManager.notify('🪑 Sitting Session Started', {
            body: 'Ultrasonic desk sensor detected you sitting down. Tracking has begun!',
            tag: 'sitting-status-change',
          });

          // Reset break alarm for the new session
          setBreakAlertDismissed(false);
          breakAlarmPlayedRef.current = false;

        } else if (currentStatus === 'AWAY') {
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
      if (!isBackground) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial load & setup listeners
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

    // Initial status fetch
    const endpoint = getStatusEndpoint();
    fetch(endpoint.url, { cache: 'no-store', headers: endpoint.headers })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: DashboardStatsResponse) => {
        if (!ignore) {
          setData(json);
          previousStatusRef.current = json.status;
          if (json.activeDurationSeconds) {
            previousDurationRef.current = json.activeDurationSeconds;
          }
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Connection failed');
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
      window.removeEventListener('click', unlockHandler);
      window.removeEventListener('touchstart', unlockHandler);
      window.removeEventListener('keydown', unlockHandler);
    };
  }, []);

  // ── Real-Time Live Push Stream (Server-Sent Events) ───────────────────────
  // Instantly refreshes the dashboard the EXACT millisecond the NodeMCU calls
  // POST /api/sitting/start or POST /api/sitting/stop.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connectSSE = () => {
      if (typeof window === 'undefined') return;

      try {
        es = new EventSource(apiUrl('/api/sitting/stream'));

        es.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'DISTANCE') {
              // Lightweight telemetry push — no status refetch needed
              setDistanceCm(typeof payload.distanceCm === 'number' ? payload.distanceCm : null);
              return;
            }
            if (payload.type === 'STATUS_CHANGE') {
              console.log('[Real-Time Telemetry] Instant event received from NodeMCU:', payload.action);
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
  }, [fetchStatus]);

  // Background polling: runs every 30 seconds via dedicated Web Worker as a
  // safety net. Real-time updates arrive instantly over SSE (device events AND
  // live distance); this slow poll only reconciles the UI if SSE silently died
  // and triggers the server's stale-session auto-close check. Dedicated Web
  // Workers bypass Chrome's background tab timer throttling completely.
  useEffect(() => {
    if (!isPolling) {
      backgroundTimer.stop();
      return;
    }

    backgroundTimer.start(30000, () => {
      fetchStatus(true);
    });

    return () => {
      backgroundTimer.stop();
    };
  }, [isPolling, fetchStatus]);

  // Break reminder watcher
  const activeDurationSec = data?.activeDurationSeconds ?? 0;
  const isSitting = data?.status === 'SITTING';
  const breakLimitSec = breakIntervalMin * 60;
  const shouldTriggerBreak = isSitting && breakIntervalMin > 0 && activeDurationSec >= breakLimitSec;

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

  // Simulator / manual action handler
  const handleSimulate = async (action: 'start' | 'stop') => {
    setSimulating(true);
    try {
      const res = await fetch(apiUrl('/api/sitting/simulate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

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

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
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
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Enable background alerts banner if notification permission is not yet granted */}
        {notificationPermission !== 'granted' && !bannerDismissed && (
          <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-transparent border border-emerald-500/30 flex items-center justify-between gap-4 shadow-lg shadow-emerald-500/5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 shrink-0">
                <Bell className="w-5 h-5 animate-bounce" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-emerald-200">
                  Enable Background Audio &amp; System Notifications
                </h4>
                <p className="text-xs text-zinc-400 mt-0.5">
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
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                title="Dismiss banner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Error notification banner if any */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              <span>Unable to sync live telemetry: {errorMessage}</span>
            </div>
            <button
              onClick={() => fetchStatus(false)}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-medium active:scale-[0.96]"
            >
              Retry
            </button>
          </div>
        )}

        {/* Ergonomic Break Alert Banner (Triggers after sitting duration exceeds threshold) */}
        {shouldTriggerBreak && !breakAlertDismissed && (
          <div className="relative overflow-hidden p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-amber-500/20 via-orange-500/15 to-amber-500/10 border border-amber-500/40 text-amber-200 shadow-xl shadow-amber-500/5 animate-pulse">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/20 text-amber-300 shrink-0">
                  <Flame className="w-6 h-6 animate-bounce" />
                </div>
                <div>
                  <h4 className="text-sm sm:text-base font-bold text-amber-100 flex items-center gap-2">
                    Time for a Stretch Break!
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/30">
                      {Math.floor(activeDurationSec / 60)}m Sitting
                    </span>
                  </h4>
                  <p className="text-xs text-amber-200/90 mt-0.5">
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
                  className="p-1.5 rounded-lg text-amber-400 hover:text-white hover:bg-amber-500/20 transition-colors"
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
        <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-zinc-300 font-medium">
            <Bell className="w-4 h-4 text-emerald-400" />
            <span>Ergonomic Break Reminder:</span>
            <span className="text-zinc-500 hidden sm:inline">• Alert sound and visual toast when threshold reached</span>
          </div>

          <div className="flex items-center gap-1.5">
            {[30, 45, 60].map((mins) => (
              <button
                key={mins}
                type="button"
                onClick={() => {
                  setBreakIntervalMin(mins);
                  setBreakAlertDismissed(false);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all active:scale-[0.96] ${
                  breakIntervalMin === mins
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-sm'
                    : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/60 hover:text-zinc-200'
                }`}
              >
                Every {mins}m
              </button>
            ))}
            <button
              type="button"
              onClick={() => setBreakIntervalMin(0)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all active:scale-[0.96] ${
                breakIntervalMin === 0
                  ? 'bg-zinc-700 text-zinc-200 border-zinc-600'
                  : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:text-zinc-300'
              }`}
            >
              Off
            </button>
          </div>
        </div>

        {/* 2. Key Metrics Grid (2 columns on mobile, 4 columns on desktop) */}
        <MetricsGrid
          todayTotalSeconds={data?.todayTotalSeconds ?? 0}
          activeDurationSeconds={data?.activeDurationSeconds ?? 0}
          isSitting={isSitting}
          todaySessionCount={data?.todaySessionCount ?? 0}
          todayLongestSessionSeconds={data?.todayLongestSessionSeconds ?? 0}
        />

        {/* 3. Analytics & Historical Logs (Chart + Scrollable Table) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8 items-start">
          {/* Weekly Statistics Visual Bar Chart */}
          <WeeklyChart weeklyStats={data?.weeklyStats ?? []} />

          {/* Today's Session History Log (with max-height and custom scrollbar) */}
          <SessionHistory sessions={data?.todaySessions ?? []} />
        </div>

        {/* 4. Ergonomics & Desk Health Advice Widget */}
        <div className="p-5 rounded-2xl border border-zinc-800/80 bg-gradient-to-br from-zinc-900/60 via-zinc-900/40 to-zinc-950 text-xs text-zinc-400 space-y-3">
          <div className="flex items-center gap-2 text-zinc-200 font-semibold text-sm">
            <HeartPulse className="w-4 h-4 text-emerald-400" />
            <span>Ergonomics &amp; Health Best Practices</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 ml-auto hidden sm:inline">
              <Sparkles className="w-3 h-3 inline mr-1" />
              Pro Tips
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-zinc-300">
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <p className="font-semibold text-white mb-1">👀 20-20-20 Rule</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Every 20 minutes, gaze at an object 20 feet away for at least 20 seconds to prevent digital eye strain.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <p className="font-semibold text-white mb-1">🧍 Stand Up Cadence</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Stand up and stretch for 2 minutes after every 45–60 minutes of sitting to boost circulation and metabolism.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <p className="font-semibold text-white mb-1">🪑 Posture Check</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Keep feet flat on the floor, elbows at 90°, and your top of the screen at eye level.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-zinc-950 py-6 text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Logo size="xs" animated={false} />
            <p className="font-medium text-zinc-400">
              Sitting Time Tracker <span className="text-zinc-600">•</span> NodeMCU ESP8266 + HC-SR04 IoT Telemetry
            </p>
          </div>
          <p className="font-mono text-[11px] text-zinc-600">
            Background Web Worker Active • Auto-Sync 4.5s • Audio Enabled
          </p>
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
