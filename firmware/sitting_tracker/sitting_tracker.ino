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
 * Logic & Timing Specifications (unchanged from the HTTP firmware):
 *   - SITTING_LIMIT_CM     = 120 cm (distance <= threshold is sitting)
 *   - SITTING_CONFIRM_TIME = 2000 ms continuous detection to confirm sitting
 *   - AWAY_CONFIRM_TIME    = 5000 ms continuous detection to confirm away
 *   - SENSOR_INTERVAL      = 700 ms  (ultrasonic ping interval)
 *
 * Communication (WebSocket — replaces the old HTTP start/stop/heartbeat):
 *   - Persistent JSON WebSocket connection to the Node.js backend
 *   - Path: /ws/device  — first message must authenticate with DEVICE_TOKEN
 *   - On confirmed state transition: { "type": "state_change", ... }
 *   - If offline during a transition: the CURRENT state is held locally and
 *     synced automatically right after the next successful authentication
 *     (never replays stale events — only the latest state is sent)
 *   - Liveness = WebSocket ping/pong (library heartbeat + server pings).
 *     The old HTTP heartbeat endpoint is no longer used. The backend treats
 *     an unexpected disconnect as the end of the sitting session.
 *
 * Required Arduino library (install via Library Manager):
 *   "WebSockets" by Markus Sattler (Links2004) — version 2.x
 * ==============================================================================
 */

#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>
#include <time.h>

// ==============================================================================
// 1. CONFIGURATION: Wi-Fi, WebSocket Server, and Device Identity
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
// WebSocket server configuration (the Express backend, NOT the dashboard URL)
//
// Production — Google Cloud Run (TLS terminated by Google, port 443):
//   wss://sitting-track-iot-1014206902177.asia-south2.run.app/ws/device
//     WS_HOST = "sitting-track-iot-1014206902177.asia-south2.run.app"
//     WS_PORT = 443, USE_TLS = true
//     WS_CA_CERT = GTS Root R1 (already embedded below — full validation)
//
// Local development (backend running on your computer — use your LAN IP):
//   ws://192.168.1.12:4000/ws/device      → USE_TLS = false
//     (find your computer's IP: macOS Wi-Fi → Option-click the icon)
// ---------------------------------------------------------------------------
const char*    WS_HOST    = "sitting-track-iot-1014206902177.asia-south2.run.app";
const uint16_t WS_PORT    = 443;              // 443 for Cloud Run (wss), 4000 for local dev
const char*    WS_PATH    = "/ws/device";
const bool     USE_TLS    = true;             // true → wss:// (Cloud Run); false → local dev

// Root CA for production wss:// — GTS Root R1 (Google Trust Services), the
// trust anchor for *.run.app certificates. Self-signed, valid 2016–2036.
// BearSSL validates the full chain (leaf → WR2 → this root) + hostname, so
// no setInsecure() is used anywhere. NTP time sync runs in setup() because
// certificate validity checks need a correct clock.
const char* WS_CA_CERT =
  "-----BEGIN CERTIFICATE-----\n"
  "MIIFWjCCA0KgAwIBAgIQbkepxUtHDA3sM9CJuRz04TANBgkqhkiG9w0BAQwFADBH\n"
  "MQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExM\n"
  "QzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIy\n"
  "MDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNl\n"
  "cnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEB\n"
  "AQUAA4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaM\n"
  "f/vo27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vX\n"
  "mX7wCl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7\n"
  "zUjwTcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0P\n"
  "fyblqAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtc\n"
  "vfaHszVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4\n"
  "Zor8Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUsp\n"
  "zBmkMiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOO\n"
  "Rc92wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYW\n"
  "k70paDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+\n"
  "DVrNVjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgF\n"
  "lQIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV\n"
  "HQ4EFgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBADiW\n"
  "Cu49tJYeX++dnAsznyvgyv3SjgofQXSlfKqE1OXyHuY3UjKcC9FhHb8owbZEKTV1\n"
  "d5iyfNm9dKyKaOOpMQkpAWBz40d8U6iQSifvS9efk+eCNs6aaAyC58/UEBZvXw6Z\n"
  "XPYfcX3v73svfuo21pdwCxXu11xWajOl40k4DLh9+42FpLFZXvRq4d2h9mREruZR\n"
  "gyFmxhE+885H7pwoHyXa/6xmld01D1zvICxi/ZG6qcz8WpyTgYMpl0p8WnK0OdC3\n"
  "d8t5/Wk6kjftbjhlRn7pYL15iJdfOBL07q9bgsiG1eGZbYwE8na6SfZu6W0eX6Dv\n"
  "J4J2QPim01hcDyxC2kLGe4g0x8HYRZvBPsVhHdljUEn2NIVq4BjFbkerQUIpm/Zg\n"
  "DdIx02OYI5NaAIFItO/Nis3Jz5nu2Z6qNuFoS3FJFDYoOj0dzpqPJeaAcWErtXvM\n"
  "+SUWgeExX6GjfhaknBZqlxi9dnKlC54dNuYvoS++cJEPqOba+MSSQGwlfnuzCdyy\n"
  "F62ARPBopY+Udf90WuioAnwMCeKpSwughQtiue+hMZL77/ZRBIls6Kl0obsXs7X9\n"
  "SQ98POyDGCBDTtWTurQ0sR8WNh8M5mQ5Fkzc4P4dyKliPUDqysU0ArSuiYgzNdws\n"
  "E3PYJ/HQcu51OyLemGhmW/HGY0dVHLqlCFF1pkgl\n"
  "-----END CERTIFICATE-----\n";

// This device's identity (reported to the backend; one live connection per ID)
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

// Detection Thresholds
const float SITTING_LIMIT_CM        = 120.0; // Distance <= 120 cm is sitting
const unsigned long SITTING_CONFIRM = 2000;  // 2000 ms continuous detection to confirm sitting
const unsigned long AWAY_CONFIRM    = 5000;  // 5000 ms continuous detection to confirm away
const unsigned long SENSOR_INTERVAL = 700;   // 700 ms between sensor readings

// Live distance telemetry: send the latest reading to the dashboard every 5s
// over the WebSocket ({"type":"sensor",...}). The backend caches it in memory
// and pushes it to the dashboard via SSE — it is never stored in the database.
const unsigned long SENSOR_SEND_INTERVAL_MS = 5000;

// WebSocket keepalive: protocol-level ping every 15s, pong must arrive within
// 3s; 2 missed pongs ⇒ the library drops the TCP connection and reconnects.
// This replaces the old 30s HTTP heartbeat — it only detects stale
// connections, it has nothing to do with sitting-time tracking.
const unsigned long WS_PING_INTERVAL_MS = 15000;
const unsigned long WS_PONG_TIMEOUT_MS  = 3000;
const unsigned int  WS_DISCONNECT_COUNT = 2;

// WebSocket reconnect pacing (avoid rapid reconnect loops)
const unsigned long WS_RECONNECT_INTERVAL_MS = 5000;

// ==============================================================================
// 3. STATE DEFINITIONS
// ==============================================================================

enum State {
  STATE_AWAY,
  STATE_SITTING
};

// Current confirmed state
State currentState = STATE_AWAY;

// Potential state being evaluated for debounce
State potentialState = STATE_AWAY;
unsigned long potentialStateStartTime = 0;

// WebSocket session state
WebSocketsClient webSocket;
bool wsAuthenticated = false; // true after the backend confirms authentication

// Timer for sensor reading loop
unsigned long lastSensorReadTime = 0;
unsigned long lastSensorSendTime = 0;      // live telemetry pacing
float lastMeasuredDistanceCm = -1.0;       // latest reading, sent as telemetry

// ==============================================================================
// 4. FUNCTION DECLARATIONS
// ==============================================================================

float readDistanceCm();
void sendStateChange(State newState);
void sendSensorReading();
void sendAuthenticate();
void syncCurrentState();
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);
void handleServerMessage(char* msg, size_t length);
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
  Serial.println(F("  Transport: WebSocket (persistent)"));
  Serial.println(F("========================================"));

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  connectToWiFi();

  // --- WebSocket client setup (non-blocking; driven from loop()) ---
  if (USE_TLS) {
    // TLS certificate validation needs a correct clock — start NTP sync.
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    if (strlen(WS_CA_CERT) > 0) {
      Serial.print(F("[WS] Waiting for NTP time sync"));
      unsigned long timeStart = millis();
      while (time(nullptr) < 1000000000 && millis() - timeStart < 10000) { // wait up to 10s
        delay(250);
        Serial.print(F("."));
      }
      Serial.println();
      webSocket.beginSslWithCA(WS_HOST, WS_PORT, WS_PATH, WS_CA_CERT);
    } else {
      Serial.println(F("[WS] WARNING: USE_TLS=true but WS_CA_CERT is empty."));
      Serial.println(F("[WS] Connecting with UNVALIDATED TLS (no server-identity check)."));
      Serial.println(F("[WS] Paste the GTS Root R1 PEM into WS_CA_CERT for production."));
      webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
    }
  } else {
    webSocket.begin(WS_HOST, WS_PORT, WS_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(WS_RECONNECT_INTERVAL_MS);
  webSocket.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, WS_DISCONNECT_COUNT);
  Serial.print(F("[WS] Connecting to "));
  Serial.print(USE_TLS ? F("wss://") : F("ws://"));
  Serial.print(WS_HOST);
  Serial.print(F(":"));
  Serial.print(WS_PORT);
  Serial.println(WS_PATH);

  // Initial read to calibrate
  float initialDistance = readDistanceCm();
  Serial.print(F("[INIT] Initial Distance: "));
  Serial.print(initialDistance);
  Serial.println(F(" cm"));

  if (initialDistance > 0 && initialDistance <= SITTING_LIMIT_CM) {
    potentialState = STATE_SITTING;
  } else {
    potentialState = STATE_AWAY;
    currentState = STATE_AWAY;
    // Startup safety check: if a session is dangling from a previous power-off,
    // the post-authentication state sync (state "away") closes it on the server.
    Serial.println(F("[INIT] Desk vacant on boot. Current state (away) will sync after WebSocket authentication."));
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

  // 2. Drive the WebSocket client (non-blocking; auto-reconnects every
  //    WS_RECONNECT_INTERVAL_MS when the socket or Wi-Fi drops)
  webSocket.loop();

  // 3. Periodic Sensor Measurement (approx. every 700 ms)
  if (now - lastSensorReadTime >= SENSOR_INTERVAL) {
    lastSensorReadTime = now;

    float distance = readDistanceCm();
    lastMeasuredDistanceCm = distance; // remembered for the periodic telemetry message

    // Print reading to Serial Monitor
    Serial.print(F("[SENSOR] Dist: "));
    if (distance < 0) {
      Serial.print(F("OUT_OF_RANGE"));
    } else {
      Serial.print(distance, 1);
      Serial.print(F(" cm"));
    }
    Serial.print(F(" | Current: "));
    Serial.print(currentState == STATE_SITTING ? F("SITTING") : F("AWAY"));

    // Determine instantaneous reading:
    // Valid distance <= threshold means person is at desk
    // Distance above threshold or negative (no echo / out of range) means away
    State measuredState = (distance > 0 && distance <= SITTING_LIMIT_CM) ? STATE_SITTING : STATE_AWAY;

    // Check if the measured state is different from potential state being debounced
    if (measuredState != potentialState) {
      // Physical measurement shifted; reset confirmation timer
      potentialState = measuredState;
      potentialStateStartTime = now;
      Serial.print(F(" -> Potential shift to: "));
      Serial.print(potentialState == STATE_SITTING ? F("SITTING") : F("AWAY"));
    } else {
      // Measured state matches potential state; check if threshold duration reached
      unsigned long duration = now - potentialStateStartTime;
      unsigned long requiredDuration = (potentialState == STATE_SITTING) ? SITTING_CONFIRM : AWAY_CONFIRM;

      if (duration >= requiredDuration && potentialState != currentState) {
        // State change is confirmed!
        Serial.println();
        Serial.print(F(">>> [STATE CHANGED] Confirmed transition to: "));
        Serial.println(potentialState == STATE_SITTING ? F("SITTING") : F("AWAY"));

        currentState = potentialState;
        sendStateChange(currentState);
      }
    }

    Serial.println();
  }

  // 4. Periodic live distance telemetry (every SENSOR_SEND_INTERVAL_MS).
  //    Tiny JSON frame on the already-open WebSocket; the backend pushes it
  //    to dashboard tabs via SSE. Silently skipped while offline.
  if (now - lastSensorSendTime >= SENSOR_SEND_INTERVAL_MS) {
    lastSensorSendTime = now;
    sendSensorReading();
  }

  // NOTE: No HTTP heartbeat anymore — WebSocket ping/pong (library heartbeat +
  // server pings) detects dead connections, and the backend closes/keeps the
  // session based on the connection state itself.

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
// 8. WEBSOCKET DISPATCH (replaces the old HTTP start/stop/heartbeat calls)
// ==============================================================================

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      // Payload holds the connected URL/path
      Serial.print(F("[WS] WebSocket connected ("));
      Serial.write(payload, (int)length);
      Serial.println(F(") — authenticating..."));
      wsAuthenticated = false;
      sendAuthenticate();
      break;

    case WStype_DISCONNECTED:
      wsAuthenticated = false;
      Serial.println(F("[WS] WebSocket disconnected"));
      Serial.println(F("[WS] WebSocket reconnecting..."));
      break;

    case WStype_TEXT:
      handleServerMessage((char*)payload, length);
      break;

    case WStype_ERROR:
      Serial.println(F("[WS] WebSocket error"));
      break;

    default:
      // WStype_PING / WStype_PONG are answered automatically by the library
      break;
  }
}

void handleServerMessage(char* msg, size_t length) {
  if (strstr(msg, "\"type\":\"authenticated\"") != nullptr) {
    wsAuthenticated = true;
    Serial.println(F("[WS] WebSocket authenticated"));
    syncCurrentState();
    return;
  }

  if (strstr(msg, "\"type\":\"auth_error\"") != nullptr) {
    wsAuthenticated = false;
    Serial.println(F("[WS] Authentication rejected by server — check DEVICE_TOKEN"));
    return;
  }

  if (strstr(msg, "\"type\":\"ack\"") != nullptr) {
    Serial.print(F("[WS] Server ack: "));
    Serial.write((uint8_t*)msg, (int)length);
    Serial.println();
    return;
  }

  if (strstr(msg, "\"type\":\"error\"") != nullptr) {
    Serial.print(F("[WS] Server error message: "));
    Serial.write((uint8_t*)msg, (int)length);
    Serial.println();
    return;
  }
}

void sendAuthenticate() {
  char payload[192];
  snprintf(payload, sizeof(payload),
           "{\"type\":\"authenticate\",\"deviceId\":\"%s\",\"token\":\"%s\"}",
           DEVICE_ID, DEVICE_TOKEN);
  webSocket.sendTXT(payload);
}

/**
 * Send the given state to the backend. If the socket is not (yet)
 * authenticated, nothing is transmitted — the state is already reflected in
 * `currentState` and will be synced once right after the next successful
 * authentication. This replaces the old pending-retry queue: only the latest
 * state ever reaches the server, never a stale intermediate event.
 */
void sendStateChange(State newState) {
  if (!webSocket.isConnected() || !wsAuthenticated) {
    Serial.println(F("[WS] Offline — state held locally, will sync after reconnect"));
    return;
  }

  char payload[128];
  snprintf(payload, sizeof(payload),
           "{\"type\":\"state_change\",\"deviceId\":\"%s\",\"state\":\"%s\"}",
           DEVICE_ID, (newState == STATE_SITTING) ? "sitting" : "away");

  if (webSocket.sendTXT(payload)) {
    Serial.print(F("[WS] State sent: "));
    Serial.println(newState == STATE_SITTING ? F("sitting") : F("away"));
  } else {
    Serial.println(F("[WS] Send failed — state held locally, will sync after reconnect"));
  }
}

/**
 * Send the latest distance reading as lightweight telemetry. Skipped silently
 * while the WebSocket is down (the dashboard holds the last known value).
 */
void sendSensorReading() {
  if (!webSocket.isConnected() || !wsAuthenticated) return;

  char payload[96];
  snprintf(payload, sizeof(payload),
           "{\"type\":\"sensor\",\"deviceId\":\"%s\",\"distance\":%.1f}",
           DEVICE_ID, lastMeasuredDistanceCm);
  webSocket.sendTXT(payload);
}

/**
 * Called right after every successful authentication: syncs the CURRENT
 * confirmed state (not old queued events). Server-side handling is idempotent:
 * - "sitting" with an active session  → no-op (no duplicate session)
 * - "sitting" without a session       → session opened now
 * - "away" without a session          → no-op (also closes dangling sessions
 *                                       after a power-off while the server
 *                                       was not connected... handled by
 *                                       disconnect logic on the server)
 */
void syncCurrentState() {
  Serial.print(F("[WS] Syncing current state: "));
  Serial.println(currentState == STATE_SITTING ? F("sitting") : F("away"));
  sendStateChange(currentState);
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
