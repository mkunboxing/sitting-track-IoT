'use client';

import React from 'react';
import { RefreshCw, Cpu, Wifi, Volume2, VolumeX, Bell, BellOff, Sun, Moon } from 'lucide-react';
import { Logo } from './Logo';

interface HeaderProps {
  isPolling: boolean;
  setIsPolling: (val: boolean) => void;
  isLoading: boolean;
  onRefresh: () => void;
  lastUpdated: string;
  onOpenHardwareGuide: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  notificationPermission: NotificationPermission;
  onRequestNotificationPermission: () => void;
}

export function Header({
  isPolling,
  setIsPolling,
  isLoading,
  onRefresh,
  lastUpdated,
  onOpenHardwareGuide,
  soundEnabled,
  onToggleSound,
  notificationPermission,
  onRequestNotificationPermission,
}: HeaderProps) {
  const formattedSyncTime = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

  const isNotifGranted = notificationPermission === 'granted';

  return (
    <header className="border-b border-edge/80 bg-panel/60 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3 group">
          <Logo size="md" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-ink-bright group-hover:text-acc-emerald-soft transition-colors">
                Sitting Time Tracker
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-acc-emerald border border-emerald-500/20">
                <Wifi className="w-3 h-3 mr-1" />
                IoT Live
              </span>
            </div>
            <p className="text-xs text-ink4">
              ESP8266 + HC-SR04 Ultrasonic Telemetry
            </p>
          </div>
        </div>

        {/* Actions & Live Telemetry Controls */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {/* Notification permission button */}
          <button
            type="button"
            onClick={onRequestNotificationPermission}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all active:scale-[0.96] ${
              isNotifGranted
                ? 'bg-emerald-500/10 text-acc-emerald-soft border-emerald-500/30'
                : 'bg-amber-500/15 text-acc-amber-strong border-amber-500/40 hover:bg-amber-500/25 animate-pulse'
            }`}
            title={
              isNotifGranted
                ? 'Browser notifications enabled for sit/stand and stretch reminders'
                : 'Click to enable notifications in background tabs'
            }
          >
            {isNotifGranted ? (
              <>
                <Bell className="w-3.5 h-3.5 text-acc-emerald" />
                <span>Alerts On</span>
              </>
            ) : (
              <>
                <BellOff className="w-3.5 h-3.5 text-acc-amber" />
                <span>Enable Alerts</span>
              </>
            )}
          </button>

          {/* Sound Audio Alerts toggle */}
          <button
            type="button"
            onClick={onToggleSound}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors active:scale-[0.96] ${
              soundEnabled
                ? 'bg-emerald-500/10 text-acc-emerald-soft border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-panel text-ink5 border-edge hover:text-ink4'
            }`}
            title={soundEnabled ? 'Chime sound enabled (plays in foreground & background tabs)' : 'Sound muted'}
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-acc-emerald" />
                <span>Audio On</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-ink5" />
                <span>Muted</span>
              </>
            )}
          </button>

          {/* Polling auto-refresh toggle */}
          <button
            type="button"
            onClick={() => setIsPolling(!isPolling)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors active:scale-[0.96] ${
              isPolling
                ? 'bg-chip/80 text-ink3 border-edge-strong hover:bg-edge-strong/80'
                : 'bg-panel text-ink5 border-edge hover:text-ink4'
            }`}
            title="Live distance telemetry streams every 2.5 seconds"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isPolling ? 'bg-emerald-400 animate-pulse' : 'bg-chip-strong'
              }`}
            />
            {isPolling ? 'Live Auto-Sync (2.5s)' : 'Auto-Sync Paused'}
          </button>

          {/* Manual Refresh */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-chip/90 text-ink2 border border-edge-strong/80 hover:bg-edge-strong/90 transition-colors disabled:opacity-50 active:scale-[0.96]"
            title="Refresh now"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-acc-emerald' : ''}`}
            />
            <span>Sync</span>
            <span className="text-[10px] text-ink5 font-mono hidden md:inline">
              ({formattedSyncTime})
            </span>
          </button>

          {/* Hardware & API Setup modal button */}
          <button
            type="button"
            onClick={onOpenHardwareGuide}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-chip/90 text-ink3 border border-edge-strong/80 hover:bg-edge-strong/90 transition-colors active:scale-[0.96]"
          >
            <Cpu className="w-3.5 h-3.5 text-acc-teal" />
            <span>ESP8266 Guide</span>
          </button>

          {/* Theme toggle — dark ⇄ light (persisted, see layout bootstrap) */}
          <button
            type="button"
            onClick={() => {
              const isDark = document.documentElement.classList.toggle('dark');
              try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch { /* storage unavailable */ }
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-chip/90 text-ink4 border border-edge-strong/80 hover:bg-edge-strong/90 hover:text-ink2 transition-colors active:scale-[0.96]"
            title="Toggle light / dark theme"
          >
            <Sun className="w-3.5 h-3.5 hidden dark:block" />
            <Moon className="w-3.5 h-3.5 dark:hidden" />
          </button>
        </div>
      </div>
    </header>
  );
}
