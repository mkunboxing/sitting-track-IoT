import mqtt from 'mqtt';
import { markDeviceOffline } from './telemetryStore';
import { parseTelemetryPayload, processDeviceTelemetry } from './telemetryProcessor';
import { handleSessionEventMessage } from './sessionEvents';
import { getSessionStateTopic } from './sessionState';

/**
 * MQTT subscriber (EMQX Cloud) — the device-telemetry transport.
 *
 *   ESP8266 ──MQTT over TLS (8883)──► EMQX Cloud ◄──MQTT over TLS── this backend
 *
 * The device publishes:
 *   - snapshots to `sitting/device/<deviceId>/telemetry`
 *     (deviceId, distance, state, timestamp, stateForMs)
 *   - a retained "online" to `sitting/device/<deviceId>/status` on every
 *     connect, with a retained Last-Will-and-Testament "offline" that the
 *     broker publishes for it if the device vanishes without a clean
 *     disconnect (power-off, Wi-Fi loss).
 *   - CONFIRMED session transitions (SESSION_STARTED / SESSION_ENDED) as
 *     QoS 1 events to `sitting/device/<deviceId>/events` — processed by
 *     lib/sessionEvents.ts (idempotent, device-timestamped) so session
 *     history survives this backend being offline (Render deploys,
 *     restarts): the broker queues them and replays on reconnect.
 *
 * This backend subscribes with wildcards and feeds every telemetry message
 * into the shared pipeline (parseTelemetryPayload → processDeviceTelemetry),
 * so session detection, stateForMs backdating, heartbeat throttling and
 * stale-check behavior are all driven from here.
 *
 * Persistent session (offline buffering): this backend connects with a
 * STABLE client id, clean: false and a sessionExpiryInterval (MQTT 5), so
 * EMQX keeps its subscription session alive while Render is down and queues
 * every QoS 1 message on the subscribed topics for replay on reconnect.
 * Telemetry snapshots are published by the device at QoS 0, so they are NOT
 * queued — they stay fire-and-forget exactly as before; only the QoS 1
 * session events (and device status messages) are buffered. The client id
 * must be stable across restarts for this to work — two backend instances
 * running simultaneously need distinct MQTT_CLIENT_IDs or they will keep
 * taking over each other's session.
 *
 * Outbound: the backend also PUBLISHES a retained QoS 1 session-state
 * snapshot (active session, previous session, today's date-aware totals) to
 * sitting/device/<deviceId>/session for the mobile MQTT app — built from the
 * same Supabase data as the dashboard API by lib/sessionStatePublisher.ts.
 * Retained delivery gives the app the latest state the instant it
 * subscribes, even while this backend is offline.
 *
 * An LWT "offline" marks the device offline in the in-memory telemetry store
 * (cached reading dropped, remembered state cleared) — the same state a 30 s
 * telemetry silence produces; the active session, if any, is still closed by
 * the existing /status stale-check at last-contact time.
 *
 * Configuration (all via environment variables, see .env.example):
 *   MQTT_BROKER_URL       mqtts://<host>:8883   (unset → MQTT disabled)
 *   MQTT_USERNAME         broker credentials created in the EMQX Cloud console
 *   MQTT_PASSWORD
 *   MQTT_CLIENT_ID        optional, defaults to smart-tracking-backend —
 *                         MUST stay stable (persistent session); set a
 *                         distinct value per running backend instance
 *   MQTT_TELEMETRY_TOPIC  optional, defaults to sitting/device/+/telemetry
 *   MQTT_STATUS_TOPIC     optional, defaults to sitting/device/+/status
 *   MQTT_EVENTS_TOPIC     optional, defaults to sitting/device/+/events
 *   MQTT_SESSION_EXPIRY   optional seconds the broker keeps the offline
 *                         session (default 7 days)
 *   MQTT_CA_CERT          optional PEM bundle when the broker uses a private CA
 *                         (EMQX Cloud's *.emqxsl.com certificate chains to
 *                         DigiCert Global Root G2, which Node's built-in roots
 *                         already trust; "\n" escapes are unescaped)
 *
 * TLS certificate validation is never disabled (rejectUnauthorized stays
 * true). Reconnection is automatic: mqtt.js retries every reconnectPeriod
 * and re-subscribes on every successful connect.
 */

interface MqttConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId: string;
  telemetryTopic: string;
  statusTopic: string;
  eventsTopic: string;
  sessionExpirySeconds: number;
  caCert?: string;
}

let mqttClient: mqtt.MqttClient | null = null;
let config: MqttConfig | null = null;

export interface MqttStatus {
  enabled: boolean;
  connected: boolean;
  brokerUrl: string | null;
  topics: string[] | null;
}

/** Lightweight health info (surfaced by GET /health). */
export function getMqttStatus(): MqttStatus {
  return {
    enabled: mqttClient !== null,
    connected: mqttClient?.connected ?? false,
    brokerUrl: config?.brokerUrl ?? null,
    topics: config ? [config.telemetryTopic, config.statusTopic, config.eventsTopic] : null,
  };
}

// ── Session-state publishing (mobile app) ───────────────────────────────────
// The backend PUBLISHES (it does not subscribe) a retained QoS 1 snapshot of
// the current sitting state to sitting/device/<deviceId>/session — see
// lib/sessionStatePublisher.ts, which builds the payload from the same
// Supabase data the dashboard API serves. Retained means a mobile MQTT app
// receives the latest state the moment it subscribes, even while this
// backend is offline.

/** Fired on every successful broker connect (first connect + each reconnect). */
type OnConnectedCallback = () => void;
const onConnectedCallbacks: OnConnectedCallback[] = [];

/**
 * Register a callback that runs after every successful (re)connect — used by
 * the session-state publisher to refresh the retained snapshot with a fresh
 * Supabase read (covers backend restarts, Render wake-ups and reconnects).
 */
export function registerOnConnected(cb: OnConnectedCallback): void {
  onConnectedCallbacks.push(cb);
}

function runOnConnectedCallbacks(): void {
  for (const cb of onConnectedCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('[MQTT] on-connected callback failed:', err);
    }
  }
}

/**
 * Publish one session-state snapshot (retained, QoS 1). Callers build the
 * payload via lib/sessionState.ts. Returns false when MQTT is disabled.
 * While the client is temporarily disconnected mqtt.js buffers the publish
 * and flushes it on reconnect; the retained copy on the broker is then
 * replaced with this fresher state.
 */
export function publishSessionStateMessage(payload: Record<string, unknown>): boolean {
  if (!mqttClient) return false;

  const topic = getSessionStateTopic();
  const json = JSON.stringify(payload);
  mqttClient.publish(topic, json, { qos: 1, retain: true }, (err) => {
    if (err) {
      console.error(`[MQTT] Session-state publish to ${topic} failed:`, err.message);
    } else {
      console.log(`[MQTT] Session-state retained → ${topic} (${json.length} bytes)`);
    }
  });
  return true;
}

const DEFAULT_SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days of offline buffering

function loadConfig(): MqttConfig | null {
  const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
  if (!brokerUrl) return null;

  const caRaw = process.env.MQTT_CA_CERT?.trim();
  return {
    brokerUrl,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    // Stable across restarts — the persistent (non-clean) session and EMQX's
    // offline event queue are keyed on this id. Never embed pid/random here.
    clientId: process.env.MQTT_CLIENT_ID?.trim() || 'smart-tracking-backend',
    telemetryTopic: process.env.MQTT_TELEMETRY_TOPIC?.trim() || 'sitting/device/+/telemetry',
    statusTopic: process.env.MQTT_STATUS_TOPIC?.trim() || 'sitting/device/+/status',
    eventsTopic: process.env.MQTT_EVENTS_TOPIC?.trim() || 'sitting/device/+/events',
    sessionExpirySeconds: (() => {
      const parsed = Number(process.env.MQTT_SESSION_EXPIRY?.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_EXPIRY_SECONDS;
    })(),
    caCert: caRaw ? caRaw.replace(/\\n/g, '\n') : undefined,
  };
}

/**
 * Extract the deviceId from a topic that matches a wildcard subscription
 * pattern like `sitting/device/+/telemetry`. Returns null when the topic
 * doesn't match the pattern.
 */
function deviceIdFromTopic(topic: string, pattern: string): string | null {
  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');
  if (patternParts.length !== topicParts.length) return null;

  let deviceId: string | null = null;
  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i];
    if (seg === '+') {
      // The + sits at the deviceId position in our patterns
      deviceId = topicParts[i];
      if (!deviceId) return null;
    } else if (seg !== topicParts[i]) {
      return null;
    }
  }
  return deviceId;
}

async function handleTelemetryMessage(topic: string, payload: Buffer, deviceId: string): Promise<void> {
  const text = payload.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[MQTT] ${topic}: invalid JSON payload dropped (${text.slice(0, 80)})`);
    return;
  }

  const parsed = parseTelemetryPayload(json);
  if (!parsed.ok) {
    console.error(`[MQTT] ${topic}: invalid telemetry dropped — ${parsed.error}`);
    return;
  }

  // The topic is authoritative for identity (it's what the subscription
  // matches on); the payload's deviceId is advisory — warn on a mismatch.
  const bodyDeviceId = (json as { deviceId?: unknown }).deviceId;
  if (typeof bodyDeviceId === 'string' && bodyDeviceId.trim() !== deviceId) {
    console.warn(`[MQTT] ${topic}: payload deviceId "${bodyDeviceId}" != topic deviceId "${deviceId}" — using topic`);
  }

  const result = await processDeviceTelemetry(deviceId, parsed.snapshot);
  if (!result.ok) {
    console.error(`[MQTT] ${topic}: telemetry processing failed — ${result.error}`);
  }
}

async function handleStatusMessage(topic: string, payload: Buffer, deviceId: string): Promise<void> {
  const status = payload.toString('utf8').trim();
  if (status === 'offline') {
    // LWT fired: device vanished without a clean disconnect. Same in-memory
    // effect as the HTTP 30 s contact gap; session close stays with the
    // /status stale-check (unchanged behavior).
    markDeviceOffline(deviceId);
  } else if (status === 'online') {
    console.log(`[MQTT] ${topic}: device online — telemetry will flow on the telemetry topic`);
  } else {
    console.warn(`[MQTT] ${topic}: unknown status payload "${status.slice(0, 40)}" ignored`);
  }
}

export function startMqttClient(): void {
  if (mqttClient) return;

  config = loadConfig();
  if (!config) {
    console.log('[MQTT] MQTT_BROKER_URL not set — MQTT disabled (HTTP telemetry only)');
    return;
  }

  console.log(`[MQTT] Connecting to ${config.brokerUrl} as ${config.clientId} ...`);

  mqttClient = mqtt.connect(config.brokerUrl, {
    clientId: config.clientId,
    username: config.username,
    password: config.password,
    // Persistent session (MQTT 5): clean start = false + sessionExpiryInterval
    // keep the subscription session on the broker while this backend is
    // offline, so EMQX buffers QoS 1 session events and replays them on
    // reconnect. Telemetry (QoS 0) is never buffered — unchanged behavior.
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: config.sessionExpirySeconds },
    keepalive: 60,
    // Automatic reconnect: mqtt.js retries with this backoff and, on every
    // successful connect, re-subscribes to the topics registered below.
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    // TLS certificate validation is never disabled. EMQX Cloud terminates
    // TLS with a certificate chaining to DigiCert Global Root G2, which
    // Node's built-in roots trust; MQTT_CA_CERT can supply a bundle for
    // private CAs.
    rejectUnauthorized: true,
    ...(config.caCert ? { ca: config.caCert } : {}),
  });

  mqttClient.on('connect', () => {
    console.log(
      `[MQTT] Connected to broker — subscribing to ${config!.telemetryTopic} + ${config!.statusTopic} + ${config!.eventsTopic}`
    );
    mqttClient!.subscribe(
      [config!.telemetryTopic, config!.statusTopic, config!.eventsTopic],
      { qos: 1 },
      (err) => {
        if (err) console.error('[MQTT] Subscribe failed:', err.message);
      }
    );
    // Refresh the mobile app's retained session state on every (re)connect —
    // the snapshot is rebuilt from Supabase with the CURRENT date, so a
    // backend that slept through midnight republishes correct new-day totals.
    runOnConnectedCallbacks();
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Reconnecting to broker ...');
  });

  mqttClient.on('close', () => {
    // Fired during every reconnect cycle; keep the log quiet-ish but present
    console.log('[MQTT] Connection closed');
  });

  mqttClient.on('error', (err) => {
    // mqtt.js emits 'error' on failed attempts too; reconnect continues regardless
    console.error('[MQTT] Error:', err.message);
  });

  mqttClient.on('message', (topic, payload) => {
    const telemetryDeviceId = deviceIdFromTopic(topic, config!.telemetryTopic);
    if (telemetryDeviceId !== null) {
      handleTelemetryMessage(topic, payload, telemetryDeviceId).catch((err) => {
        console.error(`[MQTT] Unhandled error on ${topic}:`, err);
      });
      return;
    }

    const statusDeviceId = deviceIdFromTopic(topic, config!.statusTopic);
    if (statusDeviceId !== null) {
      handleStatusMessage(topic, payload, statusDeviceId).catch((err) => {
        console.error(`[MQTT] Unhandled error on ${topic}:`, err);
      });
      return;
    }

    const eventsDeviceId = deviceIdFromTopic(topic, config!.eventsTopic);
    if (eventsDeviceId !== null) {
      handleSessionEventMessage(topic, payload, eventsDeviceId).catch((err) => {
        console.error(`[MQTT] Unhandled error on ${topic}:`, err);
      });
      return;
    }

    console.warn(`[MQTT] Ignoring message on unexpected topic ${topic}`);
  });
}
