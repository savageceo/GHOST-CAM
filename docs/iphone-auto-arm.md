# iPhone auto-arm (geofence)

Arm the camera automatically when you **leave home** and disarm when you **get
back**, so SAVAGE LAB records motion only while you're away. No app to install —
it uses Apple's built-in **Shortcuts** automations plus one webhook.

## How it works

Your iPhone already knows when you cross your home's geofence. A **Personal
Automation** fires a single HTTPS request to the camera's cloud each time you
leave or arrive:

- **Leave home** → `/api/geofence?key=…&arm=1` → camera **arms**
- **Arrive home** → `/api/geofence?key=…&arm=0` → camera **disarms**

The camera reads the new state on its next poll (within `POLL_SECONDS`, ~8 s) and
starts/stops motion capture — cloud + ntfy push + microSD — accordingly. It's the
exact same arm flag the dashboard's **Armed** button toggles.

## Before you start

1. `GEOFENCE_KEY` is set in the Vercel project env (any random secret, e.g.
   `openssl rand -hex 16`). It's already set on the live deploy.
2. Know your site URL — here `https://room-watch-six.vercel.app`.

Your two webhook URLs (swap in your real key for `<GEOFENCE_KEY>`):

```
Arm (leaving):   https://room-watch-six.vercel.app/api/geofence?key=<GEOFENCE_KEY>&arm=1
Disarm (arrive): https://room-watch-six.vercel.app/api/geofence?key=<GEOFENCE_KEY>&arm=0
```

> Keep these URLs private — the key in them is a password. Don't paste the real
> key into any file you commit.

## Set it up (~2 minutes)

### 1 · "Leave" automation → arms the camera

1. Open **Shortcuts** → **Automation** tab (bottom).
2. Tap **＋** (top-right). If asked, choose **Create Personal Automation**.
3. Scroll to the **Travel** section → tap **Leave**.
4. Tap **Choose** next to Location → set your **home** address and radius → **Done**.
5. Leave the time as **Any Time** → tap **Next**.
6. Tap **Add Action** → search **Get Contents of URL** → tap it to add.
7. Tap the **URL** field and paste your **arm** URL (the one ending `&arm=1`).
8. Tap **Next**.
9. Turn **Ask Before Running** *off* (newer iOS: choose **Run Immediately**) →
   confirm **Don't Ask** → **Done**.

### 2 · "Arrive" automation → disarms the camera

Repeat exactly, with two changes:

- Step 3: choose **Arrive** instead of **Leave**.
- Step 7: paste your **disarm** URL (the one ending `&arm=0`).

Done. Leave home → it arms itself; come back → it disarms.

## Test it without leaving the house

- **In Shortcuts:** open the automation and tap **▶ Run** (or the ⋯ menu → Run).
- **From a terminal:**
  ```
  curl -X POST "https://room-watch-six.vercel.app/api/geofence?key=<GEOFENCE_KEY>&arm=1"
  # → {"ok":true,"device":"roomcam","armed":true}
  ```
  Then open the dashboard — the **Armed** button should be lit. Run it again with
  `&arm=0` to disarm.

## Endpoint reference

`GET` or `POST` `/api/geofence`:

| Param | Values | Meaning |
| --- | --- | --- |
| `key` | your `GEOFENCE_KEY` | **required**; wrong/missing → `401` |
| `arm` | `1`/`0` (also `true`/`false`, `away`/`home`) | arm or disarm — **omit to toggle** |
| `device` | a device id | optional, defaults to `roomcam` |

Response: `{"ok":true,"device":"roomcam","armed":true|false}`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401 unauthorized` | The `key` doesn't match `GEOFENCE_KEY` in Vercel. Re-check both. |
| Automation never fires | iOS needs Location **Always** + **Precise** for Shortcuts (Settings → Privacy → Location → Shortcuts). Geofences can also lag a few minutes — give it a day. |
| Armed, but no motion clips | The camera must be online; microSD archiving also needs a FAT32 card (see the main `README.md`). Cloud + ntfy still work without a card. |
| Dashboard didn't update | The camera syncs on its next poll (~8 s). Refresh. |

> **Rotating the key:** change `GEOFENCE_KEY` in the Vercel env, redeploy, and
> update the URL in both automations. The old URL then returns `401`.

## Rearm safety (optional)

If you'd rather the camera default to **armed** and only disarm at home, that's
already the behavior — `ARM_DEFAULT 1` in the firmware and the server default arm
is `true`. The geofence just flips it as you come and go.
