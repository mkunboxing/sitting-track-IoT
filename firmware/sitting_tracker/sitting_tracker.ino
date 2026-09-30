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
 * Logic & Timing Specifications:
 *   - SITTING_LIMIT        = 100 cm
 *   - SITTING_CONFIRM_TIME = 2000 ms (must detect distance <= 100 cm continuously)
 *   - AWAY_CONFIRM_TIME    = 5000 ms (must detect distance > 100 cm continuously)
 *   - SENSOR_INTERVAL      = 700 ms  (ultrasonic ping interval)
 * 
 * API Endpoints:
 *   - POST /api/sitting/start (when transition AWAY -> SITTING is confirmed)
 *   - POST /api/sitting/stop  (when transition SITTING -> AWAY is confirmed)
 *   - Header: Authorization: Bearer <DEVICE_TOKEN>
 * ==============================================================================
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiClient.h>

// ==============================================================================
// 1. CONFIGURATION: Wi-Fi, Server API, and Device Token
// ==============================================================================

// Replace with your Wi-Fi network credentials
const char* WIFI_SSID     = "Mywifi";
const char* WIFI_PASSWORD = "12343211";

// Server Base URL (Do NOT include trailing slash)
// For local testing:  "http://192.168.1.100:3000"
// For live Vercel:    "https://your-sitting-tracker.vercel.app"
const char* SERVER_BASE_URL = "https://sitting-track-iot.vercel.app";

// Secret Device Authentication Token (must match DEVICE_TOKEN in your .env.local / Vercel)
const char* DEVICE_TOKEN    = "515e0200-a088-4c67-b6fc-3dc9cfb941d3";

// ==============================================================================
// 2. HARDWARE PIN DEFINITIONS & THRESHOLDS
// ==============================================================================

// NodeMCU Pin Mapping
// D6 = GPIO 12 (TRIG)
// D5 = GPIO 14 (ECHO)
const int PIN_TRIG = 12; // D6
const int PIN_ECHO = 14; // D5

// Detection Thresholds
const float SITTING_LIMIT_CM        = 100.0; // Distance <= 100 cm is sitting
const unsigned long SITTING_CONFIRM = 2000;  // 2000 ms continuous detection to confirm sitting
const unsigned long AWAY_CONFIRM    = 5000;  // 5000 ms continuous detection to confirm away
const unsigned long SENSOR_INTERVAL = 700;   // 700 ms between sensor readings

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

// Pending state change flag for network retries
bool hasPendingStateChange = false;
State pendingTargetState = STATE_AWAY;
unsigned long lastApiAttemptTime = 0;
const unsigned long API_RETRY_INTERVAL = 3000; // Retry every 3s if request fails

// Timer for sensor reading loop
unsigned long lastSensorReadTime = 0;

// ==============================================================================
// 4. FUNCTION DECLARATIONS
// ==============================================================================

float readDistanceCm();
bool sendStateChangeEvent(State newState);
void connectToWiFi();

// ==============================================================================
// 5. SETUP
// ==============================================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("  Sitting Time Tracker - NodeMCU ESP8266"));
  Serial.println(F("========================================"));

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  connectToWiFi();

  // Initial read to calibrate
  float initialDistance = readDistanceCm();
  Serial.print(F("[INIT] Initial Distance: "));
  Serial.print(initialDistance);
  Serial.println(F(" cm"));

  if (initialDistance > 0 && initialDistance <= SITTING_LIMIT_CM) {
    potentialState = STATE_SITTING;
  } else {
    potentialState = STATE_AWAY;
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
    // Valid distance <= 100 cm means person is at desk
    // Distance > 100 cm or negative (no echo / out of range) means away
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

        // Queue event for transmission
        hasPendingStateChange = true;
        pendingTargetState = potentialState;
      }
    }

    Serial.println();
  }

  // 3. Process Pending State Change (with retry logic)
  if (hasPendingStateChange) {
    // Attempt transmission if not rate-limited
    if (now - lastApiAttemptTime >= API_RETRY_INTERVAL) {
      lastApiAttemptTime = now;

      Serial.print(F("[API] Attempting to send event: "));
      Serial.println(pendingTargetState == STATE_SITTING ? F("START") : F("STOP"));

      bool success = sendStateChangeEvent(pendingTargetState);
      if (success) {
        // Successfully recorded by backend
        currentState = pendingTargetState;
        hasPendingStateChange = false;
        Serial.println(F("[API] Event successfully synced with server."));
      } else {
        Serial.println(F("[API] Transmission failed. Will retry shortly..."));
      }
    }
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
// 8. HTTP / HTTPS API DISPATCH
// ==============================================================================

bool sendStateChangeEvent(State newState) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[HTTP] Error: Wi-Fi not connected."));
    return false;
  }

  String endpoint = (newState == STATE_SITTING) ? "/api/sitting/start" : "/api/sitting/stop";
  String fullUrl  = String(SERVER_BASE_URL) + endpoint;

  bool isHttps = fullUrl.startsWith("https://");

  HTTPClient http;
  int httpCode = -1;

  Serial.print(F("[HTTP] POST "));
  Serial.println(fullUrl);

  if (isHttps) {
    WiFiClientSecure secureClient;
    // Set insecure to bypass SSL certificate validation on ESP8266
    // (Prevents failures caused by root certificate updates or ESP clock drift)
    secureClient.setInsecure();
    secureClient.setTimeout(8000); // 8 second timeout

    http.begin(secureClient, fullUrl);
  } else {
    WiFiClient standardClient;
    standardClient.setTimeout(8000);
    http.begin(standardClient, fullUrl);
  }

  // Set Request Headers
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("User-Agent", "NodeMCU-ESP8266-SittingTracker/1.0");

  // Send empty JSON object or minimal payload
  httpCode = http.POST("{}");

  if (httpCode > 0) {
    String response = http.getString();
    Serial.print(F("[HTTP] Response Code: "));
    Serial.println(httpCode);
    Serial.print(F("[HTTP] Body: "));
    Serial.println(response);

    http.end();

    // 200 OK or 201 Created means successful
    // 409 Conflict / already_active is also considered safe
    return (httpCode >= 200 && httpCode < 300);
  } else {
    Serial.print(F("[HTTP] Failed, error: "));
    Serial.println(http.errorToString(httpCode).c_str());
    http.end();
    return false;
  }
}

// ==============================================================================
// 9. WI-FI CONNECTION & RECONNECT HANDLER
// ==============================================================================

void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println();
  Serial.print(F("[WIFI] Connecting to "));
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 15000) {
    delay(500);
    Serial.print(F("."));
  }

  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[WIFI] Connected! IP Address: "));
    Serial.println(WiFi.localIP());
    Serial.print(F("[WIFI] Signal Strength (RSSI): "));
    Serial.print(WiFi.RSSI());
    Serial.println(F(" dBm"));
  } else {
    Serial.println(F("[WIFI] Connection timed out. Will retry in loop."));
  }
}
