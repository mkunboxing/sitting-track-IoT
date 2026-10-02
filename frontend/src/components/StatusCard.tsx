'use client';

import React, { useEffect, useState } from 'react';
import { SittingSession, SittingStatus } from '@/types/sitting';
import { formatHMS, formatTimeOnly, formatFriendlyDuration } from '@/lib/timeUtils';
import { UserCheck, UserX, Sofa, Clock, Flame, Play, Square, AlertCircle, Radar } from 'lucide-react';

interface StatusCardProps {
  status: SittingStatus;
  activeSession: SittingSession | null;
  onSimulate: (action: 'start' | 'stop' | 'relax' | 'focus') => Promise<void>;
  simulating: boolean;
  configured: boolean;
  /** Live ultrasonic reading (cm), pushed from the device via SSE */
  distanceCm: number | null;
}

/** Visual identity per posture: badge/glow/icon colors and labels */
const POSTURE_STYLES = {
  RELAXING: {
    badge: 'bg-sky-500/15 text-acc-sky-soft border border-sky-500/30',
    dot: 'bg-sky-400',
    ping: 'bg-sky-400',
    glow: 'bg-sky-500/15',
    icon: 'bg-sky-500/10 border border-sky-500/20 text-acc-sky',
    label: 'Currently Relaxing',
  },
  ATTENTIVE: {
    badge: 'bg-emerald-500/15 text-acc-emerald-soft border border-emerald-500/30',
    dot: 'bg-emerald-400',
    ping: 'bg-emerald-400',
    glow: 'bg-emerald-500/15',
    icon: 'bg-emerald-500/10 border border-emerald-500/20 text-acc-emerald',
    label: 'Currently Attentive',
  },
  AWAY: {
    badge: 'bg-chip text-ink4 border border-edge-strong/60',
    dot: 'bg-zinc-500',
    ping: '',
    glow: 'bg-edge-strong/10',
    icon: 'bg-chip border border-edge-strong/50 text-ink5',
    label: 'Currently Away',
  },
} as const;

export function StatusCard({
  status,
  activeSession,
  onSimulate,
  simulating,
  configured,
  distanceCm,
}: StatusCardProps) {
  // Live duration tickers updated client-side every 1000ms using started_at
  // and the running posture stretch (posture_changed_at)
  const [liveElapsed, setLiveElapsed] = useState<number>(0);
  const [liveSplit, setLiveSplit] = useState<{ relax: number; attentive: number }>({ relax: 0, attentive: 0 });

  const isOccupied = status === 'RELAXING' || status === 'ATTENTIVE';
  const style = POSTURE_STYLES[status];

  useEffect(() => {
    if (!isOccupied || !activeSession) return;

    const startMs = new Date(activeSession.started_at).getTime();
    const postureSinceMs = activeSession.posture_changed_at
      ? new Date(activeSession.posture_changed_at).getTime()
      : startMs;

    const updateTimer = () => {
      const nowMs = Date.now();
      setLiveElapsed(Math.max(0, Math.floor((nowMs - startMs) / 1000)));

      const stretchSec = Math.max(0, Math.floor((nowMs - postureSinceMs) / 1000));
      setLiveSplit({
        relax: (activeSession.relax_seconds ?? 0) +
          (activeSession.posture_state === 'relaxing' ? stretchSec : 0),
        attentive: (activeSession.attentive_seconds ?? 0) +
          (activeSession.posture_state === 'attentive' ? stretchSec : 0),
      });
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [activeSession, isOccupied]);

  const elapsedSeconds = isOccupied ? liveElapsed : 0;

  // Color the live distance chip by the posture band it falls into
  const distanceTone =
    distanceCm === null || distanceCm < 0
      ? 'text-ink6'
      : distanceCm < 8.0
        ? 'text-acc-sky'
        : distanceCm <= 45
          ? 'text-acc-emerald'
          : 'text-ink5';

  return (
    <div className="relative overflow-hidden rounded-2xl border border-edge bg-panel/70 p-6 md:p-8 backdrop-blur-sm shadow-xl">
      {/* Decorative ambient background blur */}
      <div
        className={`absolute -right-16 -top-16 h-64 w-64 rounded-full blur-3xl transition-opacity duration-1000 pointer-events-none ${
          isOccupied ? `${style.glow} opacity-100` : 'opacity-60'
        }`}
      />

      {!configured && (
        <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-acc-amber shrink-0 mt-0.5" />
          <div className="text-xs text-acc-amber-strong space-y-1">
            <p className="font-semibold text-acc-amber-soft">Supabase Not Connected Yet</p>
            <p>
              Please add your <code className="px-1 py-0.5 bg-black/40 rounded text-acc-amber-strong">SUPABASE_URL</code> and <code className="px-1 py-0.5 bg-black/40 rounded text-acc-amber-strong">SUPABASE_SERVICE_ROLE_KEY</code> in <code className="px-1 py-0.5 bg-black/40 rounded text-acc-amber-strong">.env.local</code> and run the SQL migration in <code className="px-1 py-0.5 bg-black/40 rounded text-acc-amber-strong">supabase/schema.sql</code>.
            </p>
          </div>
        </div>
      )}

      <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        {/* Left Section: Status & Hero Badge */}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold tracking-wide uppercase shadow-sm ${style.badge}`}
            >
              <span className="relative flex h-2.5 w-2.5">
                {isOccupied && style.ping && (
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${style.ping} opacity-75`}></span>
                )}
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${style.dot}`}></span>
              </span>
              {style.label}
            </span>

            <span className="text-xs text-ink5 font-mono inline-flex items-center gap-1.5">
              <Radar className={`w-3.5 h-3.5 ${distanceTone}`} />
              {distanceCm !== null
                ? distanceCm >= 0
                  ? `${distanceCm.toFixed(1)} cm`
                  : 'out of range'
                : 'waiting for sensor…'}
            </span>
          </div>

          <div>
            <div className="flex items-center gap-3">
              {status === 'RELAXING' ? (
                <div className={`p-3 rounded-xl ${style.icon}`}>
                  <Sofa className="w-8 h-8" />
                </div>
              ) : isOccupied ? (
                <div className={`p-3 rounded-xl ${style.icon}`}>
                  <UserCheck className="w-8 h-8" />
                </div>
              ) : (
                <div className={`p-3 rounded-xl ${style.icon}`}>
                  <UserX className="w-8 h-8" />
                </div>
              )}

              <div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink-bright">
                  {isOccupied ? 'Desk is Occupied' : 'Desk is Vacant'}
                </h2>
                <p className="text-sm text-ink4 mt-0.5">
                  {isOccupied && activeSession ? (
                    <>
                      <span className={status === 'RELAXING' ? 'text-acc-sky-soft font-medium' : 'text-acc-emerald-soft font-medium'}>
                        {status === 'RELAXING' ? 'Relaxing' : 'Attentive'}
                      </span>
                      {' — session started at '}
                      {formatTimeOnly(activeSession.started_at)}
                    </>
                  ) : (
                    'Standing by for ultrasonic sensor trigger'
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section: Live Active Stopwatch + Posture Split */}
        <div className="w-full lg:w-auto lg:min-w-[340px] flex flex-col sm:flex-row lg:flex-col sm:items-end justify-center gap-4 bg-well/40 p-5 rounded-xl border border-edge/60">
          <div className="text-left sm:text-right w-full">
            <div className="flex items-center gap-1.5 text-xs font-medium text-ink4 justify-start sm:justify-end">
              <Clock className="w-3.5 h-3.5 text-ink4" />
              <span>Current Session Duration</span>
            </div>
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-bright font-mono tabular-nums mt-1">
              {isOccupied ? formatHMS(elapsedSeconds) : '00:00:00'}
            </div>

            {isOccupied && (
              <div className="flex flex-wrap items-center gap-2 justify-start sm:justify-end mt-3">
                {/* Attentive total — highlighted while it's the live posture */}
                <div
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                    status === 'ATTENTIVE'
                      ? 'bg-emerald-500/15 border-emerald-500/30'
                      : 'bg-emerald-500/5 border-emerald-500/15'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 ${status === 'ATTENTIVE' ? 'animate-pulse' : ''}`} />
                  <span className="text-[11px] font-medium text-acc-emerald-soft/80">Attentive</span>
                  <span className="text-xs font-bold text-acc-emerald-strong font-mono tabular-nums">
                    {formatFriendlyDuration(liveSplit.attentive)}
                  </span>
                </div>
                {/* Relax total — highlighted while it's the live posture */}
                <div
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                    status === 'RELAXING'
                      ? 'bg-sky-500/15 border-sky-500/30'
                      : 'bg-sky-500/5 border-sky-500/15'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0 ${status === 'RELAXING' ? 'animate-pulse' : ''}`} />
                  <span className="text-[11px] font-medium text-acc-sky-soft/80">Relax</span>
                  <span className="text-xs font-bold text-acc-sky-strong font-mono tabular-nums">
                    {formatFriendlyDuration(liveSplit.relax)}
                  </span>
                </div>
              </div>
            )}

            {isOccupied && elapsedSeconds >= 3600 && (
              <div className="flex items-center gap-1 text-[11px] text-acc-amber font-medium justify-start sm:justify-end mt-2">
                <Flame className="w-3 h-3" />
                <span>Over 1 hour sitting – stretch break advised!</span>
              </div>
            )}
          </div>

          {/* Controls: primary session actions only (dev simulate controls live in the footer) */}
          <div className="w-full sm:w-auto flex flex-wrap items-center justify-start sm:justify-end gap-2 pt-3 border-t border-edge/60">
            {isOccupied && (
              <>
                <button
                  type="button"
                  onClick={() => onSimulate(status === 'RELAXING' ? 'focus' : 'relax')}
                  disabled={simulating}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors active:scale-[0.96] shadow-sm disabled:opacity-30 disabled:cursor-not-allowed ${
                    status === 'RELAXING'
                      ? 'bg-emerald-600/20 text-acc-emerald-soft border-emerald-500/30 hover:bg-emerald-600/30'
                      : 'bg-sky-600/20 text-acc-sky-soft border-sky-500/30 hover:bg-sky-600/30'
                  }`}
                  title="Simulate a posture change via POST /api/sitting/simulate"
                >
                  <Sofa className="w-3.5 h-3.5" />
                  <span>{status === 'RELAXING' ? 'Switch to Attentive' : 'Switch to Relaxing'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSimulate('stop')}
                  disabled={simulating}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600/30 text-acc-rose-strong border border-rose-500/50 hover:bg-rose-600/50 transition-colors active:scale-[0.96] shadow-sm disabled:opacity-30 disabled:cursor-not-allowed"
                  title="If you switched off or unplugged the NodeMCU, click here to stop the timer and record the session duration"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>End Active Session</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
