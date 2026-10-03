#!/usr/bin/env node
/**
 * ESP8266 HTTP Device Simulator
 * ─────────────────────────────
 * Simulates the sitting-tracker device against the backend's HTTP telemetry
 * endpoint so you can test the full session lifecycle without hardware.
 * Uses the same flow as the real firmware: one authenticated state-snapshot
 * POST every 2.5s to POST /api/sitting/heartbeat (Bearer DEVICE_TOKEN).
 *
 * Usage (from backend/ — or anywhere, it loads backend/.env for the token):
 *   node scripts/device-simulator.mjs <command> [options]
 *
 * Commands (one-shot unless noted):
 *   sit        alias for `attentive` — snapshot POST opens/keeps a session
 *   relax      snapshot POST with state "relaxing" (< 8 cm on the real device)
 *   attentive  snapshot POST with state "attentive" (8.5–45 cm)
 *   vacant     snapshot POST with state "vacant" — closes the active session
 *   away       alias for `vacant`
 *   stream     emulate the real device: POST a snapshot every 2.5s forever
 *              (Ctrl+C to stop). Keeps last_heartbeat_at fresh so the
 *              /status stale-check never fires. --state/--distance to override.
 *   sensor     distance-only snapshots cycling through every posture band
 *              (relaxing / attentive / deadband / vacant / invalid) — watch
 *              the dashboard distance update
 *   crash      one sitting snapshot, then stop posting entirely (simulates
 *              power-off — the session is auto-closed by the /status
 *              stale-check ~30s after the next dashboard/status poll)
 *   reconnect  sit → 3s of silence (simulated dropout) → sit again → verifies
 *              NO duplicate session was created
 *   badtoken   POST with an invalid token (expect 401/403)
 *   malformed  invalid JSON + invalid state (expect 400), then a valid POST
 *
 * Options:
 *   --url http://localhost:4000      (default; or API_URL env)
 *   --token <token>                  (default: DEVICE_TOKEN env or backend/.env)
 *   --id sitting-tracker-01          (default: DEVICE_ID env)
 *   --state attentive                (stream state override)
 *   --distance 20.0                  (stream distance override)
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load backend/.env (for DEVICE_TOKEN) relative to this script, not cwd
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const args = process.argv.slice(2);
const command = args[0];

const url = (args.find((a) => a.startsWith('--url='))?.split('=')[1]) || process.env.API_URL || 'http://localhost:4000';
const token = (args.find((a) => a.startsWith('--token='))?.split('=')[1]) || process.env.DEVICE_TOKEN || '';
const deviceId = (args.find((a) => a.startsWith('--id='))?.split('=')[1]) || process.env.DEVICE_ID || 'sitting-tracker-01';
const streamState = (args.find((a) => a.startsWith('--state='))?.split('=')[1]) || 'attentive';
const streamDistance = Number(args.find((a) => a.startsWith('--distance='))?.split('=')[1]) || 20.0;

const TELEMETRY_INTERVAL_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(tag, obj) {
  console.log(`[${tag}]`, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

/**
 * POST one telemetry snapshot, exactly like the firmware.
 * `state` and `distance` may be undefined (heartbeat-only POST).
 */
async function postTelemetry({ state, distance, tokenOverride } = {}) {
  const body = { deviceId };
  if (distance !== undefined) body.distance = distance;
  if (state !== undefined) body.state = state;
  body.timestamp = Math.floor(Date.now() / 1000);

  const res = await fetch(`${url}/api/sitting/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenOverride ?? token}`,
    },
    body: JSON.stringify(body),
  });

  let resBody;
  try { resBody = await res.json(); } catch { resBody = await res.text(); }
  log(`${deviceId} → ${res.status}`, resBody);
  return { status: res.status, body: resBody };
}

async function fetchStatus() {
  const res = await fetch(`${url}/api/sitting/status`);
  return res.json();
}

const DEFAULT_DISTANCE = { relax: 5.0, attentive: 20.0, vacant: 60.0 };

async function oneShot(state) {
  const { status } = await postTelemetry({ state, distance: DEFAULT_DISTANCE[state] });
  if (status !== 200) process.exit(1);
  await sleep(200);
  process.exit(0);
}

async function main() {
  const valid = ['sit', 'away', 'relax', 'attentive', 'vacant', 'stream', 'sensor', 'crash', 'reconnect', 'badtoken', 'malformed'];
  if (!command || !valid.includes(command)) {
    console.log(`Usage: node scripts/device-simulator.mjs <${valid.join('|')}> [--url=...] [--token=...] [--id=...] [--state=...] [--distance=...]`);
    process.exit(1);
  }
  if (!token && command !== 'malformed') {
    console.error('No token. Pass --token=<DEVICE_TOKEN>, set DEVICE_TOKEN, or add it to backend/.env.');
    process.exit(1);
  }
  console.log(`Simulating device "${deviceId}" against ${url}`);

  if (command === 'sit' || command === 'attentive') return oneShot('attentive');
  if (command === 'relax') return oneShot('relaxing');
  if (command === 'vacant' || command === 'away') return oneShot('vacant');

  if (command === 'stream') {
    console.log(`Streaming state snapshots every ${TELEMETRY_INTERVAL_MS}ms — Ctrl+C to stop.`);
    console.log('Watch the dashboard: distance + status update live, the session timer keeps ticking,');
    console.log('and last_heartbeat_at stays fresh (no stale-check auto-close).');
    while (true) {
      try {
        await postTelemetry({ state: streamState, distance: streamDistance });
      } catch (err) {
        console.error(`[${deviceId}] POST failed (${err.message}) — sensing continues, retrying next cycle`);
      }
      await sleep(TELEMETRY_INTERVAL_MS);
    }
  }

  if (command === 'sensor') {
    console.log('Sending distance-only snapshots every 2s for 10s (watch the dashboard distance / SSE stream)...');
    // Covers each posture band: relaxing (<8), attentive (8.5–45), deadband
    // (8–8.5), vacant (>45), invalid (sensor timeout = -1.0)
    const readings = [5.0, 20.0, 8.2, 60.0, -1.0];
    for (const distance of readings) {
      await postTelemetry({ distance });
      await sleep(2000);
    }
    process.exit(0);
  }

  if (command === 'crash') {
    await postTelemetry({ state: 'attentive', distance: 20.0 });
    await sleep(300);
    console.log('Simulator exited without sending further snapshots (simulated power-off).');
    console.log('The active session is left open and will be auto-closed by the /status stale-check');
    console.log('(~30s) the next time the dashboard or a status poll runs.');
    process.exit(0);
  }

  if (command === 'reconnect') {
    console.log('--- Phase 0: vacant (fresh start — reports the desk empty, as a device that left would) ---');
    await postTelemetry({ state: 'vacant', distance: DEFAULT_DISTANCE.vacant });
    await sleep(500);

    console.log('--- Phase 1: sit (opens a session) ---');
    await postTelemetry({ state: 'attentive', distance: 20.0 });
    const before = await fetchStatus();
    const sessionBefore = before.activeSession?.id ?? null;
    log('status', { sessionId: sessionBefore, startedAt: before.activeSession?.started_at });
    if (!sessionBefore) {
      console.log('FAILED: no session opened — is another device/report already active?');
      process.exit(1);
    }

    console.log('--- Phase 2: 3s of silence (simulated dropout — well inside the grace window) ---');
    await sleep(3000);

    console.log('--- Phase 3: sit again (device back online, current-state snapshot) ---');
    await postTelemetry({ state: 'attentive', distance: 20.0 });
    const after = await fetchStatus();
    const sessionAfter = after.activeSession?.id ?? null;

    const openSessionsToday = (after.todaySessions || []).filter((s) => s.ended_at === null).length;
    if (sessionAfter && sessionAfter === sessionBefore) {
      console.log('OK: same session continues after the dropout — no duplicate session created');
    } else {
      console.log(`UNEXPECTED: session before=${sessionBefore} after=${sessionAfter}`);
    }
    if (openSessionsToday <= 1) {
      console.log(`OK: ${openSessionsToday} open session(s) — no duplicates`);
    } else {
      console.log(`FAILED: ${openSessionsToday} open sessions — duplicates detected`);
      process.exit(1);
    }
    console.log('--- Phase 4: vacant (clean stop) ---');
    await postTelemetry({ state: 'vacant', distance: DEFAULT_DISTANCE.vacant });
    await sleep(200);
    process.exit(0);
  }

  if (command === 'badtoken') {
    const { status } = await postTelemetry({ state: 'attentive', distance: 20.0, tokenOverride: 'definitely-not-the-right-token' });
    console.log(status === 401 || status === 403
      ? 'OK: rejected with HTTP ' + status
      : `FAILED: expected 401/403, got ${status}`);
    process.exit(status === 401 || status === 403 ? 0 : 1);
  }

  if (command === 'malformed') {
    console.log('→ raw garbage body (not JSON)');
    const res1 = await fetch(`${url}/api/sitting/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: 'this is not json{{{',
    });
    log(`← ${res1.status}`, await res1.json());
    console.log('→ invalid state value');
    const res2 = await postTelemetry({ state: 'nonsense' });
    console.log((res1.status === 400 && res2.status === 400)
      ? 'OK: both rejected with 400, server alive'
      : `FAILED: expected 400s, got ${res1.status} and ${res2.status}`);
    const res3 = await postTelemetry({ state: 'attentive', distance: 20.0 });
    console.log(res3.status === 200 ? 'OK: valid POST still accepted afterwards' : 'FAILED: server unhappy after malformed input');
    process.exit(res1.status === 400 && res2.status === 400 && res3.status === 200 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});
