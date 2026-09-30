'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/Header';
import { StatusCard } from '@/components/StatusCard';
import { MetricsGrid } from '@/components/MetricsGrid';
import { WeeklyChart } from '@/components/WeeklyChart';
import { SessionHistory } from '@/components/SessionHistory';
import { HardwareGuideModal } from '@/components/HardwareGuideModal';
import { DashboardStatsResponse } from '@/types/sitting';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isPolling, setIsPolling] = useState<boolean>(true);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch status and metrics from server
  const fetchStatus = useCallback(async (isBackground = false) => {
    try {
      const res = await fetch('/api/sitting/status', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const json: DashboardStatsResponse = await res.json();
      setData(json);
      setErrorMessage(null);
    } catch (err: unknown) {
      console.error('Failed to fetch sitting status:', err);
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not reach Sitting Tracker API'
      );
    } finally {
      if (!isBackground) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    let ignore = false;
    fetch('/api/sitting/status', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: DashboardStatsResponse) => {
        if (!ignore) {
          setData(json);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Connection failed');
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  // Polling interval (every 6 seconds when tab is active and polling is enabled)
  useEffect(() => {
    if (!isPolling) return;

    const interval = setInterval(() => {
      // Don't poll if document is hidden to conserve resources
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchStatus(true);
    }, 6000);

    return () => clearInterval(interval);
  }, [isPolling, fetchStatus]);

  // Simulator handler for manual testing
  const handleSimulate = async (action: 'start' | 'stop') => {
    setSimulating(true);
    try {
      const res = await fetch('/api/sitting/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const resJson = await res.json();
      if (!res.ok || !resJson.success) {
        alert(`Simulation error: ${resJson.error || 'Failed action'}`);
      } else {
        await fetchStatus(false);
      }
    } catch (err: unknown) {
      alert(`Simulation failed: ${String(err)}`);
    } finally {
      setSimulating(false);
    }
  };

  const isSitting = data?.status === 'SITTING';

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <Header
        isPolling={isPolling}
        setIsPolling={setIsPolling}
        isLoading={isLoading}
        onRefresh={() => fetchStatus(false)}
        lastUpdated={data?.lastUpdated || ''}
        onOpenHardwareGuide={() => setShowHardwareGuide(true)}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Error notification if any */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
            <span>Unable to sync live telemetry: {errorMessage}</span>
            <button
              onClick={() => fetchStatus(false)}
              className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* 1. Hero Status Card (Live Sitting State & Stopwatch) */}
        <StatusCard
          status={data?.status ?? 'AWAY'}
          activeSession={data?.activeSession ?? null}
          onSimulate={handleSimulate}
          simulating={simulating}
          configured={data?.configured ?? true}
        />

        {/* 2. Key Metrics Grid (Today's Total, Current, Count, Longest) */}
        <MetricsGrid
          todayTotalSeconds={data?.todayTotalSeconds ?? 0}
          activeDurationSeconds={data?.activeDurationSeconds ?? 0}
          isSitting={isSitting}
          todaySessionCount={data?.todaySessionCount ?? 0}
          todayLongestSessionSeconds={data?.todayLongestSessionSeconds ?? 0}
        />

        {/* 3. Analytics & Historical Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
          {/* Weekly Statistics Bar Chart */}
          <WeeklyChart weeklyStats={data?.weeklyStats ?? []} />

          {/* Today's Session History Log */}
          <SessionHistory sessions={data?.todaySessions ?? []} />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-zinc-950 py-6 text-center text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p>Sitting Time Tracker • NodeMCU ESP8266 + HC-SR04 IoT Telemetry</p>
          <p className="font-mono text-[11px] text-zinc-600">
            Debounce: 2s Sitting / 5s Away • Sensor Loop: ~700ms
          </p>
        </div>
      </footer>

      {/* Hardware Guide & Testing Modal */}
      <HardwareGuideModal
        isOpen={showHardwareGuide}
        onClose={() => setShowHardwareGuide(false)}
      />
    </div>
  );
}
