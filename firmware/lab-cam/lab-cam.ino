// lab-cam — Seeed XIAO ESP32S3 Sense · SAVAGE LAB camera node
//
// Everything room-cam did, plus it now joins the lab as a first-class device:
//   · live MJPEG stream on the home network:  http://roomcam.local/?k=<key>
//   · motion detection while armed → burst of BURST_FRAMES photos:
//       - pushed to the SAVAGE LAB cloud (view + pin from anywhere)
//       - first photo attached to an ntfy push notification on your phone
//       - archived to microSD when a card is present (ring buffer)
//   · TIMELINE: one snapshot every TIMELINE_SECONDS builds the scrubbable 24h
//     history on the dashboard and doubles as the heartbeat
//   · TELEMETRY: chip temp / wifi / free memory / uptime every TELEMETRY_SECONDS
//     → live sensor charts on the dashboard
//   · self-registers in the device grid on boot (name/type/caps/firmware)
//   · "go live" from the cloud: camera streams ~1.5 fps to the page in 90s
//     windows while you watch, from anywhere
//
// Split across cores like bunny-hop: capture/motion on core 1, WiFi + uploads
// on core 0, camera behind one mutex, SD behind another.
//
// Build: board "XIAO_ESP32S3", Tools → PSRAM: "OPI PSRAM" (required).

#include "config.h"

#include <Arduino.h>
#include <ESPmDNS.h>
#include <FS.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "esp_camera.h"
#include "esp_http_server.h"
#include "img_converters.h"  // jpg2rgb565 — the motion detector's decoder

// ── XIAO ESP32S3 Sense pin map ──────────────────────────────────────────
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 10
#define SIOD_GPIO_NUM 40
#define SIOC_GPIO_NUM 39
#define Y9_GPIO_NUM 48
#define Y8_GPIO_NUM 11
#define Y7_GPIO_NUM 12
#define Y6_GPIO_NUM 14
#define Y5_GPIO_NUM 16
#define Y4_GPIO_NUM 18
#define Y3_GPIO_NUM 17
#define Y2_GPIO_NUM 15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM 47
#define PCLK_GPIO_NUM 13

static SemaphoreHandle_t fbMutex;  // serializes camera frame grabs
static SemaphoreHandle_t sdMutex;
static Preferences prefs;

static volatile bool camOk = false;
static volatile bool sdOk = false;
static volatile bool armed = ARM_DEFAULT;
static volatile bool armDirty = false;   // local toggle waiting to reach cloud
static volatile bool cloudLive = false;  // cloud says someone is watching
static volatile bool eventRequested = false;
static volatile bool eventIsTest = false;
static int64_t lastTestAt = -1;  // -1 until primed by first cloud contact
static volatile int64_t lastCloudOkMs = -1;
static volatile int64_t epochMsOffset = 0;  // epoch_ms - boot_ms after NTP

static int64_t bootMs() { return esp_timer_get_time() / 1000; }

static void isoFromEpochMs(int64_t ms, char *out, size_t outLen) {
  time_t seconds = (time_t)(ms / 1000);
  struct tm t;
  gmtime_r(&seconds, &t);
  snprintf(out, outLen, "%04d-%02d-%02dT%02d-%02d-%02dZ", t.tm_year + 1900,
           t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
}

// ── camera ──────────────────────────────────────────────────────────────

static bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAME_SIZE;
  config.jpeg_quality = JPEG_QUALITY;
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;
  if (esp_camera_init(&config) != ESP_OK) return false;
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    // Orientation is a runtime setting (local page "Rotate 180°"), so the
    // printed case can mount the board either way without a reflash.
    s->set_vflip(s, prefs.getBool("vflip", CAM_VFLIP));
    s->set_hmirror(s, prefs.getBool("hmir", CAM_HMIRROR));
    // Let AGC climb further in a dark room: grainy beats black.
    s->set_gainceiling(s, GAINCEILING_32X);
  }
  return true;
}

// Copies the newest JPEG into caller-owned PSRAM. The camera lock is held
// only for the copy, so the stream, the motion sampler, and bursts all
// interleave without starving each other. Caller frees.
static uint8_t *grabJpeg(size_t *outLen) {
  *outLen = 0;
  if (!camOk) return nullptr;
  xSemaphoreTake(fbMutex, portMAX_DELAY);
  camera_fb_t *fb = esp_camera_fb_get();
  uint8_t *copy = nullptr;
  if (fb) {
    copy = (uint8_t *)heap_caps_malloc(fb->len,
                                       MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (copy) {
      memcpy(copy, fb->buf, fb->len);
      *outLen = fb->len;
    }
    esp_camera_fb_return(fb);
  }
  xSemaphoreGive(fbMutex);
  return copy;
}

// ── microSD archive (optional) ──────────────────────────────────────────

static bool initSd() {
  bool ok = SD.begin(SD_CS_PIN) && (SD.exists("/events") || SD.mkdir("/events"));
  return ok;
}

static void sdSaveFrame(const char *eventId, int seq, const uint8_t *jpg,
                        size_t len) {
  if (!sdOk) return;
  char path[80];
  snprintf(path, sizeof(path), "/events/%s/%02d.jpg", eventId, seq);
  xSemaphoreTake(sdMutex, portMAX_DELAY);
  if (seq == 0) {
    char dir[64];
    snprintf(dir, sizeof(dir), "/events/%s", eventId);
    SD.mkdir(dir);
  }
  File f = SD.open(path, FILE_WRITE);
  if (f) {
    f.write(jpg, len);
    f.close();
  } else {
    sdOk = false;  // card pulled? loop() retries init
  }
  xSemaphoreGive(sdMutex);
}

// Ring buffer: drop oldest event folders until there's breathing room.
static void ensureSdSpace() {
  while (sdOk) {
    xSemaphoreTake(sdMutex, portMAX_DELAY);
    uint64_t freeBytes = SD.totalBytes() - SD.usedBytes();
    char oldest[64] = "";
    if (freeBytes < (uint64_t)SD_MIN_FREE_MB * 1024 * 1024) {
      File dir = SD.open("/events");
      for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
        if (f.isDirectory() &&
            (oldest[0] == '\0' || strcmp(f.name(), oldest) < 0)) {
          snprintf(oldest, sizeof(oldest), "%s", f.name());
        }
        f.close();
      }
      dir.close();
    }
    xSemaphoreGive(sdMutex);
    if (oldest[0] == '\0') return;

    char dirPath[80];
    snprintf(dirPath, sizeof(dirPath), "/events/%s", oldest);
    xSemaphoreTake(sdMutex, portMAX_DELAY);
    File dir = SD.open(dirPath);
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      char filePath[120];
      snprintf(filePath, sizeof(filePath), "%s/%s", dirPath, f.name());
      f.close();
      SD.remove(filePath);
    }
    dir.close();
    SD.rmdir(dirPath);
    xSemaphoreGive(sdMutex);
    Serial.printf("[sd] ring buffer dropped %s\n", dirPath);
  }
}

// ── cloud client (persistent, keep-alive) ───────────────────────────────

static WiFiClientSecure cloudTls;
static HTTPClient cloudHttp;
static bool cloudInit = false;

static bool cloudCall(bool isPost, const String &pathAndQuery,
                      const uint8_t *body, size_t bodyLen, const char *ctype,
                      String &resp) {
  if (WiFi.status() != WL_CONNECTED) return false;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (!cloudInit) {
      cloudTls.setInsecure();  // bearer token carries the trust here
      cloudHttp.setReuse(true);
      cloudInit = true;
    }
    if (!cloudHttp.begin(cloudTls, String("https://") + API_HOST + pathAndQuery)) {
      cloudInit = false;
      continue;
    }
    cloudHttp.setTimeout(12000);
    cloudHttp.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    if (ctype) cloudHttp.addHeader("Content-Type", ctype);
    int status = isPost ? cloudHttp.POST((uint8_t *)body, bodyLen)
                        : cloudHttp.GET();
    if (status >= 200 && status < 300) {
      resp = cloudHttp.getString();
      cloudHttp.end();
      return true;
    }
    Serial.printf("[cloud] %s → %d\n", pathAndQuery.c_str(), status);
    cloudHttp.end();
    cloudTls.stop();
    cloudInit = false;
  }
  return false;
}

// Just-enough JSON reading for {"arm":true,"live":false,"testAt":123}.
static bool jsonBool(const String &s, const char *key, bool dflt) {
  int at = s.indexOf(String("\"") + key + "\":");
  if (at < 0) return dflt;
  return s.startsWith("true", at + strlen(key) + 3);
}

static int64_t jsonInt(const String &s, const char *key, int64_t dflt) {
  int at = s.indexOf(String("\"") + key + "\":");
  if (at < 0) return dflt;
  return atoll(s.c_str() + at + strlen(key) + 3);
}

static void applyFlags(const String &resp) {
  lastCloudOkMs = bootMs();
  if (!armDirty) {
    bool cloudArm = jsonBool(resp, "arm", armed);
    if (cloudArm != (bool)armed) {
      armed = cloudArm;
      prefs.putBool("armed", armed);
      Serial.printf("[arm] cloud set %s\n", armed ? "ON" : "off");
    }
  }
  cloudLive = jsonBool(resp, "live", false);
  int64_t t = jsonInt(resp, "testAt", 0);
  if (lastTestAt < 0) {
    lastTestAt = t;  // prime — an old test press never refires after reboot
  } else if (t > lastTestAt) {
    lastTestAt = t;
    if (!eventRequested) {
      eventIsTest = true;
      eventRequested = true;
    }
  }
}

// POST one JPEG. The response carries the flags, so a streaming camera hears
// "stop"/"disarm"/"test" without separate polls. Every frame is tagged with
// this node's DEVICE_ID so the cloud files it under the right device.
static bool pushFrame(const char *kind, const char *eventId, int seq,
                      const uint8_t *jpg, size_t len) {
  String q = String("/api/device/frame?kind=") + kind + "&seq=" + seq +
             "&device=" + DEVICE_ID;
  if (eventId) {
    q += String("&event=") + eventId;
  } else {
    q += String("&sd=") + (sdOk ? 1 : 0) + "&rssi=" + (int)abs(WiFi.RSSI());
  }
  String resp;
  if (!cloudCall(true, q, jpg, len, "image/jpeg", resp)) return false;
  applyFlags(resp);
  return true;
}

// ── lab membership: register + telemetry ────────────────────────────────
static bool registered = false;

static void postRegister() {
  String body = String("{\"device\":\"") + DEVICE_ID + "\",\"name\":\"" +
                DEVICE_NAME + "\",\"type\":\"" + DEVICE_TYPE +
                "\",\"caps\":[\"camera\",\"motion\",\"stream\",\"microSD\"]," +
                "\"firmware\":\"" + FIRMWARE_TAG + "\"}";
  String resp;
  if (cloudCall(true, "/api/device/register", (const uint8_t *)body.c_str(),
                body.length(), "application/json", resp)) {
    registered = true;
    applyFlags(resp);
    Serial.println("[lab] registered in device grid");
  }
}

// chip temp + wifi + memory + uptime → the dashboard's sensor charts.
static void postTelemetry() {
  float tempC = temperatureRead();
  long uptimeMin = (long)(bootMs() / 60000);
  int heapKB = (int)(ESP.getFreeHeap() / 1024);
  int rssi = (int)WiFi.RSSI();
  String body = String("{\"device\":\"") + DEVICE_ID + "\",\"metrics\":{" +
                "\"rssi\":" + rssi + ",\"tempC\":" + String(tempC, 1) +
                ",\"heapKB\":" + heapKB + ",\"uptimeMin\":" + uptimeMin +
                ",\"sd\":" + (sdOk ? "true" : "false") +
                ",\"armed\":" + (armed ? "true" : "false") + "}}";
  String resp;
  if (cloudCall(true, "/api/device/telemetry", (const uint8_t *)body.c_str(),
                body.length(), "application/json", resp)) {
    applyFlags(resp);
  }
}

// ── phone alerts (ntfy.sh) ──────────────────────────────────────────────
// Straight from the camera — alerts still fire even if the cloud page is
// down. With a JPEG body the notification arrives with the photo attached.

static void ntfyPush(const char *title, const char *message,
                     const char *priority, const uint8_t *jpg, size_t len) {
  WiFiClientSecure tls;
  tls.setInsecure();
  HTTPClient http;
  if (!http.begin(tls, String("https://ntfy.sh/") + NTFY_TOPIC)) return;
  http.setTimeout(15000);
  http.addHeader("X-Title", title);
  http.addHeader("X-Priority", priority);
  http.addHeader("X-Click", String("https://") + API_HOST);
  int status;
  if (jpg) {
    http.addHeader("X-Filename", "motion.jpg");
    status = http.PUT((uint8_t *)jpg, len);
  } else {
    status = http.POST(String(message));
  }
  Serial.printf("[ntfy] %s → %d\n", title, status);
  http.end();
}

// ── motion event: burst → SD + cloud + phone ────────────────────────────

static void runEvent(bool isTest) {
  char id[40];
  if (epochMsOffset != 0) {
    char iso[24];
    isoFromEpochMs(epochMsOffset + bootMs(), iso, sizeof(iso));
    snprintf(id, sizeof(id), "e%s", iso);
  } else {
    snprintf(id, sizeof(id), "b%lld", (long long)bootMs());
  }
  Serial.printf("[event] %s %s\n", isTest ? "TEST" : "MOTION", id);

  for (int seq = 0; seq < BURST_FRAMES; seq++) {
    int64_t slotEnd = bootMs() + BURST_GAP_MS;
    size_t len = 0;
    uint8_t *jpg = grabJpeg(&len);
    if (jpg) {
      sdSaveFrame(id, seq, jpg, len);
      if (seq == 0) {
        ntfyPush(isTest ? "Test alert — camera is watching"
                        : "Motion in your lab",
                 nullptr, isTest ? "default" : "high", jpg, len);
      }
      pushFrame("motion", id, seq, jpg, len);
      free(jpg);
    }
    int64_t wait = slotEnd - bootMs();
    if (wait > 0) vTaskDelay(pdMS_TO_TICKS(wait));
  }
  ensureSdSpace();
}

// ── motion sampler (core 1) ─────────────────────────────────────────────
// Decode every sample at 1/8 scale (SVGA → 100×75), reduce to brightness,
// diff against the previous sample. Cheap enough to run forever.

static void motionTask(void *) {
  const int w = FRAME_W / 8, h = FRAME_H / 8, n = w * h;
  uint8_t *rgb = (uint8_t *)heap_caps_malloc(n * 2, MALLOC_CAP_SPIRAM);
  uint8_t *prev = (uint8_t *)heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
  uint8_t *cur = (uint8_t *)heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
  if (!rgb || !prev || !cur) {
    Serial.println("[motion] buffer alloc failed — detector off");
    vTaskDelete(nullptr);
    return;
  }
  bool havePrev = false;
  int hits = 0;
  int64_t lastEventMs = -(int64_t)MOTION_COOLDOWN_S * 1000;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(MOTION_SAMPLE_MS));
    if (!camOk || eventRequested) continue;
    size_t len = 0;
    uint8_t *jpg = grabJpeg(&len);
    if (!jpg) continue;
    bool decoded = jpg2rgb565(jpg, len, rgb, JPEG_IMAGE_SCALE_1_8);
    free(jpg);
    if (!decoded) continue;

    for (int i = 0; i < n; i++) {
      uint16_t px = ((uint16_t)rgb[i * 2] << 8) | rgb[i * 2 + 1];
      uint8_t r = (px >> 11) & 0x1f, g = (px >> 5) & 0x3f, b = px & 0x1f;
      cur[i] = (uint8_t)((r * 3 + g * 3 + b * 2) >> 1);  // ~0-255 brightness
    }

    if (havePrev) {
      int changed = 0;
      for (int i = 0; i < n; i++) {
        int d = (int)cur[i] - (int)prev[i];
        if (d < 0) d = -d;
        if (d > MOTION_PIXEL_DELTA) changed++;
      }
      float pct = 100.0f * changed / n;
      hits = (pct >= MOTION_TRIGGER_PCT) ? hits + 1 : 0;
      if (hits >= MOTION_CONSEC && armed && !eventRequested &&
          bootMs() > (int64_t)BOOT_GRACE_S * 1000 &&
          bootMs() - lastEventMs > (int64_t)MOTION_COOLDOWN_S * 1000) {
        lastEventMs = bootMs();
        hits = 0;
        eventIsTest = false;
        eventRequested = true;
        Serial.printf("[motion] triggered — %.1f%% of pixels moved\n", pct);
      }
    }
    uint8_t *tmp = prev;
    prev = cur;
    cur = tmp;
    havePrev = true;
  }
}

// ── local web: UI on :80, stream on :81 ─────────────────────────────────
// Two servers because a running MJPEG stream occupies its server's task;
// the UI/status/arm endpoints must stay responsive next to it.

static httpd_handle_t uiServer = nullptr;
static httpd_handle_t streamServer = nullptr;

static bool keyOk(httpd_req_t *req) {
  char query[160], val[48];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
    return false;
  }
  if (httpd_query_key_value(query, "k", val, sizeof(val)) != ESP_OK) {
    return false;
  }
  return strcmp(val, STREAM_KEY) == 0;
}

static esp_err_t deny(httpd_req_t *req) {
  httpd_resp_set_status(req, "403 Forbidden");
  return httpd_resp_sendstr(req, "locked — open the saved link with its ?k= key");
}

static esp_err_t jpgHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  size_t len = 0;
  uint8_t *jpg = grabJpeg(&len);
  if (!jpg) {
    httpd_resp_set_status(req, "503 Service Unavailable");
    return httpd_resp_sendstr(req, "camera not ready");
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  esp_err_t res = httpd_resp_send(req, (const char *)jpg, len);
  free(jpg);
  return res;
}

static esp_err_t streamHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  for (;;) {
    size_t len = 0;
    uint8_t *jpg = grabJpeg(&len);
    if (!jpg) {
      vTaskDelay(pdMS_TO_TICKS(150));
      continue;
    }
    char head[96];
    int headLen = snprintf(head, sizeof(head),
                           "--frame\r\nContent-Type: image/jpeg\r\n"
                           "Content-Length: %u\r\n\r\n",
                           (unsigned)len);
    bool sent = httpd_resp_send_chunk(req, head, headLen) == ESP_OK &&
                httpd_resp_send_chunk(req, (const char *)jpg, len) == ESP_OK &&
                httpd_resp_send_chunk(req, "\r\n", 2) == ESP_OK;
    free(jpg);
    if (!sent) break;                  // viewer closed the tab
    vTaskDelay(pdMS_TO_TICKS(70));     // ~10-14 fps
  }
  return ESP_OK;
}

static esp_err_t armHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  char query[160], val[8];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
      httpd_query_key_value(query, "on", val, sizeof(val)) == ESP_OK) {
    armed = (val[0] == '1');
    prefs.putBool("armed", armed);
    armDirty = true;  // net task mirrors it to the cloud flag
    Serial.printf("[arm] local set %s\n", armed ? "ON" : "off");
  }
  httpd_resp_set_type(req, "application/json");
  char body[48];
  snprintf(body, sizeof(body), "{\"armed\":%s}", armed ? "true" : "false");
  return httpd_resp_sendstr(req, body);
}

static esp_err_t flipHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  bool v = !prefs.getBool("vflip", CAM_VFLIP);
  bool h = !prefs.getBool("hmir", CAM_HMIRROR);
  prefs.putBool("vflip", v);
  prefs.putBool("hmir", h);
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, v);
    s->set_hmirror(s, h);
  }
  Serial.printf("[cam] rotated: vflip=%d hmirror=%d\n", v, h);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, "{\"ok\":true}");
}

static esp_err_t statusHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  char body[240];
  snprintf(body, sizeof(body),
           "{\"armed\":%s,\"sd\":%s,\"rssi\":%d,\"ip\":\"%s\","
           "\"cloudOkAgoS\":%lld,\"uptimeS\":%lld}",
           armed ? "true" : "false", sdOk ? "true" : "false", WiFi.RSSI(),
           WiFi.localIP().toString().c_str(),
           lastCloudOkMs < 0 ? -1 : (long long)((bootMs() - lastCloudOkMs) / 1000),
           (long long)(bootMs() / 1000));
  return httpd_resp_sendstr(req, body);
}

static const char PAGE_TEMPLATE[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
    "<title>lab-cam</title><style>"
    "body{background:#080a0d;color:#e9edf2;font-family:-apple-system,sans-serif;"
    "margin:0;padding:16px;max-width:560px;margin:0 auto}"
    "h3{letter-spacing:.22em;font-size:14px;margin:6px 2px 12px}"
    "img{width:100%;border-radius:14px;border:1px solid #232a35;background:#000}"
    ".row{display:flex;gap:10px;margin-top:12px}"
    "button,a.b{flex:1;padding:13px;border-radius:12px;border:1px solid #232a35;"
    "background:#12161d;color:#e9edf2;font-size:15px;font-weight:600;"
    "text-align:center;text-decoration:none;cursor:pointer}"
    "button.on{background:#103728;color:#86efac;border-color:#34d39955}"
    "pre{color:#8b93a1;font-size:12px;white-space:pre-wrap}"
    "</style></head><body><h3>SAVAGE LAB / LAB-CAM</h3>"
    "<img src=\"http://%IP%:81/stream?k=%K%\">"
    "<div class=row><button id=a onclick=arm()>...</button>"
    "<button onclick=\"fetch('/flip?k=%K%')\">Rotate 180</button>"
    "<a class=b href=\"https://%HOST%\">cloud &gt;</a></div>"
    "<pre id=s>loading...</pre><script>"
    "let armed=false;"
    "async function st(){try{const j=await(await fetch('/status.json?k=%K%')).json();"
    "armed=j.armed;document.getElementById('a').textContent=armed?'Armed':'Disarmed';"
    "document.getElementById('a').className=armed?'on':'';"
    "document.getElementById('s').textContent="
    "'ip '+j.ip+' - wifi '+j.rssi+'dBm - sd '+(j.sd?'ok':'none')+"
    "' - cloud '+(j.cloudOkAgoS<0?'never':j.cloudOkAgoS+'s ago')+"
    "' - up '+Math.floor(j.uptimeS/60)+'m';}catch(e){}}"
    "async function arm(){await fetch('/arm?k=%K%&on='+(armed?0:1));st()}"
    "st();setInterval(st,5000);</script></body></html>";

static esp_err_t rootHandler(httpd_req_t *req) {
  if (!keyOk(req)) return deny(req);
  String page = PAGE_TEMPLATE;
  page.replace("%K%", STREAM_KEY);
  page.replace("%HOST%", API_HOST);
  page.replace("%IP%", WiFi.localIP().toString());
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, page.c_str(), page.length());
}

static void startLocalServers() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.ctrl_port = 32768;
  cfg.lru_purge_enable = true;
  if (httpd_start(&uiServer, &cfg) == ESP_OK) {
    static const httpd_uri_t root = {"/", HTTP_GET, rootHandler, nullptr};
    static const httpd_uri_t jpg = {"/jpg", HTTP_GET, jpgHandler, nullptr};
    static const httpd_uri_t arm = {"/arm", HTTP_GET, armHandler, nullptr};
    static const httpd_uri_t stat = {"/status.json", HTTP_GET, statusHandler,
                                     nullptr};
    static const httpd_uri_t flip = {"/flip", HTTP_GET, flipHandler, nullptr};
    httpd_register_uri_handler(uiServer, &root);
    httpd_register_uri_handler(uiServer, &jpg);
    httpd_register_uri_handler(uiServer, &arm);
    httpd_register_uri_handler(uiServer, &stat);
    httpd_register_uri_handler(uiServer, &flip);
  }
  httpd_config_t scfg = HTTPD_DEFAULT_CONFIG();
  scfg.server_port = 81;
  scfg.ctrl_port = 32769;
  scfg.max_open_sockets = 3;
  if (httpd_start(&streamServer, &scfg) == ESP_OK) {
    static const httpd_uri_t stream = {"/stream", HTTP_GET, streamHandler,
                                       nullptr};
    httpd_register_uri_handler(streamServer, &stream);
  }
  Serial.println("[web] local UI on :80, stream on :81");
}

// ── WiFi + time + cloud loop (core 0) ───────────────────────────────────

static void connectWiFi() {
  static bool trySecondary = false;
  const char *ssid = WIFI_SSID;
  const char *pass = WIFI_PASS;
  if (trySecondary && strlen(WIFI_SSID2) > 0) {
    ssid = WIFI_SSID2;
    pass = WIFI_PASS2;
  }
  if (strlen(WIFI_SSID2) > 0) trySecondary = !trySecondary;

  Serial.printf("[wifi] trying %s\n", ssid);
  WiFi.disconnect();
  WiFi.begin(ssid, pass);
  for (int i = 0; i < 24 && WiFi.status() != WL_CONNECTED; i++) {
    vTaskDelay(pdMS_TO_TICKS(500));
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected to %s (%s)\n", ssid,
                  WiFi.localIP().toString().c_str());
  }
}

static void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 20; i++) {
    time_t now = time(nullptr);
    if (now > 1700000000) {
      epochMsOffset = (int64_t)now * 1000 - bootMs();
      Serial.println("[time] synced");
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

static void netTask(void *) {
  bool mdnsUp = false;
  bool bootNotified = false;
  int64_t lastPoll = -(int64_t)POLL_SECONDS * 1000;
  int64_t lastTlFrame = -(int64_t)TIMELINE_SECONDS * 1000;
  int64_t lastTelemetry = -(int64_t)TELEMETRY_SECONDS * 1000;
  int64_t lastLiveFrame = 0;
  int liveSeq = 0;

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      connectWiFi();
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if (!mdnsUp && MDNS.begin(HOSTNAME)) {
      MDNS.addService("http", "tcp", 80);
      mdnsUp = true;
      Serial.printf("[web] http://%s.local/?k=%s\n", HOSTNAME, STREAM_KEY);
    }
    if (epochMsOffset == 0) syncTime();
    if (!bootNotified) {
      bootNotified = true;
      char msg[120];
      snprintf(msg, sizeof(msg), "Local: http://%s.local/?k=%s (IP %s)",
               HOSTNAME, STREAM_KEY, WiFi.localIP().toString().c_str());
      ntfyPush("Lab camera online", msg, "low", nullptr, 0);
    }
    if (!registered) postRegister();  // announce into the device grid

    if (armDirty) {
      char body[24];
      snprintf(body, sizeof(body), "{\"arm\":%s}", armed ? "true" : "false");
      String resp;
      if (cloudCall(true, "/api/device/poll", (const uint8_t *)body,
                    strlen(body), "application/json", resp)) {
        armDirty = false;  // clear BEFORE apply so the echo can't overwrite
        applyFlags(resp);
      } else {
        vTaskDelay(pdMS_TO_TICKS(2000));
      }
    }

    if (eventRequested) {
      runEvent(eventIsTest);
      eventRequested = false;
      continue;
    }

    if (cloudLive) {
      if (bootMs() - lastLiveFrame >= LIVE_FRAME_MS) {
        lastLiveFrame = bootMs();
        size_t len = 0;
        uint8_t *jpg = grabJpeg(&len);
        if (jpg) {
          pushFrame("live", nullptr, liveSeq++, jpg, len);
          free(jpg);
          lastTlFrame = bootMs();  // live frames keep the timeline warm too
        }
      }
      vTaskDelay(pdMS_TO_TICKS(30));
      continue;  // frame responses carry the flags while live
    }

    if (bootMs() - lastPoll >= (int64_t)POLL_SECONDS * 1000) {
      lastPoll = bootMs();
      String resp;
      if (cloudCall(false, "/api/device/poll", nullptr, 0, nullptr, resp)) {
        applyFlags(resp);
      }
    }

    if (bootMs() - lastTelemetry >= (int64_t)TELEMETRY_SECONDS * 1000) {
      lastTelemetry = bootMs();
      postTelemetry();
    }

    if (bootMs() - lastTlFrame >= (int64_t)TIMELINE_SECONDS * 1000) {
      size_t len = 0;
      uint8_t *jpg = grabJpeg(&len);
      bool pushed = false;
      if (jpg) {
        pushed = pushFrame("timeline", nullptr, 0, jpg, len);
        free(jpg);
      }
      // On failure retry in ~20s instead of hammering or going dark.
      lastTlFrame = pushed
                        ? bootMs()
                        : bootMs() - (int64_t)TIMELINE_SECONDS * 1000 + 20000;
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ── entry points ────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[lab-cam] boot");

  fbMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();
  prefs.begin("roomcam");
  armed = prefs.getBool("armed", ARM_DEFAULT);

  if (!psramFound()) {
    Serial.println("[!] PSRAM missing — build with Tools→PSRAM: OPI PSRAM");
  }

  camOk = initCamera();
  Serial.printf("[cam] %s\n", camOk ? "ready" : "INIT FAILED");

  sdOk = initSd();
  Serial.printf("[sd] %s\n", sdOk ? "ready" : "no card (cloud+alerts still on)");

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // responsiveness over a little power

  startLocalServers();

  xTaskCreatePinnedToCore(motionTask, "motion", 8192, nullptr, 1, nullptr, 1);
  xTaskCreatePinnedToCore(netTask, "net", 16384, nullptr, 1, nullptr, 0);
  Serial.printf("[lab-cam] device=%s armed=%s\n", DEVICE_ID,
                armed ? "yes" : "no");
}

void loop() {
  // Keep-alive care: a camera that can't see is the one unacceptable state.
  if (!camOk) {
    camOk = initCamera();
    Serial.printf("[cam] reinit %s\n", camOk ? "ok" : "failed");
  }
  if (!sdOk) {
    xSemaphoreTake(sdMutex, portMAX_DELAY);
    sdOk = initSd();
    xSemaphoreGive(sdMutex);
  }
  delay(5000);
}
