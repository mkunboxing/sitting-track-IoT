# Sitting Time Tracker 🪑⏱️

An end-to-end IoT ergonomics telemetry system and real-time dashboard. The system automatically detects when you are sitting at your desk using a **NodeMCU ESP8266** and an **HC-SR04 ultrasonic distance sensor**, records sessions in **Supabase PostgreSQL**, and visualizes sitting habits on a **Next.js (App Router)** dashboard.

The project is split into two apps:

| App | Location | Role |
| :--- | :--- | :--- |
| **Frontend** | [`frontend/`](./frontend) | Next.js dashboard (static UI, calls the API server) |
| **Backend** | [`backend/`](./backend) | Express (TypeScript) API + MQTT device telemetry subscriber + SSE streaming + Supabase access |

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
                │ MQTT over TLS: snapshot every 1.5s
                │ sitting/device/<id>/telemetry + LWT status
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
- **TLS everywhere, no `setInsecure()`:** the ESP8266 embeds the **DigiCert Global Root G2** CA — the root EMQX Cloud's console publishes for the deployment — and validates the full chain against the NTP-synced clock; the backend uses `rejectUnauthorized: true` with Node's built-in roots (which already trust DigiCert Global Root G2).
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

### How the backend processes each snapshot

1. **Validation:** `parseTelemetryPayload` validates every MQTT message (state vocabulary, numeric distance, non-negative `stateForMs`); invalid payloads are dropped with a log.
2. **Telemetry cache (in-memory, never persisted):** the reading is stored and surfaced by `GET /status` as `distanceCm` + `distanceUpdatedAt`. Readings older than 30 s are reported as no-reading, so a powered-off device shows "waiting for sensor…" instead of a frozen distance.
3. **Edge-detected session transitions:** the backend compares the snapshot's state with the device's last known state and calls the shared `sessionService` **only on actual changes** — `relaxing`/`attentive` → `setPosture` (opens a session when vacant), `vacant` → `closeActiveSession`. Unchanged snapshots are no-ops (no DB hit every 2.5 s), and manual dashboard controls are never overridden by the device's unchanged state.
4. **Heartbeat:** each fresh contact touches `last_heartbeat_at` (throttled to one write per 10 s — the same rate the old WebSocket ping loop used), so the `/status` stale-check keeps working unchanged.

### Backend implementation

`backend/src/lib/telemetryProcessor.ts` is the ingestion pipeline (validate → cache → edge-detect → `sessionService` → throttled heartbeat touch); the MQTT subscriber (`backend/src/lib/mqttClient.ts`) is the only transport feeding it — the old HTTP `POST /heartbeat` route and its Bearer-token auth (`lib/auth.ts`, `DEVICE_TOKEN`) were **removed** once MQTT was verified. `backend/src/lib/telemetryStore.ts` holds the in-memory telemetry state (latest reading per device, last known state per device, heartbeat-write throttle, offline marking for MQTT LWT, online-device list for `/health`). Session open/close logic lives only in `backend/src/lib/sessionService.ts`, so MQTT telemetry, the dashboard's manual controls, and the stale-check all behave identically.

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

## 👤 User Accounts & Device Linking

The dashboard is behind a cookie-based login (bcrypt-hashed passwords, HttpOnly session cookie, **no automatic expiry** — logout happens only via the header button or by manually invalidating the `auth_sessions` row). This is completely separate from device/MQTT authentication: the Arduino never sees user accounts, it keeps authenticating at the EMQX broker exactly as before.

### One-time setup (existing installation)

1. **Run the SQL migration** — open the Supabase **SQL Editor** and run [`supabase/migrations/20261004000000_auth_users_devices.sql`](./supabase/migrations/20261004000000_auth_users_devices.sql). It creates the `users`, `auth_sessions` and `devices` tables and adds `user_id`/`device_id` to `sitting_sessions` (nothing is deleted).
2. **Run the data migration** — from `backend/`:

   ```bash
   npx tsx --env-file=.env scripts/migrate-auth.ts
   ```

   This (idempotently):
   - creates the default test/admin account (`admin` / `admin123` by default — set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `backend/.env` to choose your own),
   - assigns **all existing sitting sessions** to that account (and tags them with the device id) so the admin dashboard shows the full history as before,
   - registers + links your Arduino (`DEVICE_ID`, default `sitting-tracker-01`) to the admin account.

### The flow

> Create account → Login → Dashboard → **Connect Device** → enter device ID → device linked → Arduino data lands on that account.

- New users sign up at `/signup`, log in at `/login`, and connect their device from the **Devices** card on the dashboard.
- The backend stamps every new sitting session with the linked owner's `user_id` at open time. An **unlinked device's sessions are visible in nobody's dashboard**.
- A device can be linked to only **one** account; connecting it from another account is rejected until it is disconnected (unlink) first. If a PIN (`device_secret`) is set for a device, claiming it requires that PIN.
- Only the device owner sees its live distance reading, session events and history.

### API surface (all cookie-authenticated except signup/login)

| Route | Purpose |
| :--- | :--- |
| `POST /api/auth/signup` | Create account (duplicate usernames rejected, case-insensitive) |
| `POST /api/auth/login` | Log in, sets the persistent HttpOnly session cookie |
| `POST /api/auth/logout` | Invalidates the session row + clears the cookie |
| `GET /api/auth/me` | Current user (or `null`) |
| `GET /api/devices` | Devices linked to the logged-in user (+ online status) |
| `POST /api/devices/connect` | Link a device to the account (optional PIN) |
| `POST /api/devices/unlink` | Release a device |
| `GET /api/sitting/*` | Dashboard data — now scoped to the logged-in user |


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

# MQTT (EMQX Cloud) — the device telemetry transport
MQTT_BROKER_URL=mqtts://your-deployment.ala.asia-southeast1.emqxsl.com:8883
MQTT_USERNAME=your-emqx-username
MQTT_PASSWORD=your-emqx-password

# Express server
PORT=4000
# Allowed origin(s) of the Next.js frontend, comma-separated
CORS_ORIGIN=http://localhost:3000

# Default admin account for scripts/migrate-auth.ts (user auth setup)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
```

### Frontend — `frontend/.env.local`

```env
# Base URL of the Express backend (empty = same origin)
NEXT_PUBLIC_API_URL=http://localhost:4000
```

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
- **Backend (`backend/`)** — needs an **always-on host with HTTP streaming support for SSE** (Railway, Render, Fly.io, or a VPS all work; serverless platforms like Vercel Functions do **not** — they will not keep SSE connections open). The device telemetry arrives via a persistent outbound MQTT connection to EMQX Cloud, so no WebSocket support is required. Build with `npm run build`, start with `npm start`, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `PORT`, and `CORS_ORIGIN` there — `CORS_ORIGIN=*` allows any origin (easy for dev), or list explicit origins comma-separated, e.g. `http://localhost:3000,https://smart-tracking.vercel.app` (recommended for production).

#### Deploying the backend to Google Cloud Run

Cloud Run works well for this app — the device flow is now ordinary request-based HTTP, which is exactly what Cloud Run bills and scales for. Only SSE needs long-lived connections:

```bash
gcloud run deploy sitting-track-iot \
  --source backend \
  --region asia-south2 \
  --no-cpu-throttling \
  --set-env-vars "SUPABASE_URL=…,SUPABASE_SERVICE_ROLE_KEY=…,MQTT_BROKER_URL=…,MQTT_USERNAME=…,MQTT_PASSWORD=…,CORS_ORIGIN=https://your-frontend.vercel.app"
```

- **`--no-cpu-throttling`** — "CPU always allocated", so the SSE keepalive timer runs reliably even between HTTP requests.
- Device telemetry arrives via the backend's persistent outbound MQTT connection to EMQX Cloud — only the dashboard's SSE needs long-lived inbound connections (the browser transparently reconnects them).
- The app honors Cloud Run's injected `PORT` automatically.
- Scale-to-zero caveat: after an idle cold start, the backend takes a few seconds to reconnect to EMQX Cloud and resume telemetry processing; any session gap in that window is handled by the stale-check.

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

### Configuring the MQTT Broker in the Firmware

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

// 3. Device identity (the MQTT credentials above are the authentication)
const char* DEVICE_ID = "sitting-tracker-01";
```

> [!NOTE]
> The **DigiCert Global Root G2** CA needed for EMQX Cloud's TLS is already embedded in the sketch (`MQTT_CA_CERT` — it's the same certificate the EMQX Cloud console offers for download) — full chain + hostname validation, no `setInsecure()` anywhere. If you ever swap to a different broker, replace that PEM.

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
   - `[MQTT] Connected — status: online, LWT: offline` and `[MQTT] Telemetry: <state> @ <distance> cm` every telemetry cycle
   - `[MQTT] Connect failed (state …)` when unreachable — retried automatically, throttled to one attempt per 5 s

---

## 🛡️ Edge Cases & Reliability Design

| Edge Case | Solution & Handling |
| :--- | :--- |
| **NodeMCU restarts while sitting** | The device's first telemetry snapshot carries its current state; the backend checks if an active session already exists — if yes, posture handling is idempotent and no duplicate session is created. |
| **Duplicate state snapshots** | Idempotent design. The backend edge-detects state per device: unchanged snapshots (e.g. `attentive` every 2.5s while sitting) are safe no-ops with zero DB impact; `vacant` with no active session is a safe no-op. This also makes the MQTT + HTTP double-delivery during the migration harmless. |
| **Device stops publishing (power-off, Wi-Fi loss)** | The broker fires the retained LWT `offline` (~22 s) and the backend marks the device offline in its store. The `/status` stale-check closes the session (~30 s) with `ended_at` = last-contact time, and the dashboard shows "waiting for sensor…" once the last distance reading is >30 s old. |
| **MQTT broker unreachable / Wi-Fi down** | The device keeps sensing and retries (one MQTT attempt per 5 s, HTTP per cycle). Every transport message is a full current-state snapshot, so the first successful send after recovery reconciles everything — nothing is queued or replayed. |
| **Backend unavailable / MQTT subscriber down** | mqtt.js reconnects every 5 s and re-subscribes; the retained LWT status survives backend restarts. Device-side behavior is unchanged — snapshots reconcile on the next send. |
| **Session crossing midnight** | The statistics engine computes the mathematical intersection between any session `[started_at, ended_at]` and the day's boundaries `[00:00:00, 23:59:59]`. A session starting at 23:45 and ending at 00:30 correctly attributes 15m to yesterday and 30m to today. |
| **Malformed / hostile messages** | MQTT payloads are validated (state vocabulary, numeric distance, non-negative `stateForMs`); non-JSON/invalid messages are dropped with a log and can never crash the server. The dashboard API handles JSON parse errors with a safe Express error handler. |
| **Server as single source of truth** | The device's `timestamp` field is informational only. Server clock (`new Date()`) sets `started_at`, `ended_at`, and `duration_seconds`. |
| **Active Session Live Ticking** | The frontend uses `started_at` from the server to tick locally every second, preventing unnecessary database writes. |

---

## 🧪 Testing

### MQTT device simulator (no hardware needed)

A device simulator is included at [`backend/scripts/mqtt-device-simulator.mjs`](./backend/scripts/mqtt-device-simulator.mjs). It connects to EMQX Cloud exactly like the firmware (TLS + username/password + LWT) and publishes the same snapshot JSON:

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

> [!WARNING]
> The simulator writes real sessions to whatever Supabase your backend points at. Don't run `attentive`/`vacant`/`crash` while your real device is mid-session.

What to check while the simulator runs (backend logs + dashboard):
1. `[MQTT] Connected to broker — subscribing to sitting/device/+/telemetry + sitting/device/+/status` in the backend log.
2. `stream` → `[TELEMETRY mqtt]` snapshot logs, dashboard distance + status updating.
3. `vacant` → session closes with the device-derived `ended_at`.
4. `crash` → ~22 s later, `[TELEMETRY] … marked offline (MQTT LWT / broker status)`, and the /status stale-check closes an active session at last contact as before.
5. Check `GET /health` → `"mqtt": {"enabled": true, "connected": true, …}`.

### Host-side unit tests

The firmware's seating state machine (`firmware/sitting_tracker/debounce.h`) is compiled and tested on the host — the exact header the ESP8266 runs:

```bash
c++ -std=c++17 -Wall -Wextra -I firmware/sitting_tracker \
    firmware/tests/debounce_test.cpp -o /tmp/debounce_test && /tmp/debounce_test
```

Posture/time math helpers have their own test at `backend/scripts/posture-math-test.ts`.

### Dashboard endpoints via cURL

```bash
curl http://localhost:4000/api/sitting/status

# Backend status: SSE clients + online devices + MQTT connection
curl http://localhost:4000/health
```

---

## 🖥️ In-Browser Simulation
The dashboard includes built-in **"Sit Down"** and **"Stand Up"** simulation buttons in the header status card. You can use these to test the entire lifecycle, live stopwatch, and statistics before flashing or attaching the physical sensor.
