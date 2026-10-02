# Sitting Time Tracker 🪑⏱️

An end-to-end IoT ergonomics telemetry system and real-time dashboard. The system automatically detects when you are sitting at your desk using a **NodeMCU ESP8266** and an **HC-SR04 ultrasonic distance sensor**, records sessions in **Supabase PostgreSQL**, and visualizes sitting habits on a **Next.js (App Router)** dashboard.

The project is split into two apps:

| App | Location | Role |
| :--- | :--- | :--- |
| **Frontend** | repo root | Next.js dashboard (static UI, calls the API server) |
| **Backend** | [`server/`](./server) | Express (TypeScript) API + SSE streaming + Supabase access |

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
                │ Wi-Fi HTTP(S) POST
                │ Authorization: Bearer <DEVICE_TOKEN>
                ▼
┌─────────────────────────────────┐
│         Express API Server      │
│         (server/, TypeScript)   │
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

### Backend — `server/.env`

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
- **Backend (`server/`)** — needs an **always-on host** because it holds long-lived SSE connections (`GET /api/sitting/stream`); serverless platforms like Vercel Functions will not keep them open. Use Railway, Render, Fly.io, or a VPS. Build with `npm run build`, start with `npm start`, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_TOKEN`, `PORT`, and `CORS_ORIGIN` (include your Vercel frontend URL) there.

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
4. Select **NodeMCU 1.0 (ESP-12E Module)** in **Tools > Board**.
5. Set CPU Frequency: **80 MHz** or **160 MHz**, Upload Speed: **115200**.

### Configuring the Live API URL in the Firmware

Open [`firmware/sitting_tracker/sitting_tracker.ino`](./firmware/sitting_tracker/sitting_tracker.ino) and edit lines 43–57:

```cpp
// 1. Enter your 2.4 GHz Wi-Fi credentials
const char* WIFI_SSID     = "Your_Home_WiFi";
const char* WIFI_PASSWORD = "Your_WiFi_Password";

// 2. Set your Live API URL (the Express backend, NOT the Next.js frontend):
// For testing locally (replace with your computer's LAN IP address):
// const char* SERVER_BASE_URL = "http://192.168.1.120:4000";
//
// For production (your always-on Express host — Railway/Render/Fly/VPS):
const char* SERVER_BASE_URL = "https://your-express-host.example.com";

// 3. Set the Device Authentication Token (must match DEVICE_TOKEN in server/.env)
const char* DEVICE_TOKEN    = "tracker-secret-device-key-change-me";
```

> [!NOTE]
> The firmware talks to the **Express backend**, not the Next.js frontend. Repoint `SERVER_BASE_URL` to wherever you deploy `server/` — the old Vercel URL only serves the dashboard now.

### Flashing the NodeMCU
1. Connect the NodeMCU to your computer via micro-USB.
2. Select the appropriate **Port** in **Tools > Port**.
3. Click **Upload**.
4. Open **Tools > Serial Monitor** and set the baud rate to **115200**.
5. You will see:
   - Wi-Fi connection status and IP address
   - Initial distance measurement
   - Continuous sensor readings every ~700ms
   - Debounce status and transition logs
   - HTTP response codes when sessions start or stop

---

## 🛡️ Edge Cases & Reliability Design

| Edge Case | Solution & Handling |
| :--- | :--- |
| **NodeMCU restarts while sitting** | NodeMCU pings `POST /api/sitting/start`. Backend checks if an active session already exists. If yes, it safely returns HTTP 200 with `already_active` without creating a duplicate. |
| **Duplicate START / STOP events** | Idempotent API design. Redundant START calls return the active session. Redundant STOP calls return HTTP 200 `no_active_session` safely. |
| **Session crossing midnight** | The statistics engine computes the mathematical intersection between any session `[started_at, ended_at]` and the day's boundaries `[00:00:00, 23:59:59]`. A session starting at 23:45 and ending at 00:30 correctly attributes 15m to yesterday and 30m to today. |
| **Network temporary drop** | The firmware maintains a local state machine. If an API request fails due to temporary Wi-Fi disconnection, the firmware sets `hasPendingStateChange = true` and retries every 3 seconds until confirmed, preventing lost events. |
| **Server as single source of truth** | The NodeMCU does NOT generate timestamps. Server clock (`new Date()`) sets `started_at`, `ended_at`, and `duration_seconds`. |
| **Active Session Live Ticking** | The frontend uses `started_at` from the server to tick locally every second, preventing unnecessary database writes. |

---

## 🧪 Testing the API via cURL

You can test the endpoints directly from your terminal:

### 1. Test Starting a Session
```bash
curl -X POST http://localhost:4000/api/sitting/start \
  -H "Authorization: Bearer tracker-secret-device-key-change-me" \
  -H "Content-Type: application/json"
```

### 2. Test Stopping a Session
```bash
curl -X POST http://localhost:4000/api/sitting/stop \
  -H "Authorization: Bearer tracker-secret-device-key-change-me" \
  -H "Content-Type: application/json"
```

### 3. Check Live Telemetry
```bash
curl http://localhost:4000/api/sitting/status
```

---

## 🖥️ In-Browser Simulation
The dashboard includes built-in **"Sit Down"** and **"Stand Up"** simulation buttons in the header status card. You can use these to test the entire lifecycle, live stopwatch, and statistics before flashing or attaching the physical sensor.
