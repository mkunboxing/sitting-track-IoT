'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { connectDevice, fetchDevices, unlinkDevice, TrackerDevice } from '@/lib/authClient';
import { Cpu, Link2, Loader2, ShieldAlert, Unlink, Wifi, WifiOff, CheckCircle2 } from 'lucide-react';

/**
 * "Connect Device" card for the authenticated dashboard.
 *
 * Links an Arduino (by its device ID — the same DEVICE_ID the firmware
 * publishes to MQTT with) to the logged-in account. Only the linking flow
 * lives here; the device itself keeps authenticating via the MQTT broker and
 * knows nothing about user accounts.
 */

export function ConnectDevice() {
  const [devices, setDevices] = useState<TrackerDevice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [deviceId, setDeviceId] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const list = await fetchDevices();
      setDevices(list);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Session expired') return;
      setErrorMessage('Could not load your devices.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy || !deviceId.trim()) return;

    setIsBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await connectDevice(deviceId.trim(), secret || undefined);
      if (result.ok) {
        setSuccessMessage(result.message);
        setDeviceId('');
        setSecret('');
        await loadDevices();
      } else {
        setErrorMessage(result.error);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Connect failed');
    } finally {
      setIsBusy(false);
    }
  };

  const handleUnlink = async (device: TrackerDevice) => {
    if (isBusy) return;
    if (!window.confirm(`Disconnect "${device.name}" (${device.device_id})?\n\nIts sitting data will no longer appear on your dashboard.`)) {
      return;
    }

    setIsBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await unlinkDevice(device.device_id);
      if (result.ok) {
        setSuccessMessage(result.message);
        await loadDevices();
      } else {
        setErrorMessage(result.error);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="p-5 rounded-2xl border border-edge/80 bg-gradient-to-br from-panel/60 via-panel/40 to-app">
      <div className="flex items-center gap-2 text-ink2 font-semibold text-sm">
        <Cpu className="w-4 h-4 text-acc-teal" />
        <span>Devices</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-500/10 text-acc-teal border border-teal-500/20 ml-auto">
          Connect Device
        </span>
      </div>
      <p className="text-[11px] text-ink5 mt-1">
        Link your Arduino by its device ID (the <span className="font-mono">DEVICE_ID</span> in the firmware) to see its sitting data here. A device can only ever be linked to one account.
      </p>

      {/* Linked device list */}
      <div className="mt-4 space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-ink5 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-acc-teal" />
            Loading your devices…
          </div>
        ) : devices.length === 0 ? (
          <div className="p-3 rounded-xl bg-well/60 border border-edge/60 text-xs text-ink4">
            No device connected yet — enter your device ID below to start tracking.
          </div>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-well/60 border border-edge/60"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 ${
                    device.online
                      ? 'bg-emerald-500/10 text-acc-emerald border-emerald-500/30'
                      : 'bg-chip/60 text-ink5 border-edge-strong/50'
                  }`}
                  title={device.online ? 'Telemetry seen in the last 30s' : 'No telemetry recently'}
                >
                  {device.online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                  {device.online ? 'Online' : 'Offline'}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-ink-bright truncate">{device.name}</p>
                  <p className="text-[11px] font-mono text-ink5 truncate">{device.device_id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleUnlink(device)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-panel text-ink4 border border-edge hover:bg-rose-500/10 hover:text-acc-rose-soft hover:border-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors active:scale-[0.96]"
                title="Unlink this device from your account"
              >
                <Unlink className="w-3 h-3" />
                Disconnect
              </button>
            </div>
          ))
        )}
      </div>

      {/* Connect form */}
      <form onSubmit={handleConnect} className="mt-4 flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          required
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          placeholder="Device ID (e.g. sitting-tracker-01)"
          className="flex-1 px-3 py-2 rounded-xl bg-well/60 border border-edge-strong/60 text-xs font-mono text-ink-bright placeholder:text-ink6 placeholder:font-sans outline-none focus:border-teal-500/60 focus:ring-2 focus:ring-teal-500/20 transition"
        />
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Device PIN (if configured)"
          autoComplete="off"
          className="sm:w-44 px-3 py-2 rounded-xl bg-well/60 border border-edge-strong/60 text-xs text-ink-bright placeholder:text-ink6 outline-none focus:border-teal-500/60 focus:ring-2 focus:ring-teal-500/20 transition"
        />
        <button
          type="submit"
          disabled={isBusy || !deviceId.trim()}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-teal-500/90 hover:bg-teal-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 font-bold text-xs transition-colors shadow active:scale-[0.97]"
        >
          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
          Connect
        </button>
      </form>

      {/* Inline feedback */}
      {successMessage && (
        <div className="flex items-center gap-2 mt-3 p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-acc-emerald-soft text-xs">
          <CheckCircle2 className="w-4 h-4 text-acc-emerald shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}
      {errorMessage && (
        <div className="flex items-center gap-2 mt-3 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-acc-rose-soft text-xs">
          <ShieldAlert className="w-4 h-4 text-acc-rose shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
}
