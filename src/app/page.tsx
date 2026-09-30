'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/Header';
import { StatusCard } from '@/components/StatusCard';
import { MetricsGrid } from '@/components/MetricsGrid';
import { WeeklyChart } from '@/components/WeeklyChart';
import { SessionHistory } from '@/components/SessionHistory';
import { HardwareGuideModal } from '@/components/HardwareGuideModal';
import { DashboardStatsResponse } from '@/types/sitting';
import { soundManager } from '@/lib/soundUtils';
import { notificationManager } from '@/lib/notificationManager';
import { Bell, Flame, ShieldAlert, Sparkles, X, HeartPulse } from 'lucide-react';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isPolling, setIsPolling] = useState<boolean>(true);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sound settings
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const previousStatusRef = useRef<string | null>(null);

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

  // Fetch status and metrics from server
  const fetchStatus = useCallback(async (isBackground = false) => {
    try {
      const res = await fetch('/api/sitting/status', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const json: DashboardStatsResponse = await res.json();
      setData(json);
      setErrorMessage(null);

      // Sound alert on state transition (page-side, when tab is visible)
      // The SW handles background sound relay via postMessage when the tab is hidden.
      if (previousStatusRef.current !== null && previousStatusRef.current !== json.status) {
        if (json.status === 'SITTING') {
          // Only play from page if SW hasn't already triggered it (tab was visible)
          if (!document.hidden) soundManager.playSitDown();
        } else if (json.status === 'AWAY') {
          if (!document.hidden) soundManager.playStandUp();
          // Reset break alarm when user stands up
          setBreakAlertDismissed(false);
          breakAlarmPlayedRef.current = false;
          notificationManager.resetBreakAlarm();
        }
      }
      previousStatusRef.current = json.status;
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

  // Initial load
  useEffect(() => {
    let ignore = false;
    fetch('/api/sitting/status', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: DashboardStatsResponse) => {
        if (!ignore) {
          setData(json);
          previousStatusRef.current = json.status;
          setIsLoading(false);
          // Tell SW the current status so it doesn't fire a false notification on startup
          notificationManager.setInitialStatus(json.status);
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
    };
  }, []);

  // ── Service Worker: register, sync initial state, listen for messages ──────
  useEffect(() => {
    // Register SW and request notification permission
    notificationManager.register().then(() => {
      notificationManager.requestPermission();
    });

    // Relay SW messages → play sounds on the page (Web Audio requires page context)
    const unsub = notificationManager.onMessage((event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'PLAY_SOUND') {
        switch (msg.sound) {
          case 'sitDown':      soundManager.playSitDown();      break;
          case 'standUp':      soundManager.playStandUp();      break;
          case 'breakReminder': soundManager.playBreakReminder(); break;
        }
      }

      // Also update React state from SW data so the UI stays fresh even in background
      if (msg.type === 'STATUS_UPDATE' && msg.data) {
        setData(msg.data as DashboardStatsResponse);
      }
    });

    return unsub;
  }, []);

  // Polling interval (every 6 seconds when polling is enabled)
  // NOTE: The Service Worker handles background polling independently.
  // This interval only runs while the tab is foregrounded as a secondary sync.
  useEffect(() => {
    if (!isPolling) {
      notificationManager.stopPolling();
      return;
    }

    notificationManager.startPolling();

    // Also poll from the page when the tab is visible (immediate responsiveness)
    const interval = setInterval(() => {
      // Only fetch from the page when tab is visible to avoid duplicate network requests
      if (typeof document !== 'undefined' && !document.hidden) {
        fetchStatus(true);
      }
    }, 6000);

    return () => clearInterval(interval);
  }, [isPolling, fetchStatus]);

  // Break reminder watcher
  const activeDurationSec = data?.activeDurationSeconds ?? 0;
  const isSitting = data?.status === 'SITTING';
  const breakLimitSec = breakIntervalMin * 60;
  const shouldTriggerBreak = isSitting && breakIntervalMin > 0 && activeDurationSec >= breakLimitSec;

  // Sync break interval changes to the SW
  useEffect(() => {
    notificationManager.setBreakInterval(breakIntervalMin);
  }, [breakIntervalMin]);

  useEffect(() => {
    if (shouldTriggerBreak && !breakAlarmPlayedRef.current && !breakAlertDismissed) {
      breakAlarmPlayedRef.current = true;
      // Play sound locally (SW plays it in background via showNotification + postMessage)
      soundManager.playBreakReminder();
      // Fallback page notification in case SW notification was blocked
      notificationManager.showFallbackNotification(
        'Time for a Break! 🚶‍♂️',
        `You've been sitting for over ${breakIntervalMin} minutes. Take a quick stretch and drink some water.`
      );
    }
  }, [shouldTriggerBreak, breakAlertDismissed, breakIntervalMin]);

  // Simulator / manual action handler
  const handleSimulate = async (action: 'start' | 'stop') => {
    setSimulating(true);
    try {
      const res = await fetch('/api/sitting/simulate', {
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
      {/* Header with live sync & sound controls */}
      <Header
        isPolling={isPolling}
        setIsPolling={setIsPolling}
        isLoading={isLoading}
        onRefresh={() => fetchStatus(false)}
        lastUpdated={data?.lastUpdated || ''}
        onOpenHardwareGuide={() => setShowHardwareGuide(true)}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">
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
      <footer className="border-t border-zinc-900 bg-zinc-950 py-6 text-center text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p>Sitting Time Tracker • NodeMCU ESP8266 + HC-SR04 IoT Telemetry</p>
          <p className="font-mono text-[11px] text-zinc-600">
            Debounce: 2s Sitting / 5s Away • Loop Delay: ~700ms
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
