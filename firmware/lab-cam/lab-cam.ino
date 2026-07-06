// lab-cam — Seeed XIAO ESP32S3 Sense · SAVAGE LAB camera node
//
// Everything room-cam did, plus it now joins the lab as a first-class device:
//   · live MJPEG stream on the home network:  http://roomcam.local/?k=<key>
//   · motion detection while armed → records a 15s clip, then keeps recording
//     15s at a time as long as movement continues (rechecks every 5s):
//       - streamed to the SAVAGE LAB cloud (each clip a playable event)
//       - one ntfy + one web push per session, first frame attached
//       - archived to microSD when a card is present (ring buffer)
//   · TIMELINE: one snapshot every TIMELINE_SECONDS builds the scrubbable 24h
//     history on the dashboard and doubles as the heartbeat
//   · TELEMETRY: chip temp / wifi / free memory / uptime every TELEMETRY_SECONDS
//     → live sensor charts on the dashboard
//   · self-registers in the device grid on boot (name/type/caps/firmware)
//   · "go live" from the cloud: while you watch, the sensor drops to a fast
//     live size (HD, ~10-14 fps over the WebSocket relay) and pushes frames in
//     near-real-time, then returns to UXGA for crisp stills when you stop
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
#include <JPEGDEC.h>  // motion decoder (bitbank2). The core-3.x esp_jpeg/tjpgd
                      // decoder rejects the OV2640's JPEGs (JDR_FMT1); JPEGDEC
                      // decodes them fine. Install: arduino-cli lib install JPEGDEC

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
static volatile bool liveCaptureActive = false;  // sensor is in fast live-view mode
static volatile bool eventRequested = false;  // a clip session is requested
static volatile bool eventIsTest = false;
static volatile bool sessionActive = false;   // a clip session is currently recording
static volatile int64_t lastMotionMs = 0;     // last sample that saw motion (recheck signal)
static volatile int64_t lastSessionEndMs = -100000;  // between-session cooldown anchor
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
  config.xclk_freq_hz = 20000000;  // 20 MHz: stable OV2640 JPEGs (24 MHz emits
                                   // oversized/malformed frames strict decoders reject)
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
    // Image tuning — full auto pipeline + a touch more punch. All standard
    // OV2640 knobs (see xiao-camera/CameraWebServer app_httpd.cpp cmd_handler).
    s->set_whitebal(s, 1);       // auto white balance on
    s->set_awb_gain(s, 1);       // AWB gain on
    s->set_wb_mode(s, 0);        // 0 = auto WB mode
    s->set_exposure_ctrl(s, 1);  // auto exposure on
    s->set_aec2(s, 1);           // AEC DSP — better low-light exposure
    s->set_ae_level(s, 0);       // exposure bias (-2..2)
    s->set_gain_ctrl(s, 1);      // auto gain on
    s->set_bpc(s, 1);            // black-pixel correction
    s->set_wpc(s, 1);            // white-pixel correction
    s->set_lenc(s, 1);           // lens shading correction
    s->set_dcw(s, 1);            // advanced downsize/crop (cleaner scaling)
    s->set_brightness(s, 1);     // -2..2
    s->set_contrast(s, 1);       // -2..2
    s->set_saturation(s, 1);     // -2..2
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

// Live view trades resolution for frame rate; saved stills stay UXGA. We only
// switch the sensor at live start/stop (not per frame), so the brief reconfigure
// is rare and cheap. No-op build when LIVE_DOWNSCALE=0 (one size for everything).
static void applyCaptureMode(bool live) {
#if LIVE_DOWNSCALE
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return;
  xSemaphoreTake(fbMutex, portMAX_DELAY);
  s->set_framesize(s, live ? LIVE_FRAME_SIZE : FRAME_SIZE);
  s->set_quality(s, live ? LIVE_JPEG_QUALITY : JPEG_QUALITY);
  camera_fb_t *fb = esp_camera_fb_get();  // flush one frame at the old geometry
  if (fb) esp_camera_fb_return(fb);
  xSemaphoreGive(fbMutex);
  vTaskDelay(pdMS_TO_TICKS(120));  // let AE/AWB settle at the new size
  Serial.printf("[cam] capture mode: %s\n", live ? "live (fast)" : "still (UXGA)");
#else
  (void)live;
#endif
}

// ── microSD archive (optional) ──────────────────────────────────────────

static bool initSd() {
  SD.end();  // clear any half-open state so a re-seat / retry can remount cleanly
  // Last arg = format_if_mount_failed: with SD_FORMAT_ON_FAIL=1 an unmountable
  // (e.g. exFAT) card is reformatted FAT32 on the spot; keep it 0 in normal use.
  if (!SD.begin(SD_CS_PIN, SPI, 4000000, "/sd", 5, SD_FORMAT_ON_FAIL)) {
    Serial.println("[sd] mount failed — check the card is fully seated and "
                   "formatted FAT32 (exFAT / 64GB+ default won't mount)");
    return false;
  }
  sdcard_type_t ct = SD.cardType();
  if (ct == CARD_NONE) {
    Serial.println("[sd] no card detected");
    return false;
  }
  Serial.printf("[sd] card ok — type %d, %llu MB free of %llu MB\n", (int)ct,
                (SD.totalBytes() - SD.usedBytes()) / (1024ULL * 1024ULL),
                SD.cardSize() / (1024ULL * 1024ULL));
  return SD.exists("/events") || SD.mkdir("/events");
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

// 180° is the only rotation the OV2640 does in-sensor (vflip+hmirror). The
// cloud "Rotate" control and the local /flip page both funnel through here.
static void applyOrientation(bool flip180) {
  prefs.putBool("vflip", flip180);
  prefs.putBool("hmir", flip180);
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, flip180);
    s->set_hmirror(s, flip180);
  }
  Serial.printf("[cam] orientation: %s\n", flip180 ? "180" : "0");
}

#if NIGHT_MODE
// Auto low-light: raise gain ceiling + exposure bias + brightness when the scene
// goes dark, restore daylight defaults when it brightens. Driven by the motion
// sampler's measured brightness (see motionTask). Plain SCCB writes — no lock.
static bool nightActive = false;
static void applyNightMode(bool night) {
  if (night == nightActive) return;
  nightActive = night;
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return;
  s->set_gainceiling(s, night ? GAINCEILING_128X : GAINCEILING_32X);
  s->set_ae_level(s, night ? 2 : 0);
  s->set_brightness(s, night ? 2 : 1);
  Serial.printf("[cam] night mode %s\n", night ? "ON" : "off");
}
#endif

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
    if (!eventRequested && !sessionActive) {
      eventIsTest = true;
      eventRequested = true;
    }
  }
  // Cloud rotate: dashboard sends "orient":0|180. No-op until it does (-1).
  int64_t orient = jsonInt(resp, "orient", -1);
  if (orient == 0 || orient == 180) {
    bool want180 = (orient == 180);
    if (want180 != prefs.getBool("vflip", CAM_VFLIP)) applyOrientation(want180);
  }
}

// POST one JPEG. The response carries the flags, so a streaming camera hears
// "stop"/"disarm"/"test" without separate polls. Every frame is tagged with
// this node's DEVICE_ID so the cloud files it under the right device.
static bool pushFrame(const char *kind, const char *eventId, int seq,
                      const uint8_t *jpg, size_t len, bool notify = false) {
  String q = String("/api/device/frame?kind=") + kind + "&seq=" + seq +
             "&device=" + DEVICE_ID;
  if (eventId) {
    // notify=1 tells the cloud to fire ONE web push (the session's first frame).
    q += String("&event=") + eventId + "&notify=" + (notify ? "1" : "0");
  } else {
    q += String("&sd=") + (sdOk ? 1 : 0) + "&rssi=" + (int)abs(WiFi.RSSI());
  }
  String resp;
  if (!cloudCall(true, q, jpg, len, "image/jpeg", resp)) return false;
  applyFlags(resp);
  return true;
}

// Live-frame ingest over HTTP → Redis. The camera's HTTP keep-alive client
// reaches the cloud reliably where its TLS WebSocket client can't; the cloud
// publishes each frame to Redis and the browser's watch WebSocket delivers it in
// near-real-time. No Blob/DB on this path, so it's fast — this is the live path.
static bool streamPush(const uint8_t *jpg, size_t len) {
  String resp;
  return cloudCall(true, String("/api/stream/push?device=") + DEVICE_ID, jpg,
                   len, "image/jpeg", resp);
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

// ── motion clip session: clip → recheck → repeat while movement continues ────

static void makeEventId(char *id, size_t n) {
  if (epochMsOffset != 0) {
    char iso[24];
    isoFromEpochMs(epochMsOffset + bootMs(), iso, sizeof(iso));
    snprintf(id, n, "e%s", iso);  // e2026-07-06T09-13-12Z — dashboard-parseable
  } else {
    snprintf(id, n, "b%lld", (long long)bootMs());
  }
}

// Record one CLIP_SECONDS clip at CLIP_FPS to SD + cloud. Alerts (ntfy + the
// cloud web push) fire only on the very first frame of the session. After each
// clip we watch RECHECK_SECONDS for continued movement (motionTask keeps
// sampling and stamps lastMotionMs); if it's still moving we record another,
// up to MAX_CLIPS. Each clip is its own dashboard event.
static void runMotionSession(bool isTest) {
  Serial.printf("[event] SESSION start (%s)\n", isTest ? "TEST" : "MOTION");
  const int64_t frameGap = 1000 / (CLIP_FPS < 1 ? 1 : CLIP_FPS);
  bool firstFrame = true;
  int clips = 0;
  for (;;) {
    char id[40];
    makeEventId(id, sizeof(id));  // each clip is timestamped when it starts
    int64_t clipEnd = bootMs() + (int64_t)CLIP_SECONDS * 1000;
    int seq = 0;
    Serial.printf("[event] clip %d %s (%ds @ %dfps)\n", clips + 1, id,
                  CLIP_SECONDS, CLIP_FPS);
    while (bootMs() < clipEnd) {
      int64_t next = bootMs() + frameGap;
      size_t len = 0;
      uint8_t *jpg = grabJpeg(&len);
      if (jpg) {
        sdSaveFrame(id, seq, jpg, len);
        if (firstFrame) {
          ntfyPush(isTest ? "Test alert — camera is watching"
                          : "Motion in your lab",
                   nullptr, isTest ? "default" : "high", jpg, len);
        }
        pushFrame("motion", id, seq, jpg, len, firstFrame);  // notify once
        firstFrame = false;
        seq++;
        free(jpg);
      }
      int64_t wait = next - bootMs();
      if (wait > 0) vTaskDelay(pdMS_TO_TICKS(wait));
    }
    clips++;
    Serial.printf("[event] clip %d done — %d frames\n", clips, seq);
    if (isTest || clips >= MAX_CLIPS) break;
    // Watch for continued movement; motionTask stamps lastMotionMs each hit.
    int64_t recheckStart = bootMs();
    bool cont = false;
    while (bootMs() - recheckStart < (int64_t)RECHECK_SECONDS * 1000) {
      if (lastMotionMs >= recheckStart) {
        cont = true;
        break;
      }
      vTaskDelay(pdMS_TO_TICKS(120));
    }
    if (!cont) {
      Serial.println("[event] quiet — session end");
      break;
    }
    Serial.println("[event] still moving — another clip");
  }
  ensureSdSpace();
}

// ── motion sampler (core 1) ─────────────────────────────────────────────
// Decode every sample at 1/8 scale (SVGA → 100×75), reduce to brightness,
// diff against the previous sample. Cheap enough to run forever.

static JPEGDEC jpeg;
static uint8_t *g_bright = nullptr;  // brightness map the decode callback fills
static int g_bw = 0, g_bh = 0;

// JPEGDEC draw callback: reduce this MCU block's RGB565 pixels to brightness and
// store into the coarse map. iWidth is the row stride; iWidthUsed clips edges.
static int motionDraw(JPEGDRAW *p) {
  const uint16_t *px = p->pPixels;  // RGB565 little-endian
  for (int row = 0; row < p->iHeight; row++) {
    int yy = p->y + row;
    if (yy < 0 || yy >= g_bh) continue;
    for (int col = 0; col < p->iWidthUsed; col++) {
      int xx = p->x + col;
      if (xx < 0 || xx >= g_bw) continue;
      uint16_t v = px[row * p->iWidth + col];
      uint8_t r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
      g_bright[yy * g_bw + xx] = (uint8_t)((r * 3 + g * 3 + b * 2) >> 1);
    }
  }
  return 1;
}

static void motionTask(void *) {
#if MOTION_SCALE_DIV == 2
  const int scaleOpt = JPEG_SCALE_HALF;
#elif MOTION_SCALE_DIV == 4
  const int scaleOpt = JPEG_SCALE_QUARTER;
#else
  const int scaleOpt = JPEG_SCALE_EIGHTH;
#endif
  const int w = FRAME_W / MOTION_SCALE_DIV, h = FRAME_H / MOTION_SCALE_DIV,
            n = w * h;
  uint8_t *prev = (uint8_t *)heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
  uint8_t *cur = (uint8_t *)heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
  if (!prev || !cur) {
    Serial.println("[motion] buffer alloc failed — detector off");
    vTaskDelete(nullptr);
    return;
  }
  g_bw = w;
  g_bh = h;
  Serial.printf("[motion] detector on — %dx%d @ 1/%d\n", w, h, MOTION_SCALE_DIV);
  bool havePrev = false;
  int hits = 0;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(MOTION_SAMPLE_MS));
    if (!camOk) continue;  // keep sampling during a session so recheck sees motion
#if LIVE_DOWNSCALE
    // Live-view runs the sensor at a different geometry than these buffers, and
    // someone's already watching — pause detection and re-prime when live ends.
    if (liveCaptureActive) {
      havePrev = false;
      continue;
    }
#endif
    size_t len = 0;
    uint8_t *jpg = grabJpeg(&len);
    if (!jpg) continue;
    // Decode straight to 8-bit grayscale at 1/MOTION_SCALE_DIV into `cur`.
    g_bright = cur;
    bool decoded = false;
    int derr = 0;
    if (jpeg.openRAM(jpg, (int)len, motionDraw)) {
      jpeg.setPixelType(RGB565_LITTLE_ENDIAN);
      decoded = (jpeg.decode(0, 0, scaleOpt) == 1);
      derr = jpeg.getLastError();
      jpeg.close();
    } else {
      derr = jpeg.getLastError();
    }
    free(jpg);
    if (!decoded) {
      static int64_t lastErrLog = 0;
      if (bootMs() - lastErrLog > 3000) {  // rate-limited decode-fail diagnostic
        lastErrLog = bootMs();
        Serial.printf("[motion] decode failed len=%u err=%d\n", (unsigned)len,
                      derr);
      }
      continue;
    }

#if NIGHT_MODE
    {  // auto day/night from average scene brightness (hysteresis band)
      long sum = 0;
      for (int i = 0; i < n; i++) sum += cur[i];
      float avg = (float)sum / n;
      static float lumaEma = -1;
      lumaEma = (lumaEma < 0) ? avg : (lumaEma * 0.95f + avg * 0.05f);
      applyNightMode(nightActive ? (lumaEma < NIGHT_EXIT_LUMA)
                                 : (lumaEma < NIGHT_ENTER_LUMA));
    }
#endif

    if (havePrev) {
      int changed = 0;
      for (int i = 0; i < n; i++) {
        int d = (int)cur[i] - (int)prev[i];
        if (d < 0) d = -d;
        if (d > MOTION_PIXEL_DELTA) changed++;
      }
      float pct = 100.0f * changed / n;
      bool moving = pct >= MOTION_TRIGGER_PCT;
      if (moving) lastMotionMs = bootMs();  // recheck signal for the clip session
      // Log notable samples (near/over threshold) + a 10s idle heartbeat — makes
      // tuning MOTION_TRIGGER_PCT easy: watch the % as you walk past.
      static int64_t lastMotionLog = 0;
      if (moving || bootMs() - lastMotionLog > 10000) {
        lastMotionLog = bootMs();
        Serial.printf("[motion] %.1f%% (armed=%s%s)\n", pct, armed ? "yes" : "no",
                      sessionActive ? ", recording" : "");
      }
      hits = moving ? hits + 1 : 0;
      if (hits >= MOTION_CONSEC && armed && !eventRequested && !sessionActive &&
          bootMs() > (int64_t)BOOT_GRACE_S * 1000 &&
          bootMs() - lastSessionEndMs > (int64_t)MOTION_COOLDOWN_S * 1000) {
        hits = 0;
        eventIsTest = false;
        eventRequested = true;
        Serial.printf("[motion] TRIGGER %.1f%% → starting clip session\n", pct);
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
    vTaskDelay(pdMS_TO_TICKS(30));     // pace local stream; UXGA encode self-limits
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
  applyOrientation(!prefs.getBool("vflip", CAM_VFLIP));
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
  int64_t fpsWindowMs = 0;  // live-fps report window (serial diagnostic)
  int fpsCount = 0;

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
      eventRequested = false;
      sessionActive = true;
      runMotionSession(eventIsTest);
      sessionActive = false;
      lastSessionEndMs = bootMs();
      continue;
    }

    if (cloudLive) {
      if (!liveCaptureActive) {  // entering live → pause motion, then downscale
        liveCaptureActive = true;
        applyCaptureMode(true);
        fpsWindowMs = bootMs();
        fpsCount = 0;
      }
      // Keep hearing stop/disarm/test/rotate while streaming.
      if (bootMs() - lastPoll >= (int64_t)POLL_SECONDS * 1000) {
        lastPoll = bootMs();
        String resp;
        if (cloudCall(false, "/api/device/poll", nullptr, 0, nullptr, resp)) {
          applyFlags(resp);
        }
      }
      // Stream frames as fast as the HTTP round-trip allows — streamPush() blocks
      // on the POST, so it self-paces at the true link rate; LIVE_MIN_INTERVAL_MS
      // is only a floor. The browser's watch WebSocket delivers them live.
      if (bootMs() - lastLiveFrame >= (int64_t)LIVE_MIN_INTERVAL_MS) {
        lastLiveFrame = bootMs();
        size_t len = 0;
        uint8_t *jpg = grabJpeg(&len);
        if (jpg) {
          streamPush(jpg, len);
          free(jpg);
          lastTlFrame = bootMs();  // timeline pauses while live is on
          fpsCount++;
        }
      }
      if (bootMs() - fpsWindowMs >= 5000) {  // report live fps on serial for tuning
        Serial.printf("[live] %.1f fps (http→redis)\n",
                      fpsCount * 1000.0 / (bootMs() - fpsWindowMs));
        fpsWindowMs = bootMs();
        fpsCount = 0;
      }
      vTaskDelay(pdMS_TO_TICKS(3));
      continue;
    }
    if (liveCaptureActive) {  // leaving live → restore UXGA stills
      applyCaptureMode(false);
      liveCaptureActive = false;
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

  xTaskCreatePinnedToCore(motionTask, "motion", 12288, nullptr, 1, nullptr, 1);
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
