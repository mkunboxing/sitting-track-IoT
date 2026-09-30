'use client';

import React from 'react';
import { formatFriendlyDuration, formatHMS } from '@/lib/timeUtils';
import { Clock, CheckCircle2, Trophy, Hourglass } from 'lucide-react';

interface MetricsGridProps {
  todayTotalSeconds: number;
  activeDurationSeconds: number;
  isSitting: boolean;
  todaySessionCount: number;
  todayLongestSessionSeconds: number;
}

export function MetricsGrid({
  todayTotalSeconds,
  activeDurationSeconds,
  isSitting,
  todaySessionCount,
  todayLongestSessionSeconds,
}: MetricsGridProps) {
  // If sitting, the effective today total includes active session time
  const displayTotalSeconds = todayTotalSeconds;

  // Ergonomic recommendation: under 6-8 hours daily sitting is healthy
  const targetSittingSeconds = 8 * 3600;
  const percentageOfLimit = Math.min(100, Math.round((displayTotalSeconds / targetSittingSeconds) * 100));

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* 1. Today's Total Sitting Time */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400">Today&apos;s Total Sitting</span>
          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
            <Clock className="w-4 h-4" />
          </div>
        </div>

        <div className="mt-3">
          <div className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono tabular-nums">
            {formatFriendlyDuration(displayTotalSeconds)}
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-0.5">
            {formatHMS(displayTotalSeconds)} total
          </div>
        </div>

        {/* Progress bar towards daily benchmark */}
        <div className="mt-3 space-y-1">
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                percentageOfLimit > 85 ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
              style={{ width: `${percentageOfLimit}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>{percentageOfLimit}% of 8h desk cap</span>
            <span>Target: &lt; 8h</span>
          </div>
        </div>
      </div>

      {/* 2. Current Session Duration */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400">Current Session</span>
          <div
            className={`p-2 rounded-xl ${
              isSitting ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            <Hourglass className="w-4 h-4" />
          </div>
        </div>

        <div className="mt-3">
          <div className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono tabular-nums">
            {isSitting ? formatFriendlyDuration(activeDurationSeconds) : '--'}
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-0.5">
            {isSitting ? formatHMS(activeDurationSeconds) : 'No active session'}
          </div>
        </div>

        <div className="mt-3 text-[11px] text-zinc-400 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isSitting ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span>{isSitting ? 'Live timer counting' : 'Away from desk'}</span>
        </div>
      </div>

      {/* 3. Number of Sessions Today */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400">Sessions Today</span>
          <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400">
            <CheckCircle2 className="w-4 h-4" />
          </div>
        </div>

        <div className="mt-3">
          <div className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono tabular-nums">
            {todaySessionCount}
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-0.5">
            {todaySessionCount === 1 ? '1 recorded session' : `${todaySessionCount} recorded sessions`}
          </div>
        </div>

        <div className="mt-3 text-[11px] text-zinc-400">
          {todaySessionCount > 0
            ? `Avg: ${formatFriendlyDuration(Math.round(displayTotalSeconds / Math.max(1, todaySessionCount)))}/session`
            : 'No sessions recorded today'}
        </div>
      </div>

      {/* 4. Longest Sitting Session Today */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400">Longest Session</span>
          <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400">
            <Trophy className="w-4 h-4" />
          </div>
        </div>

        <div className="mt-3">
          <div className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono tabular-nums">
            {formatFriendlyDuration(todayLongestSessionSeconds)}
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-0.5">
            {formatHMS(todayLongestSessionSeconds)}
          </div>
        </div>

        <div className="mt-3 text-[11px] text-zinc-400">
          {todayLongestSessionSeconds >= 5400 ? (
            <span className="text-amber-400">Notice: Long streak without standing</span>
          ) : (
            <span>Healthy interval discipline</span>
          )}
        </div>
      </div>
    </div>
  );
}
