/*
 * ==============================================================================
 * SITTING TIME TRACKER - NodeMCU ESP8266 FIRMWARE
 * ==============================================================================
 *
 * Hardware Connections:
 *   - NodeMCU ESP8266
 *   - HC-SR04 Ultrasonic Distance Sensor
 *   - TRIG → NodeMCU Pin D6 (GPIO 12)
 *   - ECHO → NodeMCU Pin D5 (GPIO 14) via Voltage Divider (5V -> 3.3V)
 *   - VCC  → NodeMCU VIN (5V supply)
 *   - GND  → NodeMCU GND
 *
 * Voltage Divider on ECHO Pin:
 *   HC-SR04 ECHO (5V) ---> [ 1kΩ Resistor ] ---> NodeMCU D5 (3.3V)
 *                                           |
 *                                    [ 2kΩ Resistor ]
 *                                           |
 *                                          GND
 *
 * Logic & Timing Specifications (posture tracking — thresholds + debounce live
 * in debounce.h, shared with the host-side test suite):
 *   - RELAX_ENTER_CM     = 8 cm   (distance < threshold is relaxing)
 *   - ATTENTIVE_ENTER_CM = 8.5 cm (8–8.5 cm is a deadband: hold previous state)
 *   - OCCUPANCY_LIMIT_CM = 45 cm  (distance <= threshold is occupied)
 *   - SIT_START_CONFIRM  = 5000 ms continuous sitting to confirm vacant →
 *                          occupied (the session OPENS on that snapshot)
 *   - SIT_END_CONFIRM    = 10000 ms continuous vacant to confirm occupied →
 *                          vacant (the session CLOSES on that snapshot)
 *   - POSTURE_CONFIRM    = 2000 ms continuous to confirm relaxing ↔ attentive
 *                          (posture switch only — never opens/closes a session)
 *   - SENSOR_INTERVAL    = 700 ms  (ultrasonic ping interval)
 *
 * Communication (MQTT over TLS via EMQX Cloud — primary; the HTTP heartbeat
 * is kept during the migration and removed once MQTT is verified):
 *   - Every 2.5s the device publishes its CURRENT seating state + distance
 *     as JSON to the MQTT topic sitting/device/<deviceId>/telemetry:
 *       { "deviceId": "sitting-tracker-01", "distance": 10.5,
 *         "state": "relaxing|attentive|vacant", "timestamp": <epoch secs>,
 *         "stateForMs": <ms the reported state has been continuously
 *                        measured, i.e. since its confirmation window began> }
 *     The backend (backend/src/lib/mqttClient.ts) subscribes to
 *     sitting/device/+/telemetry and feeds every message into the SAME
 *     pipeline as the old HTTP heartbeat, so `stateForMs` still anchors
 *     session started_at/ended_at to FIRST DETECTION of the new state (true
 *     sit-down / stand-up moments) and the 5 s / 10 s confirmation windows
 *     never inflate the recorded sitting duration.
 *   - Online/offline status uses MQTT Last-Will-and-Testament: on every
 *     connect the device publishes a retained "online" to
 *     sitting/device/<deviceId>/status, and the broker publishes the
 *     retained LWT "offline" for it if the device vanishes without a clean
 *     disconnect (power-off, Wi-Fi loss) — after ~1.5× the 15 s keepalive.
 *   - Each snapshot is still the device's heartbeat: the backend touches
 *     last_heartbeat_at (throttled) and the /status stale-check auto-closes
 *     the session via that signal if snapshots stop arriving.
 *   - Because every message carries the full current state (not events),
 *     there is nothing to queue or re-sync after an outage: if the broker is
 *     unreachable the device simply keeps sensing, and the next published
 *     snapshot reconciles everything (the backend only acts on state
 *     CHANGES). MQTT reconnects automatically (one attempt per 5 s).
 *   - TLS uses the embedded ISRG Root X1 CA (EMQX Cloud terminates TLS with
 *     a Let's Encrypt certificate — full chain + hostname validation, no
 *     setInsecure anywhere); NTP sync provides the clock both for
 *     certificate validation and the timestamp field.
 *
 * Migration switch (both transports run in parallel): the device publishes
 * the MQTT snapshot AND posts the HTTP heartbeat; identical snapshots are
 * idempotent in the shared backend pipeline (edge detection), so double
 * delivery is harmless and each transport can be verified against real
 * traffic. After MQTT is verified end-to-end: set USE_HTTP false (HTTP-only
 * removal) — see the "HTTP TELEMETRY" section for the code to delete.
 *
 * Required Arduino libraries: PubSubClient (Nick O'Leary — Library Manager);
 * everything else is the ESP8266 core (built-in WiFiClientSecure/BearSSL).
 * ==============================================================================
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <BearSSLHelpers.h>
#include <PubSubClient.h>
#include <time.h>

// Pure seating-state machine (thresholds, confirmation windows, debounce) —
// shared verbatim with firmware/tests/debounce_test.cpp
#include "debounce.h"

// ==============================================================================
// 1. CONFIGURATION: Wi-Fi, Backend API, and Device Identity
// ==============================================================================

// ---------------------------------------------------------------------------
// Multi-WiFi Configuration
// Add as many {SSID, Password} pairs as you need.
// The device will try each network in order and connect to the first available one.
// If all fail it will retry from the top on each reconnect attempt.
// ---------------------------------------------------------------------------
struct WifiCredential {
  const char* ssid;
  const char* password;
};

const WifiCredential WIFI_NETWORKS[] = {
  { "Railwire",  "Mk727498" },// Primary network
  { "Mywifi",    "12343211"}  // Secondary network
  // Add more entries here:
  // { "OfficeWiFi", "officepass" },
};

const int WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

// Timeout (ms) to wait per network before trying the next one
const unsigned long WIFI_PER_NETWORK_TIMEOUT = 10000; // 10 seconds each

// ---------------------------------------------------------------------------
// Backend API configuration (the Express backend, NOT the dashboard URL)
// — the HTTP heartbeat transport. KEPT during the MQTT migration so MQTT can
// be verified against real traffic before the HTTP path is removed; set
// USE_HTTP false (or delete section 8) after MQTT is verified end-to-end.
//
// Production — Render.com (TLS terminated by Render, port 443):
//   https://sitting-track-iot.onrender.com/api/sitting/heartbeat
//     API_HOST = "sitting-track-iot.onrender.com"
//     API_PORT = 443, USE_TLS = true
//     API_CA_CERT = GTS Root R4 (EC/P-384, embedded below — full validation)
//     Chain: leaf (WE1) → WE1 intermediate (GTS Root R4) → GTS Root R4 root
//
// Previous Cloud Run deployment (archived):
//   https://sitting-track-iot-1014206902177.asia-south2.run.app  → GTS Root R1
//
// Local development (backend running on your computer — use your LAN IP):
//   http://192.168.1.12:4000/api/sitting/heartbeat   → USE_TLS = false
//     (find your computer's IP: macOS Wi-Fi → Option-click the icon)
// ---------------------------------------------------------------------------
const char*    API_HOST = "sitting-track-iot.onrender.com";
const uint16_t API_PORT = 443;                 // 443 for Render (https), 4000 for local dev
const char*    API_PATH = "/api/sitting/heartbeat";
const bool     USE_TLS  = true;                // true → https:// (Render); false → local dev
const bool     USE_HTTP = true;                // HTTP heartbeat master switch (migration:
                                               // set false once MQTT is verified end-to-end)

// Root CA for production https:// — GTS Root R4 (Google Trust Services, ECDSA/P-384).
// Render.com's TLS chain: leaf → WE1 (intermediate) → GTS Root R4 (this root).
// Self-signed, valid 2016–2036. Source: http://i.pki.goog/r4.crt
//
// BearSSL validates the full certificate chain and the notValidBefore/After
// dates against the NTP-synced clock (handed to the client via setX509Time —
// the core does not read the clock by itself), so no setInsecure() is used
// anywhere. NTP time sync runs in setup().
//
// NOTE: GTS Root R4 uses EC (ECDSA/P-384) — BearSSL on ESP8266 fully supports
// EC certificates; no RSA-only limitation applies.
const char* API_CA_CERT =
  "-----BEGIN CERTIFICATE-----\n"
  "MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD\n"
  "VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG\n"
  "A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw\n"
  "WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz\n"
  "IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi\n"
  "AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi\n"
  "QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR\n"
  "HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW\n"
  "BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D\n"
  "9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8\n"
  "p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD\n"
  "-----END CERTIFICATE-----\n";

// ---------------------------------------------------------------------------
// MQTT configuration (EMQX Cloud) — the device's telemetry transport.
//
// EMQX Cloud console → your deployment → "Connection info" gives the host
// (mqtts://, port 8883); "Access Management" → "Authentication" is where the
// username/password below is created. Topics (built in setup() from DEVICE_ID):
//   sitting/device/<DEVICE_ID>/telemetry — state snapshots, same JSON fields
//                                          as the HTTP heartbeat body
//   sitting/device/<DEVICE_ID>/status    — retained "online" on connect +
//                                          retained LWT "offline" (the broker
//                                          publishes it if this device
//                                          vanishes without a clean disconnect)
//
// The backend subscribes to these with wildcards and feeds every message
// into the same pipeline as the HTTP heartbeat, so during the migration BOTH
// transports can carry identical snapshots safely (the backend edge-detects,
// so the second copy of a snapshot is a no-op).
// ---------------------------------------------------------------------------
const bool     USE_MQTT       = true;
const char*    MQTT_HOST      = "zfc11cf7.ala.asia-southeast1.emqxsl.com";
const uint16_t MQTT_PORT      = 8883;
const char*    MQTT_USERNAME  = "sitting-iot";
const char*    MQTT_PASSWORD  = "Mk727498";
const char*    MQTT_CLIENT_ID = "sitting-tracker-01";   // must be unique per device

// Root CA for MQTT over TLS — ISRG Root X1 (Internet Security Research Group
// / Let's Encrypt). EMQX Cloud's *.emqxsl.com endpoints terminate TLS with
// Let's Encrypt certificates: leaf → intermediate → ISRG Root X1 (this root).
// Self-signed, valid 2015–2035. Source: https://letsencrypt.org/certs/isrgrootx1.pem
//
// BearSSL validates the full certificate chain and the notValidBefore/After
// dates against the NTP-synced clock (handed to the client via setX509Time —
// the core does not read the clock by itself), so no setInsecure() is used
// anywhere. If you self-host a broker with a private CA, paste ITS root here
// instead.
const char* MQTT_CA_CERT =
  "-----BEGIN CERTIFICATE-----\n"
  "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\n"
  "-----END CERTIFICATE-----\n";

// BearSSL TLS record buffer sizes for the MQTT connection. The device keeps
// TWO TLS connections alive during the migration (HTTP + MQTT), and the ESP8266
// has ~80 KB of RAM total — so the MQTT connection negotiates MFLN (RFC 6066
// max-fragment-length) to shrink its record buffers from the 16 KB BearSSL
// default to 512 B; EMQX Cloud negotiates MFLN fine. If [MQTT] logs show the
// TLS handshake failing against a different broker, raise MQTT_TLS_RX_BUFFER
// (e.g. 2048) — at the cost of free heap.
const uint16_t MQTT_TLS_RX_BUFFER = 512;
const uint16_t MQTT_TLS_TX_BUFFER = 512;

// This device's identity (sent in the telemetry payload; the Bearer token is
// the actual authentication)
const char* DEVICE_ID = "sitting-tracker-01";

// Secret Device Authentication Token (must match DEVICE_TOKEN in backend/.env)
const char* DEVICE_TOKEN = "515e0200-a088-4c67-b6fc-3dc9cfb941d3";

// ==============================================================================
// 2. HARDWARE PIN DEFINITIONS & THRESHOLDS
// ==============================================================================

// NodeMCU Pin Mapping
// D6 = GPIO 12 (TRIG)
// D5 = GPIO 14 (ECHO)
const int PIN_TRIG = 12; // D6
const int PIN_ECHO = 14; // D5

// Posture Detection Thresholds & Confirmation Windows — defined in debounce.h
//   distance <  8      → RELAXING
//   8 … 8.5            → deadband: keep the previous state (hysteresis, so
//                        readings hovering at the boundary don't flap)
//   8.5 < distance ≤ 45 → ATTENTIVE
//   distance > 45 or invalid → VACANT (desk unoccupied)
//
// Session confirmation is transition-dependent (SIT_START_CONFIRM 5 s of
// continuous sitting opens a session, SIT_END_CONFIRM 10 s of continuous
// vacant closes it, POSTURE_CONFIRM 2 s only switches relaxing ↔ attentive).
const unsigned long SENSOR_INTERVAL = 700;   // 700 ms between sensor readings

// Telemetry cadence: one HTTP POST carrying distance + current state every
// 2.5s. Each POST IS the device heartbeat — the backend treats a gap in these
// posts as the device being gone and auto-closes the session via its
// stale-check. Distance is cached in memory server-side and shown on the
// dashboard; it is never stored in the database.
const unsigned long TELEMETRY_INTERVAL_MS = 2500;

// HTTP timeouts: 60s to get a response (Render free tier can take ~40s on cold
// start after 15 min of inactivity), connection dropped when the server stays
// quiet for 300ms after the status line (responses are tiny JSON).
const unsigned long HTTP_RESPONSE_TIMEOUT_MS = 60000;

// ==============================================================================
// 3. STATE DEFINITIONS (enum State comes from debounce.h)
// ==============================================================================

// Debounced seating state machine: `current` is the confirmed state reported
// by telemetry; `potential` accumulates continuous confirmation time toward a
// transition (windows: SIT_START_CONFIRM / SIT_END_CONFIRM / POSTURE_CONFIRM);
// `currentSince` is when `current` was first continuously measured (telemetry
// `stateForMs` — lets the backend exclude confirmation windows from the
// recorded sitting duration).
DebounceState debounce = { STATE_VACANT, STATE_VACANT, 0, 0 };

// Backend HTTP client — one persistent TLS/plain connection reused across
// telemetry POSTs (a single handshake is amortized, like the old WebSocket).
// If the server closes it (keep-alive timeout), the next POST re-handshakes.
WiFiClientSecure tlsClient;
WiFiClient plainClient;
WiFiClient* apiClient = nullptr;
// Parsed PEM root CA for TLS. The client only keeps a POINTER to this, so it
// must stay allocated for the app's lifetime. Heap-allocated in setup() when
// USE_TLS so non-TLS builds don't pay for it.
BearSSL::X509List* apiTrustAnchors = nullptr;

// MQTT client (PubSubClient) over its own BearSSL TLS connection — separate
// from the HTTP client so neither transport can stall the other.
WiFiClientSecure mqttTlsClient;
PubSubClient mqttClient(mqttTlsClient);
BearSSL::X509List* mqttTrustAnchors = nullptr;
bool mqttReady = false;   // config parsed + trust anchors loaded

// Topic strings built in setup() from DEVICE_ID (sized for a 64-char id)
char MQTT_TELEMETRY_TOPIC[96];
char MQTT_STATUS_TOPIC[96];

// Throttled automatic reconnect: one connect attempt per interval. A failed
// attempt (TCP connect + TLS handshake) is blocking, so never retry hot.
unsigned long lastMqttReconnectAttemptMs = 0;
const unsigned long MQTT_RECONNECT_INTERVAL_MS = 5000;

// Timer for sensor reading loop
unsigned long lastSensorReadTime = 0;
unsigned long lastTelemetryPostTime = 0;   // telemetry POST pacing
float lastMeasuredDistanceCm = -1.0;       // latest reading, sent as telemetry

// ==============================================================================
// 4. FUNCTION DECLARATIONS
// ==============================================================================

float readDistanceCm();
const char* stateName(State s);
bool ensureApiClientConnected();
bool postTelemetry();
void setupMqtt();
bool connectMqtt();
void ensureMqttConnected();
bool publishTelemetryMqtt();
void connectToWiFi();
bool tryConnectToNetwork(const WifiCredential& net);

// ==============================================================================
// 5. SETUP
// ==============================================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("  Sitting Time Tracker - NodeMCU ESP8266"));
  Serial.println(F("  Transport: MQTT over TLS (EMQX Cloud) + HTTP heartbeat"));
  Serial.println(F("========================================"));

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  connectToWiFi();

  // --- Backend HTTP client setup (kept during the MQTT migration) ---
  if (USE_HTTP) {
    if (USE_TLS) {
      // TLS certificate validation needs a correct clock — start NTP sync.
      // (The clock also feeds the telemetry payload's timestamp field.)
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      if (strlen(API_CA_CERT) > 0) {
        Serial.print(F("[NTP] Waiting for time sync"));
        unsigned long timeStart = millis();
        while (time(nullptr) < 1000000000 && millis() - timeStart < 10000) { // wait up to 10s
          delay(250);
          Serial.print(F("."));
        }
        Serial.println();
        // Parse the PEM root CA into BearSSL trust anchors. (Note: ESP8266's
        // WiFiClientSecure has no setCACert() — that's the ESP32 API — and it
        // does NOT pick up the NTP clock by itself; see setX509Time() below.)
        apiTrustAnchors = new BearSSL::X509List(API_CA_CERT);
        tlsClient.setTrustAnchors(apiTrustAnchors);
      } else {
        Serial.println(F("[TLS] WARNING: USE_TLS=true but API_CA_CERT is empty."));
        Serial.println(F("[TLS] Connecting with UNVALIDATED TLS (no server-identity check)."));
        Serial.println(F("[TLS] Paste the GTS Root R1 PEM into API_CA_CERT for production."));
      }
      apiClient = &tlsClient;
    } else {
      apiClient = &plainClient;
    }
    apiClient->setTimeout(HTTP_RESPONSE_TIMEOUT_MS);
    Serial.print(F("[API] Telemetry endpoint: "));
    Serial.print(USE_TLS ? F("https://") : F("http://"));
    Serial.print(API_HOST);
    Serial.print(F(":"));
    Serial.print(API_PORT);
    Serial.println(API_PATH);
  } else {
    // MQTT is the only telemetry transport — NTP is still needed for TLS
    // certificate validation and the payload timestamp.
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.print(F("[NTP] Waiting for time sync"));
    unsigned long timeStart = millis();
    while (time(nullptr) < 1000000000 && millis() - timeStart < 10000) { // wait up to 10s
      delay(250);
      Serial.print(F("."));
    }
    Serial.println();
  }

  // --- MQTT (EMQX Cloud) client setup ---
  if (USE_MQTT) {
    setupMqtt();
  }

  // Initial read to calibrate
  float initialDistance = readDistanceCm();
  Serial.print(F("[INIT] Initial Distance: "));
  Serial.print(initialDistance);
  Serial.println(F(" cm"));

  // Same classification as loop() (classifyDistance): < 8 relaxing, 8–8.5
  // deadband (treat as attentive on boot), 8.5–45 attentive, > 45 / invalid
  // vacant. Current state starts vacant, so a desk occupied at boot still
  // needs SIT_START_CONFIRM of continuous sitting before a session opens.
  debounce.current = STATE_VACANT;
  debounce.potential = classifyDistance(initialDistance, debounce.current);
  if (debounce.potential == STATE_VACANT) {
    // Startup safety check: if a session is dangling from a previous power-off,
    // the first "vacant" telemetry POST closes it on the server.
    Serial.println(F("[INIT] Desk vacant on boot. Current state (vacant) is sent with the next telemetry POST."));
  }
  debounce.potentialSince = millis();
  debounce.currentSince = debounce.potentialSince; // current (vacant) held since boot

  Serial.println(F("[INIT] Setup complete. Monitoring desk..."));
}

// ==============================================================================
// 6. MAIN LOOP
// ==============================================================================

void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi Connection
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  // 2. Periodic Sensor Measurement (approx. every 700 ms)
  if (now - lastSensorReadTime >= SENSOR_INTERVAL) {
    lastSensorReadTime = now;

    float distance = readDistanceCm();
    lastMeasuredDistanceCm = distance; // remembered for the periodic telemetry POST

    // Print reading to Serial Monitor
    Serial.print(F("[SENSOR] Dist: "));
    if (distance < 0) {
      Serial.print(F("OUT_OF_RANGE"));
    } else {
      Serial.print(distance, 1);
      Serial.print(F(" cm"));
    }
    Serial.print(F(" | Current: "));
    Serial.print(stateName(debounce.current));

    // Instantaneous posture classification with the 8–8.5 cm hysteresis
    // deadband (see classifyDistance in debounce.h), then debounced with a
    // transition-dependent confirmation window: 5 s of continuous sitting to
    // leave vacant (opens a session), 10 s of continuous vacant to leave
    // sitting (closes a session), 2 s for a relaxing ↔ attentive switch
    // (posture only). A fluctuation restarts the pending window, so momentary
    // readings never confirm a transition.
    State measuredState = classifyDistance(distance, debounce.current);
    DebounceEvent event = updateDebounce(debounce, measuredState, now);

    if (event == DEBOUNCE_RESET) {
      Serial.print(F(" -> Potential shift to: "));
      Serial.print(stateName(debounce.potential));
    } else if (event == DEBOUNCE_CONFIRMED) {
      // State change is confirmed. Nothing to transmit here — the next
      // telemetry POST (≤ 2.5s away) carries the new current state.
      Serial.println();
      Serial.print(F(">>> [STATE CHANGED] Confirmed transition to: "));
      Serial.print(stateName(debounce.current));
      Serial.println(F(" (sent with next telemetry POST)"));
    }

    Serial.println();
  }

  // 3. Maintain the MQTT connection: service keepalive pings/incoming packets
  //    on every pass and reconnect (throttled to one attempt per interval)
  //    whenever the broker connection is gone.
  if (USE_MQTT) {
    ensureMqttConnected();
    if (mqttReady) mqttClient.loop();
  }

  // 4. Periodic telemetry (every TELEMETRY_INTERVAL_MS). Both transports send
  //    the same current-state snapshot; the backend's edge detection makes
  //    the second copy a no-op, so running both during the migration is safe.
  //    Silently skipped while offline — sensing continues, and the next
  //    successful send reconciles everything (it's a state snapshot).
  if (now - lastTelemetryPostTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryPostTime = now;
    postTelemetry();         // HTTP heartbeat — removed once MQTT is verified
    publishTelemetryMqtt();  // MQTT snapshot — EMQX Cloud
  }

  yield(); // Allow ESP8266 background tasks (WiFi, TCP) to run
}

// ==============================================================================
// 7. SENSOR READING (HC-SR04 Ultrasonic)
// ==============================================================================

float readDistanceCm() {
  // Clear trigger pin
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);

  // Send 10µs HIGH pulse
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  // Measure ECHO pulse length (timeout = 30000 µs ~ 5 meters max)
  unsigned long duration = pulseIn(PIN_ECHO, HIGH, 30000);

  if (duration == 0) {
    // Sensor timed out / out of range
    return -1.0;
  }

  // Speed of sound: 343 m/s = 0.0343 cm/µs
  // Distance = (duration / 2) * 0.0343
  float distanceCm = (duration * 0.0343) / 2.0;
  return distanceCm;
}

// ==============================================================================
// 8. HTTP TELEMETRY (legacy transport — kept during the MQTT migration so the
//    MQTT path can be verified against real traffic first; delete this section
//    + the USE_HTTP config parts once MQTT is verified end-to-end)
// ==============================================================================

/** Wire/serial name for a state — matches the backend telemetry vocabulary */
const char* stateName(State s) {
  switch (s) {
    case STATE_RELAXING:  return "relaxing";
    case STATE_ATTENTIVE: return "attentive";
    default:              return "vacant";
  }
}

/**
 * Ensure the persistent API connection is up (TLS handshake happens here on
 * first use and after the server closes the keep-alive connection).
 */
bool ensureApiClientConnected() {
  if (apiClient->connected()) return true;

  if (USE_TLS) {
    // BearSSL checks the certificate's notValidBefore/After against the time
    // WE hand it — the core never reads the NTP clock on its own. Refresh it
    // on every (re)connect so a late NTP sync self-heals.
    tlsClient.setX509Time(time(nullptr));
  }

  Serial.print(F("[API] Connecting to "));
  Serial.print(API_HOST);
  Serial.println(F(" ..."));
  if (!apiClient->connect(API_HOST, API_PORT)) {
    Serial.println(F("[API] Connect failed — offline, sensing continues"));
    return false;
  }
  Serial.println(F("[API] Connected"));
  return true;
}

/**
 * POST one telemetry snapshot: {deviceId, distance, state, timestamp}.
 * Every POST IS the device heartbeat. Returns true on HTTP 2xx. Any failure
 * just drops the connection (fresh handshake next cycle) — sensing never
 * stops, and because each POST is a full state snapshot, nothing needs to be
 * queued or replayed after an outage.
 */
bool postTelemetry() {
  if (!USE_HTTP) return false;
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!ensureApiClientConnected()) return false;

  // Discard any stale response bytes left from a previous exchange so the
  // status line read below always belongs to THIS request.
  while (apiClient->available()) apiClient->read();

  char body[160];
  snprintf(body, sizeof(body),
           "{\"deviceId\":\"%s\",\"distance\":%.1f,\"state\":\"%s\",\"timestamp\":%lu,\"stateForMs\":%lu}",
           DEVICE_ID, lastMeasuredDistanceCm, stateName(debounce.current),
           (unsigned long)time(nullptr), (unsigned long)(millis() - debounce.currentSince));

  char request[512];
  int requestLen = snprintf(request, sizeof(request),
           "POST %s HTTP/1.1\r\n"
           "Host: %s\r\n"
           "Authorization: Bearer %s\r\n"
           "Content-Type: application/json\r\n"
           "Content-Length: %d\r\n"
           "Connection: keep-alive\r\n"
           "\r\n"
           "%s",
           API_PATH, API_HOST, DEVICE_TOKEN, (int)strlen(body), body);

  if (requestLen < 0 || (size_t)requestLen >= sizeof(request)) {
    Serial.println(F("[API] Request build failed"));
    apiClient->stop();
    return false;
  }

  size_t sent = apiClient->write((const uint8_t*)request, requestLen);
  if (sent != (size_t)requestLen) {
    Serial.println(F("[API] Send failed — state held locally, retried with next POST"));
    apiClient->stop();
    return false;
  }

  // Wait for the response status line
  unsigned long start = millis();
  while (!apiClient->available()) {
    if (!apiClient->connected()) {
      Serial.println(F("[API] Connection closed before response"));
      apiClient->stop();
      return false;
    }
    if (millis() - start > HTTP_RESPONSE_TIMEOUT_MS) {
      Serial.println(F("[API] Response timeout"));
      apiClient->stop();
      return false;
    }
    delay(10);
  }

  // "HTTP/1.1 200 OK" → code starts at char 9
  String statusLine = apiClient->readStringUntil('\n');
  int httpCode = 0;
  if (statusLine.startsWith("HTTP/1.")) {
    httpCode = statusLine.substring(9, 12).toInt();
  }

  // Best-effort drain of headers + tiny JSON body (they may still be in
  // flight); anything left over is discarded before the next POST anyway.
  unsigned long quietStart = millis();
  while (millis() - quietStart < 300) {
    while (apiClient->available()) {
      apiClient->read();
      quietStart = millis();
    }
    if (!apiClient->connected()) break;
    delay(5);
  }

  if (httpCode >= 200 && httpCode < 300) {
    Serial.print(F("[API] Telemetry POST: "));
    Serial.print(stateName(debounce.current));
    Serial.print(F(" @ "));
    Serial.print(lastMeasuredDistanceCm, 1);
    Serial.print(F(" cm → HTTP "));
    Serial.println(httpCode);
    return true;
  }

  Serial.print(F("[API] Telemetry POST failed → HTTP "));
  Serial.println(httpCode);
  if (httpCode == 401 || httpCode == 403) {
    Serial.println(F("[API] Authentication rejected — check DEVICE_TOKEN"));
  }
  return false;
}

// ==============================================================================
// 9. MQTT TELEMETRY (EMQX Cloud — primary transport)
// ==============================================================================

/**
 * One-time MQTT setup: build the device topics from DEVICE_ID, parse the
 * ISRG Root X1 trust anchors, and configure the PubSubClient (broker, MFLN
 * buffer sizes, keepalive). Refuses to enable MQTT without a CA cert —
 * TLS certificate validation is never skipped (no setInsecure).
 */
void setupMqtt() {
  snprintf(MQTT_TELEMETRY_TOPIC, sizeof(MQTT_TELEMETRY_TOPIC), "sitting/device/%s/telemetry", DEVICE_ID);
  snprintf(MQTT_STATUS_TOPIC, sizeof(MQTT_STATUS_TOPIC), "sitting/device/%s/status", DEVICE_ID);

  if (strlen(MQTT_CA_CERT) == 0) {
    Serial.println(F("[MQTT] ERROR: MQTT_CA_CERT is empty — MQTT disabled (HTTP heartbeat continues)."));
    Serial.println(F("[MQTT] TLS certificate validation is mandatory; no setInsecure fallback exists."));
    return;
  }

  mqttTrustAnchors = new BearSSL::X509List(MQTT_CA_CERT);
  mqttTlsClient.setTrustAnchors(mqttTrustAnchors);
  // MFLN (RFC 6066): shrink the TLS record buffers so the two live TLS
  // connections (HTTP + MQTT) fit in the ESP8266's heap together.
  mqttTlsClient.setBufferSizes(MQTT_TLS_RX_BUFFER, MQTT_TLS_TX_BUFFER);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);   // headroom over the ~140-byte snapshot payload
  mqttClient.setKeepAlive(15);     // broker fires the LWT after ~1.5× this
  mqttClient.setSocketTimeout(10); // seconds to wait for CONNACK

  Serial.print(F("[MQTT] Broker: "));
  Serial.print(MQTT_HOST);
  Serial.print(F(":"));
  Serial.println(MQTT_PORT);
  Serial.print(F("[MQTT] Telemetry topic: "));
  Serial.println(MQTT_TELEMETRY_TOPIC);
  Serial.print(F("[MQTT] Status topic:    "));
  Serial.println(MQTT_STATUS_TOPIC);
  mqttReady = true;
}

/**
 * One MQTT connect attempt (blocking: TCP + TLS handshake + CONNACK, a few
 * seconds on ESP8266). Registers the retained LWT "offline" on the status
 * topic and publishes the retained "online" on success. The caller throttles
 * attempts to one per MQTT_RECONNECT_INTERVAL_MS.
 */
bool connectMqtt() {
  if (!mqttReady) return false;

  // BearSSL checks the certificate's notValidBefore/After against the time
  // WE hand it — the core never reads the NTP clock on its own. Refresh it
  // on every (re)connect so a late NTP sync self-heals.
  mqttTlsClient.setX509Time(time(nullptr));
  // Start from a clean socket so a half-dead TLS session can't poison this handshake.
  mqttTlsClient.stop();

  Serial.print(F("[MQTT] Connecting to "));
  Serial.print(MQTT_HOST);
  Serial.println(F(" ..."));
  // Last Will and Testament: if this device vanishes without a clean
  // disconnect (power-off, Wi-Fi loss), the broker publishes the retained
  // "offline" here after ~1.5× keepalive — the backend marks the device
  // offline on that message.
  bool ok = mqttClient.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD,
                               MQTT_STATUS_TOPIC, 1, true, "offline");
  if (!ok) {
    Serial.print(F("[MQTT] Connect failed (state "));
    Serial.print(mqttClient.state());
    Serial.println(F(") — HTTP heartbeat continues, sensing unaffected"));
    return false;
  }

  // Retained "online": also received by the backend (re)subscribing later,
  // so a restarted backend learns the device is up immediately.
  mqttClient.publish(MQTT_STATUS_TOPIC, "online", true);
  Serial.println(F("[MQTT] Connected — status: online, LWT: offline"));
  return true;
}

/** Automatic reconnect, throttled so a failed attempt never hot-loops. */
void ensureMqttConnected() {
  if (!USE_MQTT || !mqttReady) return;
  if (mqttClient.connected()) return;

  unsigned long now = millis();
  if (now - lastMqttReconnectAttemptMs < MQTT_RECONNECT_INTERVAL_MS) return;
  lastMqttReconnectAttemptMs = now;
  connectMqtt();
}

/**
 * Publish one telemetry snapshot to sitting/device/<id>/telemetry — the same
 * JSON fields as the HTTP POST body. QoS 0 on purpose: a snapshot every 2.5 s
 * needs no per-message acks (a dropped one is reconciled by the next, and
 * `stateForMs` keeps the recorded session timing exact anyway).
 */
bool publishTelemetryMqtt() {
  if (!USE_MQTT || !mqttClient.connected()) return false;

  char payload[160];
  snprintf(payload, sizeof(payload),
           "{\"deviceId\":\"%s\",\"distance\":%.1f,\"state\":\"%s\",\"timestamp\":%lu,\"stateForMs\":%lu}",
           DEVICE_ID, lastMeasuredDistanceCm, stateName(debounce.current),
           (unsigned long)time(nullptr), (unsigned long)(millis() - debounce.currentSince));

  bool ok = mqttClient.publish(MQTT_TELEMETRY_TOPIC, payload);
  if (ok) {
    Serial.print(F("[MQTT] Telemetry: "));
    Serial.print(stateName(debounce.current));
    Serial.print(F(" @ "));
    Serial.print(lastMeasuredDistanceCm, 1);
    Serial.println(F(" cm"));
  } else {
    Serial.println(F("[MQTT] Publish failed — state held locally, reconciled by the next snapshot"));
  }
  return ok;
}

// ==============================================================================
// 10. WI-FI CONNECTION & RECONNECT HANDLER (Multi-Network) — unchanged
// ==============================================================================

// Attempt to connect to a single network; returns true on success.
bool tryConnectToNetwork(const WifiCredential& net) {
  Serial.println();
  Serial.print(F("[WIFI] Trying SSID: "));
  Serial.println(net.ssid);

  WiFi.disconnect(true);
  delay(100);
  WiFi.begin(net.ssid, net.password);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < WIFI_PER_NETWORK_TIMEOUT) {
    delay(500);
    Serial.print(F("."));
  }
  Serial.println();

  return WiFi.status() == WL_CONNECTED;
}

// Cycles through all configured networks until one connects.
void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println();
  Serial.println(F("[WIFI] Starting multi-network scan..."));

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // We handle reconnect manually for multi-AP support

  for (int i = 0; i < WIFI_NETWORK_COUNT; i++) {
    Serial.print(F("[WIFI] Attempting network "));
    Serial.print(i + 1);
    Serial.print(F("/"));
    Serial.print(WIFI_NETWORK_COUNT);
    Serial.print(F(": "));
    Serial.println(WIFI_NETWORKS[i].ssid);

    if (tryConnectToNetwork(WIFI_NETWORKS[i])) {
      Serial.print(F("[WIFI] Connected to: "));
      Serial.println(WIFI_NETWORKS[i].ssid);
      Serial.print(F("[WIFI] IP Address: "));
      Serial.println(WiFi.localIP());
      Serial.print(F("[WIFI] Signal Strength (RSSI): "));
      Serial.print(WiFi.RSSI());
      Serial.println(F(" dBm"));
      Serial.println(F("[WIFI] WiFi connected"));
      return; // Successfully connected — done
    }

    Serial.print(F("[WIFI] Failed to connect to: "));
    Serial.println(WIFI_NETWORKS[i].ssid);
  }

  Serial.println(F("[WIFI] All networks exhausted. Will retry in next loop iteration."));
}
