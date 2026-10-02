'use client';

import React, { useState } from 'react';
import { X, Copy, Check, Terminal, ShieldCheck, Zap } from 'lucide-react';
import { Logo } from './Logo';

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
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-edge-strong bg-panel p-6 md:p-8 shadow-2xl text-ink">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-edge">
          <div className="flex items-center gap-3">
            <Logo size="sm" animated={false} />
            <div>
              <h3 className="text-lg font-bold text-ink-bright">
                ESP8266 &amp; HC-SR04 Hardware Setup Guide
              </h3>
              <p className="text-xs text-ink4">
                Wiring, firmware configuration, and API test commands
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink4 hover:text-ink-bright hover:bg-chip transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-6 space-y-6 text-sm">
          {/* 1. Pinout Wiring */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-acc-emerald flex items-center gap-1.5">
              <Zap className="w-4 h-4" /> 1. Circuit &amp; Pinout Connections
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-3 rounded-xl bg-well/60 border border-edge">
                <p className="text-ink4 font-semibold mb-1">HC-SR04 Pin → NodeMCU ESP8266</p>
                <ul className="space-y-1 text-ink2">
                  <li><strong className="text-acc-emerald">TRIG</strong> → D6 (GPIO 12)</li>
                  <li><strong className="text-acc-amber">ECHO</strong> → D5 (GPIO 14) via Voltage Divider</li>
                  <li><strong className="text-acc-rose">VCC</strong> → VIN (5V power)</li>
                  <li><strong className="text-ink4">GND</strong> → GND (Ground)</li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-well/60 border border-edge">
                <p className="text-ink4 font-semibold mb-1">Voltage Divider on ECHO (5V to 3.3V)</p>
                <p className="text-ink3 text-[11px] leading-relaxed">
                  HC-SR04 outputs 5V logic on ECHO. The ESP8266 is 3.3V tolerant.
                  Connect ECHO → 1kΩ resistor → D5 → 2kΩ resistor → GND.
                </p>
              </div>
            </div>
          </div>

          {/* 2. Firmware Settings */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-acc-teal flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> 2. NodeMCU Firmware Configuration
            </h4>
            <p className="text-xs text-ink4">
              Open <code className="text-acc-emerald-soft">firmware/sitting_tracker/sitting_tracker.ino</code> in the Arduino IDE and customize:
            </p>
            <div className="p-3 rounded-xl bg-well/80 border border-edge font-mono text-xs text-ink3 overflow-x-auto">
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
            <h4 className="text-xs font-semibold uppercase tracking-wider text-acc-purple flex items-center gap-1.5">
              <Terminal className="w-4 h-4" /> 3. Test Endpoints Directly via Terminal (cURL)
            </h4>

            {/* Test Start */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-ink4">
                <span>Start Session: <code className="text-acc-emerald-soft">POST /api/sitting/start</code></span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(sampleStartCurl, 'start')}
                  className="inline-flex items-center gap-1 text-[11px] text-ink4 hover:text-ink-bright"
                >
                  {copiedCurl === 'start' ? <Check className="w-3.5 h-3.5 text-acc-emerald" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCurl === 'start' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="p-2.5 rounded-lg bg-well/80 border border-edge text-[11px] font-mono text-ink3 overflow-x-auto">
                {sampleStartCurl}
              </pre>
            </div>

            {/* Test Stop */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-ink4">
                <span>Stop Session: <code className="text-acc-rose-soft">POST /api/sitting/stop</code></span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(sampleStopCurl, 'stop')}
                  className="inline-flex items-center gap-1 text-[11px] text-ink4 hover:text-ink-bright"
                >
                  {copiedCurl === 'stop' ? <Check className="w-3.5 h-3.5 text-acc-emerald" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCurl === 'stop' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="p-2.5 rounded-lg bg-well/80 border border-edge text-[11px] font-mono text-ink3 overflow-x-auto">
                {sampleStopCurl}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-edge flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-chip text-ink-bright hover:bg-edge-strong transition-colors active:scale-[0.96]"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
}
