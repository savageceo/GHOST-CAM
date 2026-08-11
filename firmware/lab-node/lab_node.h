// lab_node.h — join any ESP32 gadget to SAVAGE LAB in a few lines.
//
// Set LAB_API_HOST and LAB_DEVICE_TOKEN (either #define them BEFORE including
// this header, or edit the defaults below), then:
//
//   lab::connectWifi(ssid, pass);
//   lab::registerDevice("mynode", "My Node", "sensor", "[\"temp\"]", "v1");
//   lab::Metrics m; m.add("tempC", 21.4).add("rssi", (int)WiFi.RSSI());
//   lab::telemetry("mynode", m);
//
// The node then shows up in the dashboard device grid and its numeric metrics
// become live sensor charts. No account, no MQTT broker — just HTTPS + a token.
#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#ifndef LAB_API_HOST
#define LAB_API_HOST "room-watch-six.vercel.app"
#endif
#ifndef LAB_DEVICE_TOKEN
#define LAB_DEVICE_TOKEN "PUT-YOUR-DEVICE-TOKEN-HERE"
#endif

namespace lab {

inline bool wifiUp() {
  return WiFi.status() == WL_CONNECTED;
}

inline bool connectWifi(const char *ssid, const char *pass,
                        uint32_t timeoutMs = 15000) {
  if (wifiUp()) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
  }
  return wifiUp();
}

// Bearer-token HTTPS POST. TLS is set insecure because the token is the trust
// boundary (same pattern as the camera) — fine for a private studio API.
inline bool post(const char *path, const String &body, String *resp = nullptr) {
  if (!wifiUp()) return false;
  WiFiClientSecure tls;
  tls.setInsecure();
  HTTPClient http;
  if (!http.begin(tls, String("https://") + LAB_API_HOST + path)) return false;
  http.setTimeout(12000);
  http.addHeader("Authorization", String("Bearer ") + LAB_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t *)body.c_str(), body.length());
  bool ok = code >= 200 && code < 300;
  if (resp) *resp = ok ? http.getString() : String("");
  if (!ok) Serial.printf("[lab] %s -> %d\n", path, code);
  http.end();
  return ok;
}

// Fluent JSON metrics builder: m.add("tempC", 21.4).add("armed", true)
class Metrics {
 public:
  Metrics &add(const char *k, double v) {
    sep();
    s_ += '"';
    s_ += k;
    s_ += "\":";
    s_ += String(v, 3);
    return *this;
  }
  Metrics &add(const char *k, int v) {
    sep();
    s_ += '"';
    s_ += k;
    s_ += "\":";
    s_ += v;
    return *this;
  }
  Metrics &add(const char *k, bool v) {
    sep();
    s_ += '"';
    s_ += k;
    s_ += "\":";
    s_ += (v ? "true" : "false");
    return *this;
  }
  Metrics &add(const char *k, const String &v) {
    sep();
    s_ += '"';
    s_ += k;
    s_ += "\":\"";
    s_ += v;
    s_ += '"';
    return *this;
  }
  String json() const { return String("{") + s_ + "}"; }

 private:
  String s_;
  bool first_ = true;
  void sep() {
    if (!first_) s_ += ',';
    first_ = false;
  }
};

// Announce this node into the device grid. caps is a JSON array literal, e.g.
// "[\"camera\",\"motion\"]". Safe to call repeatedly; the registry upserts.
inline bool registerDevice(const char *id, const char *name, const char *type,
                           const char *capsJsonArray, const char *firmware) {
  String body = String("{\"device\":\"") + id + "\",\"name\":\"" + name +
                "\",\"type\":\"" + type + "\",\"caps\":" + capsJsonArray +
                ",\"firmware\":\"" + firmware + "\"}";
  return post("/api/device/register", body);
}

// Stream metrics. The overload with meta registers + reports in one request.
inline bool telemetry(const char *id, const Metrics &m) {
  String body =
      String("{\"device\":\"") + id + "\",\"metrics\":" + m.json() + "}";
  return post("/api/device/telemetry", body);
}

inline bool telemetry(const char *id, const Metrics &m, const char *name,
                      const char *type, const char *capsJsonArray,
                      const char *firmware) {
  String meta = String(",\"meta\":{\"name\":\"") + name + "\",\"type\":\"" +
                type + "\",\"caps\":" + capsJsonArray + ",\"firmware\":\"" +
                firmware + "\"}";
  String body = String("{\"device\":\"") + id + "\",\"metrics\":" + m.json() +
                meta + "}";
  return post("/api/device/telemetry", body);
}

// Fire an ALARM EVENT: it lands in the dashboard event feed and pushes to
// every subscribed phone with the camera's latest frame attached. This is the
// one call a tripwire / door contact / panic button needs:
//
//   if (beamBroken)   lab::event("entrynode", "trip",  "entry beam");
//   if (doorOpened)   lab::event("doornode",  "door",  "front door");
//   if (buttonHeld)   lab::event("panic1",    "panic", "her button");
//
// Known kinds get their own push voice: trip · door · panic · sound ·
// presence. Anything else shows as a generic ping. Set notify=false to log
// the event silently (no phone push).
inline bool event(const char *id, const char *kind, const char *label = nullptr,
                  bool notify = true) {
  String body = String("{\"device\":\"") + id + "\",\"kind\":\"" + kind + "\"";
  if (label) body += String(",\"label\":\"") + label + "\"";
  if (!notify) body += ",\"notify\":false";
  body += "}";
  return post("/api/device/event", body);
}

}  // namespace lab
