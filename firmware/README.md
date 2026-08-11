# SAVAGE LAB firmware

Every device here talks to the same cloud (`API_HOST`) with the same shared
`DEVICE_TOKEN`. Register once, stream telemetry, done — it shows up on the
dashboard grid automatically.

## `lab-cam/` — the XIAO ESP32S3 Sense camera (device #1)

**The hardware.** A **Seeed Studio XIAO ESP32S3 Sense**: an ESP32-S3 (dual-core
240 MHz) with **8 MB PSRAM**, an **OV2640** 2 MP camera (max UXGA 1600×1200,
native 4:3), an onboard **PDM microphone** (GPIO 41/42), a microSD slot, and
**2.4 GHz-only** Wi-Fi on a single onboard antenna. The PSRAM is what makes
full-res JPEG capture possible; the 2.4 GHz radio is the ceiling on live frame
rate (see the table below). With the mic unlocked, every sensor on the board
is now in use.

Everything the old `room-cam` did, plus:

- a **live WebSocket stream** to the cloud relay so the away page is
  near-real-time. While you're watching, the sensor drops to a fast **HD 720p**
  live size (~10–14 fps) and pushes JPEG frames over `wss://`; when you stop it
  returns to **UXGA** for crisp stills. Auto-falls back to HTTP frame POSTs
  (~1.4 fps) if the socket is down.
- a **timeline** snapshot every `TIMELINE_SECONDS` (default 1s) at full UXGA →
  the scrubber + timelapse + heartbeat (the cloud keeps ~3h, then prunes),
- **telemetry** every `TELEMETRY_SECONDS`: chip temp, wifi RSSI, free heap,
  uptime, SD + armed state → live charts,
- **cloud rotate**: the dashboard's Rotate button flips the image (0/180) on the
  next poll, persisted to NVS — no reflash,
- **the MIC, unlocked**: continuous sound-level metering (`soundDb`/`soundPk`
  charts) + a loud-noise trigger that records a clip session exactly like
  motion, filed as a 🔊 "sound" event. Detection is adaptive (floor-tracking
  EMA), so it triggers on *bang above ambient*, not absolute volume alone.
  Sound events ALWAYS record; the phone push is armed-gated unless
  `SOUND_PUSH_WHEN_DISARMED 1`. Knobs: `SOUND_TRIGGER_DB` (main sensitivity),
  `SOUND_MIN_DBFS`, `SOUND_MIN_MS`, `SOUND_COOLDOWN_S`, `MIC_ENABLED 0` kills
  it entirely,
- **cloud cadence knob**: the dashboard's snapshot-cadence control ("auto/1s/
  2s/5s/10s") overrides `TIMELINE_SECONDS` live via the `tl` flag — no reflash,
- **🎬 BTS mode** (`bts` flag): motion + sound triggers fully suppressed while
  the timeline keeps rolling — the shoot IS the content. **⏺ Capture**
  (`captureAt` flag) records one silent full-res clip on demand, filed 🎬,
- **self-registration** into the device grid on boot.

### Build & flash

Board **XIAO_ESP32S3**, Tools → **PSRAM: OPI PSRAM** (required). One library —
**JPEGDEC** (bitbank2) — because Arduino-ESP32 3.x's bundled JPEG decoder can't
read the OV2640's frames (needed for motion detection):

```
arduino-cli lib install JPEGDEC
arduino-cli compile --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
arduino-cli upload -p /dev/cu.usbmodem* --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
```

(Arduino IDE: Library Manager → install "JPEGDEC".) Secrets + tuning live in
`lab-cam/config.h`; it reuses your existing WiFi/token/stream-key, so it's a
drop-in upgrade. Serial at 115200 tells the whole story — `[live] N fps`,
`[motion] N% change`, `[sd] …`.

> **XCLK is 20 MHz, on purpose.** The OV2640 clocked at 24 MHz emits oversized,
> subtly-malformed JPEGs — browsers tolerate them but the on-chip decoders reject
> them, which silently breaks motion detection (`Error in decoding JPEG image!`).
> 20 MHz produces clean frames (~6× smaller), so motion works, quality is better,
> and the live stream is faster. Don't raise `xclk_freq_hz` back to 24.

> **Live transport.** The camera streams live frames over plain HTTP POST to
> `/api/stream/push`, which republishes them to Redis; the browser receives them
> over a WebSocket. (The ESP32's own TLS WebSocket client can't reliably open a
> second TLS connection to Vercel alongside the HTTP keep-alive, so the reliable
> HTTP path wins.) Frame rate is set by resolution/quality — see the table above.

### Streaming quality & frame rate

Saved stills (timeline, motion bursts, pins) are **always UXGA 1600×1200** — the
sharpest the OV2640 does. The **live** view uses a separate, faster resolution so
you get max-detail stills *and* a smoother live picture. Live frames go out one
HTTP POST at a time, so the frame rate is capped by the **round-trip to the cloud**
(~150–200 ms each) more than by resolution — smaller frames help a little, not a
lot. Measured over a decent connection:

| `LIVE_FRAME_SIZE` | Live res | Typical live fps | Feel |
| --- | --- | --- | --- |
| `FRAMESIZE_VGA` | 640×480 | ~6–8 | fastest, softest |
| `FRAMESIZE_SVGA` | 800×600 | ~5–7 | smooth |
| **`FRAMESIZE_HD`** (default) | **1280×720** | **~4–6** | **crisp (16:9)** |
| `FRAMESIZE_XGA` | 1024×768 | ~4–5 | more detail, 4:3 |
| `FRAMESIZE_UXGA` | 1600×1200 | ~2–4 | sharpest, slowest |

Tuning knobs (all in `config.h`, all documented inline):

- `LIVE_FRAME_SIZE` — the live-stream resolution (see table). Default `HD`.
- `LIVE_JPEG_QUALITY` — live JPEG quality, 10 (best) … 63. Default 11.
- `LIVE_MIN_INTERVAL_MS` — floor between live frames. **0 = uncapped**, stream as
  fast as Wi-Fi drains; raise to cap fps / save data (66≈15fps, 100≈10fps).
- `LIVE_DOWNSCALE` — `1` = the dual-resolution scheme above; `0` = live at the
  full `FRAME_SIZE` (one resolution for everything). Motion detection pauses
  while a downscaled live view is active (you're already watching).
- `FRAME_SIZE` / `JPEG_QUALITY` — the still-capture resolution/quality (UXGA/12).
- `USE_WS_STREAM` — `1` = WebSocket live (needs ArduinoWebsockets); `0` = HTTP
  POST fallback (~1.4 fps), no library needed.
- `TIMELINE_SECONDS` — snapshot cadence. **1s** ≈ a smooth one-second timelapse
  but ~3600 Blob writes/hr (~86k/day); raise to 2–5 if that's too much.
- `TELEMETRY_SECONDS` — how often sensor charts update.
- `MOTION_TRIGGER_PCT` — raise for fewer motion alerts.

> **Getting the best real-world fps:** put the camera on a strong 2.4 GHz signal
> (RSSI > −60 dBm), close to the AP, on a not-too-crowded channel. Wi-Fi upload —
> not the sensor or the cloud — is almost always the limit. If HD feels choppy,
> drop to `FRAMESIZE_SVGA`; if you want more detail and can live with less
> smoothness, try `FRAMESIZE_XGA`.

## `lab-node/` — drop-in template for any ESP32

`lab_node.h` is a tiny helper (no external libraries): connect WiFi, register,
and stream a fluent metrics object over HTTPS.

```cpp
lab::connectWifi(WIFI_SSID, WIFI_PASS);
lab::registerDevice("mynode", "My Node", "sensor", "[\"temp\"]", "v1");

lab::Metrics m;
m.add("tempC", 21.4).add("rssi", (int)WiFi.RSSI()).add("doorOpen", false);
lab::telemetry("mynode", m);
```

To make a new node: copy the `lab-node/` folder, edit the CONFIG block
(`DEVICE_ID`, `DEVICE_NAME`, WiFi, and the same `DEVICE_TOKEN`), fill
`readSensors()`, flash. Numeric metrics become charts; bools/strings show as
status chips.

**Alarms:** `lab::event(id, kind, label)` is the one-liner that pings the
phone — it files an event and the cloud pushes it with the camera's latest
frame attached. Kinds with their own push voice: `trip` (laser beam), `door`
(reed contact + magnet), `panic` (the button), `sound`, `presence` (mmWave).
That's the whole integration for a tripwire or panic button: one `if`, one
call (see the commented examples in `lab-node.ino`).

## `lillygo-tembed-cc1101/` — sub-GHz RF node example

Turns a **LilyGo T-Embed CC1101** into a lab device that reports the ambient
sub-GHz **RF noise floor** (read straight off the CC1101 RSSI register) plus
wifi + uptime — handy for noticing when something starts transmitting near the
studio.

Uses minimal raw-SPI access (no library needed). CC1101 pins are set for the
stock board (CS 44, GDO0 43, SCK 11, MISO 10, MOSI 9 — shared with the display);
verify for your revision if the RF numbers look off. For full scan / capture /
replay, drop in the **ELECHOUSE_CC1101** library and keep the `lab::telemetry()`
calls to stream whatever you measure.

Board: **ESP32S3 Dev Module** (or the LilyGo T-Embed profile), PSRAM enabled.

## `room-cam/` — original firmware, kept as a backup

Unchanged. If you ever want the pre-lab behavior back, flash this.

## Device ideas for the studio

| Node | Reports | Metrics to chart |
| --- | --- | --- |
| lab-cam (XIAO) | vision + environment | `tempC`, `rssi`, `heapKB` |
| T-Embed CC1101 | sub-GHz RF | `rfDbm`, `rfLink` |
| NRF24 scanner | 2.4GHz channel activity | `chanBusyPct`, `topChan` |
| BME280 node | air | `tempC`, `humidity`, `presshPa` |
| Door/PIR node | entry | `doorOpen`, `motion`, `battPct` |
| Bench power | rail health | `volts`, `amps`, `watts` |

All of them: same `DEVICE_TOKEN`, `lab::telemetry(...)`, and they're on the
dashboard. No server changes.
