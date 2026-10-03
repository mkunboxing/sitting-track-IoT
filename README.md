# Sitting Time Tracker 🪑⏱️

An end-to-end IoT ergonomics telemetry system and real-time dashboard. The system automatically detects when you are sitting at your desk using a **NodeMCU ESP8266** and an **HC-SR04 ultrasonic distance sensor**, records sessions in **Supabase PostgreSQL**, and visualizes sitting habits on a **Next.js (App Router)** dashboard.

The project is split into two apps:

| App | Location | Role |
| :--- | :--- | :--- |
| **Frontend** | [`frontend/`](./frontend) | Next.js dashboard (static UI, calls the API server) |
| **Backend** | [`backend/`](./backend) | Express (TypeScript) API + device HTTP telemetry endpoint + SSE streaming + Supabase access |

---

## 🏛️ Architecture

```
┌─────────────────────────────────┐
│     NodeMCU ESP8266 + HC-SR04   │
│  - Distance <  8cm   (Relaxing) │
│  - 8.5–45cm          (Attentive)│
│  - Distance >  45cm  (Vacant)   │
│  - 2s / 5s Debounce + Deadband  │
│  - Loop Delay: ~700ms           │
└───────────────┬─────────────────┘
                │
                │ MQTT over TLS (primary): snapshot every 2.5s
                │ sitting/device/<id>/telemetry + LWT status
                │ (legacy HTTP POST /api/sitting/heartbeat kept
                │  during the migration, removed after verification)
                ▼
┌─────────────────────────────────┐
│       EMQX Cloud (broker)       │
│  - MQTT over TLS, port 8883     │
│  - Device auth (user/password)  │
└───────────────┬─────────────────┘
                │
                │ Backend subscribes: sitting/device/+/telemetry
                │                     sitting/device/+/status (LWT)
┌───────────────┴─────────────────┐
│         Express API Server      │
│         (backend/, TypeScript)  │
│  - MQTT telemetry subscriber    │  ← device telemetry = heartbeat
│  - POST /api/sitting/heartbeat  │  ← legacy HTTP telemetry (migration)
│  - GET  /api/sitting/status     │
│  - GET  /api/sitting/stream     │  ← SSE (session/posture events)
│  - POST /api/sitting/simulate   │
└───────────────┬─────────────────┘
                │
                │ Supabase Service-Role
                ▼
┌─────────────────────────────────┐
│       Supabase PostgreSQL       │
│  - Table: sitting_sessions      │
│  - Partial Unique Index         │
│    (1 active session enforced)  │
│  - Server-calculated duration   │
└───────────────┬─────────────────┘
                │
                │ HTTP poll every 2.5s (+ SSE push)
                ▼
┌─────────────────────────────────┐
│       Next.js Dashboard         │
│  - Live Active Stopwatch        │
│  - Today's Total Sitting Time   │
│  - 7-Day Analytics Bar Chart    │
│  - Session History & Overlaps   │
└─────────────────────────────────┘
```

---

## 🔗 Device ⇄ Backend Telemetry

The device publishes its state over **MQTT via EMQX Cloud** (the primary transport since the MQTT migration), and — during the migration period only — still POSTs the same snapshot over HTTP. Both transports feed the **same backend pipeline**, and identical snapshots are idempotent there (edge detection), so running both in parallel is safe.

### MQTT transport (primary)

```
ESP8266 ──MQTT over TLS :8883──► EMQX Cloud ◄──MQTT over TLS── Express backend (mqtt.js)
```

Every **2.5 s** the device publishes its **current** seating state + distance to a device-specific topic:

```json
topic: sitting/device/sitting-tracker-01/telemetry
{ "deviceId": "sitting-tracker-01", "distance": 10.5, "state": "attentive",
  "timestamp": 1234567890, "stateForMs": 42000 }
```

- `state` is one of `relaxing` | `attentive` | `vacant` (classified on the device: < 8 cm relaxing · 8.5–45 cm attentive · > 45 cm or invalid vacant, with an 8–8.5 cm deadband and 2 s / 5 s debounce). `distance` `-1` = out of range. `timestamp` (epoch seconds from NTP) is informational only — the **server clock** remains the source of truth.
- **Online/offline (LWT):** on every connect the device publishes a *retained* `"online"` to `sitting/device/<id>/status` and registers a *retained* Last-Will `"offline"`. If the device vanishes without a clean disconnect (power-off, Wi-Fi loss), the broker publishes the LWT after ~1.5× the 15 s keepalive; the backend marks the device offline in its in-memory store (the same state a 30 s HTTP contact gap produces).
- **QoS:** telemetry publishes at QoS 0 (a snapshot arrives again 2.5 s later, and `stateForMs` keeps session timing exact); status publishes at QoS 1 with retain.
- **Reconnect:** automatic on both sides — the ESP8266 throttles to one connect attempt per 5 s; the backend (mqtt.js) retries every 5 s and re-subscribes on success.
- **TLS everywhere, no `setInsecure()`:** the ESP8266 embeds the **ISRG Root X1** CA (EMQX Cloud terminates TLS with a Let's Encrypt certificate) and validates the full chain against the NTP-synced clock; the backend uses `rejectUnauthorized: true` with Node's built-in roots.
- **Auth:** broker-level username/password (created in the EMQX Cloud console). The `deviceId` is carried by the topic (`sitting/device/<id>/telemetry`), which is what the backend subscribes to with wildcards.

### Backend env vars (MQTT)

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `MQTT_BROKER_URL` | *(unset → MQTT disabled)* | `mqtts://<deployment>.emqxsl.com:8883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | — | EMQX Cloud credentials (Access Management → Authentication) |
| `MQTT_CLIENT_ID` | `smart-tracking-backend-<pid>-<rand>` | unique per backend instance |
| `MQTT_TELEMETRY_TOPIC` | `sitting/device/+/telemetry` | telemetry subscription |
| `MQTT_STATUS_TOPIC` | `sitting/device/+/status` | LWT/online subscription |
| `MQTT_CA_CERT` | *(Node's built-in roots)* | optional PEM bundle for private CAs (`\n` escapes unescaped) |

### Legacy HTTP transport (removed after MQTT is verified)

During the migration the firmware **also** POSTs the same snapshot every 2.5 s (this section describes what still exists today):

**Exact URL:** `http://<backend-host>:4000/api/sitting/heartbeat` (dev) · `https://<backend-host>/api/sitting/heartbeat` (production)

```json
POST /api/sitting/heartbeat
Authorization: Bearer <DEVICE_TOKEN>
Content-Type: application/json

{ "deviceId": "sitting-tracker-01", "distance": 10.5, "state": "attentive", "timestamp": 1234567890 }
```

- Authenticated with `Authorization: Bearer <DEVICE_TOKEN>` (invalid tokens get `401/403`, malformed bodies `400`).
- **Heartbeat = the telemetry POST itself.** A device that stops posting goes stale, and the `/status` stale-check auto-closes any active session (~30 s) with `ended_at` = last-contact time.
- **Backend unavailable:** sensing never stops. The device skips the POST, keeps classifying locally, and retries on the next 2.5 s cycle. Because every POST is a full *current-state snapshot* (not an event), the first successful POST after an outage reconciles everything.
- **Live distance on the dashboard:** arrives via the dashboard's 2.5 s `GET /status` poll. SSE is used for instant *session* events (`STATUS_CHANGE` / `POSTURE_CHANGE`) so chimes and notifications fire immediately.

### How the backend processes each snapshot (shared by both transports)

1. **Validation:** `parseTelemetryPayload` enforces the same rules for MQTT messages as the HTTP route always did (error strings identical).
2. **Telemetry cache (in-memory, never persisted):** the reading is stored and surfaced by `GET /status` as `distanceCm` + `distanceUpdatedAt`. Readings older than 30 s are reported as no-reading, so a powered-off device shows "waiting for sensor…" instead of a frozen distance.
3. **Edge-detected session transitions:** the backend compares the snapshot's state with the device's last known state and calls the shared `sessionService` **only on actual changes** — `relaxing`/`attentive` → `setPosture` (opens a session when vacant), `vacant` → `closeActiveSession`. Unchanged snapshots are no-ops (no DB hit every 2.5 s), and manual dashboard controls are never overridden by the device's unchanged state.
4. **Heartbeat:** each fresh contact touches `last_heartbeat_at` (throttled to one write per 10 s — the same rate the old WebSocket ping loop used), so the `/status` stale-check keeps working unchanged.

### Backend implementation

`backend/src/lib/telemetryProcessor.ts` is the shared ingestion pipeline (validate → cache → edge-detect → `sessionService` → throttled heartbeat touch); the HTTP route (`POST /heartbeat`) and the MQTT subscriber (`backend/src/lib/mqttClient.ts`) are thin adapters over it. `backend/src/lib/telemetryStore.ts` holds the in-memory telemetry state (latest reading per device, last known state per device, heartbeat-write throttle, offline marking for MQTT LWT, online-device list for `/health`). Session open/close logic lives only in `backend/src/lib/sessionService.ts`, so MQTT telemetry, HTTP telemetry, the dashboard's manual controls, and the stale-check all behave identically.

### Removing the HTTP heartbeat after verification

Once MQTT is verified end-to-end (device + backend logs + EMQX dashboard):
1. Firmware: set `USE_HTTP = false`, flash, re-verify, then delete the HTTP sections (config block, section 8 `HTTP TELEMETRY`, the `apiClient` globals) from `sitting_tracker.ino`.
2. Backend: `POST /api/sitting/heartbeat` can then be deleted from `backend/src/routes/sitting.ts` (and `requireDeviceToken` if unused elsewhere).

---

## 🔌 Hardware Wiring & Pinout

### Components
1. **NodeMCU ESP8266** (Amica, Lolin, or generic ESP-12E module)
2. **HC-SR04 Ultrasonic Distance Sensor**
3. **Resistors for Voltage Divider**: 1× 1kΩ and 1× 2kΩ (to safely step down HC-SR04 5V ECHO output to ESP8266 3.3V GPIO level)
4. Breadboard & Jumper wires

### Pin Connections

| HC-SR04 Pin | NodeMCU Pin | Description |
| :--- | :--- | :--- |
| **VCC** | **VIN** | 5V DC power (HC-SR04 requires 5V to operate reliably) |
| **GND** | **GND** | Ground reference |
| **TRIG** | **D6 (GPIO 12)** | Ultrasonic trigger output from ESP8266 |
| **ECHO** | **D5 (GPIO 14)** | Pulse return (MUST route through voltage divider) |

### Voltage Divider on ECHO Pin
HC-SR04 outputs a 5V digital signal on the ECHO pin. ESP8266 GPIO pins are rated for 3.3V max.
```
HC-SR04 ECHO (5V) ───[ 1kΩ Resistor ]───┬───► NodeMCU D5 (GPIO 14) [~3.3V]
                                        │
                                 [ 2kΩ Resistor ]
                                        │
                                       GND
```

---

## 🗄️ Supabase Database Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase project dashboard.
3. Open [`supabase/schema.sql`](./supabase/schema.sql) in this repository, copy its contents, paste them into the SQL Editor, and click **Run**.
   - This creates the `sitting_sessions` table.
   - It sets up a **partial unique index** (`WHERE ended_at IS NULL`) guaranteeing that at most **one** active session can exist at a time.
   - It sets up helper functions and performance indexes.
4. *(Optional)* To preview the dashboard with sample historical data before flashing the hardware, run [`supabase/seed_demo.sql`](./supabase/seed_demo.sql).

---

## ⚙️ Environment Variables Configuration

### Backend — `backend/.env`

```bash
cd server
cp .env.example .env
```

Fill in your secrets:

```env
# Supabase Configuration (From Supabase -> Project Settings -> API)
SUPABASE_URL=https://your-project-id.supabase.co
# IMPORTANT: Use the Service Role secret key here (server-side only, bypasses RLS).
# NEVER expose this key to the browser or client-side bundles.
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Shared Secret Device Token
# The NodeMCU ESP8266 must include this in: "Authorization: Bearer <DEVICE_TOKEN>"
DEVICE_TOKEN=tracker-secret-device-key-change-me

# Express server
PORT=4000
# Allowed origin(s) of the Next.js frontend, comma-separated
CORS_ORIGIN=http://localhost:3000
```

### Frontend — `frontend/.env.local`

```env
# Base URL of the Express backend (empty = same origin)
NEXT_PUBLIC_API_URL=http://localhost:4000
```

> [!IMPORTANT]
> The `DEVICE_TOKEN` is your authentication secret between your ESP8266 and the Express API. Keep it random and secure.

---

## 🚀 Running the Apps

### Local Development

Run both processes in separate terminals:

```bash
# Terminal 1 — Express backend (http://localhost:4000)
cd backend
npm install
npm run dev

# Terminal 2 — Next.js frontend (http://localhost:3000)
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The dashboard talks to the API on `:4000` via `NEXT_PUBLIC_API_URL` (CORS is already configured).

### Deploying

- **Frontend (`frontend/`)** — deploys to Vercel. In the Vercel project settings, set **Root Directory = `frontend`** (Vercel auto-detects Next.js from there), and set the `NEXT_PUBLIC_API_URL` environment variable to the public URL of your Express server (it is inlined into the client bundle at build time), e.g. your Cloud Run URL.
- **Backend (`backend/`)** — needs an **always-on host with HTTP streaming support for SSE** (Railway, Render, Fly.io, or a VPS all work; serverless platforms like Vercel Functions do **not** — they will not keep SSE connections open). The device protocol is plain request/response HTTP POSTs, so no WebSocket support is required. Build with `npm run build`, start with `npm start`, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_TOKEN`, `PORT`, and `CORS_ORIGIN` there — `CORS_ORIGIN=*` allows any origin (easy for dev), or list explicit origins comma-separated, e.g. `http://localhost:3000,https://smart-tracking.vercel.app` (recommended for production).

#### Deploying the backend to Google Cloud Run

Cloud Run works well for this app — the device flow is now ordinary request-based HTTP, which is exactly what Cloud Run bills and scales for. Only SSE needs long-lived connections:

```bash
gcloud run deploy sitting-track-iot \
  --source backend \
  --region asia-south2 \
  --no-cpu-throttling \
  --set-env-vars "SUPABASE_URL=…,SUPABASE_SERVICE_ROLE_KEY=…,DEVICE_TOKEN=…,CORS_ORIGIN=https://your-frontend.vercel.app"
```

- **`--no-cpu-throttling`** — "CPU always allocated", so the SSE keepalive timer runs reliably even between HTTP requests.
- The old `--timeout 3600` WebSocket workaround is **no longer needed** — device requests are short-lived POSTs that finish in milliseconds. (Cloud Run's default 300 s request timeout applies only to the dashboard's SSE connections, which the browser transparently reconnects.)
- The app honors Cloud Run's injected `PORT` automatically.
- Scale-to-zero caveat: after an idle cold start, the first telemetry POST may be dropped while the instance boots; the ESP simply retries on its next 2.5 s cycle, and any session gap is handled by the stale-check.
- ESP firmware for Cloud Run: `API_HOST = "<service>.run.app"`, `API_PORT = 443`, `USE_TLS = true` (the **GTS Root R1** PEM is already embedded in the sketch for full certificate validation).

---

## 📡 NodeMCU ESP8266 Firmware Setup

The firmware source code is located in [`firmware/sitting_tracker/sitting_tracker.ino`](./firmware/sitting_tracker/sitting_tracker.ino).

### Prerequisites (Arduino IDE)
1. Install [Arduino IDE](https://www.arduino.cc/en/software).
2. Add ESP8266 Board Manager URL in **Preferences**:
   ```
   http://arduino.esp8266.com/stable/package_esp8266com_index.json
   ```
3. In **Tools > Board > Boards Manager**, search for `esp8266` and install the package.
4. Install the **PubSubClient** library (Tools > Manage Libraries — MQTT client; 2.8+).
5. Select **NodeMCU 1.0 (ESP-12E Module)** in **Tools > Board**.
6. Set CPU Frequency: **80 MHz** or **160 MHz**, Upload Speed: **115200**.

### Configuring the Backend API in the Firmware

Open [`firmware/sitting_tracker/sitting_tracker.ino`](./firmware/sitting_tracker/sitting_tracker.ino) and edit the configuration block:

```cpp
// 1. Enter your 2.4 GHz Wi-Fi credentials (multi-network list)
const WifiCredential WIFI_NETWORKS[] = {
  { "Mywifi",  "12343211" },
};

// 2. MQTT broker (EMQX Cloud) — the device's telemetry transport
const bool     USE_MQTT       = true;
const char*    MQTT_HOST      = "your-deployment.ala.asia-southeast1.emqxsl.com";
const uint16_t MQTT_PORT      = 8883;                  // MQTT over TLS
const char*    MQTT_USERNAME  = "your-emqx-username";  // EMQX Cloud → Access Management
const char*    MQTT_PASSWORD  = "your-emqx-password";
const char*    MQTT_CLIENT_ID = "sitting-tracker-01";  // unique per device

// 3. Legacy HTTP heartbeat (kept until MQTT is verified; set USE_HTTP=false to disable)
const char*    API_HOST = "192.168.1.120";
const uint16_t API_PORT = 4000;
const char*    API_PATH = "/api/sitting/heartbeat";
const bool     USE_TLS  = false;   // true → https:// (GTS Root R4 CA is already embedded)
const bool     USE_HTTP = true;

// 4. Device identity + token (must match DEVICE_TOKEN in backend/.env)
const char* DEVICE_ID    = "sitting-tracker-01";
const char* DEVICE_TOKEN = "your-device-token";
```

> [!NOTE]
> The **ISRG Root X1** CA needed for EMQX Cloud's TLS is already embedded in the sketch (`MQTT_CA_CERT`) — full chain + hostname validation, no `setInsecure()` anywhere. If you ever swap to a self-hosted broker with a private CA, replace that PEM.

### Flashing the NodeMCU
1. Connect the NodeMCU to your computer via micro-USB.
2. Select the appropriate **Port** in **Tools > Port**.
3. Click **Upload**.
4. Open **Tools > Serial Monitor** and set the baud rate to **115200**.
5. You will see:
   - Wi-Fi connection status and IP address
   - NTP time sync (needed for TLS certificate validation + the timestamp field)
   - Continuous sensor readings every ~700ms
   - Debounce status and transition logs
   - `[MQTT] Connected — status: online, LWT: offline` and `[MQTT] Telemetry: <state> @ <distance> cm` every 2.5s
   - `[API] Telemetry POST: <state> @ <distance> cm → HTTP 200` every 2.5s (legacy HTTP, during the migration)
   - `[MQTT] Connect failed (state …)` / `[API] Connect failed` when unreachable — retried automatically (MQTT reconnects are throttled to one attempt per 5 s)

---

## 🛡️ Edge Cases & Reliability Design

| Edge Case | Solution & Handling |
| :--- | :--- |
| **NodeMCU restarts while sitting** | The device's first telemetry snapshot carries its current state; the backend checks if an active session already exists — if yes, posture handling is idempotent and no duplicate session is created. |
| **Duplicate state snapshots** | Idempotent design. The backend edge-detects state per device: unchanged snapshots (e.g. `attentive` every 2.5s while sitting) are safe no-ops with zero DB impact; `vacant` with no active session is a safe no-op. This also makes the MQTT + HTTP double-delivery during the migration harmless. |
| **Device stops posting (power-off, Wi-Fi loss)** | MQTT: the broker fires the retained LWT `offline` (~22 s) and the backend marks the device offline in its store. HTTP: the telemetry POST *is* the heartbeat, so silence goes stale. Either way the `/status` stale-check closes the session (~30 s) with `ended_at` = last-contact time, and the dashboard shows "waiting for sensor…" once the last distance reading is >30 s old. |
| **MQTT broker unreachable / Wi-Fi down** | The device keeps sensing and retries (one MQTT attempt per 5 s, HTTP per cycle). Every transport message is a full current-state snapshot, so the first successful send after recovery reconciles everything — nothing is queued or replayed. |
| **Backend unavailable / MQTT subscriber down** | mqtt.js reconnects every 5 s and re-subscribes; the retained LWT status survives backend restarts. Device-side behavior is unchanged — snapshots reconcile on the next send. |
| **Session crossing midnight** | The statistics engine computes the mathematical intersection between any session `[started_at, ended_at]` and the day's boundaries `[00:00:00, 23:59:59]`. A session starting at 23:45 and ending at 00:30 correctly attributes 15m to yesterday and 30m to today. |
| **Malformed / hostile HTTP requests** | Every device request is Bearer-authenticated (`401/403` on bad tokens) and body-validated (`400` on bad `state`/`distance`/`timestamp`). JSON parse errors are handled by a safe Express error handler that can never crash the server. MQTT payloads get the same validation; non-JSON/invalid messages are dropped with a log. |
| **Server as single source of truth** | The device's `timestamp` field is informational only. Server clock (`new Date()`) sets `started_at`, `ended_at`, and `duration_seconds`. |
| **Active Session Live Ticking** | The frontend uses `started_at` from the server to tick locally every second, preventing unnecessary database writes. |

---

## 🧪 Testing

### HTTP device simulator (no hardware needed)

A device simulator is included at [`backend/scripts/device-simulator.mjs`](./backend/scripts/device-simulator.mjs). It mimics the real firmware: authenticated state-snapshot POSTs to `/api/sitting/heartbeat`. Run it from `backend/` (it reads `DEVICE_TOKEN` from `backend/.env`, or pass `--token=…`):

```bash
cd backend

node scripts/device-simulator.mjs attentive  # open a session (one snapshot POST)
node scripts/device-simulator.mjs attentive  # again → unchanged snapshot, no duplicate
node scripts/device-simulator.mjs relax      # switch the active session to relaxing
node scripts/device-simulator.mjs vacant     # close the session
node scripts/device-simulator.mjs stream     # emulate the real device: POST every 2.5s (Ctrl+C to stop)
node scripts/device-simulator.mjs crash      # one sitting snapshot, then go silent → stale-check closes the session (~30s after the next status poll)
node scripts/device-simulator.mjs reconnect  # sit → 3s dropout → sit again → verifies no duplicate session
node scripts/device-simulator.mjs sensor     # distance-only snapshots cycling every posture band (watch the dashboard)
node scripts/device-simulator.mjs badtoken   # expect 401/403
node scripts/device-simulator.mjs malformed  # invalid JSON/state → expect 400, server alive
```

Options: `--url=http://localhost:4000` · `--token=…` · `--id=sitting-tracker-01` · `--state=attentive` · `--distance=20.0` (for `stream`).

> [!WARNING]
> The simulator writes real sessions to whatever Supabase your backend points at. Don't run `attentive`/`vacant`/`crash`/`reconnect` while your real device is mid-session.

### MQTT device simulator (no hardware needed)

An MQTT twin of the HTTP simulator lives at [`backend/scripts/mqtt-device-simulator.mjs`](./backend/scripts/mqtt-device-simulator.mjs). It connects to EMQX Cloud exactly like the firmware (TLS + username/password + LWT) and publishes the same snapshot JSON. Use it to verify the MQTT path **before reflashing the ESP8266**:

```bash
cd backend   # MQTT_BROKER_URL / MQTT_USERNAME / MQTT_PASSWORD come from backend/.env

node scripts/mqtt-device-simulator.mjs attentive  # open a session (one snapshot publish)
node scripts/mqtt-device-simulator.mjs relax      # switch the active session to relaxing
node scripts/mqtt-device-simulator.mjs vacant     # close the session
node scripts/mqtt-device-simulator.mjs stream     # publish a snapshot every 2.5s (Ctrl+C to stop)
node scripts/mqtt-device-simulator.mjs crash      # exit without DISCONNECT → broker fires the LWT
                                                  # (~22s) → backend logs the device going offline
node scripts/mqtt-device-simulator.mjs badjson    # non-JSON payload → dropped, server stays healthy
```

Options: `--url=mqtts://host:8883` · `--username=…` · `--password=…` · `--id=sitting-tracker-01` · `--state=…` · `--distance=…`.

Verification checklist for the MQTT migration (run the backend locally with the MQTT env vars set):
1. `[MQTT] Connected to broker — subscribing to sitting/device/+/telemetry + sitting/device/+/status` in the backend log.
2. `stream` → `[TELEMETRY mqtt]` snapshot logs, dashboard distance + status updating.
3. `vacant` → session closes with the device-derived `ended_at`.
4. `crash` → ~22 s later, `[TELEMETRY] … marked offline (MQTT LWT / broker status)`, and the /status stale-check closes an active session at last contact as before.
5. Check `GET /health` → `"mqtt": {"enabled": true, "connected": true, …}`.

### HTTP endpoints via cURL

```bash
# Device telemetry endpoint (the firmware's only endpoint)
curl -X POST http://localhost:4000/api/sitting/heartbeat \
  -H "Authorization: Bearer your-device-token" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"sitting-tracker-01","distance":20.0,"state":"attentive","timestamp":1759500000}'

# Dashboard endpoints
curl http://localhost:4000/api/sitting/status

# Gateway status: recently-online devices + SSE clients
curl http://localhost:4000/health
```

---

## 🖥️ In-Browser Simulation
The dashboard includes built-in **"Sit Down"** and **"Stand Up"** simulation buttons in the header status card. You can use these to test the entire lifecycle, live stopwatch, and statistics before flashing or attaching the physical sensor.
