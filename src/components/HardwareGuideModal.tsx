'use client';

import React, { useState } from 'react';
import { X, Copy, Check, Terminal, Cpu, ShieldCheck, Zap } from 'lucide-react';

interface HardwareGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HardwareGuideModal({ isOpen, onClose }: HardwareGuideModalProps) {
  const [copiedCurl, setCopiedCurl] = useState<string | null>(null);

  if (!isOpen) return null;

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCurl(key);
    setTimeout(() => setCopiedCurl(null), 2000);
  };

  const sampleStartCurl = `curl -X POST http://localhost:3000/api/sitting/start \\
  -H "Authorization: Bearer tracker-secret-device-key-change-me" \\
  -H "Content-Type: application/json"`;

  const sampleStopCurl = `curl -X POST http://localhost:3000/api/sitting/stop \\
  -H "Authorization: Bearer tracker-secret-device-key-change-me" \\
  -H "Content-Type: application/json"`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 md:p-8 shadow-2xl text-zinc-100">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                ESP8266 &amp; HC-SR04 Hardware Setup Guide
              </h3>
              <p className="text-xs text-zinc-400">
                Wiring, firmware configuration, and API test commands
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-6 space-y-6 text-sm">
          {/* 1. Pinout Wiring */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Zap className="w-4 h-4" /> 1. Circuit &amp; Pinout Connections
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
                <p className="text-zinc-400 font-semibold mb-1">HC-SR04 Pin → NodeMCU ESP8266</p>
                <ul className="space-y-1 text-zinc-200">
                  <li><strong className="text-emerald-400">TRIG</strong> → D6 (GPIO 12)</li>
                  <li><strong className="text-amber-400">ECHO</strong> → D5 (GPIO 14) via Voltage Divider</li>
                  <li><strong className="text-rose-400">VCC</strong> → VIN (5V power)</li>
                  <li><strong className="text-zinc-400">GND</strong> → GND (Ground)</li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
                <p className="text-zinc-400 font-semibold mb-1">Voltage Divider on ECHO (5V to 3.3V)</p>
                <p className="text-zinc-300 text-[11px] leading-relaxed">
                  HC-SR04 outputs 5V logic on ECHO. The ESP8266 is 3.3V tolerant.
                  Connect ECHO → 1kΩ resistor → D5 → 2kΩ resistor → GND.
                </p>
              </div>
            </div>
          </div>

          {/* 2. Firmware Settings */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-teal-400 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> 2. NodeMCU Firmware Configuration
            </h4>
            <p className="text-xs text-zinc-400">
              Open <code className="text-emerald-300">firmware/sitting_tracker/sitting_tracker.ino</code> in the Arduino IDE and customize:
            </p>
            <div className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 font-mono text-xs text-zinc-300 overflow-x-auto">
              <pre>{`const char* WIFI_SSID     = "Your_WiFi_Name";
const char* WIFI_PASSWORD = "Your_WiFi_Password";

// Live Vercel or local URL (e.g., "https://your-app.vercel.app")
const char* SERVER_BASE_URL = "https://your-app.vercel.app";

// Secret Device Bearer Token (must match DEVICE_TOKEN in .env.local)
const char* DEVICE_TOKEN    = "tracker-secret-device-key-change-me";`}</pre>
            </div>
          </div>

          {/* 3. Testing via Terminal (curl) */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
              <Terminal className="w-4 h-4" /> 3. Test Endpoints Directly via Terminal (cURL)
            </h4>

            {/* Test Start */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Start Session: <code className="text-emerald-300">POST /api/sitting/start</code></span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(sampleStartCurl, 'start')}
                  className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white"
                >
                  {copiedCurl === 'start' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCurl === 'start' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="p-2.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-[11px] font-mono text-zinc-300 overflow-x-auto">
                {sampleStartCurl}
              </pre>
            </div>

            {/* Test Stop */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Stop Session: <code className="text-rose-300">POST /api/sitting/stop</code></span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(sampleStopCurl, 'stop')}
                  className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white"
                >
                  {copiedCurl === 'stop' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCurl === 'stop' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="p-2.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-[11px] font-mono text-zinc-300 overflow-x-auto">
                {sampleStopCurl}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-zinc-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-zinc-800 text-white hover:bg-zinc-700 transition-colors active:scale-[0.96]"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
}
