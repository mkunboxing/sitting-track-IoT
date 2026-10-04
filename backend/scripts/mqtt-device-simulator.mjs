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
 *   sit          alias for `attentive` — one snapshot (opens/keeps a session)
 *   relax        one snapshot with state "relaxing"
 *   vacant       one snapshot with state "vacant" — closes the active session
 *   away         alias for `vacant`
 *   stream       emulate the real device: publish a snapshot every 2.5s forever
 *                (Ctrl+C to stop). --state/--distance to override.
 *   crash        one sitting snapshot, then exit WITHOUT a clean disconnect —
 *                the broker fires the LWT "offline" after the keepalive window
 *                (~22 s) — watch the backend mark the device offline
 *   graceful     one snapshot, then a clean MQTT DISCONNECT (publishes nothing
 *                special — the backend keeps its last reading until it ages out)
 *   badjson      publishes a non-JSON payload (backend should drop it and stay
 *                healthy), then a valid snapshot
 *   start-event  publish a confirmed SESSION_STARTED session event to the
 *                events topic (QoS 1, waits for the broker PUBACK) — the
 *                offline-backend test tool: publish these while the backend
 *                is DOWN, then start it and watch it replay them
 *   end-event    publish a confirmed SESSION_ENDED session event (QoS 1)
 *
 * Options:
 *   --url mqtts://host:8883     (default: MQTT_BROKER_URL env or backend/.env)
 *   --username <user>           (default: MQTT_USERNAME env or backend/.env)
 *   --password <pass>           (default: MQTT_PASSWORD env or backend/.env)
 *   --id sitting-tracker-01     (default: DEVICE_ID env)
 *   --state attentive           (stream / start-event state override)
 *   --distance 20.0             (stream distance override)
 *   --event-id <id>             (session events: reuse the SAME eventId to
 *                                verify the backend drops duplicate QoS 1
 *                                deliveries idempotently)
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
const overrideEventId = args.find((a) => a.startsWith('--event-id='))?.split('=')[1];

const TELEMETRY_TOPIC = `sitting/device/${deviceId}/telemetry`;
const STATUS_TOPIC = `sitting/device/${deviceId}/status`;
const EVENTS_TOPIC = `sitting/device/${deviceId}/events`;

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

/**
 * One confirmed session event — same JSON fields as the firmware publishes to
 * the events topic (unique eventId + device/ESP-style epoch-seconds timestamp).
 */
function sessionEvent(type, state, eventIdOverride) {
  const eventId = eventIdOverride || `${deviceId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    eventId,
    payload: JSON.stringify({
      eventId,
      type,
      deviceId,
      state,
      timestamp: Math.floor(Date.now() / 1000),
    }),
  };
}

async function main() {
  const valid = ['sit', 'away', 'relax', 'attentive', 'vacant', 'stream', 'crash', 'graceful', 'badjson', 'start-event', 'end-event'];
  if (!command || !valid.includes(command)) {
    console.log(`Usage: node scripts/mqtt-device-simulator.mjs <${valid.join('|')}> [--url=...] [--username=...] [--password=...] [--id=...] [--state=...] [--distance=...] [--event-id=...]`);
    process.exit(1);
  }
  if (!brokerUrl) {
    console.error('No broker URL. Pass --url=mqtts://host:8883, set MQTT_BROKER_URL, or add it to backend/.env.');
    process.exit(1);
  }
  console.log(`Simulating device "${deviceId}" against ${brokerUrl}`);
  console.log(`  telemetry topic: ${TELEMETRY_TOPIC}`);
  console.log(`  status topic:    ${STATUS_TOPIC} (retained online, LWT = offline)`);
  if (command === 'start-event' || command === 'end-event') {
    console.log(`  events topic:    ${EVENTS_TOPIC} (QoS 1 — buffered by EMQX while the backend is offline)`);
  }

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

  // QoS 1 event publish — the callback fires on the broker's PUBACK, so the
  // event is safely in EMQX's queue before we exit (offline-backend test).
  const publishSessionEvent = (type, state) =>
    new Promise((resolve, reject) => {
      const { eventId, payload } = sessionEvent(type, state, overrideEventId);
      client.publish(EVENTS_TOPIC, payload, { qos: 1, retain: false }, (err) => {
        if (err) return reject(err);
        log(`${deviceId} → ${EVENTS_TOPIC} (QoS 1, PUBACK received)`, JSON.parse(payload));
        resolve(eventId);
      });
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

  if (command === 'start-event' || command === 'end-event') {
    const type = command === 'start-event' ? 'SESSION_STARTED' : 'SESSION_ENDED';
    const state = type === 'SESSION_STARTED'
      ? (['relaxing', 'attentive'].includes(streamState) ? streamState : 'attentive')
      : 'vacant';
    try {
      const eventId = await publishSessionEvent(type, state);
      console.log(`OK: event ${eventId} acknowledged by the broker.`);
      if (overrideEventId) console.log('(--event-id override used — send the SAME id again to test duplicate-drop)');
      console.log('If the backend was offline, it will process this on reconnect with the event\'s own timestamp.');
    } catch (err) {
      console.error(`Publish failed: ${err.message}`);
    }
    await sleep(200);
    client.end(false);
    process.exit(0);
  }

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
