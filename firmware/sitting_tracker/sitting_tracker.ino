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
 * Logic & Timing Specifications (posture tracking):
 *   - RELAX_ENTER_CM     = 8 cm   (distance < threshold is relaxing)
 *   - ATTENTIVE_ENTER_CM = 8.5 cm (8–8.5 cm is a deadband: hold previous state)
 *   - OCCUPANCY_LIMIT_CM = 45 cm  (distance <= threshold is occupied)
 *   - OCCUPIED_CONFIRM   = 2000 ms continuous detection to confirm relaxing/attentive
 *   - VACANT_CONFIRM     = 5000 ms continuous detection to confirm vacant
 *   - SENSOR_INTERVAL    = 700 ms  (ultrasonic ping interval)
 *
 * Communication (HTTP telemetry — replaces the old persistent WebSocket):
 *   - Every 2.5s the device POSTs its CURRENT seating state + distance:
 *       POST /api/sitting/heartbeat
 *       Authorization: Bearer <DEVICE_TOKEN>
 *       { "deviceId": "sitting-tracker-01", "distance": 10.5,
 *         "state": "relaxing|attentive|vacant", "timestamp": <epoch secs> }
 *   - Each request IS the device's last-contact/heartbeat signal: the backend
 *     touches last_heartbeat_at and auto-closes the session via its stale
 *     check if the snapshots stop arriving (power-off, Wi-Fi loss).
 *   - Because every POST carries the full current state (not events), there is
 *     nothing to queue or re-sync after an outage: if the backend is
 *     unavailable the device simply keeps sensing, and the next successful
 *     POST reconciles everything (the backend only acts on state CHANGES).
 *   - TLS uses the embedded GTS Root R1 CA (full chain + hostname validation,
 *     no setInsecure anywhere); NTP sync provides the clock both for
 *     certificate validation and the timestamp field.
 *
 * Required Arduino libraries: none beyond the ESP8266 core (built-in
 * WiFiClientSecure). The old "WebSockets" library dependency is gone.
 * ==============================================================================
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

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
//
// Production — Google Cloud Run (TLS terminated by Google, port 443):
//   https://sitting-track-iot-1014206902177.asia-south2.run.app/api/sitting/heartbeat
//     API_HOST = "sitting-track-iot-1014206902177.asia-south2.run.app"
//     API_PORT = 443, USE_TLS = true
//     API_CA_CERT = GTS Root R1 (already embedded below — full validation)
//
// Local development (backend running on your computer — use your LAN IP):
//   http://192.168.1.12:4000/api/sitting/heartbeat   → USE_TLS = false
//     (find your computer's IP: macOS Wi-Fi → Option-click the icon)
// ---------------------------------------------------------------------------
const char*    API_HOST = "sitting-track-iot-1014206902177.asia-south2.run.app";
const uint16_t API_PORT = 443;                 // 443 for Cloud Run (https), 4000 for local dev
const char*    API_PATH = "/api/sitting/heartbeat";
const bool     USE_TLS  = true;                // true → https:// (Cloud Run); false → local dev

// Root CA for production https:// — GTS Root R1 (Google Trust Services), the
// trust anchor for *.run.app certificates. Self-signed, valid 2016–2036.
// BearSSL validates the full chain (leaf → WR2 → this root) + hostname, so
// no setInsecure() is used anywhere. NTP time sync runs in setup() because
// certificate validity checks need a correct clock.
const char* API_CA_CERT =
  "-----BEGIN CERTIFICATE-----\n"
  "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\n"
  "-----END CERTIFICATE-----\n";

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

// Posture Detection Thresholds
//   distance <  8      → RELAXING
//   8 … 8.5            → deadband: keep the previous state (hysteresis, so
//                        readings hovering at the boundary don't flap)
//   8.5 < distance ≤ 45 → ATTENTIVE
//   distance > 45 or invalid → VACANT (desk unoccupied)
const float RELAX_ENTER_CM          = 8.0;   // Distance < 8 cm is relaxing
const float ATTENTIVE_ENTER_CM      = 8.5;   // Distance > 8.5 cm (and <= 45) is attentive
const float OCCUPANCY_LIMIT_CM      = 45.0;  // Distance > 45 cm is vacant
const unsigned long OCCUPIED_CONFIRM = 2000; // 2000 ms continuous to confirm relaxing/attentive
const unsigned long VACANT_CONFIRM   = 5000; // 5000 ms continuous to confirm vacant
const unsigned long SENSOR_INTERVAL = 700;   // 700 ms between sensor readings

// Telemetry cadence: one HTTP POST carrying distance + current state every
// 2.5s. Each POST IS the device heartbeat — the backend treats a gap in these
// posts as the device being gone and auto-closes the session via its
// stale-check. Distance is cached in memory server-side and shown on the
// dashboard; it is never stored in the database.
const unsigned long TELEMETRY_INTERVAL_MS = 2500;

// HTTP timeouts: 5s to get a response, connection dropped when the server
// stays quiet for 300ms after the status line (responses are tiny JSON).
const unsigned long HTTP_RESPONSE_TIMEOUT_MS = 5000;

// ==============================================================================
// 3. STATE DEFINITIONS
// ==============================================================================

enum State {
  STATE_VACANT,
  STATE_RELAXING,
  STATE_ATTENTIVE
};

// Current confirmed state
State currentState = STATE_VACANT;

// Potential state being evaluated for debounce
State potentialState = STATE_VACANT;
unsigned long potentialStateStartTime = 0;

// Backend HTTP client — one persistent TLS/plain connection reused across
// telemetry POSTs (a single handshake is amortized, like the old WebSocket).
// If the server closes it (keep-alive timeout), the next POST re-handshakes.
WiFiClientSecure tlsClient;
WiFiClient plainClient;
WiFiClient* apiClient = nullptr;

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
  Serial.println(F("  Transport: HTTP telemetry (2.5s POST)"));
  Serial.println(F("========================================"));

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  connectToWiFi();

  // --- Backend HTTP client setup ---
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
      tlsClient.setCACert(API_CA_CERT);
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

  // Initial read to calibrate
  float initialDistance = readDistanceCm();
  Serial.print(F("[INIT] Initial Distance: "));
  Serial.print(initialDistance);
  Serial.println(F(" cm"));

  // Same classification as loop(): < 8 relaxing, 8–8.5 deadband (treat as
  // attentive on boot), 8.5–45 attentive, > 45 / invalid vacant
  if (initialDistance > 0 && initialDistance <= OCCUPANCY_LIMIT_CM) {
    potentialState = (initialDistance < RELAX_ENTER_CM) ? STATE_RELAXING : STATE_ATTENTIVE;
  } else {
    potentialState = STATE_VACANT;
    currentState = STATE_VACANT;
    // Startup safety check: if a session is dangling from a previous power-off,
    // the first "vacant" telemetry POST closes it on the server.
    Serial.println(F("[INIT] Desk vacant on boot. Current state (vacant) is sent with the next telemetry POST."));
  }
  potentialStateStartTime = millis();

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
    Serial.print(stateName(currentState));

    // Determine instantaneous posture (with 8–8.5 cm hysteresis deadband):
    //   Valid distance < 8 cm              → relaxing
    //   Distance in the 8–8.5 cm deadband  → hold the current state (a vacant
    //                                        device reads the deadband as attentive)
    //   8.5 cm < distance <= 45 cm         → attentive
    //   Distance > 45 cm or negative (no echo / out of range) → vacant
    State measuredState;
    if (distance <= 0 || distance > OCCUPANCY_LIMIT_CM) {
      measuredState = STATE_VACANT;
    } else if (distance < RELAX_ENTER_CM) {
      measuredState = STATE_RELAXING;
    } else if (distance > ATTENTIVE_ENTER_CM) {
      measuredState = STATE_ATTENTIVE;
    } else {
      measuredState = (currentState == STATE_VACANT) ? STATE_ATTENTIVE : currentState;
    }

    // Check if the measured state is different from potential state being debounced
    if (measuredState != potentialState) {
      // Physical measurement shifted; reset confirmation timer
      potentialState = measuredState;
      potentialStateStartTime = now;
      Serial.print(F(" -> Potential shift to: "));
      Serial.print(stateName(potentialState));
    } else {
      // Measured state matches potential state; check if threshold duration reached
      unsigned long duration = now - potentialStateStartTime;
      unsigned long requiredDuration = (potentialState == STATE_VACANT) ? VACANT_CONFIRM : OCCUPIED_CONFIRM;

      if (duration >= requiredDuration && potentialState != currentState) {
        // State change is confirmed. Nothing to transmit here — the next
        // telemetry POST (≤ 2.5s away) carries the new current state.
        Serial.println();
        Serial.print(F(">>> [STATE CHANGED] Confirmed transition to: "));
        Serial.print(stateName(potentialState));
        Serial.println(F(" (sent with next telemetry POST)"));

        currentState = potentialState;
      }
    }

    Serial.println();
  }

  // 3. Periodic telemetry POST (every TELEMETRY_INTERVAL_MS). Carries the
  //    current state + latest distance; the backend treats it as the device
  //    heartbeat. Silently skipped while offline — sensing continues, and the
  //    next successful POST reconciles everything (it's a state snapshot).
  if (now - lastTelemetryPostTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryPostTime = now;
    postTelemetry();
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
// 8. HTTP TELEMETRY (replaces the old WebSocket dispatch)
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
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!ensureApiClientConnected()) return false;

  // Discard any stale response bytes left from a previous exchange so the
  // status line read below always belongs to THIS request.
  while (apiClient->available()) apiClient->read();

  char body[160];
  snprintf(body, sizeof(body),
           "{\"deviceId\":\"%s\",\"distance\":%.1f,\"state\":\"%s\",\"timestamp\":%lu}",
           DEVICE_ID, lastMeasuredDistanceCm, stateName(currentState),
           (unsigned long)time(nullptr));

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
    Serial.print(stateName(currentState));
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
// 9. WI-FI CONNECTION & RECONNECT HANDLER (Multi-Network) — unchanged
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
