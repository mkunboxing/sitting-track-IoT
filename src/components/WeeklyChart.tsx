'use client';

import React from 'react';
import { DayStats } from '@/types/sitting';
import { formatFriendlyDuration } from '@/lib/timeUtils';
import { BarChart3, Calendar } from 'lucide-react';

interface WeeklyChartProps {
  weeklyStats: DayStats[];
}

export function WeeklyChart({ weeklyStats }: WeeklyChartProps) {
  // Find maximum seconds in the week to scale bar heights proportionally
  const maxSeconds = Math.max(
    ...weeklyStats.map((d) => d.totalSeconds),
    3600 * 4 // Minimum scale of 4 hours so small bars still look proportional
  );

  const totalWeeklySeconds = weeklyStats.reduce((acc, curr) => acc + curr.totalSeconds, 0);
  const totalWeeklySessions = weeklyStats.reduce((acc, curr) => acc + curr.sessionCount, 0);
  const averageDailySeconds = Math.round(totalWeeklySeconds / 7);

  const todayIso = new Date().toISOString().split('T')[0];

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 backdrop-blur-sm shadow-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-5 border-b border-zinc-800/80">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Weekly Sitting Activity</h3>
            <p className="text-xs text-zinc-400">Past 7 days sitting distribution &amp; session volume</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-1.5 text-zinc-400">
            <span>Week: <strong className="text-white font-bold">{formatFriendlyDuration(totalWeeklySeconds)}</strong> ({totalWeeklySessions} sess)</span>
          </div>
          <div className="text-zinc-500 hidden sm:inline">|</div>
          <div className="flex items-center gap-1.5 text-zinc-400">
            <Calendar className="w-3.5 h-3.5 text-zinc-500" />
            <span>Avg: <strong className="text-white font-bold">{formatFriendlyDuration(averageDailySeconds)}/day</strong></span>
          </div>
        </div>
      </div>

      {/* Bar Chart Display */}
      <div className="mt-6 pt-4">
        <div className="grid grid-cols-7 gap-2 sm:gap-4 items-end h-48 sm:h-52 px-1">
          {weeklyStats.map((day) => {
            const isToday = day.date === todayIso;
            const barHeightPercent = Math.max(
              day.totalSeconds > 0 ? 8 : 2,
              Math.min(100, Math.round((day.totalSeconds / maxSeconds) * 100))
            );

            return (
              <div key={day.date} className="flex flex-col items-center h-full justify-end group">
                {/* Hover Tooltip Details */}
                <div className="text-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 mb-2 pointer-events-none text-[11px] font-mono text-zinc-300 bg-zinc-800 px-2 py-1 rounded shadow-lg border border-zinc-700 whitespace-nowrap z-20">
                  <p className="font-semibold text-white">{day.dayName} ({day.date.slice(5)})</p>
                  <p className="text-emerald-400">{formatFriendlyDuration(day.totalSeconds)}</p>
                  <p className="text-zinc-400">{day.sessionCount} sessions</p>
                </div>

                {/* Duration text above bar */}
                <span className="text-[10px] font-mono text-zinc-400 mb-1.5 tabular-nums">
                  {day.totalSeconds > 0 ? formatFriendlyDuration(day.totalSeconds) : '0m'}
                </span>

                {/* Bar */}
                <div className="w-full max-w-[44px] bg-zinc-800/80 rounded-t-lg overflow-hidden flex flex-col justify-end p-0.5 border border-zinc-700/50 group-hover:border-emerald-500/50 transition-colors">
                  <div
                    className={`w-full rounded-t-md transition-all duration-700 ${
                      isToday
                        ? 'bg-gradient-to-t from-emerald-600 to-teal-400 shadow-md shadow-emerald-500/20'
                        : day.totalSeconds > 0
                        ? 'bg-gradient-to-t from-zinc-600 to-emerald-500/70 group-hover:from-emerald-700 group-hover:to-teal-400'
                        : 'bg-zinc-800/40'
                    }`}
                    style={{ height: `${barHeightPercent}%` }}
                  />
                </div>

                {/* Day of Week Label */}
                <div className="mt-2.5 text-center">
                  <span
                    className={`text-xs font-semibold block ${
                      isToday
                        ? 'text-emerald-400 underline decoration-emerald-500 decoration-2 underline-offset-4'
                        : 'text-zinc-400'
                    }`}
                  >
                    {day.dayName}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono block mt-0.5">
                    {day.sessionCount} {day.sessionCount === 1 ? 'sess' : 'sess'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
