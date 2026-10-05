/*
 * ==============================================================================
 * credentials.example.h — TEMPLATE for credentials.h (PRIVATE, gitignored)
 * ==============================================================================
 *
 * credentials.h holds the firmware's secrets: Wi-Fi networks and MQTT broker
 * credentials. It is listed in .gitignore and must NEVER be committed.
 *
 * First-time setup:
 *   1. Copy this file next to the sketch and rename it:
 *        cp credentials.example.h credentials.h
 *   2. Fill in your real values below (same symbols, same order).
 *
 * Everything NON-secret (MQTT port, TLS buffers, client id, device id, CA
 * certificates, health-check host, intervals) lives in sitting_tracker.ino.
 * ==============================================================================
 */

#ifndef CREDENTIALS_H
#define CREDENTIALS_H

// ---------------------------------------------------------------------------
// Multi-WiFi Configuration
// Add as many {SSID, Password} pairs as you need.
// The device will try each network in order and connect to the first available
// one. If all fail it will retry from the top on each reconnect attempt.
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

// ---------------------------------------------------------------------------
// MQTT configuration (EMQX Cloud) — secret half. The EMQX Cloud console →
// your deployment → "Connection info" gives the host (mqtts://, port 8883);
// "Access Management" → "Authentication" is where the username/password below
// is created. Port, client id, topics and TLS setup live in sitting_tracker.ino.
// ---------------------------------------------------------------------------
const char* MQTT_HOST     = "zfc11cf7.ala.asia-southeast1.emqxsl.com";
const char* MQTT_USERNAME = "sitting-iot";
const char* MQTT_PASSWORD = "Mk727498";

#endif // CREDENTIALS_H
