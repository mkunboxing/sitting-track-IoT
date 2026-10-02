# Sitting Time Tracker 🪑⏱️

An end-to-end IoT ergonomics telemetry system and real-time dashboard. The system automatically detects when you are sitting at your desk using a **NodeMCU ESP8266** and an **HC-SR04 ultrasonic distance sensor**, records sessions in **Supabase PostgreSQL**, and visualizes sitting habits on a **Next.js (App Router)** dashboard.

The project is split into two apps:

| App | Location | Role |
| :--- | :--- | :--- |
| **Frontend** | repo root | Next.js dashboard (static UI, calls the API server) |
| **Backend** | [`backend/`](./backend) | Express (TypeScript) API + device WebSocket + SSE streaming + Supabase access |

---

## 🏛️ Architecture

```
┌─────────────────────────────────┐
│     NodeMCU ESP8266 + HC-SR04   │
│  - Distance <= 100cm (Sitting)  │
│  - Distance >  100cm (Away)     │
│  - 2s Debounce for Sitting      │
│  - 5s Debounce for Away         │
│  - Loop Delay: ~700ms           │
└───────────────┬─────────────────┘
                │
                │ Persistent WebSocket (JSON)
                │ ws(s)://…/ws/device + DEVICE_TOKEN auth
                ▼
┌─────────────────────────────────┐
│         Express API Server      │
│         (backend/, TypeScript)  │
│  - WS   /ws/device              │
│  - POST /api/sitting/start      │
│  - POST /api/sitting/stop       │
│  - POST /api/sitting/heartbeat  │
│  - GET  /api/sitting/status     │
│  - GET  /api/sitting/stream     │
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
                │ Real-time / Polling Telemetry
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

## 🔗 Device ⇄ Backend WebSocket

The ESP8266 talks to the backend over a **persistent WebSocket** (library: `WebSockets` by Markus Sattler, install via Arduino Library Manager). Connection state replaces the old HTTP heartbeat.

**Exact URL:** `ws://<backend-host>:4000/ws/device` (dev) · `wss://<backend-host>/ws/device` (production)

### Protocol (JSON text frames)

| Direction | Message | Purpose |
| :--- | :--- | :--- |
| ESP → Backend | `{"type":"authenticate","deviceId":"sitting-tracker-01","token":"…"}` | Must be the first message within 10s of connecting, or the socket is closed (4001) |
| Backend → ESP | `{"type":"authenticated","deviceId":"…"}` | Auth OK; the ESP then syncs its **current** state |
| Backend → ESP | `{"type":"auth_error","error":"…"}` + close 4001 | Bad token / timeout |
| ESP → Backend | `{"type":"state_change","deviceId":"…","state":"sitting"\|"away"}` | Opens/closes a session (idempotent — duplicates are safe no-ops) |
| Backend → ESP | `{"type":"ack","state":"…","result":"started\|closed\|already_active\|no_active_session","durationSeconds"?:n}` | Session result |
| ESP → Backend | `{"type":"sensor","deviceId":"…","distance":75.4}` | Optional telemetry, logged only (firmware does not send it by default) |

### Liveness, disconnects & reconnects

- **Keepalive:** the ESP pings every 15s (`enableHeartbeat`) and the backend pings every 30s; dead sockets are terminated. While a device is connected, the backend touches `last_heartbeat_at`, so the `/status` stale-check keeps working unchanged.
- **Unexpected disconnect** (Wi-Fi loss, power-off, platform-forced drop): the session is **not** closed instantly — managed platforms like Cloud Run force-close long-lived WebSocket connections periodically, and closing on every drop would fragment sessions. Instead the session is left active and auto-closed by the `/status` stale-check (~90 s, `ended_at` = last-contact time) **only if the device does not return**. A device that reconnects quickly and syncs `sitting` continues the same session (`already_active`) with no fragmentation.
- **Reconnect:** the ESP reconnects every 5s (no rapid loops), re-authenticates, then sends only its **current** state. Backend handling is idempotent, so normal reconnects never create duplicate sessions: `sitting` with an active session → no-op; `away` without one → no-op.
- **State change while offline:** nothing is queued or replayed — the ESP holds its current state locally and sends it once after the next successful authentication (never a stale event).
- **One connection per deviceId:** a newer authenticated connection silently replaces the older one (close code 4000) without touching sessions.
- Backend close codes: `4001` authentication failed/timeout/not authenticated · `4000` connection replaced.

### Backend implementation

`backend/src/ws/deviceGateway.ts` — attached to the same HTTP server as Express (same port). Malformed JSON, oversized frames (4 KB cap), binary frames, and unknown message types are answered with `{"type":"error",…}` and can never crash the server. Session open/close logic is shared with the HTTP routes via `backend/src/lib/sessionService.ts`, so WebSocket and HTTP behave identically.

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

### Frontend — `.env.local` (repo root)

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
cd server
npm install
npm run dev

# Terminal 2 — Next.js frontend (http://localhost:3000)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The dashboard talks to the API on `:4000` via `NEXT_PUBLIC_API_URL` (CORS is already configured).

### Deploying

- **Frontend (repo root)** — deploys to Vercel as before. Set the `NEXT_PUBLIC_API_URL` environment variable to the public URL of your Express server (it is inlined into the client bundle at build time).
- **Backend (`backend/`)** — needs an **always-on host with WebSocket support** (Railway, Render, Fly.io, or a VPS all work; serverless platforms like Vercel Functions do **not** — they will not keep WebSocket or SSE connections open). Build with `npm run build`, start with `npm start`, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_TOKEN`, `PORT`, and `CORS_ORIGIN` there — `CORS_ORIGIN=*` allows any origin (easy for dev), or list explicit origins comma-separated, e.g. `http://localhost:3000,https://smart-tracking.vercel.app` (recommended for production). The device WebSocket and the HTTP API share one port — no extra port to open. If you put Nginx in front, forward the upgrade headers:
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:4000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 300s;   # keep idle WS connections alive
  }
  ```

#### Deploying the backend to Google Cloud Run

Cloud Run works (it supports WebSockets and SSE), but two service settings matter for this app:

```bash
gcloud run deploy sitting-track-iot \
  --source backend \
  --region asia-south2 \
  --timeout 3600 \
  --no-cpu-throttling \
  --set-env-vars "SUPABASE_URL=…,SUPABASE_SERVICE_ROLE_KEY=…,DEVICE_TOKEN=…,CORS_ORIGIN=https://your-frontend.vercel.app"
```

- **`--timeout 3600`** — Cloud Run applies the request timeout to **WebSocket connections**: with the default 300 s, the device's connection is force-closed every 5 minutes. Raise it to the 1-hour max; the ESP reconnects within ~5 s of any forced drop and (thanks to grace-based disconnect handling) its session continues unbroken.
- **`--no-cpu-throttling`** — "CPU always allocated", so the server-side ping/heartbeat-touch timers run reliably even between HTTP requests.
- The app honors Cloud Run's injected `PORT` automatically (HTTP and WebSocket share it).
- ESP firmware for Cloud Run: `WS_HOST = "<service>.run.app"`, `WS_PORT = 443`, `USE_TLS = true` (paste the **GTS Root R1** PEM from [pki.goog](https://pki.goog) into `WS_CA_CERT` for full certificate validation).

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
4. In **Library Manager**, install **"WebSockets" by Markus Sattler** (version 2.x) — required for the WebSocket transport.
5. Select **NodeMCU 1.0 (ESP-12E Module)** in **Tools > Board**.
6. Set CPU Frequency: **80 MHz** or **160 MHz**, Upload Speed: **115200**.

### Configuring the WebSocket Server in the Firmware

Open [`firmware/sitting_tracker/sitting_tracker.ino`](./firmware/sitting_tracker/sitting_tracker.ino) and edit the configuration block:

```cpp
// 1. Enter your 2.4 GHz Wi-Fi credentials (multi-network list)
const WifiCredential WIFI_NETWORKS[] = {
  { "Mywifi",  "12343211" },
};

// 2. Point at the Express backend's WebSocket endpoint (NOT the dashboard URL):
//    Local dev (your computer's LAN IP):  ws://192.168.1.120:4000/ws/device
//    Production:                          wss://your-express-host/ws/device
const char*    WS_HOST = "192.168.1.120";
const uint16_t WS_PORT = 4000;
const char*    WS_PATH = "/ws/device";
const bool     USE_TLS = false;   // true → wss:// (paste Let's Encrypt ISRG Root X1 into WS_CA_CERT)

// 3. Device identity + token (must match DEVICE_TOKEN in backend/.env)
const char* DEVICE_ID    = "sitting-tracker-01";
const char* DEVICE_TOKEN = "your-device-token";
```

> [!NOTE]
> The firmware talks to the **Express backend's WebSocket**, not the Next.js frontend. Repoint `WS_HOST`/`WS_PORT` to wherever you deploy `backend/` — the old Vercel URL only serves the dashboard now.

### Flashing the NodeMCU
1. Connect the NodeMCU to your computer via micro-USB.
2. Select the appropriate **Port** in **Tools > Port**.
3. Click **Upload**.
4. Open **Tools > Serial Monitor** and set the baud rate to **115200**.
5. You will see:
   - Wi-Fi connection status and IP address
   - `WebSocket connected → authenticating → WebSocket authenticated`
   - A one-time state sync after authentication
   - Continuous sensor readings every ~700ms
   - Debounce status and transition logs
   - `State sent: sitting/away` on confirmed transitions
   - `WebSocket disconnected / reconnecting` on connection loss

---

## 🛡️ Edge Cases & Reliability Design

| Edge Case | Solution & Handling |
| :--- | :--- |
| **NodeMCU restarts while sitting** | Device reconnects, authenticates and syncs its current state over the WebSocket. Backend checks if an active session already exists — if yes, it returns `already_active` without creating a duplicate. |
| **Duplicate START / STOP events** | Idempotent design. Redundant `state_change: sitting` returns the active session; redundant `state_change: away` is a safe no-op. |
| **Unexpected device disconnect** | Detected instantly via the WebSocket close/missed pings. The session stays active for a grace window — if the device reconnects (its 5 s retry), the same session continues; if it stays offline, the `/status` stale-check closes it (~90 s) with `ended_at` = last-contact time. |
| **State change while offline** | The firmware holds only its current state; after reconnect + authentication it sends that single current state. Stale events are never replayed, and idempotent handling prevents duplicate sessions. |
| **Stale TCP connection (device silently unreachable)** | Two keepalive layers: the ESP pings every 15s, the backend pings every 30s; a missed pong terminates the socket, which then triggers the disconnect handling above. |
| **Session crossing midnight** | The statistics engine computes the mathematical intersection between any session `[started_at, ended_at]` and the day's boundaries `[00:00:00, 23:59:59]`. A session starting at 23:45 and ending at 00:30 correctly attributes 15m to yesterday and 30m to today. |
| **Malformed / hostile WebSocket messages** | 4 KB frame cap, binary-frame rejection, safe JSON parsing, and per-message error replies. A bad message can never crash the server. |
| **Server as single source of truth** | The NodeMCU does NOT generate timestamps. Server clock (`new Date()`) sets `started_at`, `ended_at`, and `duration_seconds`. |
| **Active Session Live Ticking** | The frontend uses `started_at` from the server to tick locally every second, preventing unnecessary database writes. |

---

## 🧪 Testing

### WebSocket device (no hardware needed)

A device simulator is included at [`backend/scripts/ws-device-simulator.mjs`](./backend/scripts/ws-device-simulator.mjs). Run it from `backend/` with `DEVICE_TOKEN` exported (or pass `--token=…`):

```bash
cd backend
export DEVICE_TOKEN=your-device-token

node scripts/ws-device-simulator.mjs sit        # open a session
node scripts/ws-device-simulator.mjs sit        # again → already_active, no duplicate
node scripts/ws-device-simulator.mjs away       # close the session (prints duration ack)
node scripts/ws-device-simulator.mjs crash      # sit, then hard-drop → session auto-closes via stale-check (~90s)
node scripts/ws-device-simulator.mjs reconnect  # sit → drop → reconnect → sync → away
node scripts/ws-device-simulator.mjs badtoken   # expect auth_error + close 4001
node scripts/ws-device-simulator.mjs malformed  # garbage frames → error replies, server alive
node scripts/ws-device-simulator.mjs twice      # second connection with same deviceId supersedes first
```

> [!WARNING]
> Every authenticated simulator connection that disconnects **closes the active sitting session** (by design). Don't run `sit`/`crash`/`reconnect` while your real device is mid-session.

### HTTP endpoints via cURL

```bash
# Device-side endpoints (kept for manual testing; the firmware no longer uses them)
curl -X POST http://localhost:4000/api/sitting/start \
  -H "Authorization: Bearer your-device-token" -H "Content-Type: application/json"

curl -X POST http://localhost:4000/api/sitting/stop \
  -H "Authorization: Bearer your-device-token" -H "Content-Type: application/json"

# Dashboard endpoints
curl http://localhost:4000/api/sitting/status

# Gateway status: connected devices + SSE clients
curl http://localhost:4000/health
```

---

## 🖥️ In-Browser Simulation
The dashboard includes built-in **"Sit Down"** and **"Stand Up"** simulation buttons in the header status card. You can use these to test the entire lifecycle, live stopwatch, and statistics before flashing or attaching the physical sensor.
