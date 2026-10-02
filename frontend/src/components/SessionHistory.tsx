'use client';

import React from 'react';
import { SittingSession } from '@/types/sitting';
import { formatFriendlyDuration, formatHMS, formatTimeOnly } from '@/lib/timeUtils';
import { History, CheckCircle2, Radio, Clock } from 'lucide-react';

interface SessionHistoryProps {
  sessions: SittingSession[];
}

export function SessionHistory({ sessions }: SessionHistoryProps) {
  return (
    <div className="rounded-2xl border border-edge bg-panel/50 p-6 backdrop-blur-sm shadow-md">
      <div className="flex items-center justify-between pb-5 border-b border-edge/80">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-teal-500/10 text-acc-teal">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-ink-bright">Today&apos;s Session Log</h3>
            <p className="text-xs text-ink4">Chronological history of sitting periods today</p>
          </div>
        </div>

        <span className="text-xs font-mono text-ink4 px-2.5 py-1 rounded-full bg-chip border border-edge-strong/60">
          {sessions.length} {sessions.length === 1 ? 'Session' : 'Sessions'}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="py-12 text-center">
          <div className="inline-flex p-3 rounded-2xl bg-chip/60 text-ink5 mb-3">
            <Clock className="w-8 h-8" />
          </div>
          <h4 className="text-sm font-medium text-ink3">No sessions recorded yet today</h4>
          <p className="text-xs text-ink5 max-w-sm mx-auto mt-1">
            When you sit down at your desk, the HC-SR04 sensor will automatically record your session after 2 seconds.
          </p>
        </div>
      ) : (
        <div className="mt-4 max-h-[380px] overflow-y-auto overflow-x-auto pr-1 rounded-xl border border-edge/80 bg-well/40">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel/95 backdrop-blur-md z-10 border-b border-edge/90 shadow-sm">
              <tr className="text-ink4 font-medium">
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Start Time</th>
                <th className="py-3 px-3">End Time</th>
                <th className="py-3 px-3">Posture Split</th>
                <th className="py-3 px-3 text-right">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/40 font-mono">
              {sessions.map((session, index) => {
                const isActive = session.ended_at === null;
                const durationSec = session.duration_seconds ?? 0;

                // Snapshot of the posture split: completed columns plus the
                // running stretch for the active session (refreshed on every
                // status fetch)
                const postureSinceMs = session.posture_changed_at
                  ? new Date(session.posture_changed_at).getTime()
                  : new Date(session.started_at).getTime();
                const stretchSec = isActive
                  ? Math.max(0, Math.floor((Date.now() - postureSinceMs) / 1000))
                  : 0;
                const relaxSec = (session.relax_seconds ?? 0) +
                  (isActive && session.posture_state === 'relaxing' ? stretchSec : 0);
                const attentiveSec = (session.attentive_seconds ?? 0) +
                  (isActive && session.posture_state === 'attentive' ? stretchSec : 0);
                const hasSplit = relaxSec > 0 || attentiveSec > 0;

                return (
                  <tr
                    key={session.id || index}
                    className="hover:bg-chip/30 transition-colors group"
                  >
                    {/* Status badge */}
                    <td className="py-3.5 px-3">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-sans font-medium bg-emerald-500/15 text-acc-emerald-soft border border-emerald-500/30">
                          <Radio className="w-3 h-3 animate-pulse text-acc-emerald" />
                          <span>Active Now</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-sans font-medium bg-chip text-ink4 border border-edge-strong/60">
                          <CheckCircle2 className="w-3 h-3 text-ink4" />
                          <span>Completed</span>
                        </span>
                      )}
                    </td>

                    {/* Start Time */}
                    <td className="py-3.5 px-3 text-ink2">
                      {formatTimeOnly(session.started_at)}
                    </td>

                    {/* End Time */}
                    <td className="py-3.5 px-3 text-ink4">
                      {isActive ? (
                        <span className="text-acc-emerald italic">In progress...</span>
                      ) : (
                        formatTimeOnly(session.ended_at!)
                      )}
                    </td>

                    {/* Posture Split */}
                    <td className="py-3.5 px-3 whitespace-nowrap">
                      {!hasSplit ? (
                        <span className="text-ink6">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {attentiveSec > 0 && (
                            <span className="inline-flex items-center gap-1.5 text-acc-emerald-soft">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                              A&nbsp;{formatFriendlyDuration(attentiveSec)}
                            </span>
                          )}
                          {relaxSec > 0 && (
                            <span className="inline-flex items-center gap-1.5 text-acc-sky-soft">
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                              R&nbsp;{formatFriendlyDuration(relaxSec)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Duration */}
                    <td className="py-3.5 px-3 text-right tabular-nums">
                      {isActive ? (
                        <span className="text-acc-emerald font-bold">Counting...</span>
                      ) : (
                        <div className="flex flex-col items-end">
                          <span className="font-bold text-ink">
                            {formatFriendlyDuration(durationSec)}
                          </span>
                          <span className="text-[10px] text-ink5">
                            {formatHMS(durationSec)}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
