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
 * Communication (MQTT over TLS via EMQX Cloud — the only telemetry transport):
 *   - Every TELEMETRY_INTERVAL_MS the device publishes its CURRENT seating
 *     state + distance as JSON to the MQTT topic
 *     sitting/device/<deviceId>/telemetry:
 *       { "deviceId": "sitting-tracker-01", "distance": 10.5,
 *         "state": "relaxing|attentive|vacant", "timestamp": <epoch secs>,
 *         "stateForMs": <ms the reported state has been continuously
 *                        measured, i.e. since its confirmation window began> }
 *     The backend (backend/src/lib/mqttClient.ts) subscribes to
 *     sitting/device/+/telemetry and feeds every message into the shared
 *     telemetry pipeline, so `stateForMs` still anchors session
 *     started_at/ended_at to FIRST DETECTION of the new state (true sit-down /
 *     stand-up moments) and the 5 s / 10 s confirmation windows never inflate
 *     the recorded sitting duration.
 *   - CONFIRMED session transitions are ALSO published as discrete QoS 1
 *     events to sitting/device/<deviceId>/events:
 *       { "eventId": "<deviceId>-<uptimeMillis>-<epochSecs>",
 *         "type": "SESSION_STARTED" | "SESSION_ENDED",
 *         "deviceId": "sitting-tracker-01",
 *         "state": "relaxing|attentive|vacant",
 *         "timestamp": <epoch secs of the confirmed transition> }
 *     SESSION_STARTED fires when a vacant → sitting transition is confirmed
 *     (5 s window), SESSION_ENDED when sitting → vacant is confirmed (10 s
 *     window); posture switches (relaxing ↔ attentive) never open/close a
 *     session and produce no event. QoS 1 + the backend's persistent (non-
 *     clean) MQTT session mean EMQX Cloud buffers these while the backend is
 *     offline (Render deploy/crash) and replays them on reconnect — the
 *     backend processes them idempotently by eventId and uses the event's
 *     own timestamp, so replayed history lands at its true moments. There is
 *     deliberately NO local event storage on the device: if the device
 *     itself is offline when a transition confirms, the event is lost and
 *     the next telemetry snapshot still reconciles the state as today.
 *   - Online/offline status uses MQTT Last-Will-and-Testament: on every
 *     connect the device publishes a retained "online" to
 *     sitting/device/<deviceId>/status, and the broker publishes the
 *     retained LWT "offline" for it if the device vanishes without a clean
 *     disconnect (power-off, Wi-Fi loss) — after ~1.5× the 15 s keepalive.
 *   - Each snapshot is still the device's heartbeat: the backend touches
 *     last_heartbeat_at (throttled) and the /status stale-check auto-closes
 *     the session via that signal if snapshots stop arriving.
 *   - Telemetry stays QoS 0 on purpose: because every message carries the
 *     full current state (not events), a dropped snapshot is reconciled by
 *     the next one, and `stateForMs` keeps the recorded session timing exact.
 *     MQTT reconnects automatically (one attempt per 5 s).
 *   - TLS uses the embedded DigiCert Global Root G2 CA (the root EMQX Cloud
 *     itself publishes for the deployment — full chain + hostname validation,
 *     no setInsecure anywhere); NTP sync provides the clock both for
 *     certificate validation and the timestamp field.
 *   - Render keep-alive: every 10 minutes the device GETs the backend's
 *     existing https://<RENDER_HEALTH_HOST>/health over a separate HTTPS
 *     connection (GTS Root R4-validated TLS) so the Render free tier never
 *     sleeps and the MQTT backend stays available without the website open.
 *     Non-blocking between checks; failures are logged and retried next
 *     interval without touching MQTT/telemetry/session behavior (section 10).
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

// Private secrets (Wi-Fi networks, MQTT broker host/username/password) —
// gitignored, never committed. First-time setup: copy credentials.example.h
// (same folder) to credentials.h and fill in your own values.
#include "credentials.h"

// ==============================================================================
// 1. CONFIGURATION: Wi-Fi, MQTT Broker, and Device Identity
// ==============================================================================

// ---------------------------------------------------------------------------
// Multi-WiFi Configuration — the {SSID, password} network list lives in
// credentials.h (gitignored; credentials.example.h shows the format). The
// device will try each network in order and connect to the first available
// one. If all fail it will retry from the top on each reconnect attempt.
// ---------------------------------------------------------------------------

// Timeout (ms) to wait per network before trying the next one
const unsigned long WIFI_PER_NETWORK_TIMEOUT = 10000; // 10 seconds each

// ---------------------------------------------------------------------------
// MQTT configuration (EMQX Cloud) — the device's telemetry transport.
//
// EMQX Cloud console → your deployment → "Connection info" gives the host
// (mqtts://, port 8883); "Access Management" → "Authentication" is where the
// username/password in credentials.h is created. Topics (built in setup() from DEVICE_ID):
//   sitting/device/<DEVICE_ID>/telemetry — state snapshots (QoS 0)
//   sitting/device/<DEVICE_ID>/status    — retained "online" on connect +
//                                          retained LWT "offline" (the broker
//                                          publishes it if this device
//                                          vanishes without a clean disconnect)
//   sitting/device/<DEVICE_ID>/events    — confirmed session transitions
//                                          (SESSION_STARTED/ENDED, QoS 1) that
//                                          the broker buffers for the backend's
//                                          persistent session while it is offline
//
// The backend subscribes to these with wildcards and feeds telemetry into its
// shared pipeline (telemetryProcessor.ts) and events into its idempotent
// session-event handler (sessionEvents.ts).
// ---------------------------------------------------------------------------
const bool     USE_MQTT       = true;
// MQTT_HOST / MQTT_USERNAME / MQTT_PASSWORD live in credentials.h (gitignored)
const uint16_t MQTT_PORT      = 8883;
const char*    MQTT_CLIENT_ID = "sitting-tracker-01";   // must be unique per device

// Root CA for MQTT over TLS — DigiCert Global Root G2. This is the root the
// EMQX Cloud console itself offers for download ("CA Certificate" on the
// deployment's connection-info page): the broker's *.emqxsl.com TLS
// certificate chains to it. Self-signed public root, valid 2013–2038.
// Source: EMQX Cloud console download (sha256 fingerprint
// CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F).
//
// BearSSL validates the full certificate chain and the notValidBefore/After
// dates against the NTP-synced clock (handed to the client via setX509Time —
// the core does not read the clock by itself), so no setInsecure() is used
// anywhere. If you ever switch to a different broker/CA, replace this PEM
// (download it from the EMQX Cloud console, or inspect the chain with:
//  openssl s_client -connect <host>:8883 -showcerts).
const char* MQTT_CA_CERT =
  "-----BEGIN CERTIFICATE-----\n"
  "MIIDjjCCAnagAwIBAgIQAzrx5qcRqaC7KGSxHQn65TANBgkqhkiG9w0BAQsFADBh\n"
  "MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3\n"
  "d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH\n"
  "MjAeFw0xMzA4MDExMjAwMDBaFw0zODAxMTUxMjAwMDBaMGExCzAJBgNVBAYTAlVT\n"
  "MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j\n"
  "b20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IEcyMIIBIjANBgkqhkiG\n"
  "9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuzfNNNx7a8myaJCtSnX/RrohCgiN9RlUyfuI\n"
  "2/Ou8jqJkTx65qsGGmvPrC3oXgkkRLpimn7Wo6h+4FR1IAWsULecYxpsMNzaHxmx\n"
  "1x7e/dfgy5SDN67sH0NO3Xss0r0upS/kqbitOtSZpLYl6ZtrAGCSYP9PIUkY92eQ\n"
  "q2EGnI/yuum06ZIya7XzV+hdG82MHauVBJVJ8zUtluNJbd134/tJS7SsVQepj5Wz\n"
  "tCO7TG1F8PapspUwtP1MVYwnSlcUfIKdzXOS0xZKBgyMUNGPHgm+F6HmIcr9g+UQ\n"
  "vIOlCsRnKPZzFBQ9RnbDhxSJITRNrw9FDKZJobq7nMWxM4MphQIDAQABo0IwQDAP\n"
  "BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUTiJUIBiV\n"
  "5uNu5g/6+rkS7QYXjzkwDQYJKoZIhvcNAQELBQADggEBAGBnKJRvDkhj6zHd6mcY\n"
  "1Yl9PMWLSn/pvtsrF9+wX3N3KjITOYFnQoQj8kVnNeyIv/iPsGEMNKSuIEyExtv4\n"
  "NeF22d+mQrvHRAiGfzZ0JFrabA0UWTW98kndth/Jsw1HKj2ZL7tcu7XUIOGZX1NG\n"
  "Fdtom/DzMNU+MeKNhJ7jitralj41E6Vf8PlwUHBHQRFXGU7Aj64GxJUTFy8bJZ91\n"
  "8rGOmaFvE7FBcf6IKshPECBV1/MUReXgRPTqh5Uykw7+U0b6LJ3/iyK5S9kJRaTe\n"
  "pLiaWN0bfVKfjllDiIGknibVb63dDcY3fe0Dkhvld1927jyNxF1WW6LZZm6zNTfl\n"
  "MrY=\n"
  "-----END CERTIFICATE-----\n";

// BearSSL TLS record buffer sizes for the MQTT connection. The MQTT
// connection negotiates MFLN (RFC 6066 max-fragment-length) to shrink its
// record buffers from the 16 KB BearSSL default to 512 B; EMQX Cloud
// negotiates MFLN fine, and the small buffers leave generous free heap on
// the ESP8266's ~80 KB of RAM. If [MQTT] logs show the TLS handshake failing
// against a different broker, raise MQTT_TLS_RX_BUFFER (e.g. 2048).
const uint16_t MQTT_TLS_RX_BUFFER = 512;
const uint16_t MQTT_TLS_TX_BUFFER = 512;

// This device's identity (sent in the telemetry payload; MQTT broker
// username/password in credentials.h is the actual authentication)
const char* DEVICE_ID = "sitting-tracker-01";

// ---------------------------------------------------------------------------
// Render keep-alive heartbeat: every HEALTH_CHECK_INTERVAL_MS the device
// GETs the backend's EXISTING /health endpoint over HTTPS. Goal: enough
// periodic traffic to stop the Render free tier from sleeping, so the MQTT
// backend stays available even when no browser/dashboard is open. The
// backend URL lives HERE and nowhere else (see section 10 for the client).
// The health check is advisory only — on any failure it logs and retries at
// the next interval; MQTT, telemetry and session logic are unaffected.
// ---------------------------------------------------------------------------
const char*    RENDER_HEALTH_HOST = "sitting-track-iot.onrender.com";
const uint16_t RENDER_HEALTH_PORT = 443;
const char*    RENDER_HEALTH_PATH = "/health";   // the backend's existing health endpoint
const unsigned long HEALTH_CHECK_INTERVAL_MS   = 10UL * 60UL * 1000UL;  // 10 minutes
const unsigned long HEALTH_RESPONSE_TIMEOUT_MS = 90UL * 1000UL;         // Render free tier cold-starts on the request (~40 s)

// Root CA for the Render HTTPS connection — GTS Root R4 (Google Trust
// Services, EC P-384, self-signed, valid 2016–2036). Render terminates TLS
// with a GTS WE1 certificate chaining to this root (NOT Let's Encrypt —
// check the served chain if you ever change hosts). Fingerprint
// 34:9D:FA:40:58:C5:E2:63:12:3B:39:8A:E7:95:57:3C:4E:13:13:C8:3F:E6:8F:93:55:6C:D5:E8:03:1B:3C:7D
// (matches the OS trust stores; recovered verbatim from the pre-MQTT
// firmware where it was verified working against this exact host).
// BearSSL validates the chain + hostname against the NTP-synced clock —
// no setInsecure anywhere. If you ever move the backend off Render,
// replace this PEM (openssl s_client -connect <host>:443 -showcerts).
const char* RENDER_HEALTH_CA_CERT =
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

// Telemetry cadence: one MQTT snapshot carrying distance + current state
// every TELEMETRY_INTERVAL_MS. Each snapshot IS the device heartbeat — the
// backend treats a gap in these snapshots as the device being gone and
// auto-closes the session via its stale-check (plus the broker's LWT marks
// the device offline ~22 s after a vanish). Distance is cached in memory
// server-side and shown on the dashboard; it is never stored in the database.
const unsigned long TELEMETRY_INTERVAL_MS = 1500;

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

// MQTT client (PubSubClient) over a BearSSL TLS connection.
WiFiClientSecure mqttTlsClient;
PubSubClient mqttClient(mqttTlsClient);
BearSSL::X509List* mqttTrustAnchors = nullptr;
bool mqttReady = false;   // config parsed + trust anchors loaded

// Topic strings built in setup() from DEVICE_ID (sized for a 64-char id)
char MQTT_TELEMETRY_TOPIC[96];
char MQTT_STATUS_TOPIC[96];
char MQTT_EVENTS_TOPIC[96];

// Throttled automatic reconnect: one connect attempt per interval. A failed
// attempt (TCP connect + TLS handshake) is blocking, so never retry hot.
unsigned long lastMqttReconnectAttemptMs = 0;
const unsigned long MQTT_RECONNECT_INTERVAL_MS = 5000;

// Timer for sensor reading loop
unsigned long lastSensorReadTime = 0;
unsigned long lastTelemetryPostTime = 0;   // last telemetry publish time
float lastMeasuredDistanceCm = -1.0;       // latest reading, sent as telemetry

// Render keep-alive heartbeat state (see section 10). The response wait is a
// NON-blocking state machine — only the TLS handshake inside connect()
// briefly blocks (capped by the core at 15 s; normal handshakes take 1–3 s).
WiFiClientSecure healthTlsClient;          // separate socket from the MQTT one
BearSSL::X509List* healthTrustAnchors = nullptr;
bool healthReady = false;                  // config parsed + trust anchors loaded
bool healthBootCheckDone = false;          // first check fires right after boot Wi-Fi
bool healthAwaitingResponse = false;       // request sent, polling for the status line
unsigned long lastHealthCheckMs = 0;
unsigned long healthAttemptStartMs = 0;
char healthStatusHead[16];                 // first bytes of the HTTP response ("HTTP/1.1 NNN")
uint8_t healthStatusLen = 0;

// ==============================================================================
// 4. FUNCTION DECLARATIONS
// ==============================================================================

float readDistanceCm();
const char* stateName(State s);
void setupMqtt();
bool connectMqtt();
void ensureMqttConnected();
bool publishTelemetryMqtt();
bool publishMqttQos1(const char* topic, const char* payload);
void publishSessionEventMqtt(const char* type, const char* state);
void connectToWiFi();
bool tryConnectToNetwork(const WifiCredential& net);
void setupHealthHeartbeat();
void runHealthHeartbeat(unsigned long now);
bool startHealthRequest(unsigned long now);
void finishHealthRequest(bool ok, const char* detail);

// ==============================================================================
// 5. SETUP
// ==============================================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("  Sitting Time Tracker - NodeMCU ESP8266"));
  Serial.println(F("  Transport: MQTT over TLS (EMQX Cloud)"));
  Serial.println(F("========================================"));

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  connectToWiFi();

  // TLS certificate validation needs a correct clock — start NTP sync.
  // (The clock also feeds the telemetry payload's timestamp field.)
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.print(F("[NTP] Waiting for time sync"));
  unsigned long timeStart = millis();
  while (time(nullptr) < 1000000000 && millis() - timeStart < 10000) { // wait up to 10s
    delay(250);
    Serial.print(F("."));
  }
  Serial.println();

  // --- MQTT (EMQX Cloud) client setup ---
  if (USE_MQTT) {
    setupMqtt();
  }

  // --- Render keep-alive heartbeat (GET /health every 10 min, section 10) ---
  setupHealthHeartbeat();

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
    // the first "vacant" telemetry snapshot closes it on the server.
    Serial.println(F("[INIT] Desk vacant on boot. Current state (vacant) is sent with the next telemetry snapshot."));
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
    lastMeasuredDistanceCm = distance; // remembered for the periodic telemetry publish

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
    State previousState = debounce.current; // remembered for the session-event hook below
    DebounceEvent event = updateDebounce(debounce, measuredState, now);

    if (event == DEBOUNCE_RESET) {
      Serial.print(F(" -> Potential shift to: "));
      Serial.print(stateName(debounce.potential));
    } else if (event == DEBOUNCE_CONFIRMED) {
      // State change is confirmed. The next telemetry snapshot
      // (<= TELEMETRY_INTERVAL_MS away) carries the new current state as
      // usual; session-level transitions are ALSO published as discrete
      // QoS 1 events (buffered by EMQX while the backend is offline).
      Serial.println();
      Serial.print(F(">>> [STATE CHANGED] Confirmed transition to: "));
      Serial.print(stateName(debounce.current));
      Serial.println(F(" (sent with next telemetry snapshot)"));

      // Confirmed vacant -> sitting opens a session; sitting -> vacant closes
      // one. Posture switches (relaxing <-> attentive) never open or close a
      // session, so no event for those.
      if (previousState == STATE_VACANT && debounce.current != STATE_VACANT) {
        publishSessionEventMqtt("SESSION_STARTED", stateName(debounce.current));
      } else if (previousState != STATE_VACANT && debounce.current == STATE_VACANT) {
        publishSessionEventMqtt("SESSION_ENDED", "vacant");
      }
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

  // 4. Render keep-alive heartbeat (GET /health every 10 min). Non-blocking
  //    state machine — see section 10. Failure is logged and retried at the
  //    next interval; MQTT, telemetry and sensing are never blocked by it.
  runHealthHeartbeat(now);

  // 5. Periodic telemetry publish (every TELEMETRY_INTERVAL_MS). Carries the
  //    current state + latest distance; the backend treats it as the device
  //    heartbeat. Silently skipped while offline — sensing continues, and the
  //    next successful publish reconciles everything (it's a state snapshot).
  if (now - lastTelemetryPostTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryPostTime = now;
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
// 8. TELEMETRY (MQTT over TLS — EMQX Cloud)
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
 * One-time MQTT setup: build the device topics from DEVICE_ID, parse the
 * DigiCert Global Root G2 trust anchors, and configure the PubSubClient (broker, MFLN
 * buffer sizes, keepalive). Refuses to enable MQTT without a CA cert —
 * TLS certificate validation is never skipped (no setInsecure).
 */
void setupMqtt() {
  snprintf(MQTT_TELEMETRY_TOPIC, sizeof(MQTT_TELEMETRY_TOPIC), "sitting/device/%s/telemetry", DEVICE_ID);
  snprintf(MQTT_STATUS_TOPIC, sizeof(MQTT_STATUS_TOPIC), "sitting/device/%s/status", DEVICE_ID);
  snprintf(MQTT_EVENTS_TOPIC, sizeof(MQTT_EVENTS_TOPIC), "sitting/device/%s/events", DEVICE_ID);

  if (strlen(MQTT_CA_CERT) == 0) {
    Serial.println(F("[MQTT] ERROR: MQTT_CA_CERT is empty — MQTT disabled."));
    Serial.println(F("[MQTT] TLS certificate validation is mandatory; no setInsecure fallback exists."));
    return;
  }

  mqttTrustAnchors = new BearSSL::X509List(MQTT_CA_CERT);
  mqttTlsClient.setTrustAnchors(mqttTrustAnchors);
  // MFLN (RFC 6066): shrink the TLS record buffers — leaves generous free
  // heap on the ESP8266.
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
  Serial.print(F("[MQTT] Events topic:    "));
  Serial.println(MQTT_EVENTS_TOPIC);
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
    Serial.println(F(") — sensing unaffected, retried in 5 s"));
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
 * Publish one telemetry snapshot to sitting/device/<id>/telemetry.
 * QoS 0 on purpose: a snapshot every TELEMETRY_INTERVAL_MS needs no
 * per-message acks (a dropped one is reconciled by the next, and
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

/**
 * Publish one MQTT 3.1.1 PUBLISH packet at QoS 1. PubSubClient 2.8 has no
 * QoS parameter on publish() — it is hardwired to QoS 0 — and QoS 1 is
 * REQUIRED for the session events: EMQX only queues QoS >= 1 messages for
 * the backend's persistent (non-clean) session while the backend is
 * offline, so a QoS 0 event would defeat the offline-buffering feature.
 *
 * This writes exactly the packet the library itself writes in publish()
 * (fixed header + remaining-length varint + topic + payload), with the QoS 1
 * flag and a packet id added, through PubSubClient's own write() passthrough
 * so its keepalive bookkeeping (lastOutActivity) stays correct. The
 * broker's PUBACK is drained and ignored by PubSubClient::loop() (readPacket
 * consumes the whole packet; the type switch has no PUBACK case), so nothing
 * else is needed. Without local storage there is nothing to retry an
 * unacked event against — a failed or partial write is treated as a lost
 * event, same as every other offline publish here.
 */
bool publishMqttQos1(const char* topic, const char* payload) {
  if (!USE_MQTT || !mqttClient.connected()) return false;

  const uint16_t topicLen = (uint16_t)strlen(topic);
  const uint16_t payloadLen = (uint16_t)strlen(payload);
  const uint32_t remainingLength = 2u + topicLen + 2u + payloadLen; // topic field + packet id + payload

  // Fixed header (1) + up to 4 length bytes + topic field + packet id + payload
  const uint16_t PACKET_BUF_SIZE = 5 + 2 + 96 + 2 + 224; // topic max 96, payload max 224
  uint8_t packet[PACKET_BUF_SIZE];

  uint16_t pos = 0;
  packet[pos++] = MQTTPUBLISH | MQTTQOS1; // 0x32: PUBLISH, QoS 1, no retain, no dup
  // Remaining-length varint (1-4 bytes, 7 bits each, high bit = continue)
  uint32_t len = remainingLength;
  do {
    uint8_t digit = len & 0x7F;
    len >>= 7;
    if (len > 0) digit |= 0x80;
    packet[pos++] = digit;
  } while (len > 0);

  if (pos + 2u + topicLen + 2u + payloadLen > PACKET_BUF_SIZE) return false;

  packet[pos++] = topicLen >> 8;
  packet[pos++] = topicLen & 0xFF;
  memcpy(packet + pos, topic, topicLen);
  pos += topicLen;

  static uint16_t packetId = 0; // must be nonzero for QoS > 0
  if (++packetId == 0) packetId = 1;
  packet[pos++] = packetId >> 8;
  packet[pos++] = packetId & 0xFF;

  memcpy(packet + pos, payload, payloadLen);
  pos += payloadLen;

  // One atomic write: a partial packet would be a protocol violation, so
  // require the full write to succeed.
  return mqttClient.write(packet, pos) == pos;
}

/**
 * Publish one CONFIRMED session event to sitting/device/<id>/events at
 * QoS 1 (not retained). EMQX queues these for the backend's persistent
 * (non-clean) MQTT session, so a SESSION_STARTED/SESSION_ENDED that happens
 * while the backend (Render) is offline is delivered once it reconnects —
 * the reliability layer for session history. Telemetry snapshots stay QoS 0
 * fire-and-forget; only these events are buffered.
 *
 * The payload carries the device's own event timestamp (NTP-synced epoch
 * secs — the moment this transition was confirmed) and a unique eventId
 * (<deviceId>-<uptimeMillis>-<epochSecs>); the backend keys idempotent
 * processing and true-timestamp session records on both.
 *
 * There is deliberately NO local event storage: if the device itself is
 * offline (Wi-Fi/broker down) when an event confirms, the publish fails and
 * the event is lost — the next telemetry snapshot still reconciles the
 * device state exactly as before.
 */
void publishSessionEventMqtt(const char* type, const char* state) {
  if (!USE_MQTT) return;
  if (!mqttClient.connected()) {
    Serial.print(F("[MQTT] Session event LOST (not connected): "));
    Serial.println(type);
    return;
  }

  char eventId[48];
  snprintf(eventId, sizeof(eventId), "%s-%lu-%lu",
           DEVICE_ID, (unsigned long)millis(), (unsigned long)time(nullptr));

  char payload[224];
  snprintf(payload, sizeof(payload),
           "{\"eventId\":\"%s\",\"type\":\"%s\",\"deviceId\":\"%s\",\"state\":\"%s\",\"timestamp\":%lu}",
           eventId, type, DEVICE_ID, state, (unsigned long)time(nullptr));

  // QoS 1 via the hand-built packet writer below — PubSubClient 2.8 has no
  // QoS publish API (see publishMqttQos1). The PUBACK is drained by the
  // library's loop(); no waiting is needed for rare session transitions.
  bool ok = publishMqttQos1(MQTT_EVENTS_TOPIC, payload);
  if (ok) {
    Serial.print(F("[MQTT] Session event (QoS 1): "));
    Serial.print(type);
    Serial.print(F(" "));
    Serial.print(state);
    Serial.print(F(" — "));
    Serial.println(eventId);
  } else {
    Serial.print(F("[MQTT] Session event FAILED (no local storage): "));
    Serial.println(type);
  }
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

// ==============================================================================
// 10. RENDER KEEP-ALIVE HEARTBEAT (GET /health every 10 minutes)
// ==============================================================================

/**
 * One-time setup: parse the GTS Root R4 trust anchors (Render terminates TLS
 * with a Google Trust Services WE1 certificate chaining to this root) and
 * configure the health TLS client. LARGER buffers than MQTT (8 KB rx) on
 * purpose: Render's edge does not negotiate MFLN, so the server's
 * certificate record arrives whole and must fit in one buffer. The buffers
 * are heap-transient (allocated per connect, freed on stop), so this costs
 * nothing between the 10-minute checks. Full chain + hostname validation
 * against the NTP clock — no setInsecure anywhere.
 */
void setupHealthHeartbeat() {
  if (strlen(RENDER_HEALTH_CA_CERT) == 0) {
    Serial.println(F("[HEALTH] ERROR: RENDER_HEALTH_CA_CERT is empty — keep-alive disabled."));
    return;
  }

  healthTrustAnchors = new BearSSL::X509List(RENDER_HEALTH_CA_CERT);
  healthTlsClient.setTrustAnchors(healthTrustAnchors);
  healthTlsClient.setBufferSizes(8192, 1024);
  healthReady = true;

  Serial.print(F("[HEALTH] Keep-alive ready: https://"));
  Serial.print(RENDER_HEALTH_HOST);
  Serial.println(RENDER_HEALTH_PATH);
}

/**
 * Fire one health check. Depends ONLY on Wi-Fi availability — deliberately
 * NOT on MQTT state: the heartbeat's whole purpose is to wake/keep Render
 * alive precisely when nothing else is hitting the backend (e.g. the site is
 * closed and Render went to sleep), so it must run regardless of whether the
 * MQTT connection is up. Blocking ONLY for the TCP connect + TLS handshake
 * (~1–3 s normally; the core caps the handshake at 15 s). When MQTT is
 * connected, telemetry publishes refresh it every 1.5 s, so broker silence
 * stays well under the ~22 s LWT threshold; when MQTT is down there is no
 * live connection to lose. The HTTP RESPONSE is awaited non-blocking in
 * runHealthHeartbeat (Render's free tier cold-starts on this request, which
 * can take ~40 s — blocking on it would starve PubSubClient's loop() and
 * trip the LWT).
 */
bool startHealthRequest(unsigned long now) {
  if (!healthReady) return false;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[HEALTH] Skipped — Wi-Fi down (retried at the next interval)"));
    return false;
  }

  // Start from a clean socket so a half-dead TLS session can't poison this handshake.
  healthTlsClient.stop();
  // Certificate validity is checked against the NTP clock we hand BearSSL
  // (refreshed here so a late sync self-heals).
  healthTlsClient.setX509Time(time(nullptr));
  healthStatusLen = 0;

  Serial.print(F("[HEALTH] GET https://"));
  Serial.print(RENDER_HEALTH_HOST);
  Serial.println(RENDER_HEALTH_PATH);

  if (!healthTlsClient.connect(RENDER_HEALTH_HOST, RENDER_HEALTH_PORT)) {
    Serial.println(F("[HEALTH] FAILED — TCP/TLS connect error; retrying at the next interval"));
    return false;
  }

  healthTlsClient.print(F("GET "));
  healthTlsClient.print(RENDER_HEALTH_PATH);
  healthTlsClient.print(F(" HTTP/1.1\r\nHost: "));
  healthTlsClient.print(RENDER_HEALTH_HOST);
  healthTlsClient.print(F("\r\nUser-Agent: sitting-tracker-esp/1.0\r\nConnection: close\r\n\r\n"));

  healthAwaitingResponse = true;
  healthAttemptStartMs = now;
  return true;
}

/** Close the attempt and log the outcome. */
void finishHealthRequest(bool ok, const char* detail) {
  healthTlsClient.stop();
  healthAwaitingResponse = false;
  if (ok) {
    Serial.print(F("[HEALTH] HTTP 200 OK — Render keep-alive sent ("));
    Serial.print(detail);
    Serial.println(F(")"));
  } else {
    Serial.print(F("[HEALTH] FAILED ("));
    Serial.print(detail);
    Serial.println(F(") — MQTT/telemetry unaffected; retrying at the next interval"));
  }
}

/**
 * Every loop() pass: fire the boot check (the moment Wi-Fi is up after boot),
 * then one check per HEALTH_CHECK_INTERVAL_MS, and poll the in-flight
 * request's status line WITHOUT blocking. Only the first ~12 bytes of the
 * response are read — "HTTP/1.x 200" is all we need; the rest is discarded
 * by the close(). Any non-200, early close, or 90 s silence is a logged
 * failure followed by normal operation until the next interval.
 */
void runHealthHeartbeat(unsigned long now) {
  if (!healthReady) return;

  if (!healthBootCheckDone) {
    if (WiFi.status() == WL_CONNECTED) {
      healthBootCheckDone = true;
      lastHealthCheckMs = now;
      startHealthRequest(now);
    }
  } else if (!healthAwaitingResponse && now - lastHealthCheckMs >= HEALTH_CHECK_INTERVAL_MS) {
    lastHealthCheckMs = now;
    startHealthRequest(now);
  }

  if (!healthAwaitingResponse) return;

  // Drain whatever arrived into the status-line buffer (non-blocking)
  while (healthTlsClient.available() > 0 && healthStatusLen < sizeof(healthStatusHead) - 1) {
    healthStatusHead[healthStatusLen++] = (char)healthTlsClient.read();
  }

  // "HTTP/1.x NNN" — status code sits at bytes 9..11
  if (healthStatusLen >= 12 && strncmp(healthStatusHead, "HTTP/1.", 7) == 0) {
    int code = (healthStatusHead[9] - '0') * 100
             + (healthStatusHead[10] - '0') * 10
             + (healthStatusHead[11] - '0');
    if (code == 200) {
      finishHealthRequest(true, "backend awake");
    } else {
      char detail[16];
      snprintf(detail, sizeof(detail), "HTTP %d", code);
      finishHealthRequest(false, detail);
    }
    return;
  }

  if (healthTlsClient.available() == 0 && !healthTlsClient.connected()) {
    finishHealthRequest(false, healthStatusLen > 0 ? "connection closed early" : "no response — connection lost");
    return;
  }

  if (now - healthAttemptStartMs >= HEALTH_RESPONSE_TIMEOUT_MS) {
    finishHealthRequest(false, "no status line — timeout");
  }
}
