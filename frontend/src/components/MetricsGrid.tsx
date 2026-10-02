'use client';

import React from 'react';
import { SittingStatus } from '@/types/sitting';
import { formatFriendlyDuration, formatHMS } from '@/lib/timeUtils';
import { Clock, CheckCircle2, Trophy, Timer, Sofa, Focus } from 'lucide-react';

interface MetricsGridProps {
  todayTotalSeconds: number;
  activeDurationSeconds: number;
  isOccupied: boolean;
  /** Current live status — lets the relax/attentive cards show "counting live" */
  currentPosture: SittingStatus;
  todaySessionCount: number;
  todayLongestSessionSeconds: number;
  todayRelaxSeconds: number;
  todayAttentiveSeconds: number;
}

export function MetricsGrid({
  todayTotalSeconds,
  activeDurationSeconds,
  isOccupied,
  currentPosture,
  todaySessionCount,
  todayLongestSessionSeconds,
  todayRelaxSeconds,
  todayAttentiveSeconds,
}: MetricsGridProps) {
  // If sitting, the effective today total includes active session time
  const displayTotalSeconds = todayTotalSeconds;

  // Ergonomic recommendation: under 6-8 hours daily sitting is healthy
  const targetSittingSeconds = 8 * 3600;
  const percentageOfLimit = Math.min(100, Math.round((displayTotalSeconds / targetSittingSeconds) * 100));

  // Posture share of today's sitting time
  const relaxPct = displayTotalSeconds > 0 ? Math.round((todayRelaxSeconds / displayTotalSeconds) * 100) : 0;
  const attentivePct = displayTotalSeconds > 0 ? Math.round((todayAttentiveSeconds / displayTotalSeconds) * 100) : 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
      {/* 1. Today's Total Sitting Time */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Today&apos;s Total</span>
          <div className="p-1.5 sm:p-2 rounded-xl bg-emerald-500/10 text-acc-emerald">
            <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {formatFriendlyDuration(displayTotalSeconds)}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {formatHMS(displayTotalSeconds)} total
          </div>
        </div>

        {/* Progress bar towards daily benchmark */}
        <div className="mt-2.5 sm:mt-3 space-y-1">
          <div className="w-full bg-chip rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                percentageOfLimit > 85 ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
              style={{ width: `${percentageOfLimit}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] sm:text-[10px] text-ink5">
            <span>{percentageOfLimit}% of 8h</span>
            <span className="hidden sm:inline">Target: &lt; 8h</span>
          </div>
        </div>
      </div>

      {/* 2. Current Session Duration */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Current Session</span>
          <div
            className={`p-1.5 sm:p-2 rounded-xl ${
              isOccupied ? 'bg-emerald-500/10 text-acc-emerald' : 'bg-chip text-ink5'
            }`}
          >
            <Timer className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {isOccupied ? formatFriendlyDuration(activeDurationSeconds) : '--'}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {isOccupied ? formatHMS(activeDurationSeconds) : 'No active session'}
          </div>
        </div>

        <div className="mt-2.5 sm:mt-3 text-[10px] sm:text-[11px] text-ink4 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOccupied ? 'bg-emerald-400' : 'bg-chip-strong'}`} />
          <span className="truncate">
            {isOccupied
              ? currentPosture === 'RELAXING'
                ? 'Counting live · relaxing'
                : 'Counting live · attentive'
              : 'Away from desk'}
          </span>
        </div>
      </div>

      {/* 3. Attentive Time Today */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Attentive Time</span>
          <div className="p-1.5 sm:p-2 rounded-xl bg-emerald-500/10 text-acc-emerald">
            <Focus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {formatFriendlyDuration(todayAttentiveSeconds)}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {formatHMS(todayAttentiveSeconds)} focused
          </div>
        </div>

        <div className="mt-2.5 sm:mt-3 text-[10px] sm:text-[11px] text-ink4 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${currentPosture === 'ATTENTIVE' ? 'bg-emerald-400 animate-pulse' : 'bg-chip-strong'}`} />
          <span className="truncate">
            {currentPosture === 'ATTENTIVE' ? 'Counting live' : `${attentivePct}% of sitting`}
          </span>
        </div>
      </div>

      {/* 4. Relax Time Today */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Relax Time</span>
          <div className="p-1.5 sm:p-2 rounded-xl bg-sky-500/10 text-acc-sky">
            <Sofa className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {formatFriendlyDuration(todayRelaxSeconds)}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {formatHMS(todayRelaxSeconds)} relaxing
          </div>
        </div>

        <div className="mt-2.5 sm:mt-3 text-[10px] sm:text-[11px] text-ink4 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${currentPosture === 'RELAXING' ? 'bg-sky-400 animate-pulse' : 'bg-chip-strong'}`} />
          <span className="truncate">
            {currentPosture === 'RELAXING' ? 'Counting live' : `${relaxPct}% of sitting`}
          </span>
        </div>
      </div>

      {/* 5. Number of Sessions Today */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Sessions Today</span>
          <div className="p-1.5 sm:p-2 rounded-xl bg-blue-500/10 text-acc-blue">
            <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {todaySessionCount}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {todaySessionCount === 1 ? '1 session' : `${todaySessionCount} sessions`}
          </div>
        </div>

        <div className="mt-2.5 sm:mt-3 text-[10px] sm:text-[11px] text-ink4 truncate">
          {todaySessionCount > 0
            ? `Avg: ${formatFriendlyDuration(Math.round(displayTotalSeconds / Math.max(1, todaySessionCount)))}`
            : 'No sessions'}
        </div>
      </div>

      {/* 6. Longest Sitting Session Today */}
      <div className="rounded-2xl border border-edge bg-panel/50 p-3.5 sm:p-5 backdrop-blur-sm hover:border-edge-strong/80 transition-all flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <span className="text-[11px] sm:text-xs font-medium text-ink4">Longest Session</span>
          <div className="p-1.5 sm:p-2 rounded-xl bg-amber-500/10 text-acc-amber">
            <Trophy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
        </div>

        <div className="mt-2 sm:mt-3">
          <div className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-ink-bright font-mono tabular-nums">
            {formatFriendlyDuration(todayLongestSessionSeconds)}
          </div>
          <div className="text-[10px] sm:text-xs text-ink5 font-mono mt-0.5">
            {formatHMS(todayLongestSessionSeconds)}
          </div>
        </div>

        <div className="mt-2.5 sm:mt-3 text-[10px] sm:text-[11px] text-ink4 truncate">
          {todayLongestSessionSeconds >= 5400 ? (
            <span className="text-acc-amber font-medium">Long streak</span>
          ) : (
            <span>Healthy cadence</span>
          )}
        </div>
      </div>
    </div>
  );
}
