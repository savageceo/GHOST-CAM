# GHOST-CAM build notes

A running record of the state of this build and the non-obvious things that
matter. Newest work at the top.

## 2026-08-11 (later) — 🎬 BTS mode · Govee lights · expansion playbook

Second pass the same day: the suite is now a **content rig too**, and the
lights answer to the dashboard.

- **BTS mode** (`device_state.bts`, migration 0003): 🎬 button suppresses
  motion + sound alerts entirely while the timeline keeps rolling at full res;
  **⏺ Capture** (`capture_at`) records a silent on-demand 15s burst, filed 🎬
  in Events. Pill in the header + `bts` telemetry chip make shoot mode
  visible. House rules + socials workflow: `docs/EXPANSION-PLAYBOOK.md` §10.
- **Govee lights**: `GOVEE_API_KEY` env → Studio lights section (on/off,
  brightness, SAVAGE swatches) via the Govee platform API; **panic events
  slam the strips full-bright red** (`GOVEE_ALERT_KINDS`, default panic).
- **`docs/EXPANSION-PLAYBOOK.md`** — wiring + flash-ready sketches for the
  laser tripwire, VL53L1X invisible trip, reed door node, panic button, siren
  (MOSFET), LD2410C presence, cams #2/#3, NFC tap-to-arm, print queue, and
  the deploy checklist. This is the build manual for the incoming order.
- Deploy delta on top of the morning pass: `npx drizzle-kit migrate` picks up
  0003 automatically; add `GOVEE_API_KEY` (+optional `GOVEE_ALERT_KINDS`) to
  Vercel; redeploy; reflash (same command). Verified: next build clean, tsc
  clean, XIAO_ESP32S3 compile clean (37% flash).

## 2026-08-11 — mic unlocked · 24h timeline · save-from-window · alarm pipeline

The Sense's last dark corner (the PDM mic) is now live, the timeline is a full
day deep, anything in it can be saved out permanently, and any future node
(tripwire / door / panic) alerts the phone with ONE call. Deploy order:

1. **DB migration** (adds `device_state.tl_sec`, `motion_events.kind/label`):
   `npx drizzle-kit migrate` (or `npx drizzle-kit push`). Idempotent.
2. **Env**: delete/raise any `TIMELINE_HOURS=3` override in Vercel — the code
   default is now **24**. (Blob cost at 24h·1s ≈ 86k writes/day, ~10-17 GB
   rolling; the dashboard cadence knob → 2s halves it. Watch the first bill.)
3. **Deploy**: `vercel deploy --prod --yes`. Dashboard gains: window picker
   (1h/3h/6h/24h), ⟦ In / Out ⟧ + 💾 Save clip, cadence knob (footer), sound
   charts, kind-tagged event feed.
4. **Reflash the camera** (same build command as always). New config knobs are
   optional — an untouched config.h compiles (defaults live in the .ino);
   copy the mic block from `config.h.example` when you want to tune. Serial
   now narrates `[mic] level/floor/peak` + `[mic] TRIGGER`.
5. **Verify**: `[mic] PDM mic on` at boot · Sound level chart moving · clap
   hard → 🔊 push with photo · scrub, mark In/Out, Save clip → plays in feed.

Decisions that live here: mic policy is **always-on, always-record; push
armed-gated** (`SOUND_PUSH_WHEN_DISARMED` flips that). Sound clips ride the
motion session machinery (`&type=sound` on the frame POST) — one pipeline, two
triggers. Node alarms: `POST /api/device/event` / `lab::event()` — the push
attaches the camera's newest frame so every alert arrives with a look at the
room.

## Where things stand

- **Live streaming: fixed and working (~5 fps @ HD).** It was silently stuck at
  1.4 fps for a long time — see "Gotchas" below. Reliable now; not "high fps"
  (round-trip bound, not the camera).
- **Motion detection: working** — records **15 s clips**, keeps recording while
  movement continues (rechecks every 5 s), sends **one** push per event, and
  **runs even while you're watching live**. Each clip plays back in the
  dashboard (scrubbable).
- **Push notifications: working** — installable PWA + native Web Push with the
  snapshot. (`docs/install-and-alerts.md`)
- **Auto-arm by iPhone location: working** — Shortcuts geofence → `/api/geofence`.
  (`docs/iphone-auto-arm.md`)
- **Night mode, 180° orientation, clip player: done.**
- **Domain:** `www.ghostk.ing` serves the app (apex redirects to www).
- **Deployed** to Vercel prod; **firmware flashed** to the XIAO ESP32S3 Sense.

## What still needs *you*

1. **microSD card** — it isn't mounting (reads `sd:false`). It's not a firmware
   problem; the card isn't detected at the hardware level. **Reseat it firmly**,
   or pull it and reformat **FAT32** on a computer (exFAT / 64 GB+ won't mount),
   then reinsert. Cloud + push work without it; only the on-card archive needs it.
2. **Camera placement (for reliable motion)** — the camera is currently pointed
   at a **dark, backlit room** (a bright window crushes the interior to near
   black, avg brightness ~33/255). Motion in near-black barely changes any
   pixels. The firmware now forces a long night-mode exposure + a low change
   threshold to compensate, but the single biggest win is **aiming it at a
   reasonably lit area, not into a window.**
3. **Reinstall the PWA from `www.ghostk.ing`** if you want push tied to the new
   domain (push subscriptions are per-origin; the ones from the vercel.app URL
   stay on that origin).

## Gotchas / learnings (don't regress these)

- **The `ws` npm package is required** for Vercel's `experimental_upgradeWebSocket`.
  It was missing → every WebSocket upgrade 500'd → live silently fell back to
  1.4 fps HTTP. It's installed now; don't remove it.
- **XCLK must be 20 MHz, not 24.** At 24 MHz the OV2640 emits oversized,
  malformed JPEGs that browsers accept but the on-chip decoders reject — which
  silently kills motion detection. 20 MHz = clean frames, working motion.
- **The ESP32 can't reliably open a WebSocket to Vercel** (a second TLS
  connection alongside the HTTP keep-alive won't fit in heap). So the camera
  streams live frames over **HTTP POST → `/api/stream/push` → Redis → browser
  WebSocket**. The browser side is a normal WS and works fine.
- **The core's JPEG decoder can't read the OV2640's frames** — motion uses the
  **JPEGDEC** library instead. Only firmware lib dependency now.
- **Live fps ≈ 5** is round-trip-bound (each frame waits for its HTTP response,
  ~150–200 ms to Vercel), not bandwidth — only ~1 of ~3 Mbps is used. Real high
  fps (15–25) needs a send-only socket or an edge relay; not built.

## Firmware tuning knobs (`firmware/lab-cam/config.h`)

| Knob | Now | What it does |
| --- | --- | --- |
| `LIVE_FRAME_SIZE` | `FRAMESIZE_HD` | live resolution (smaller barely raises fps here) |
| `MOTION_TRIGGER_PCT` | `1.8` | % of pixels that must change to fire |
| `MOTION_PIXEL_DELTA` | `10` | how much a pixel must change to count (low = dim-room friendly) |
| `MOTION_CONSEC` | `1` | samples in a row before firing (1 = catch a quick walk-by) |
| `CLIP_SECONDS` / `CLIP_FPS` | `15` / `3` | length + rate of each motion clip |
| `RECHECK_SECONDS` | `5` | how long to watch for continued movement |
| `NIGHT_EXPOSURE` | `1000` | manual exposure in the dark (higher = brighter room, more blur) |
| `NIGHT_ENTER_LUMA` | `60` | scene brightness below which night mode kicks in |

Serial @ 115200 narrates everything: `[live] N fps (http→redis)`,
`[motion] now/peak/avg`, `[event] SESSION/clip …`, `[cam] night mode`, `[sd] …`.

## Devices

- **Seeed XIAO ESP32S3 Sense** — the camera (`firmware/lab-cam/`). OV2640 2 MP,
  8 MB PSRAM, 2.4 GHz WiFi. Often on wall power (off USB) → can't reflash then.
- **LilyGo T-Embed CC1101** — a sub-GHz RF sensor node, not a camera
  (`firmware/lillygo-tembed-cc1101/`).
