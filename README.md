# SAVAGE LAB — studio command center

A private, view-from-anywhere control room for your studio, built on the proven
room-watch bones. The XIAO ESP32S3 Sense in the printed case is device #1; the
system is a **multi-device lab hub** that any ESP32 gadget (LillyGo T-Embed
CC1101, NRF bridges, bare sensors) can join with a few lines of code.

Live at **https://room-watch-six.vercel.app** — password unchanged
(`<STORAGE_PASSWORD>`). The camera needs **no reflash** to keep working; flash
the new `lab-cam` firmware when convenient for the richer timeline + telemetry.

## What's new vs. room-watch

- **24-hour timeline scrubber.** Every snapshot from the last day is kept in
  Vercel Blob. Drag the scrubber to any moment, or hit **▶ Timelapse** to play
  the whole day back. Auto-pruned past 24h (set `TIMELINE_RETENTION_HOURS` to
  change).
- **Permanent pinned archive.** Hit **📌 Pin** on any live or scrubbed frame (or
  a motion event) to copy it into `pinned/` — never auto-deleted. Your keep-
  forever shots live separately from the rolling window.
- **Multi-device grid.** Every node that registers shows up as a card with its
  latest telemetry and online status. The camera is just the first one.
- **Live sensor charts.** Any numeric telemetry (chip temp, wifi, RF noise
  floor, battery, humidity…) becomes a 24h line chart. Pick a device to view its
  sensors.
- **Lab-themed dashboard.** Reactor status, glassy panels, the works.

Everything room-watch did still works: LAN MJPEG stream, motion bursts, ntfy
phone alerts with the photo attached, microSD ring buffer, arm/disarm that syncs
both ways, "go live" from anywhere.

## iPhone setup (unchanged)

1. Open **https://room-watch-six.vercel.app**, password `<STORAGE_PASSWORD>`,
   Share → **Add to Home Screen**.
2. Alerts: **ntfy** app → subscribe to `<NTFY_TOPIC>`.
3. Home stream (LAN): **http://roomcam.local/?k=<STREAM_KEY>**.

## How the data is stored (Vercel Blob, private store)

| Prefix | What | Retention |
| --- | --- | --- |
| `timeline/<device>/<ms>.jpg` | 24h scrubbable snapshots | rolling 24h |
| `pinned/<ms>_<meta>.jpg` | permanent saves | forever |
| `motion/<event>/<seq>.jpg` | motion bursts | until you delete |
| `telemetry/<device>/<ms>_<metrics>.json` | sensor readings | rolling 24h |
| `devices/<device>__<meta>.json` | device registry | latest wins |
| `state/flags-*`, `state/latest-*` | control + newest-frame pointers | latest wins |
| `live/*` | low-latency go-live frames | rolling (few) |

State rides in blob **pathnames** (metrics, flags, latest pointer) so reads come
straight from the API with no CDN cache — the same trick that makes "go live"
reach the camera in ~8s. Retention is enforced opportunistically on device
writes plus a daily Vercel Cron (`/api/cron/prune`, see `vercel.json`).

## API map

Device side (Bearer `DEVICE_TOKEN`):

- `POST /api/device/frame?kind=timeline|live|motion&device=<id>` — JPEG body
- `POST /api/device/telemetry` — `{device, metrics:{…}, meta?:{…}}`
- `POST /api/device/register` — `{device, name, type, caps[], firmware}`
- `GET|POST /api/device/poll` — arm/live/test flags

Viewer side (cookie session):

- `GET /api/view/status | timeline | telemetry | devices | events | pinned`
- `GET /api/view/frame?path=` — signed CDN redirect
- `POST /api/view/pin` · `DELETE /api/view/pinned?path=`
- `POST /api/view/flags` — arm / go-live / test

## Firmware

See **`firmware/README.md`**. Three sketches:

- `firmware/lab-cam/` — the upgraded camera (timeline + telemetry + auto-
  register). Flash this to level up the XIAO.
- `firmware/lab-node/` — drop-in template: any ESP32 becomes a lab node.
- `firmware/lillygo-tembed-cc1101/` — example RF node reporting sub-GHz noise
  floor from the CC1101.
- `firmware/room-cam/` — the original, kept as a backup.

## Deploy

```
vercel deploy --prod --yes
```

Env vars (already set on the project; `.env.example` documents them). No new
required secrets — the whole hub reuses the existing `DEVICE_TOKEN`,
`STORAGE_PASSWORD`, `SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`. Optional:
`TIMELINE_RETENTION_HOURS` (default 24).

## Adding a new gadget (the fun part)

1. Copy `firmware/lab-node/` to a new folder.
2. Set `DEVICE_ID`, `DEVICE_NAME`, WiFi, and paste the same `DEVICE_TOKEN`.
3. Fill `readSensors()` with your reads (`m.add("tempC", 21.4)` …).
4. Flash. It appears in the dashboard grid and its numbers start charting.

Same token, same API — no dashboard changes needed. Build out the studio one
node at a time.
