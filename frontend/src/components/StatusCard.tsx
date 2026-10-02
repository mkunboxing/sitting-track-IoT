'use client';

import React, { useEffect, useState } from 'react';
import { SittingSession, SittingStatus } from '@/types/sitting';
import { formatHMS, formatTimeOnly } from '@/lib/timeUtils';
import { UserCheck, UserX, Clock, Flame, Play, Square, AlertCircle, Radar } from 'lucide-react';

interface StatusCardProps {
  status: SittingStatus;
  activeSession: SittingSession | null;
  onSimulate: (action: 'start' | 'stop') => Promise<void>;
  simulating: boolean;
  configured: boolean;
  /** Live ultrasonic reading (cm), pushed from the device via SSE */
  distanceCm: number | null;
}

export function StatusCard({
  status,
  activeSession,
  onSimulate,
  simulating,
  configured,
  distanceCm,
}: StatusCardProps) {
  // Live duration ticker updated client-side every 1000ms using started_at
  const [liveElapsed, setLiveElapsed] = useState<number>(0);
  const isSitting = status === 'SITTING' && !!activeSession;

  useEffect(() => {
    if (!isSitting || !activeSession) return;

    const startMs = new Date(activeSession.started_at).getTime();

    const updateTimer = () => {
      const diffSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      setLiveElapsed(diffSec);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [activeSession, isSitting]);

  const elapsedSeconds = isSitting ? liveElapsed : 0;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:p-8 backdrop-blur-sm shadow-xl">
      {/* Decorative ambient background blur */}
      <div
        className={`absolute -right-16 -top-16 h-64 w-64 rounded-full blur-3xl transition-opacity duration-1000 pointer-events-none ${
          isSitting
            ? 'bg-emerald-500/15 opacity-100'
            : 'bg-zinc-700/10 opacity-60'
        }`}
      />

      {!configured && (
        <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 space-y-1">
            <p className="font-semibold text-amber-300">Supabase Not Connected Yet</p>
            <p>
              Please add your <code className="px-1 py-0.5 bg-black/40 rounded text-amber-100">SUPABASE_URL</code> and <code className="px-1 py-0.5 bg-black/40 rounded text-amber-100">SUPABASE_SERVICE_ROLE_KEY</code> in <code className="px-1 py-0.5 bg-black/40 rounded text-amber-100">.env.local</code> and run the SQL migration in <code className="px-1 py-0.5 bg-black/40 rounded text-amber-100">supabase/schema.sql</code>.
            </p>
          </div>
        </div>
      )}

      <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        {/* Left Section: Status & Hero Badge */}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold tracking-wide uppercase shadow-sm ${
                isSitting
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700/60'
              }`}
            >
              <span className="relative flex h-2.5 w-2.5">
                {isSitting && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                )}
                <span
                  className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                    isSitting ? 'bg-emerald-400' : 'bg-zinc-500'
                  }`}
                ></span>
              </span>
              {isSitting ? 'Currently Sitting' : 'Currently Away'}
            </span>

            <span className="text-xs text-zinc-500 font-mono inline-flex items-center gap-1.5">
              <Radar className={`w-3.5 h-3.5 ${distanceCm !== null ? 'text-emerald-400' : 'text-zinc-600'}`} />
              {distanceCm !== null
                ? distanceCm >= 0
                  ? `${distanceCm.toFixed(1)} cm`
                  : 'out of range'
                : 'waiting for sensor…'}
            </span>
          </div>

          <div>
            <div className="flex items-center gap-3">
              {isSitting ? (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <UserCheck className="w-8 h-8" />
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-zinc-800 border border-zinc-700/50 text-zinc-500">
                  <UserX className="w-8 h-8" />
                </div>
              )}

              <div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                  {isSitting ? 'Desk is Occupied' : 'Desk is Vacant'}
                </h2>
                <p className="text-sm text-zinc-400 mt-0.5">
                  {isSitting && activeSession
                    ? `Session started at ${formatTimeOnly(activeSession.started_at)}`
                    : 'Standing by for ultrasonic sensor trigger'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section: Live Active Stopwatch */}
        <div className="flex flex-col sm:flex-row lg:flex-col sm:items-end justify-center gap-4 bg-zinc-950/40 p-5 rounded-xl border border-zinc-800/60">
          <div className="text-left sm:text-right">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 justify-start sm:justify-end">
              <Clock className="w-3.5 h-3.5 text-zinc-400" />
              <span>Current Session Duration</span>
            </div>
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white font-mono tabular-nums mt-1">
              {isSitting ? formatHMS(elapsedSeconds) : '00:00:00'}
            </div>
            {isSitting && elapsedSeconds >= 3600 && (
              <div className="flex items-center gap-1 text-[11px] text-amber-400 font-medium justify-start sm:justify-end mt-1">
                <Flame className="w-3 h-3" />
                <span>Over 1 hour sitting – stretch break advised!</span>
              </div>
            )}
          </div>

          {/* Action & Simulation Controls */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-800/60 w-full sm:w-auto justify-end">
            {isSitting && (
              <button
                type="button"
                onClick={() => onSimulate('stop')}
                disabled={simulating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600/30 text-rose-200 border border-rose-500/50 hover:bg-rose-600/50 transition-colors active:scale-[0.96] shadow-sm animate-pulse"
                title="If you switched off or unplugged the NodeMCU, click here to stop the timer and record the session duration"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>End Active Session</span>
              </button>
            )}

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-500 mr-1 hidden sm:inline">
                Simulate:
              </span>
              <button
                type="button"
                onClick={() => onSimulate('start')}
                disabled={simulating || isSitting}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors active:scale-[0.96]"
                title="Simulate NodeMCU sending POST /api/sitting/start"
              >
                <Play className="w-3 h-3" />
                <span>Sit Down</span>
              </button>
              <button
                type="button"
                onClick={() => onSimulate('stop')}
                disabled={simulating || !isSitting}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/80 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors active:scale-[0.96]"
                title="Simulate NodeMCU sending POST /api/sitting/stop"
              >
                <Square className="w-3 h-3" />
                <span>Stand Up</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
