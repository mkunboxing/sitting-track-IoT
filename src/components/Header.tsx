'use client';

import React from 'react';
import { RefreshCw, Cpu, Wifi, Volume2, VolumeX, Bell, BellOff } from 'lucide-react';
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
    <header className="border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3 group">
          <Logo size="md" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-white group-hover:text-emerald-300 transition-colors">
                Sitting Time Tracker
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Wifi className="w-3 h-3 mr-1" />
                IoT Live
              </span>
            </div>
            <p className="text-xs text-zinc-400">
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
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                : 'bg-amber-500/15 text-amber-200 border-amber-500/40 hover:bg-amber-500/25 animate-pulse'
            }`}
            title={
              isNotifGranted
                ? 'Browser notifications enabled for sit/stand and stretch reminders'
                : 'Click to enable notifications in background tabs'
            }
          >
            {isNotifGranted ? (
              <>
                <Bell className="w-3.5 h-3.5 text-emerald-400" />
                <span>Alerts On</span>
              </>
            ) : (
              <>
                <BellOff className="w-3.5 h-3.5 text-amber-400" />
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
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-400'
            }`}
            title={soundEnabled ? 'Chime sound enabled (plays in foreground & background tabs)' : 'Sound muted'}
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Audio On</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-zinc-500" />
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
                ? 'bg-zinc-800/80 text-zinc-300 border-zinc-700 hover:bg-zinc-700/80'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-400'
            }`}
            title="Toggle background auto-sync every 4 seconds"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isPolling ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
              }`}
            />
            {isPolling ? 'Live Auto-Sync (4s)' : 'Auto-Sync Paused'}
          </button>

          {/* Manual Refresh */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800/90 text-zinc-200 border border-zinc-700/80 hover:bg-zinc-700/90 transition-colors disabled:opacity-50 active:scale-[0.96]"
            title="Refresh now"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-emerald-400' : ''}`}
            />
            <span>Sync</span>
            <span className="text-[10px] text-zinc-500 font-mono hidden md:inline">
              ({formattedSyncTime})
            </span>
          </button>

          {/* Hardware & API Setup modal button */}
          <button
            type="button"
            onClick={onOpenHardwareGuide}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800/90 text-zinc-300 border border-zinc-700/80 hover:bg-zinc-700/90 transition-colors active:scale-[0.96]"
          >
            <Cpu className="w-3.5 h-3.5 text-teal-400" />
            <span>ESP8266 Guide</span>
          </button>
        </div>
      </div>
    </header>
  );
}
