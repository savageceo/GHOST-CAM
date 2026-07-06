# SAVAGE LAB — studio command center

A private, view-from-anywhere control room for your studio, built on the proven
room-watch bones. The XIAO ESP32S3 Sense in the printed case is device #1; the
system is a **multi-device lab hub** that any ESP32 gadget (LilyGo T-Embed
CC1101, NRF bridges, bare sensors) can join with a few lines of code.

Live at **https://room-watch-six.vercel.app** — log in with the password held in
the `STORAGE_PASSWORD` env var. The camera needs **no reflash** to keep working;
flash the `lab-cam` firmware when convenient for the live WebSocket stream, 1s
timeline, telemetry, and cloud rotate.

## Architecture at a glance

Three stores, split by job:

- **Neon Postgres** (via drizzle-orm) — the **index, state, and control plane**:
  device registry, per-device flags (arm/live/test + orientation), the frame
  index, telemetry, motion events, and pins. Schema in `src/lib/db/schema.ts`.
- **Vercel Blob** (private store) — the **image bytes**. Frame/pin rows in
  Postgres point at their JPEG via `blobPath`; the bytes never touch the DB.
  Reads go out as a signed, short-lived CDN URL (local HMAC presign, no
  round-trip — so caching a signed URL can never serve a stale frame).
- **Redis** (Upstash) — the **live-stream bus**. Vercel pins each WebSocket to a
  single Function instance, so a shared pub/sub channel is what fans the camera's
  frames out to every watching browser.

> Heads-up for anyone reading older commits or docs: earlier versions encoded all
> state in Blob **pathnames**. That scheme is gone — Neon is now the source of
> truth (`src/lib/lab.ts`, `src/lib/store.ts`, `src/lib/db/schema.ts`).

## What it does

- **Live WebSocket stream.** Open the page and the camera opens a `wss://` socket
  to the cloud and pushes JPEG frames in near-real-time. While you watch, the
  sensor streams **HD 720p at ~10–14 fps** (tunable up to ~30 fps at lower res),
  then snaps back to full **UXGA** for stills. Falls back automatically to HTTP
  frame POSTs (~1.4 fps) if the socket can't connect (`USE_WS_STREAM 0`). Frames
  paint straight to the page (no per-frame re-render), so it stays smooth.
- **Timeline scrubber + timelapse.** The camera saves one snapshot per second.
  Drag the scrubber to any moment in the retained window, or hit **▶ Timelapse**
  to play it back. Images are kept ~3h (`TIMELINE_HOURS`); telemetry ~24h
  (`TIMELINE_RETENTION_HOURS`). Auto-pruned.
- **Rotate from anywhere.** The **Rotate** button sets an `orient` flag (0/180);
  the camera reads it on its next poll and flips (persisted to NVS) — no reflash,
  no cable.
- **Permanent pinned archive.** **📌 Pin** any live, scrubbed, or motion frame to
  copy it into `pinned/` — never auto-deleted. Keep-forever shots live separately
  from the rolling window.
- **Multi-device grid.** Every node that registers shows up as a card with its
  latest telemetry and online status. The camera is just the first one.
- **Live sensor charts.** Any numeric telemetry (chip temp, wifi, RF noise
  floor, battery, humidity…) becomes a 24h line chart. Pick a device to view its
  sensors.
- **Motion bursts + phone alerts.** Armed motion fires an **ntfy** push with the
  photo attached and saves the burst as a motion event.

Everything room-watch did still works: LAN MJPEG stream, motion bursts, ntfy
alerts, microSD ring buffer, arm/disarm that syncs both ways, "go live" from
anywhere.

## Hardware (the lab devices)

| Device | Role | Key specs | Firmware |
| --- | --- | --- | --- |
| **Seeed XIAO ESP32S3 Sense** | the camera — device #1 (`roomcam`) | ESP32-S3 · 8 MB PSRAM · OV2640 2 MP (max UXGA 1600×1200) · microSD · 2.4 GHz Wi-Fi | `firmware/lab-cam/` |
| **LilyGo T-Embed CC1101** | sub-GHz **RF** sensor node (not a camera) | ESP32-S3 + CC1101 radio + display; charts the ambient RF noise floor | `firmware/lillygo-tembed-cc1101/` |
| **Any ESP32** | drop-in sensor node | your choice of sensors | `firmware/lab-node/` |

The camera is the star: full-res **UXGA** stills for the timeline/motion/pins and
a smooth **HD** live stream on demand. Its 2.4 GHz Wi-Fi upload — not the sensor
or the cloud — is what caps live frame rate; **`firmware/README.md`** has the
resolution ↔ frame-rate table and every tuning knob. The T-Embed CC1101 rides the
same dashboard as an RF-monitoring node — it reports the sub-GHz noise floor, not
video. (If you actually have a LilyGo *camera* board, its pin map differs from the
XIAO — say so and it's a small firmware fork.)

## iPhone setup

1. Open **https://room-watch-six.vercel.app**, enter the `STORAGE_PASSWORD`,
   Share → **Add to Home Screen**.
2. Alerts: **ntfy** app → subscribe to your `NTFY_TOPIC` (set in firmware).
3. Home stream (LAN): **http://roomcam.local/?k=<STREAM_KEY>**.

### Auto-arm when you leave (iPhone geofence)

Arm the camera automatically when you leave home and disarm when you get back, so
it records motion only while you're away — no app, just Apple **Shortcuts**:

1. Set `GEOFENCE_KEY` in the Vercel env (any random secret).
2. Shortcuts → **Automation** → **＋** → **Leave** → pick your home → **Next**.
3. Add action **Get Contents of URL**:
   - URL `https://room-watch-six.vercel.app/api/geofence?key=<GEOFENCE_KEY>&arm=1`
   - Method **POST** · turn **Ask Before Running** off (so it's automatic).
4. Duplicate it for **Arrive** with `&arm=0` (disarm at home).

The camera picks up the new arm state on its next poll (≤ `POLL_SECONDS`). Endpoint:
`POST /api/geofence?key=…&arm=1|0` (omit `arm` to toggle); it flips the same arm
flag the dashboard's Armed button uses. Motion bursts then land in the cloud +
ntfy + microSD exactly as when armed by hand.

## Data model

**Neon — index / state / control plane** (`src/lib/db/schema.ts`):

| Table | Holds |
| --- | --- |
| `devices` | registry: id, name, type, caps, firmware, last seen |
| `device_state` | per-device flags: `arm`, `liveUntil`, `testAt`, `orient` (0/180) |
| `frames` | frame **index**: device, kind (`live`/`timeline`/`motion`/`pinned`), timestamp, `blobPath`, w/h, meta |
| `telemetry` | sensor readings: device, timestamp, metrics JSON |
| `motion_events` | motion bursts: id, device, timestamp, frame paths, disposition |
| `pins` | permanent saves: label, kind, `blobPath`, timestamp |
| `commands` | generalized command queue — groundwork for actuator nodes (alarm/greet/shades/scene); not yet wired |

**Vercel Blob — bytes** (private store, referenced by `blobPath`):

| Prefix | What | Retention |
| --- | --- | --- |
| `timeline/<device>/<ms>.jpg` | 1s scrubbable snapshots | ~3h (`TIMELINE_HOURS`) |
| `pinned/<ms>_<meta>.jpg` | permanent saves | forever |
| `motion/<event>/<seq>.jpg` | motion bursts | until you delete |
| `live/<ms>_….jpg` | HTTP-fallback live frames | newest few |

Retention is enforced opportunistically on device writes plus a daily Vercel
Cron (`/api/cron/prune`, see `vercel.json`; auth via `CRON_SECRET`).

## API map

Device side (Bearer `DEVICE_TOKEN`):

- `POST /api/device/frame?kind=timeline|live|motion&device=<id>` — JPEG body
- `POST /api/device/telemetry` — `{device, metrics:{…}, meta?:{…}}`
- `POST /api/device/register` — `{device, name, type, caps[], firmware}`
- `GET|POST /api/device/poll` — read arm/live/test/`orient`; POST syncs a
  wall-button arm/disarm back up
- `wss /api/stream/ingest?token=<DEVICE_TOKEN>&device=<id>` — binary live frames

Viewer side (session cookie from `POST /api/auth`):

- `GET /api/view/status | timeline | telemetry | devices | events | pinned`
- `GET /api/view/frame?path=` — signed CDN redirect
- `POST /api/view/pin` · `DELETE /api/view/pinned?path=` · `DELETE /api/view/events?id=`
- `POST /api/view/flags` — arm / go-live / stop-live / test / rotate (`orient`)
- `wss /api/stream/watch?device=<id>` — receive live frames
- `POST /api/auth` (log in) · `DELETE /api/auth` (log out)

## Firmware

See **`firmware/README.md`** for the full build/flash steps, the streaming
quality ↔ frame-rate table, and every tuning knob. Sketches:

- `firmware/lab-cam/` — the camera (dual-res HD live stream + UXGA stills, 1s
  timeline, telemetry, cloud rotate, auto-register). Flash this to level up the
  XIAO. Needs the **ArduinoWebsockets** library:
  `arduino-cli lib install ArduinoWebsockets` (or set `USE_WS_STREAM 0`).
- `firmware/lab-node/` — drop-in template: any ESP32 becomes a lab node.
- `firmware/lillygo-tembed-cc1101/` — example RF node reporting sub-GHz noise
  floor from the CC1101.
- `firmware/room-cam/` — the original, kept as a backup.

## Deploy

```
vercel deploy --prod --yes
```

Database migrations live in `drizzle/` — apply with `drizzle-kit` (config in
`drizzle.config.ts`).

### Environment

Pull real values with `vercel env pull`; `.env.example` documents them. The
Neon, Upstash, and Blob vars are provisioned by their Vercel integrations.

Required:

| Var | What |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string (pooled) |
| `REDIS_URL` | Upstash Redis — live-stream fan-out |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob private store |
| `STORAGE_PASSWORD` | the login password the away page asks for |
| `SESSION_SECRET` | HMAC key for the session cookie (`openssl rand -hex 32`) |
| `DEVICE_TOKEN` | shared device secret (`openssl rand -hex 24`) — must match firmware `config.h` |

Optional:

| Var | Default | What |
| --- | --- | --- |
| `TIMELINE_HOURS` | 3 | how long the 1s image timeline is kept |
| `TIMELINE_RETENTION_HOURS` | 24 | how long telemetry is kept |
| `CRON_SECRET` | — | Bearer auth for the prune cron |
| `NEXT_PUBLIC_SITE_URL` | — | absolute URLs for OpenGraph |
| `GEOFENCE_KEY` | — | shared secret for the iPhone auto-arm hook (`/api/geofence`) |

## Adding a new gadget (the fun part)

1. Copy `firmware/lab-node/` to a new folder.
2. Set `DEVICE_ID`, `DEVICE_NAME`, WiFi, and paste the same `DEVICE_TOKEN`.
3. Fill `readSensors()` with your reads (`m.add("tempC", 21.4)` …).
4. Flash. It appears in the dashboard grid and its numbers start charting.

Same token, same API — no dashboard changes needed. Build out the studio one
node at a time.
