#!/usr/bin/env node
/**
 * Session-confirmation end-to-end test
 * ────────────────────────────────────
 * Verifies that, with the new firmware confirmation windows, only a genuine
 * confirmed Vacant → Sitting transition opens a session and only a confirmed
 * Sitting → Vacant transition closes one — through the REAL backend (Express
 * routes + sessionService), with zero contact with the real Supabase project.
 *
 * Architecture:
 *   1. A mock PostgREST server stands in for Supabase (in-memory
 *      sitting_sessions rows + a log of every INSERT/PATCH it receives).
 *   2. The real backend is spawned (tsx) with SUPABASE_URL pointing at the
 *      mock and a throwaway DEVICE_TOKEN.
 *   3. A device driver POSTs real telemetry snapshots to
 *      /api/sitting/heartbeat while running the firmware's debounce state
 *      machine over a scripted distance timeline (mirrors
 *      firmware/sitting_tracker/debounce.h: 700 ms sensing, 2.5 s telemetry,
 *      5 s sit-start / 10 s sit-end / 2 s posture windows). Simulated time
 *      runs ~50x faster than wall clock — the backend only counts
 *      transitions, not pacing.
 *
 * Run from backend/:
 *   node scripts/session-confirmation-e2e-test.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Firmware mirror (keep in sync with firmware/sitting_tracker/debounce.h) ──

const RELAX_ENTER_CM = 8.0;
const ATTENTIVE_ENTER_CM = 8.5;
const OCCUPANCY_LIMIT_CM = 45.0;
const SIT_START_CONFIRM = 5000;  // continuous sitting to confirm vacant → occupied
const SIT_END_CONFIRM = 10000;   // continuous vacant to confirm occupied → vacant
const POSTURE_CONFIRM = 2000;    // continuous to confirm relaxing ↔ attentive
const SENSOR_INTERVAL = 700;
const TELEMETRY_INTERVAL_MS = 2500;

function classifyDistance(d, current) {
  if (d <= 0 || d > OCCUPANCY_LIMIT_CM) return 'vacant';
  if (d < RELAX_ENTER_CM) return 'relaxing';
  if (d > ATTENTIVE_ENTER_CM) return 'attentive';
  return current === 'vacant' ? 'attentive' : current;
}

function confirmationWindowMs(potential, current) {
  if (potential === 'vacant') return SIT_END_CONFIRM;
  if (current === 'vacant') return SIT_START_CONFIRM;
  return POSTURE_CONFIRM;
}

// ── Mock PostgREST (stands in for Supabase) ──────────────────────────────────

function startMockSupabase() {
  const db = { rows: [], seq: 0 };
  /** Every DB write the backend performs, in order */
  const ops = [];
  /** Invariant violations (e.g. a session opened while another was active) */
  const violations = [];

  function classifyPatch(patch) {
    if ('ended_at' in patch && patch.ended_at !== null) return 'close';
    if ('posture_state' in patch) return 'posture';
    if ('last_heartbeat_at' in patch) return 'heartbeat';
    return 'other';
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/rest/v1/sitting_sessions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `mock: unhandled path ${url.pathname}` }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object');
        const p = url.searchParams;

        if (req.method === 'POST') {
          const incoming = Array.isArray(body) ? body : [body];
          for (const row of incoming) {
            if (db.rows.some((r) => r.ended_at === null)) {
              violations.push({ kind: 'insert_while_session_active', row });
            }
            db.seq += 1;
            const stored = {
              id: db.seq,
              created_at: new Date().toISOString(),
              last_heartbeat_at: null,
              ...row,
            };
            db.rows.push(stored);
            // Snapshot the row — later PATCHes mutate the stored object
            ops.push({ kind: 'insert', row: { ...stored } });
          }
          const last = db.rows[db.rows.length - 1];
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(wantsObject ? last : [last]));
          return;
        }

        if (req.method === 'PATCH') {
          const idParam = p.get('id') ?? '';
          const id = idParam.startsWith('eq.') ? Number(idParam.slice(3)) : null;
          const row = db.rows.find((r) => r.id === id);
          if (!row) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'mock: row not found' }));
            return;
          }
          Object.assign(row, body);
          ops.push({ kind: classifyPatch(body), id: row.id, patch: { ...body } });
          if (wantsObject) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(row));
          } else {
            res.writeHead(204);
            res.end();
          }
          return;
        }

        if (req.method === 'GET') {
          let rows = [...db.rows];
          const idParam = p.get('id');
          if (idParam?.startsWith('eq.')) rows = rows.filter((r) => r.id === Number(idParam.slice(3)));
          if (p.get('ended_at') === 'is.null') rows = rows.filter((r) => r.ended_at === null);
          // `or=` (recent-sessions window query): return everything — the tiny
          // in-memory dataset only holds what this test created.
          if ((p.get('order') ?? '').startsWith('started_at.desc')) {
            rows.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
          }
          const limit = p.get('limit');
          if (limit) rows = rows.slice(0, Number(limit));
          if (rows.length > 1 && wantsObject) {
            res.writeHead(406, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'PGRST116', message: 'mock: multiple rows for object request' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(wantsObject ? (rows[0] ?? null) : rows));
          return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `mock: unhandled method ${req.method}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(err) }));
      }
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, db, ops, violations })));
}

// ── Scripted distance timeline (simulated milliseconds → cm) ────────────────
//
//  [0, 7000)      60 cm  vacant boot baseline — posts vacant, no session
//  [7000, 10000)  20 cm  sitting attempt (2.1 s sampled — below the 5 s window)
//  [10000, 10700) 60 cm  ONE stray vacant sample (fluctuation inside the window)
//  [10700, 20000) 20 cm  sitting resumes → confirmed at sim 16800 → session #1
//                        opens on the 17500 snapshot
//  [20000, 25000)  5 cm  relaxing → 2 s posture confirm → posture update
//  [25000, 30000) 20 cm  attentive → posture update (session untouched)
//  [30000, 39100) 60 cm  brief absence (8.4 s sampled — below the 10 s window)
//                        → device keeps reporting sitting → session stays open
//  [39100, 47000) 20 cm  sits back down — same session continues, no duplicate
//  [47000, 60000) 60 cm  genuine leave → confirmed at sim 58100 → session #1
//                        closes on the 60000 snapshot
//  [60000, 70000) 60 cm  still vacant — unchanged snapshots, no DB writes
//  [70000, 80000) 20 cm  genuine re-sit → confirmed at sim 75600 → session #2
//                        opens on the 77500 snapshot
//  [80000, 95000) 60 cm  leave again → confirmed at sim 91000 → session #2
//                        closes on the 92500 snapshot
const SIM_TOTAL = 95000;
const SIM_STEP = 50; // divides both 700 and 2500 → ticks fire on exact multiples

function distanceAt(sim) {
  if (sim < 7000) return 60.0;
  if (sim < 10000) return 20.0;
  if (sim < 10700) return 60.0;
  if (sim < 20000) return 20.0;
  if (sim < 25000) return 5.0;
  if (sim < 30000) return 20.0;
  if (sim < 39100) return 60.0;
  if (sim < 47000) return 20.0;
  if (sim < 60000) return 60.0;
  if (sim < 70000) return 60.0;
  if (sim < 80000) return 20.0;
  return 60.0;
}

// ── Device driver ────────────────────────────────────────────────────────────

async function runDevice(baseUrl, token) {
  // Mirrors DebounceState; realCurrentSince maps `currentSince` onto the real
  // clock so `stateForMs` means the same thing the firmware sends (the
  // firmware's millis() is real uptime — simulated time only drives the
  // scenario timeline).
  const debounce = { current: 'vacant', potential: 'vacant', potentialSince: 0, currentSince: 0 };
  let realPotentialSince = Date.now();
  let realCurrentSince = realPotentialSince;
  const confirmations = []; // { sim, state, firstDetectionReal } — first detection = real clock
  const postLog = [];
  let lastDistance = distanceAt(0);
  let sim = 0;

  async function post(simMs) {
    const res = await fetch(`${baseUrl}/api/sitting/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        deviceId: 'sitting-tracker-01',
        distance: Number(lastDistance.toFixed(1)),
        state: debounce.current,
        timestamp: Math.floor(Date.now() / 1000),
        stateForMs: Date.now() - realCurrentSince,
      }),
    });
    postLog.push({ sim: simMs, state: debounce.current, httpStatus: res.status, realAt: Date.now() });
    if (res.status !== 200) throw new Error(`heartbeat POST failed: HTTP ${res.status} at sim ${simMs}`);
    await res.body.cancel();
  }

  for (; sim <= SIM_TOTAL; sim += SIM_STEP) {
    if (sim % SENSOR_INTERVAL === 0) {
      lastDistance = distanceAt(sim);
      const measured = classifyDistance(lastDistance, debounce.current);
      if (measured !== debounce.potential) {
        debounce.potential = measured;
        debounce.potentialSince = sim;
        realPotentialSince = Date.now();
      } else if (debounce.potential !== debounce.current) {
        if (sim - debounce.potentialSince >= confirmationWindowMs(debounce.potential, debounce.current)) {
          debounce.current = debounce.potential;
          debounce.currentSince = debounce.potentialSince;
          realCurrentSince = realPotentialSince;
          confirmations.push({ sim, state: debounce.current, firstDetectionReal: realCurrentSince });
          console.log(`  [device] sim ${(sim / 1000).toFixed(1)}s → confirmed ${debounce.current}`);
        }
      }
    }
    if (sim % TELEMETRY_INTERVAL_MS === 0) await post(sim);
  }
  return { postLog, confirmations };
}

// ── Assertions ───────────────────────────────────────────────────────────────

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function main() {
  const mock = await startMockSupabase();
  const mockPort = mock.server.address().port;
  const backendPort = 40000 + Math.floor(Math.random() * 20000);
  const token = 'e2e-confirmation-test-token';

  console.log(`[e2e] mock Supabase on 127.0.0.1:${mockPort}, backend on port ${backendPort}`);

  const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(backendPort),
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-key',
      DEVICE_TOKEN: token,
      CORS_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const backendLogs = [];
  child.stdout.on('data', (c) => backendLogs.push(c));
  child.stderr.on('data', (c) => backendLogs.push(c));

  const baseUrl = `http://127.0.0.1:${backendPort}`;
  try {
    // Wait for the backend to come up
    let up = false;
    for (let i = 0; i < 75 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`${baseUrl}/health`);
        up = res.ok;
      } catch { /* not up yet */ }
    }
    if (!up) throw new Error(`backend did not start:\n${backendLogs.join('')}`);

    console.log('[e2e] running device timeline (simulated time ~50x)…');
    const { postLog, confirmations } = await runDevice(baseUrl, token);

    // Driver-side: telemetry never blocked, sessions only on confirmed snapshots
    check('every telemetry POST returned HTTP 200 (sensing/telemetry never blocked)',
      postLog.every((p) => p.httpStatus === 200), `${postLog.length} posts`);
    check('no sitting state was reported before the 5 s open window (first sitting POST at sim 17.5 s)',
      postLog.find((p) => p.state !== 'vacant')?.sim === 17500);
    check('posts during the pending open window kept reporting vacant + live distance',
      [7500, 10000, 12500, 15000].every((s) => postLog.find((p) => p.sim === s)?.state === 'vacant'));
    check('posts during the brief absence kept reporting sitting (no premature close snapshot)',
      [32500, 35000, 37500].every((s) => postLog.find((p) => p.sim === s)?.state === 'attentive'));
    check('device reported vacant only after the 10 s close window (first close snapshot at sim 60 s)',
      postLog.filter((p) => p.state === 'vacant' && p.sim > 17500)[0]?.sim === 60000);

    // Backend-side: what actually reached the database
    const ops = mock.ops;
    const inserts = ops.filter((o) => o.kind === 'insert');
    const postures = ops.filter((o) => o.kind === 'posture');
    const closes = ops.filter((o) => o.kind === 'close');
    const heartbeats = ops.filter((o) => o.kind === 'heartbeat');
    const others = ops.filter((o) => o.kind === 'other');

    console.log(`[e2e] DB ops: ${inserts.length} inserts, ${postures.length} posture updates, ` +
      `${closes.length} closes, ${heartbeats.length} heartbeat touches`);

    check('exactly 2 sessions were ever opened (genuine sits only)', inserts.length === 2);
    check('both sessions opened in the attentive posture', inserts.every((o) => o.row.posture_state === 'attentive'));
    check('exactly 2 sessions were closed (confirmed leaves only)', closes.length === 2);
    check('closes happened in open order', closes.length === 2 && closes[0].id < closes[1].id);
    check('each close set ended_at on its own session',
      closes.every((o) => typeof o.patch.ended_at === 'string'));
    check('exactly 2 posture updates (relaxing, then attentive) while session #1 was open',
      postures.length === 2 &&
      postures[0].id === inserts[0].row.id && postures[0].patch.posture_state === 'relaxing' &&
      postures[1].id === inserts[0].row.id && postures[1].patch.posture_state === 'attentive');
    check('no session was ever opened while another was active', mock.violations.length === 0);
    check('no unexpected DB writes', others.length === 0);

    // Recorded session times must anchor to FIRST DETECTION (true sit-down /
    // stand-up), not to confirmation or snapshot arrival — the confirmation
    // windows must not appear in the recorded sitting duration
    const sittingConfirms = confirmations.filter((c) => c.state !== 'vacant');
    const vacantConfirms = confirmations.filter((c) => c.state === 'vacant');
    const [s1, s2] = inserts.map((o) => o.row);
    const s1Detect = sittingConfirms[0].firstDetectionReal;
    const s1StandUp = vacantConfirms[0].firstDetectionReal;
    const s2Detect = sittingConfirms[sittingConfirms.length - 1].firstDetectionReal;
    const s2StandUp = vacantConfirms[1].firstDetectionReal;
    const delta = (iso, real) => Date.parse(iso) - real;

    check('session 1 started_at anchored to first sitting detection (±2s), not confirmation',
      Math.abs(delta(s1.started_at, s1Detect)) < 2000, `delta ${delta(s1.started_at, s1Detect)}ms`);
    check('session 1 posture stretch begins at started_at (no unclassified gap)',
      s1.posture_changed_at === s1.started_at);
    check('session 1 ended_at anchored to first vacancy detection (±2s), not confirmation',
      Math.abs(delta(closes[0].patch.ended_at, s1StandUp)) < 2000,
      `delta ${delta(closes[0].patch.ended_at, s1StandUp)}ms`);
    check('session 1 recorded duration ≈ true sitting time (windows excluded)',
      Math.abs((Date.parse(closes[0].patch.ended_at) - Date.parse(s1.started_at)) / 1000 -
        (s1StandUp - s1Detect) / 1000) < 3);
    check('session 2 started_at anchored to its first sitting detection (±2s)',
      Math.abs(delta(s2.started_at, s2Detect)) < 2000, `delta ${delta(s2.started_at, s2Detect)}ms`);
    check('session 2 ended_at anchored to its first vacancy detection (±2s)',
      Math.abs(delta(closes[1].patch.ended_at, s2StandUp)) < 2000,
      `delta ${delta(closes[1].patch.ended_at, s2StandUp)}ms`);
    check('sessions are backdated strictly before their opening snapshots arrived',
      Date.parse(s1.started_at) < postLog.find((p) => p.state !== 'vacant').realAt);

    // Final /status sanity check + the closed rows' shape in the "database"
    const status = await (await fetch(`${baseUrl}/api/sitting/status`)).json();
    check('/status reports AWAY with no active session',
      status.status === 'AWAY' && status.activeSession === null);
    check('both stored sessions are cleanly closed (ended_at set, posture flushed)',
      mock.db.rows.length === 2 &&
      mock.db.rows.every((r) =>
        typeof r.ended_at === 'string' &&
        typeof r.duration_seconds === 'number' &&
        r.posture_state === null &&
        r.posture_changed_at === null &&
        typeof r.relax_seconds === 'number' &&
        typeof r.attentive_seconds === 'number'));

    if (failures === 0) {
      console.log('\nALL PASS');
    } else {
      console.log(`\n${failures} FAILURES — backend log:\n${backendLogs.join('').slice(-4000)}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000).unref?.(); });
    mock.server.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e test failed:', err);
  process.exit(1);
});
