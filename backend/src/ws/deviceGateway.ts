import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  canUseDatabase,
  setPosture,
  closeActiveSession,
  touchActiveSessionHeartbeat,
} from '../lib/sessionService';
import { eventBroadcaster } from '../lib/eventBroadcaster';

/**
 * Device WebSocket Gateway
 * ────────────────────────
 * Persistent connection for the ESP8266 device, replacing the old HTTP
 * start/stop/heartbeat calls. Connection state replaces the HTTP heartbeat:
 * - A connected, authenticated device keeps last_heartbeat_at fresh via
 *   server-side ping/pong ticks (so /status stale-check keeps working).
 * - An unexpected disconnect does NOT close the session immediately:
 *   managed platforms force-close long-lived WebSocket connections (e.g.
 *   Cloud Run's request timeout), so the session is left active and is
 *   auto-closed by /status's stale-check (30s, ended_at = last contact)
 *   only if the device does not reconnect. Fast reconnects therefore
 *   continue the same session with no fragmentation.
 *
 * Protocol (JSON text frames):
 *   ESP → Backend:
 *     { "type": "authenticate", "deviceId": "...", "token": "..." }
 *     { "type": "state_change", "deviceId": "...", "state": "relaxing" | "attentive" | "vacant" }
 *     { "type": "sensor",       "deviceId": "...", "distance": 75.4 }
 *   Backend → ESP:
 *     { "type": "authenticated", "deviceId": "..." }
 *     { "type": "auth_error", "error": "..." }                (then close 4001)
 *     { "type": "ack", "state": "...", "result": "...", "durationSeconds"?: n }
 *     { "type": "error", "message": "..." }                   (connection stays open)
 *
 * Close codes:
 *   4001 authentication failed / timeout
 *   4000 connection replaced by a newer connection for the same deviceId
 */

const WS_PATH = '/ws/device';
const AUTH_TIMEOUT_MS = 10_000; // must authenticate within 10s of connecting
// Stale-connection detection + liveness touch cadence. Must stay well under
// the /status stale-check threshold (30s) so a connected device's
// last_heartbeat_at never looks stale between touches.
const PING_INTERVAL_MS = 10_000;

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string | null;
  authenticated: boolean;
  /** Set when a newer connection for the same deviceId takes over; its close must not touch sessions. */
  superseded: boolean;
  isAlive: boolean;
  authTimer: NodeJS.Timeout | null;
}

/** deviceId → current live connection. Single registry of connected devices. */
const devices = new Map<string, DeviceConnection>();

/** deviceId → latest sensor telemetry. In-memory only (never stored in the DB). */
const latestSensorData = new Map<string, { distanceCm: number; updatedAt: string }>();

export function getOnlineDeviceCount(): number {
  return devices.size;
}

export function getOnlineDeviceIds(): string[] {
  return Array.from(devices.keys());
}

/**
 * Most recent sensor reading across devices (single-device system today).
 * Used by /status so a freshly loaded dashboard shows the last known
 * distance immediately, and by /health for debugging.
 */
export function getLatestSensorReading(): { distanceCm: number; updatedAt: string } | null {
  let latest: { distanceCm: number; updatedAt: string } | null = null;
  for (const reading of latestSensorData.values()) {
    if (!latest || reading.updatedAt > latest.updatedAt) latest = reading;
  }
  return latest;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err: unknown) {
      console.error('[WS] Failed to send message:', err);
    }
  }
}

/**
 * Attach the device gateway to the existing HTTP server.
 * The Express app keeps serving HTTP; WebSocket upgrades on WS_PATH are
 * handled by `ws`.
 */
export function attachDeviceGateway(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 4 * 1024 });

  wss.on('error', (err: Error) => {
    console.error('[WS] Server error:', err.message);
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const conn: DeviceConnection = {
      ws,
      deviceId: null,
      authenticated: false,
      superseded: false,
      isAlive: true,
      authTimer: null,
    };
    // Link the connection state onto the socket so the ping loop can find it
    (ws as WebSocket & { __conn?: DeviceConnection }).__conn = conn;
    const peer = req.socket.remoteAddress ?? 'unknown';
    console.log(`[WS] ESP connected (${peer}) — awaiting authentication`);

    // Authentication deadline: unauthenticated sockets are dropped
    conn.authTimer = setTimeout(() => {
      if (!conn.authenticated) {
        console.log('[WS] Authentication timeout — closing connection');
        sendJson(ws, { type: 'auth_error', error: 'Authentication timeout' });
        ws.close(4001, 'authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      conn.isAlive = true;
    });

    ws.on('message', (data: unknown, isBinary: boolean) => {
      // Never let a bad message crash the server
      try {
        if (isBinary) {
          sendJson(ws, { type: 'error', message: 'Binary frames are not supported; send JSON text' });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          console.log('[WS] Malformed JSON received — ignored');
          sendJson(ws, { type: 'error', message: 'Malformed JSON' });
          return;
        }

        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).type !== 'string') {
          sendJson(ws, { type: 'error', message: 'Message must be a JSON object with a "type" field' });
          return;
        }

        handleMessage(conn, parsed as Record<string, unknown>);
      } catch (err: unknown) {
        console.error('[WS] Error handling message:', err);
        sendJson(ws, { type: 'error', message: 'Internal error processing message' });
      }
    });

    ws.on('error', (err: Error) => {
      console.error(`[WS] Connection error${conn.deviceId ? ` (${conn.deviceId})` : ''}:`, err.message);
      // 'close' fires after 'error' — all cleanup lives there
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }

      if (!conn.authenticated || !conn.deviceId) {
        console.log(`[WS] Unauthenticated connection closed (code ${code})`);
        return;
      }

      // A replaced connection's close must NOT close sessions — the new
      // connection has already taken over the deviceId slot.
      if (conn.superseded || devices.get(conn.deviceId) !== conn) {
        console.log(`[WS] Superseded connection for ${conn.deviceId} closed (code ${code})`);
        return;
      }

      devices.delete(conn.deviceId);
      console.log(`[WS] ESP disconnected (${conn.deviceId}, code ${code}${reason.length ? `, reason: ${reason.toString()}` : ''})`);

      // Grace-based disconnect handling. We do NOT close the session here:
      // managed platforms (e.g. Cloud Run's request timeout) force-close
      // long-lived WebSocket connections periodically, and closing the
      // session on every forced drop would fragment sitting sessions.
      //
      // Instead, last_heartbeat_at stops being touched and the /status
      // endpoint's stale-check (30s) closes the session — with ended_at set
      // to the last-contact time — if the device does not return. A device
      // that reconnects and syncs "sitting" within the grace window finds
      // its session still active (already_active) and the session continues
      // unbroken.
      console.log(`[WS] Waiting for reconnect — any active session auto-closes via stale-check if the device stays offline`);
    });
  });

  // Stale-connection detection + liveness touch for the active session.
  // Replaces the firmware's HTTP heartbeat: a connected device pongs every
  // 30s, and last_heartbeat_at stays fresh so /status never auto-closes a
  // session for a device that is actually online.
  const pingInterval = setInterval(() => {
    for (const conn of wss.clients) {
      // wss.clients yields WebSocket; recover our state via extension fields
      const deviceConn = (conn as WebSocket & { __conn?: DeviceConnection }).__conn;
      if (deviceConn) {
        if (!deviceConn.isAlive) {
          console.log(`[WS] Terminating stale connection${deviceConn.deviceId ? ` (${deviceConn.deviceId})` : ''}`);
          deviceConn.ws.terminate();
          continue;
        }
        deviceConn.isAlive = false;
        deviceConn.ws.ping();
      }
    }
    if (devices.size > 0 && canUseDatabase()) {
      touchActiveSessionHeartbeat().catch((err: unknown) =>
        console.error('[WS] Heartbeat touch error:', err)
      );
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref();

  console.log(`[WS] Device gateway ready at ${WS_PATH}`);
  return wss;
}

/**
 * Route a parsed message. `conn` is guaranteed authenticated before any
 * state-changing message is accepted.
 */
function handleMessage(conn: DeviceConnection, msg: Record<string, unknown>): void {
  const type = msg.type;

  // ── Authentication ────────────────────────────────────────────────
  if (type === 'authenticate') {
    handleAuthenticate(conn, msg);
    return;
  }

  // Every other message type requires an authenticated device
  if (!conn.authenticated || !conn.deviceId) {
    console.log('[WS] Rejected message from unauthenticated connection');
    sendJson(conn.ws, { type: 'error', message: 'Not authenticated. Send {"type":"authenticate",...} first.' });
    conn.ws.close(4001, 'not authenticated');
    return;
  }

  // Guard against a device spoofing another deviceId
  if (typeof msg.deviceId === 'string' && msg.deviceId !== conn.deviceId) {
    console.log(`[WS] deviceId mismatch from ${conn.deviceId}: claimed ${String(msg.deviceId)}`);
    sendJson(conn.ws, { type: 'error', message: 'deviceId does not match authenticated device' });
    return;
  }

  switch (type) {
    case 'state_change':
      handleStateChange(conn, msg);
      return;
    case 'sensor': {
      // Optional telemetry — firmware sends one reading every few seconds.
      // Cached in memory and pushed to dashboards over SSE; never stored in
      // the database.
      const distance = Number(msg.distance);
      if (!Number.isFinite(distance)) {
        sendJson(conn.ws, { type: 'error', message: 'sensor.distance must be a number' });
        return;
      }
      const reading = { distanceCm: distance, updatedAt: new Date().toISOString() };
      latestSensorData.set(conn.deviceId, reading);
      eventBroadcaster.broadcastEvent('DISTANCE', {
        deviceId: conn.deviceId,
        distanceCm: reading.distanceCm,
        updatedAt: reading.updatedAt,
      });
      return;
    }
    default:
      sendJson(conn.ws, { type: 'error', message: `Unknown message type: ${String(type)}` });
  }
}

function handleAuthenticate(conn: DeviceConnection, msg: Record<string, unknown>): void {
  const configuredToken = process.env.DEVICE_TOKEN;

  if (!configuredToken) {
    console.error('[WS] Authentication failed — DEVICE_TOKEN is not set in environment');
    sendJson(conn.ws, { type: 'auth_error', error: 'Server misconfiguration: DEVICE_TOKEN is not set' });
    conn.ws.close(4001, 'server misconfiguration');
    return;
  }

  const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.trim().slice(0, 64) : '';
  const token = typeof msg.token === 'string' ? msg.token : '';

  if (!deviceId) {
    console.log('[WS] Authentication failed — missing deviceId');
    sendJson(conn.ws, { type: 'auth_error', error: 'Missing deviceId' });
    conn.ws.close(4001, 'authentication failed');
    return;
  }

  if (token !== configuredToken) {
    // Never log the token itself
    console.log(`[WS] Authentication failed for deviceId "${deviceId}" — invalid token`);
    sendJson(conn.ws, { type: 'auth_error', error: 'Invalid device token' });
    conn.ws.close(4001, 'authentication failed');
    return;
  }

  // Successful authentication — enforce one live connection per device.
  // The old socket is marked superseded BEFORE closing so its close handler
  // does not touch sessions (avoids session churn during device reconnects).
  const existing = devices.get(deviceId);
  if (existing && existing.ws.readyState !== WebSocket.CLOSED) {
    existing.superseded = true;
    if (existing.authTimer) clearTimeout(existing.authTimer);
    console.log(`[WS] Connection replaced for ${deviceId} — closing old socket`);
    existing.ws.close(4000, 'replaced by newer connection');
  }

  if (conn.authTimer) {
    clearTimeout(conn.authTimer);
    conn.authTimer = null;
  }

  conn.authenticated = true;
  conn.deviceId = deviceId;
  devices.set(deviceId, conn);

  console.log(`[WS] Authentication successful (${deviceId}) — online devices: ${devices.size}`);
  sendJson(conn.ws, { type: 'authenticated', deviceId });
}

async function handleStateChange(conn: DeviceConnection, msg: Record<string, unknown>): Promise<void> {
  const state = msg.state;
  const deviceId = conn.deviceId as string;

  // 'sitting'/'away' are legacy values from pre-posture firmware; they map to
  // attentive/vacant so old devices keep working across the rollout.
  const postureStates = ['relaxing', 'attentive', 'sitting'];
  const vacantStates = ['vacant', 'away'];

  if (typeof state !== 'string' || (!postureStates.includes(state) && !vacantStates.includes(state))) {
    sendJson(conn.ws, { type: 'error', message: 'state must be "relaxing", "attentive" or "vacant"' });
    return;
  }

  if (!canUseDatabase()) {
    sendJson(conn.ws, { type: 'error', message: 'Database not configured' });
    return;
  }

  if (postureStates.includes(state)) {
    const posture = state === 'relaxing' ? 'relaxing' : 'attentive';
    const result = await setPosture(posture);
    switch (result.status) {
      case 'updated':
        console.log(`[WS] State change: ${state} (${deviceId}) — session ${result.session.id} posture set to ${posture}`);
        sendJson(conn.ws, { type: 'ack', state, result: 'updated', sessionId: result.session.id });
        break;
      case 'unchanged':
        // Duplicate posture state — safe no-op
        console.log(`[WS] State change: ${state} (${deviceId}) — no posture change needed`);
        sendJson(conn.ws, {
          type: 'ack',
          state,
          result: 'unchanged',
          sessionId: result.session?.id ?? null,
        });
        break;
      case 'db_error':
        console.error(`[WS] Failed to set posture for ${deviceId}:`, result.error);
        sendJson(conn.ws, { type: 'error', message: 'Failed to set posture' });
        break;
    }
    return;
  }

  // state === 'vacant' | 'away'
  const result = await closeActiveSession();
  switch (result.status) {
    case 'stopped':
      console.log(`[WS] State change: ${state} (${deviceId}) — session closed, duration ${result.durationSeconds}s`);
      sendJson(conn.ws, { type: 'ack', state, result: 'closed', durationSeconds: result.durationSeconds });
      break;
    case 'no_active_session':
      // Duplicate vacant / vacant after disconnect-close — safe no-op
      console.log(`[WS] State change: ${state} (${deviceId}) — no active session, nothing to close`);
      sendJson(conn.ws, { type: 'ack', state, result: 'no_active_session' });
      break;
    case 'db_error':
      console.error(`[WS] Failed to close session for ${deviceId}:`, result.error);
      sendJson(conn.ws, { type: 'error', message: 'Failed to close session' });
      break;
  }
}
