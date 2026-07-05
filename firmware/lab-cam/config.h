#pragma once

// ── identity (this device in the SAVAGE LAB grid) ───────────────────────────
#define DEVICE_ID "roomcam"        // lowercase id, [a-z0-9_-], unique per node
#define DEVICE_NAME "Room Cam"     // shown on the dashboard card
#define DEVICE_TYPE "esp32-cam"    // free-form category label
#define FIRMWARE_TAG "lab-cam-1"

// ── network ─────────────────────────────────────────────────────────────────
#define WIFI_SSID "SAVAGE STUDIO"
#define WIFI_PASS "Make.Money."
// Optional fallback network. Leave SSID empty to skip.
#define WIFI_SSID2 ""
#define WIFI_PASS2 ""
// mDNS name → http://roomcam.local on the home network.
#define HOSTNAME "roomcam"

// ── cloud (SAVAGE LAB / room-watch on Vercel) ───────────────────────────────
#define API_HOST "room-watch-six.vercel.app"
// Must match the DEVICE_TOKEN env var on the Vercel project.
#define DEVICE_TOKEN "4bb9daffafe1e7fb031d700242d11a769017e11269c3173d"

// ── phone alerts (ntfy.sh, no account needed) ───────────────────────────────
// Subscribe to this topic in the ntfy iPhone app. The name is the password —
// keep it private.
#define NTFY_TOPIC "room-watch-alert-58dc0be4d95b"

// ── local viewing ───────────────────────────────────────────────────────────
// Key required on every local URL, so housemates on the WiFi can't watch:
//   http://roomcam.local/?k=<STREAM_KEY>
#define STREAM_KEY "1196be308b771e83"

// ── camera ───────────────────────────────────────────────────────────────────
// FRAMESIZE_SVGA = 800x600 — the sweet spot for stream + motion detection.
#define FRAME_SIZE FRAMESIZE_SVGA
#define FRAME_W 800
#define FRAME_H 600
// 10 (best) … 63 (worst). 14 ≈ 30-45 KB per frame.
#define JPEG_QUALITY 14
// Flip these if the printed case mounts the board rotated.
#define CAM_VFLIP 0
#define CAM_HMIRROR 0

// ── behavior ─────────────────────────────────────────────────────────────────
// Armed = motion alerts on. Persisted across reboots once you toggle it.
#define ARM_DEFAULT 1
// How often to ask the cloud for arm/live/test flags when idle.
#define POLL_SECONDS 8
// One snapshot this often builds the scrubbable 24h timeline AND doubles as
// the camera's heartbeat. 60s ≈ 1440 frames/day. Raise to save blob writes.
#define TIMELINE_SECONDS 60
// Push chip temp / wifi / memory / uptime this often (feeds sensor charts).
#define TELEMETRY_SECONDS 60
// Frame pacing while someone is watching live on the away page.
#define LIVE_FRAME_MS 700

// ── motion detection ─────────────────────────────────────────────────────────
#define MOTION_SAMPLE_MS 500
// A pixel "changed" when its brightness moves more than this (0-255)…
#define MOTION_PIXEL_DELTA 26
// …and the frame is motion when more than this % of pixels changed…
#define MOTION_TRIGGER_PCT 4.0
// …for this many samples in a row (debounces exposure flicker).
#define MOTION_CONSEC 2
// Quiet time between events; continuous motion = one event per cooldown.
#define MOTION_COOLDOWN_S 90
// Ignore motion this long after boot (auto-exposure settling).
#define BOOT_GRACE_S 15
// Photos per event and spacing between them.
#define BURST_FRAMES 6
#define BURST_GAP_MS 1200

// ── microSD archive (optional — works fine with no card) ────────────────────
#define SD_CS_PIN 21
// Ring buffer: delete oldest events when free space drops below this.
#define SD_MIN_FREE_MB 200
