'use client';

import React from 'react';
import { DayStats } from '@/types/sitting';
import { formatFriendlyDuration } from '@/lib/timeUtils';
import { BarChart3, Flame, TrendingUp } from 'lucide-react';

interface WeeklyChartProps {
  weeklyStats: DayStats[];
}

export function WeeklyChart({ weeklyStats }: WeeklyChartProps) {
  const rawMax = Math.max(...weeklyStats.map((d) => d.totalSeconds), 0);
  // Minimum scale = 1h so tiny bars still look proportional
  const maxSeconds = Math.max(rawMax, 3600);

  const totalWeeklySeconds = weeklyStats.reduce((acc, curr) => acc + curr.totalSeconds, 0);
  const totalWeeklySessions = weeklyStats.reduce((acc, curr) => acc + curr.sessionCount, 0);
  const averageDailySeconds = Math.round(totalWeeklySeconds / 7);

  const bestDay = [...weeklyStats].sort((a, b) => b.totalSeconds - a.totalSeconds)[0];
  const todayLocalDate = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();

  return (
    <div className="rounded-2xl border border-edge bg-panel/50 p-5 backdrop-blur-sm shadow-md">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5 pb-4 border-b border-edge/80">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-purple-500/10 text-acc-purple">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-bright">Weekly Sitting Activity</h3>
            <p className="text-[11px] text-ink4">Daily sitting duration comparison</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
          <span className="px-2.5 py-1 rounded-lg bg-chip border border-edge-strong/60 text-ink3 whitespace-nowrap">
            Week: <strong className="text-ink-bright">{formatFriendlyDuration(totalWeeklySeconds)}</strong>
            <span className="text-ink5 ml-1">({totalWeeklySessions}s)</span>
          </span>
          <span className="hidden sm:inline text-ink5 text-[11px]">
            Avg: <strong className="text-ink3">{formatFriendlyDuration(averageDailySeconds)}/day</strong>
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="flex gap-2 sm:gap-3 items-end h-44" style={{ paddingBottom: 0 }}>
        {weeklyStats.map((day, index) => {
          const isToday = day.date === todayLocalDate || index === weeklyStats.length - 1;
          const hasData = day.totalSeconds > 0;
          const percent = hasData
            ? Math.min(100, Math.max(6, Math.round((day.totalSeconds / maxSeconds) * 100)))
            : 0;
          // Posture segments as a share of the bar (stacked bottom → top:
          // attentive, relaxing, unclassified pre-posture time)
          const segShare = (sec: number) =>
            day.totalSeconds > 0 ? Math.min(100, (sec / day.totalSeconds) * 100) : 0;
          const hasPostureData = day.relaxSeconds > 0 || day.attentiveSeconds > 0;

          return (
            <div key={day.date} className="flex-1 flex flex-col items-center gap-1.5 group h-full">
              {/* Duration label above bar */}
              <span className={`text-[9px] sm:text-[10px] font-mono tabular-nums transition-colors ${
                isToday ? 'text-acc-emerald font-bold' : hasData ? 'text-ink3' : 'text-ink6'
              }`}>
                {hasData ? formatFriendlyDuration(day.totalSeconds) : '—'}
              </span>

              {/* Bar track */}
              <div className="flex-1 w-full flex flex-col justify-end relative">
                {/* Tooltip */}
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none z-30 whitespace-nowrap bg-app border border-edge-strong px-2 py-1 rounded-lg shadow-xl text-[11px] font-mono">
                  <p className="font-semibold text-ink-bright">{day.dayName} {day.date.slice(5)} · {formatFriendlyDuration(day.totalSeconds)}</p>
                  {hasPostureData && (
                    <>
                      <p className="text-acc-emerald">A {formatFriendlyDuration(day.attentiveSeconds)}</p>
                      <p className="text-acc-sky">R {formatFriendlyDuration(day.relaxSeconds)}</p>
                    </>
                  )}
                  {day.unclassifiedSeconds > 0 && (
                    <p className="text-ink4">Untracked {formatFriendlyDuration(day.unclassifiedSeconds)}</p>
                  )}
                  <p className="text-ink4">{day.sessionCount} sess</p>
                </div>

                {/* Empty track */}
                <div className="absolute inset-0 rounded-lg bg-chip/40 border border-edge/60 group-hover:border-edge-strong transition-colors" />

                {/* Filled portion — stacked posture segments */}
                {hasData && (
                  <div
                    className="relative w-full flex flex-col justify-end rounded-lg transition-all duration-700 overflow-hidden"
                    style={{ height: `${percent}%` }}
                  >
                    {day.attentiveSeconds > 0 && (
                      <div
                        className={`w-full ${isToday ? 'bg-gradient-to-t from-emerald-600 to-teal-400' : 'bg-emerald-500/80'}`}
                        style={{ height: `${segShare(day.attentiveSeconds)}%` }}
                      />
                    )}
                    {day.relaxSeconds > 0 && (
                      <div
                        className={`w-full ${isToday ? 'bg-gradient-to-t from-sky-600 to-sky-400' : 'bg-sky-500/80'}`}
                        style={{ height: `${segShare(day.relaxSeconds)}%` }}
                      />
                    )}
                    {day.unclassifiedSeconds > 0 && (
                      <div
                        className="w-full bg-chip-strong/60"
                        style={{ height: `${segShare(day.unclassifiedSeconds)}%` }}
                      />
                    )}
                    {isToday && (
                      <div className="absolute inset-0 bg-white/10 animate-pulse pointer-events-none" />
                    )}
                  </div>
                )}
              </div>

              {/* Day name + sessions */}
              <div className="text-center shrink-0">
                <span className={`text-[10px] sm:text-xs font-semibold block ${
                  isToday ? 'text-acc-emerald' : 'text-ink4 group-hover:text-ink2'
                }`}>
                  {day.dayName}
                </span>
                <span className="text-[9px] text-ink6 font-mono block">
                  {day.sessionCount}s
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-edge/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink4">
        <div className="flex items-center gap-1.5">
          <Flame className="w-3.5 h-3.5 text-acc-amber shrink-0" />
          <span>
            Best: <strong className="text-ink2">{bestDay?.dayName || 'N/A'}</strong>{' '}
            ({formatFriendlyDuration(bestDay?.totalSeconds || 0)})
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-medium">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-emerald-500/80 shrink-0" />
            Attentive
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-sky-500/80 shrink-0" />
            Relaxing
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-chip-strong/60 shrink-0" />
            Pre-posture
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-acc-teal shrink-0" />
          <span>Target: &lt; 8h / day</span>
        </div>
      </div>
    </div>
  );
}
