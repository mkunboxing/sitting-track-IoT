#!/usr/bin/env node
/**
 * ESP8266 MQTT Device Simulator
 * ─────────────────────────────
 * Simulates the sitting-tracker device over MQTT (EMQX Cloud) so you can
 * verify the whole MQTT path end-to-end BEFORE reflashing the ESP8266.
 * Mimics the real firmware exactly: connects with MQTT-over-TLS + username/
 * password auth, publishes a retained "online" status, registers the LWT
 * ("offline" retained on the status topic), then publishes the SAME state
 * snapshot JSON as the HTTP heartbeat every 2.5s.
 *
 * Usage (from backend/ — or anywhere, it loads backend/.env for credentials):
 *   node scripts/mqtt-device-simulator.mjs <command> [options]
 *
 * Commands:
 *   sit        alias for `attentive` — one snapshot (opens/keeps a session)
 *   relax      one snapshot with state "relaxing"
 *   vacant     one snapshot with state "vacant" — closes the active session
 *   away       alias for `vacant`
 *   stream     emulate the real device: publish a snapshot every 2.5s forever
 *              (Ctrl+C to stop). --state/--distance to override.
 *   crash      one sitting snapshot, then exit WITHOUT a clean disconnect —
 *              the broker fires the LWT "offline" after the keepalive window
 *              (~22 s) — watch the backend mark the device offline
 *   graceful   one snapshot, then a clean MQTT DISCONNECT (publishes nothing
 *              special — the backend keeps its last reading until it ages out)
 *   badjson    publishes a non-JSON payload (backend should drop it and stay
 *              healthy), then a valid snapshot
 *
 * Options:
 *   --url mqtts://host:8883     (default: MQTT_BROKER_URL env or backend/.env)
 *   --username <user>           (default: MQTT_USERNAME env or backend/.env)
 *   --password <pass>           (default: MQTT_PASSWORD env or backend/.env)
 *   --id sitting-tracker-01     (default: DEVICE_ID env)
 *   --state attentive           (stream state override)
 *   --distance 20.0             (stream distance override)
 *
 * Env (backend/.env): MQTT_BROKER_URL, MQTT_USERNAME, MQTT_PASSWORD, DEVICE_ID
 */

import dotenv from 'dotenv';
import mqtt from 'mqtt';
import { fileURLToPath } from 'node:url';

// Load backend/.env (for MQTT credentials) relative to this script, not cwd
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const args = process.argv.slice(2);
const command = args[0];

const brokerUrl = (args.find((a) => a.startsWith('--url='))?.split('=')[1]) || process.env.MQTT_BROKER_URL || '';
const username = (args.find((a) => a.startsWith('--username='))?.split('=')[1]) || process.env.MQTT_USERNAME || '';
const password = (args.find((a) => a.startsWith('--password='))?.split('=')[1]) || process.env.MQTT_PASSWORD || '';
const deviceId = (args.find((a) => a.startsWith('--id='))?.split('=')[1]) || process.env.DEVICE_ID || 'sitting-tracker-01';
const streamState = (args.find((a) => a.startsWith('--state='))?.split('=')[1]) || 'attentive';
const streamDistance = Number(args.find((a) => a.startsWith('--distance='))?.split('=')[1]) || 20.0;

const TELEMETRY_TOPIC = `sitting/device/${deviceId}/telemetry`;
const STATUS_TOPIC = `sitting/device/${deviceId}/status`;

const TELEMETRY_INTERVAL_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(tag, obj) {
  console.log(`[${tag}]`, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

/** One telemetry snapshot — same JSON fields as the HTTP heartbeat body. */
function snapshot({ state, distance } = {}) {
  const payload = { deviceId };
  if (distance !== undefined) payload.distance = distance;
  if (state !== undefined) payload.state = state;
  payload.timestamp = Math.floor(Date.now() / 1000);
  return JSON.stringify(payload);
}

async function main() {
  const valid = ['sit', 'away', 'relax', 'attentive', 'vacant', 'stream', 'crash', 'graceful', 'badjson'];
  if (!command || !valid.includes(command)) {
    console.log(`Usage: node scripts/mqtt-device-simulator.mjs <${valid.join('|')}> [--url=...] [--username=...] [--password=...] [--id=...] [--state=...] [--distance=...]`);
    process.exit(1);
  }
  if (!brokerUrl) {
    console.error('No broker URL. Pass --url=mqtts://host:8883, set MQTT_BROKER_URL, or add it to backend/.env.');
    process.exit(1);
  }
  console.log(`Simulating device "${deviceId}" against ${brokerUrl}`);
  console.log(`  telemetry topic: ${TELEMETRY_TOPIC}`);
  console.log(`  status topic:    ${STATUS_TOPIC} (retained online, LWT = offline)`);

  const client = mqtt.connect(brokerUrl, {
    clientId: `${deviceId}-sim-${process.pid}`,
    username: username || undefined,
    password: password || undefined,
    clean: true,
    keepalive: 15, // same as the firmware — broker fires the LWT after ~1.5× keepalive
    reconnectPeriod: 5000,
    connectTimeout: 30000,
    rejectUnauthorized: true, // TLS certificate validation, like the firmware
  });

  const connected = new Promise((resolve, reject) => {
    client.on('connect', resolve);
    client.on('error', reject);
  });
  try {
    await connected;
  } catch (err) {
    console.error(`Connect failed: ${err.message}`);
    process.exit(1);
  }
  log('mqtt', `connected (clientId ${client.options.clientId})`);

  // Retained "online" + LWT "offline" — exactly like the firmware
  client.publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });
  log('mqtt', `published retained status: online (LWT: offline)`);

  const publishTelemetry = (payload) =>
    new Promise((resolve) => {
      client.publish(TELEMETRY_TOPIC, payload, { qos: 0 }, () => resolve());
    });

  const DEFAULT_DISTANCE = { relax: 5.0, attentive: 20.0, vacant: 60.0 };

  async function oneShot(state) {
    await publishTelemetry(snapshot({ state, distance: DEFAULT_DISTANCE[state] }));
    log(`${deviceId} → ${TELEMETRY_TOPIC}`, snapshot({ state, distance: DEFAULT_DISTANCE[state] }));
    await sleep(300);
    client.end(false);
    process.exit(0);
  }

  if (command === 'sit' || command === 'attentive') return oneShot('attentive');
  if (command === 'relax') return oneShot('relaxing');
  if (command === 'vacant' || command === 'away') return oneShot('vacant');

  if (command === 'stream') {
    console.log(`Streaming state snapshots every ${TELEMETRY_INTERVAL_MS}ms — Ctrl+C to stop.`);
    console.log('Watch the backend logs for [TELEMETRY mqtt] lines and the dashboard updating live.');
    while (true) {
      await publishTelemetry(snapshot({ state: streamState, distance: streamDistance }));
      log(`${deviceId} → ${TELEMETRY_TOPIC}`, snapshot({ state: streamState, distance: streamDistance }));
      await sleep(TELEMETRY_INTERVAL_MS);
    }
  }

  if (command === 'crash') {
    await publishTelemetry(snapshot({ state: 'attentive', distance: 20.0 }));
    await sleep(300);
    console.log('Simulator exiting WITHOUT a clean disconnect (simulated power-off).');
    console.log('The broker fires the LWT "offline" after ~1.5× keepalive (~22s) —');
    console.log('watch the backend log "[TELEMETRY] ... marked offline (MQTT LWT)".');
    process.exit(0); // hard exit = TCP dropped without DISCONNECT
  }

  if (command === 'graceful') {
    await publishTelemetry(snapshot({ state: 'attentive', distance: 20.0 }));
    await sleep(300);
    console.log('Clean disconnect (DISCONNECT packet — no LWT fires).');
    client.end(false, () => process.exit(0));
    return;
  }

  if (command === 'badjson') {
    console.log('→ non-JSON garbage on the telemetry topic (backend should drop it)');
    await publishTelemetry('this is not json{{{');
    await sleep(500);
    console.log('→ valid snapshot afterwards (server must still process it)');
    await publishTelemetry(snapshot({ state: 'attentive', distance: 20.0 }));
    console.log('OK: check backend logs — the garbage was dropped, the snapshot processed.');
    await sleep(300);
    client.end(false);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});
