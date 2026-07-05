// lab-node — generic SAVAGE LAB telemetry node template.
//
// Copy this folder, fill in the CONFIG block, wire your sensor into
// readSensors(), and flash. The node registers itself and streams telemetry;
// every numeric metric becomes a live chart on the dashboard.
//
// Works on any ESP32 / ESP32-S3 / ESP32-C3 board with WiFi.

// ── CONFIG (edit these) ──────────────────────────────────────────────────
#define LAB_API_HOST "room-watch-six.vercel.app"
#define LAB_DEVICE_TOKEN "4bb9daffafe1e7fb031d700242d11a769017e11269c3173d"

#define WIFI_SSID "SAVAGE STUDIO"
#define WIFI_PASS "Make.Money."

#define DEVICE_ID "labnode1"     // unique, [a-z0-9_-]
#define DEVICE_NAME "Lab Node 1" // shown on the card
#define DEVICE_TYPE "sensor"     // free-form label
static const char *DEVICE_CAPS = "[\"sensor\"]"; // JSON array literal
#define FIRMWARE_TAG "lab-node-1"

#define TELEMETRY_EVERY_MS 60000 // one reading per minute
// ─────────────────────────────────────────────────────────────────────────

#include "lab_node.h"

static uint32_t lastSend = 0;
static bool announced = false;

// Replace the body with your real sensor reads. Add as many metrics as you
// like — numbers become charts, bools/strings show as status chips.
static void readSensors(lab::Metrics &m) {
  m.add("tempC", (double)temperatureRead());   // ESP32 internal die temp
  m.add("rssi", (int)WiFi.RSSI());              // wifi signal
  m.add("uptimeMin", (int)(millis() / 60000));  // uptime
  // Examples you might add:
  //   m.add("lux", analogRead(2));
  //   m.add("humidity", bme.readHumidity());
  //   m.add("doorOpen", digitalRead(4) == HIGH);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[lab-node] boot");
  lab::connectWifi(WIFI_SSID, WIFI_PASS);
}

void loop() {
  if (!lab::wifiUp()) {
    lab::connectWifi(WIFI_SSID, WIFI_PASS);
    delay(500);
    return;
  }

  if (!announced) {
    announced = lab::registerDevice(DEVICE_ID, DEVICE_NAME, DEVICE_TYPE,
                                    DEVICE_CAPS, FIRMWARE_TAG);
    if (announced) Serial.println("[lab-node] registered");
  }

  if (millis() - lastSend >= TELEMETRY_EVERY_MS || lastSend == 0) {
    lastSend = millis();
    lab::Metrics m;
    readSensors(m);
    bool ok = lab::telemetry(DEVICE_ID, m);
    Serial.printf("[lab-node] telemetry %s\n", ok ? "sent" : "failed");
  }

  delay(50);
}
