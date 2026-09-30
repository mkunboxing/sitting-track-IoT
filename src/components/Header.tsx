'use client';

import React from 'react';
import { Activity, RefreshCw, Cpu, Wifi } from 'lucide-react';

interface HeaderProps {
  isPolling: boolean;
  setIsPolling: (val: boolean) => void;
  isLoading: boolean;
  onRefresh: () => void;
  lastUpdated: string;
  onOpenHardwareGuide: () => void;
}

export function Header({
  isPolling,
  setIsPolling,
  isLoading,
  onRefresh,
  lastUpdated,
  onOpenHardwareGuide,
}: HeaderProps) {
  const formattedSyncTime = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 shadow-lg shadow-emerald-500/20 text-white font-bold">
            <Activity className="w-5 h-5" />
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-white">
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
          {/* Polling auto-refresh toggle */}
          <button
            type="button"
            onClick={() => setIsPolling(!isPolling)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors active:scale-[0.96] ${
              isPolling
                ? 'bg-zinc-800/80 text-zinc-300 border-zinc-700 hover:bg-zinc-700/80'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-400'
            }`}
            title="Toggle automatic updates every 6 seconds"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isPolling ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
              }`}
            />
            {isPolling ? 'Live Auto-Sync (6s)' : 'Auto-Sync Paused'}
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors active:scale-[0.96]"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>ESP8266 &amp; API Guide</span>
          </button>
        </div>
      </div>
    </header>
  );
}
