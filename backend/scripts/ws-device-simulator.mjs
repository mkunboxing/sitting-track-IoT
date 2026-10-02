#!/usr/bin/env node
/**
 * ESP8266 WebSocket Device Simulator
 * ──────────────────────────────────
 * Simulates the sitting-tracker device against the backend WebSocket gateway
 * so you can test the full session lifecycle without hardware.
 *
 * Usage (from backend/):
 *   node scripts/ws-device-simulator.mjs <command> [options]
 *
 * Commands:
 *   sit        connect, authenticate, send state_change: sitting, wait, exit
 *   away       connect, authenticate, send state_change: away, wait, exit
 *   crash      connect, authenticate, sit, then hard-drop the socket
 *              (simulates powering off — backend should auto-close the session)
 *   reconnect  sit → hard-drop → reconnect + re-auth (syncs current state)
 *              → verifies no duplicate sessions and state sync
 *   badtoken   connect with an invalid token (expect auth_error + close 4001)
 *   malformed  authenticate, then send garbage (expect error, connection alive)
 *   twice      open two connections with the same deviceId (first is superseded)
 *   ping       connect, authenticate, then idle 20s (observe ws ping/pong + acks)
 *
 * Options:
 *   --url ws://localhost:4000/ws/device   (default; or WS_URL env)
 *   --token <token>                       (default: DEVICE_TOKEN env)
 *   --id sitting-tracker-01               (default: DEVICE_ID env)
 */

import WebSocket from 'ws';

const args = process.argv.slice(2);
const command = args[0];

const url = (args.find((a) => a.startsWith('--url='))?.split('=')[1]) || process.env.WS_URL || 'ws://localhost:4000/ws/device';
const token = (args.find((a) => a.startsWith('--token='))?.split('=')[1]) || process.env.DEVICE_TOKEN || '';
const deviceId = (args.find((a) => a.startsWith('--id='))?.split('=')[1]) || process.env.DEVICE_ID || 'sitting-tracker-01';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(tag, obj) {
  console.log(`[${tag}]`, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

class Device {
  constructor(id) {
    this.id = id;
    this.authenticated = false;
    this.messages = [];
    this.closed = { code: null, reason: null };
    this.opened = false;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const timeout = setTimeout(() => reject(new Error('connect timeout')), 5000);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.opened = true;
        log(this.id, 'WS open');
        resolve();
      });
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { msg = { raw: data.toString() }; }
        this.messages.push(msg);
        if (msg.type === 'authenticated') this.authenticated = true;
        log(`${this.id} ←`, msg);
      });
      this.ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        this.opened = false;
        log(this.id, `WS closed (code=${code}${reason.length ? `, reason=${reason}` : ''})`);
      });
      this.ws.on('error', (err) => log(this.id, `WS error: ${err.message}`));
    });
  }

  send(obj) {
    log(`${this.id} →`, obj);
    this.ws.send(JSON.stringify(obj));
  }

  authenticate(tokenOverride) {
    this.send({ type: 'authenticate', deviceId: this.id, token: tokenOverride ?? token });
  }

  state(state) {
    this.send({ type: 'state_change', deviceId: this.id, state });
  }

  /** Wait until an authenticated message arrives (or timeout) */
  async waitAuth(ms = 3000) {
    const deadline = Date.now() + ms;
    while (!this.authenticated && Date.now() < deadline) await sleep(50);
    return this.authenticated;
  }

  /** Wait until a message matching predicate arrives (or timeout) */
  async waitFor(pred, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.messages.find(pred);
      if (found) return found;
      await sleep(50);
    }
    return null;
  }

  hardKill() {
    // Simulate power loss: terminate the socket without a close handshake
    log(this.id, 'HARD KILL (terminating socket, no close frame)');
    this.ws.terminate();
  }

  close(code = 1000) {
    try { this.ws.close(code); } catch { /* already closed */ }
  }
}

async function main() {
  if (!command || !['sit', 'away', 'crash', 'reconnect', 'badtoken', 'malformed', 'twice', 'ping'].includes(command)) {
    console.log('Usage: node scripts/ws-device-simulator.mjs <sit|away|crash|reconnect|badtoken|malformed|twice|ping> [--url=...] [--token=...] [--id=...]');
    process.exit(1);
  }
  if (!token) {
    console.error('No token. Pass --token=<DEVICE_TOKEN> or set DEVICE_TOKEN env var.');
    process.exit(1);
  }

  if (command === 'sit' || command === 'away') {
    const state = command === 'sit' ? 'sitting' : 'away';
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate();
    if (!(await d.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    d.state(state);
    await d.waitFor((m) => m.type === 'ack' && m.state === state);
    await sleep(300);
    d.close();
    await sleep(200);
    process.exit(0);
  }

  if (command === 'crash') {
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate();
    if (!(await d.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    d.state('sitting');
    await d.waitFor((m) => m.type === 'ack' && m.state === 'sitting');
    await sleep(300);
    d.hardKill();
    await sleep(300);
    console.log('Simulator exited while socket was destroyed. The active session is left open and will be');
    console.log('auto-closed by the /status stale-check (~90s) if the device does not reconnect.');
    process.exit(0);
  }

  if (command === 'reconnect') {
    console.log('--- Phase 1: connect, sit, hard-drop ---');
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate();
    if (!(await d.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    d.state('sitting');
    await d.waitFor((m) => m.type === 'ack' && m.state === 'sitting');
    await sleep(300);
    d.hardKill();
    await sleep(500);

    console.log('--- Phase 2: reconnect + re-auth (should sync current state: sitting) ---');
    const d2 = new Device(deviceId);
    await d2.connect();
    d2.authenticate();
    if (!(await d2.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    // The real firmware sends its current state after auth; mimic "still sitting":
    d2.state('sitting');
    const ack = await d2.waitFor((m) => m.type === 'ack' && m.state === 'sitting');
    if (ack && ack.result === 'already_active') console.log('OK: reconnect did NOT create a duplicate session');
    else if (ack && ack.result === 'started') console.log('OK: session re-created after disconnect (previous one auto-closed)');
    else console.log('UNEXPECTED ack:', ack);

    console.log('--- Phase 3: send away (clean stop) ---');
    d2.state('away');
    await d2.waitFor((m) => m.type === 'ack' && m.state === 'away');
    await sleep(300);
    d2.close();
    await sleep(200);
    process.exit(0);
  }

  if (command === 'badtoken') {
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate('definitely-not-the-right-token');
    const err = await d.waitFor((m) => m.type === 'auth_error');
    await sleep(300);
    console.log(err && d.closed.code === 4001 ? 'OK: rejected with close code 4001' : 'FAILED: expected auth_error + close 4001');
    process.exit(err ? 0 : 1);
  }

  if (command === 'malformed') {
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate();
    if (!(await d.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    log(deviceId, '→ (raw garbage: "this is not json{{{")');
    d.ws.send('this is not json{{{');
    const err = await d.waitFor((m) => m.type === 'error' && /Malformed/.test(m.message || ''));
    d.send({ type: 'nonsense_type' });
    await d.waitFor((m) => m.type === 'error' && /Unknown message type/.test(m.message || ''));
    await sleep(300);
    console.log(d.opened ? 'OK: connection still open after malformed + unknown messages' : 'FAILED: connection was closed');
    d.close();
    process.exit(err && d.opened ? 0 : 1);
  }

  if (command === 'twice') {
    const a = new Device(deviceId);
    await a.connect();
    a.authenticate();
    await a.waitAuth();
    console.log('--- opening second connection with the same deviceId ---');
    const b = new Device(deviceId);
    await b.connect();
    b.authenticate();
    await b.waitAuth();
    await sleep(500);
    console.log(a.closed.code === 4000 ? 'OK: first connection superseded (close code 4000)' : 'FAILED: first connection not superseded');
    b.close();
    await sleep(300);
    process.exit(a.closed.code === 4000 ? 0 : 1);
  }

  if (command === 'ping') {
    const d = new Device(deviceId);
    await d.connect();
    d.authenticate();
    if (!(await d.waitAuth())) { console.error('FAILED: not authenticated'); process.exit(1); }
    console.log('Idling 20s — server pings every 30s; protocol pong handled automatically.');
    console.log('Watch the backend log for "[WS] ..." liveness messages.');
    await sleep(20000);
    d.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});
