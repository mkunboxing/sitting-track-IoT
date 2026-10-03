# Migration: persistent WebSocket → HTTP telemetry (ESP → backend → dashboard)

## Current state (verified by reading the code)

- The **only** WebSocket is ESP8266 ↔ backend: `backend/src/ws/deviceGateway.ts` (in-band JSON auth vs `DEVICE_TOKEN`, ping/pong every 10s, `touchActiveSessionHeartbeat()` every 10s while a device is connected, in-memory `latestSensorData` map, `state_change`/`sensor` handlers → `sessionService`).
- The **frontend has zero WebSocket code**: it uses SSE (`GET /api/sitting/stream`) for instant `STATUS_CHANGE`/`POSTURE_CHANGE`/`DISTANCE` events + a 30s poll of `GET /api/sitting/status` via the `backgroundTimer` Web Worker.
- `GET /api/sitting/status` already returns everything (session, stats, `distanceCm`, `distanceUpdatedAt`) **and performs the 30s stale-check auto-close** using the `last_heartbeat_at` DB column.
- Session logic is transport-agnostic in `backend/src/lib/sessionService.ts` (`openSession`/`setPosture`/`closeActiveSession`/`touchActiveSessionHeartbeat`, all idempotent). Device auth already exists as HTTP Bearer: `requireDeviceToken` in `backend/src/lib/auth.ts`, and a legacy `POST /api/sitting/heartbeat` route already exists (Bearer-authed, touches `last_heartbeat_at`).

**Key design insight:** the ESP now sends a *state snapshot* (not transition events) every 2.5s. The backend edge-detects state changes in memory (per-device "last known state") so `sessionService` is called only on actual transitions — this preserves manual dashboard controls (a manual "End Session" isn't undone by the device's unchanged "attentive" snapshot) and avoids a Supabase query every 2.5s. Every snapshot is also self-healing after outages — no reconnect-sync logic needed anywhere.

## New flow

```
ESP8266 (every 2.5s, state snapshot):  POST /api/sitting/heartbeat
  Authorization: Bearer <DEVICE_TOKEN>
  {"deviceId":"sitting-tracker-01","distance":10.5,"state":"attentive","timestamp":1234567890}
        │  (requireDeviceToken → telemetryStore cache → edge-detect state →
        │   sessionService.setPosture/closeActiveSession on change →
        │   touchActiveSessionHeartbeat throttled to 10s → last_heartbeat_at)
        ▼
Next.js dashboard: poll GET /api/sitting/status every 2.5s (existing Web Worker timer, 30s → 2.5s)
  SSE kept for instant session/posture events (chimes/notifications); DISTANCE event retired.
  Offline/session-close: unchanged /status stale-check (30s grace, ended_at = last contact).
```

## Backend changes

1. **New `backend/src/lib/telemetryStore.ts`** (in-memory only, replaces the gateway's maps):
   - `recordTelemetry(deviceId, distanceCm?)` → `{distanceCm, updatedAt, lastContactAt}` map (never persisted, same as today).
   - `getLatestSensorReading(maxAgeMs?)` → same signature/shape `/status` uses today; optional max-age so a device silent >30s reports no reading instead of a stale one forever.
   - `getLastKnownState` / `setLastKnownState` (edge detection), `shouldTouchHeartbeat(deviceId, 10s)` (throttle), `getOnlineDeviceIds()` (devices with contact ≤30s — replaces the WS registry for `/health`).
2. **`backend/src/routes/sitting.ts`**:
   - Rewrite `POST /heartbeat` (keeps `requireDeviceToken`) into the telemetry endpoint: validates body (`state` ∈ relaxing|attentive|vacant, `distance` finite, `timestamp` numeric — 400 otherwise; all fields optional so old heartbeat-only callers still work), records telemetry, edge-detects state → `setPosture()` / `closeActiveSession()` (imported from sessionService, no duplicate logic), then `touchActiveSessionHeartbeat()` throttled to one DB write per 10s (keeps today's write rate; stale-check 30s threshold unaffected). `timestamp` is accepted but ignored — server clock stays authoritative (existing README principle).
   - Update `getLatestSensorReading` import → telemetryStore (with 30s freshness so the dashboard shows "waiting for sensor…" when the device dies).
   - **Delete `POST /start` and `POST /stop`** — subsumed by the telemetry endpoint (state snapshot opens/closes sessions); nothing else calls them.
3. **`backend/src/index.ts`**: remove `attachDeviceGateway` + `Server` import; `getOnlineDeviceIds` now from telemetryStore; plain `app.listen()`.
4. **Delete `backend/src/ws/deviceGateway.ts`** entirely; remove `ws` + `@types/ws` from `backend/package.json`; **delete `backend/scripts/ws-device-simulator.mjs`**.
5. Comment-only touch-ups where docs now lie (`sessionService.ts` header, `/stream` doc comment).

## Frontend changes (frontend/)

1. **`page.tsx`**: poll interval `30000` → `2500` in the existing worker-driven poll effect (single interval; no new timer); remove the SSE `DISTANCE` branch (no longer emitted) and keep `STATUS_CHANGE`/`POSTURE_CHANGE` → `fetchStatus(true)`; add a small in-flight guard in `fetchStatus` so a poll and an SSE-triggered refresh can't overlap and land out of order. Update comments. Chime/notification logic untouched (driven by status transitions in `fetchStatus`).
2. **`HardwareGuideModal.tsx`**: replace the now-deleted `/start`//`/stop` sample curls + endpoint list with the telemetry `POST /api/sitting/heartbeat` example.
3. Footer/Header labels already say "Live Telemetry 2.5s" — now accurate, no change. No new deps; `types/sitting.ts` unchanged.

## Firmware changes (firmware/sitting_tracker/sitting_tracker.ino)

- Remove all WebSocketsClient code (include, `WS_HOST/PORT/PATH`, ping/reconnect constants, `webSocket` object, `webSocketEvent`, `handleServerMessage`, `sendAuthenticate`, `syncCurrentState`, `sendStateChange`, `webSocket.loop()`). **No new library needed** — uses the built-in `WiFiClientSecure` (GTS Root R1 CA pinning and NTP wait kept, renamed `API_CA_CERT`; NTP also feeds the `timestamp` field). The "WebSockets" library dependency is dropped entirely.
- Add `postTelemetry()` every 2.5s (`SENSOR_SEND_INTERVAL_MS`): reuses one persistent `WiFiClientSecure` connection (re-handshake only when the server closed it — keeps the handshake cost amortized like today's WS), sends the JSON snapshot with `Authorization: Bearer <DEVICE_TOKEN>`, parses just the HTTP status line. Any failure → log, drop the connection, continue. **Sensing/debounce loop is untouched** and never blocks on a failed backend — because every POST carries the *current* state, there is nothing to queue or re-sync after an outage.
- Header comment updated (transport = HTTP telemetry; the telemetry POST *is* the heartbeat).

## Simulator (replaces ws-device-simulator)

New **`backend/scripts/device-simulator.mjs`** using Node's global `fetch` (no deps), same CLI ergonomics: `relax|attentive` (one snapshot POST → opens/updates session), `vacant` (closes), `stream [--state=…] [--distance=…]` (POST every 2.5s forever — emulates the live device and keeps the heartbeat fresh), `crash` (one sit snapshot then stop POSTing → watch stale-check close it after ~30s of dashboard polling), `reconnect` (sit → 3s silence → sit again → proves no duplicate session), `badtoken` (expect 401/403), `malformed` (invalid JSON/state → expect 400), `sensor` (cycles the five distance bands). Options `--url`, `--token`, `--id`, `--distance`.

## Docs

README: refresh only the WebSocket-specific sections — architecture diagram, "Device ⇄ Backend WebSocket" → HTTP telemetry, host requirements (SSE-only streaming now), Cloud Run notes (`--timeout 3600` no longer needed for the device; `--no-cpu-throttling` still useful while SSE exists), firmware setup (no library install), simulator command list, troubleshooting rows. No other doc rewrites.

## Must remain (untouched)

`lib/sessionService.ts` (all session/stat/posture logic), `lib/auth.ts` (Bearer auth), `lib/eventBroadcaster.ts` + `GET /stream` (SSE for session/posture events), `GET /status` incl. the 30s/8h stale-check auto-close, `POST /simulate` (manual controls), `touchActiveSessionHeartbeat`, Supabase schema (**no migration needed** — `last_heartbeat_at` is reused), `DEVICE_TOKEN` env (no new secrets; ESP still only holds the device token, never service-role keys).

## Verification & testing

1. `npm run typecheck && npm run build` in backend; `npx tsx --env-file=.env scripts/posture-math-test.ts`; `npm install` after dep removal.
2. Frontend: `npx tsc --noEmit`, `npm run lint`, `npm run build`.
3. Live smoke test with the simulator (local backend + dashboard). Per your prod-DB caution: I'll check the Cloud Run `/health` first — if the real device is currently online (desk occupied), I'll run only the no-DB-write scenarios (`badtoken`, `malformed`) and hand you the full test commands instead of simulating session transitions.
4. Report: exact changed/deleted files, the new flow, local test steps, deploy order (deploy backend → reflash ESP → redeploy frontend; the old WS firmware simply goes offline until reflashed and its session is closed by the stale-check).