# SAVAGE LAB firmware

Every device here talks to the same cloud (`API_HOST`) with the same shared
`DEVICE_TOKEN`. Register once, stream telemetry, done — it shows up on the
dashboard grid automatically.

## `lab-cam/` — the upgraded XIAO ESP32S3 Sense camera

Everything the old `room-cam` did, plus:

- a **timeline** snapshot every `TIMELINE_SECONDS` (default 60s) → the 24h
  scrubber + heartbeat,
- **telemetry** every `TELEMETRY_SECONDS`: chip temp, wifi RSSI, free heap,
  uptime, SD + armed state → live charts,
- **self-registration** into the device grid on boot.

Build: board **XIAO_ESP32S3**, Tools → **PSRAM: OPI PSRAM** (required).

```
arduino-cli compile --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
arduino-cli upload -p /dev/cu.usbmodem* --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
```

Secrets + tuning live in `lab-cam/config.h` (WiFi, token, cadences, motion
sensitivity). It reuses your existing WiFi/token/stream-key, so it's a drop-in
upgrade. Serial at 115200 tells the whole story.

Tuning knobs worth knowing:

- `TIMELINE_SECONDS` — lower = richer timeline, more blob writes. 60s ≈ 1440
  frames/day.
- `TELEMETRY_SECONDS` — how often sensor charts update.
- `MOTION_TRIGGER_PCT` — raise for fewer motion alerts.

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
