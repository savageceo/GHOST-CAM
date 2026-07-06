# Install the app + motion push notifications

Turn SAVAGE LAB into a real app on your phone's home screen and get a **native
push notification with the snapshot** the instant the camera sees motion — even
when the app is closed.

## 1 · Install it (iPhone)

1. Open **https://room-watch-six.vercel.app** in **Safari** and log in.
2. Tap **Share** (□↑) → **Add to Home Screen** → **Add**.
3. Launch the new **SAVAGE LAB** icon from your home screen — it opens
   full-screen with no browser bars. **That installed app is what unlocks push
   on iOS** (Safari tabs can't do Web Push).

*Android / desktop Chrome:* you'll get an **Install app** prompt (or ⋮ → Install).

## 2 · Turn on motion alerts

1. In the installed app, tap the big **🔔 Turn on motion push notifications**
   button (or the **🔔 enable alerts** link at the very bottom).
2. Tap **Allow** when iOS asks.
3. Tap **🔔 alerts on · test** to fire a test push and confirm it lands.

From then on, whenever the camera is **armed** and detects motion, every device
you've enabled gets a push — **"🚨 Motion in your lab"** with the snapshot — and
tapping it jumps straight to the live view.

> Pair this with the geofence auto-arm ([`iphone-auto-arm.md`](iphone-auto-arm.md))
> so you're only pinged while you're away.

## 3 · The live "box"

Tap **⛶** on the camera to blow the feed up into a full-screen, black cinema box
(**✕** exits). Hit **● Go live** first for a smooth real-time HD stream. Since
it's an installed PWA, the home-screen icon is your one-tap way in — or make an
iOS Shortcut with **Open URL → `https://room-watch-six.vercel.app`**.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Add to Home Screen, then tap here…" | You're in a Safari tab. Install to the home screen first (step 1), then enable from the installed app. |
| No permission prompt | iOS **16.4+** is required; make sure you opened the installed app, not Safari. |
| Enabled but no pushes | Confirm the camera is **armed** and online; use **🔔 alerts on · test** to test the push path directly, and **Test alert** to test the full motion → push chain. |
| Accidentally blocked | iOS: Settings → Notifications → **SAVAGE LAB** → allow, then re-tap enable. |

## How it works (under the hood)

Web Push (VAPID). The installed PWA registers `public/sw.js` and subscribes via
`PushManager`; the subscription is stored in Neon (`push_subscriptions`). When
the camera POSTs its first motion frame, the server signs and fans a push out to
every subscription with `web-push` (`src/lib/push.ts`), attaching a short-lived
signed snapshot URL, and prunes any endpoints the push service reports as gone.
Keys live in the `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env
vars (+ `NEXT_PUBLIC_VAPID_PUBLIC_KEY` for the client).
