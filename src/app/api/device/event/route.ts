import { waitUntil } from "@vercel/functions";
import {
  checkDeviceAuth,
  deviceFlagView,
  readFlags,
  recordEvent,
  signedUrlFor,
  validEventKind,
} from "@/lib/store";
import { readLatest, validDeviceId } from "@/lib/lab";
import { sendPushToAll } from "@/lib/push";
import { alertKinds, alertLights, goveeConfigured } from "@/lib/govee";

// The generic alarm pipeline: ANY lab node can fire an event with one POST —
// laser tripwire, reed door contact, mmWave presence, the panic button. It
// lands in the dashboard event feed and (unless notify:false) pushes to every
// subscribed phone with the camera's latest frame attached, so the alert
// arrives with a look at the room.
//
//   POST /api/device/event   Bearer DEVICE_TOKEN
//   { device:"entrynode", kind:"trip", label:"entry beam", notify:true }
//
// Kinds get their own push voice; anything else falls back to a generic ping.
const KIND_PUSH: Record<string, { title: string; body: string }> = {
  trip: { title: "⚡ Tripwire broken", body: "A beam was crossed." },
  door: { title: "🚪 Door contact", body: "A door or window just opened." },
  panic: { title: "🆘 PANIC BUTTON", body: "The panic button was pressed. Check in NOW." },
  sound: { title: "🔊 Loud noise", body: "A sensor heard something loud." },
  presence: { title: "👤 Presence detected", body: "mmWave sees someone." },
};

export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    device?: unknown;
    kind?: unknown;
    label?: unknown;
    notify?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const device = typeof body.device === "string" ? body.device : "";
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!validEventKind(kind)) {
    return Response.json({ error: "bad kind" }, { status: 400 });
  }
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.slice(0, 60)
      : undefined;
  const notify = body.notify !== false; // default: push

  const now = Date.now();
  const eventId = `${kind.slice(0, 8)}${String(now).padStart(13, "0")}`;
  await recordEvent(eventId, device, now, kind, label);

  // Light tie-in: alarm kinds (default just "panic" — GOVEE_ALERT_KINDS env)
  // slam the Govee strips to full-bright red. Best-effort; never blocks push.
  if (goveeConfigured() && alertKinds().has(kind)) {
    waitUntil(alertLights());
  }

  if (notify) {
    const voice = KIND_PUSH[kind] ?? {
      title: `📟 ${kind} — ${device}`,
      body: label ?? "A lab node fired an event.",
    };
    // Attach the camera's newest frame so the push shows the room right now.
    let image: string | undefined;
    try {
      const newest = await readLatest();
      if (newest && now - newest.at < 5 * 60 * 1000) {
        image = await signedUrlFor(newest.path);
      }
    } catch {}
    waitUntil(
      sendPushToAll({
        title: voice.title,
        body: label ? `${voice.body} (${label})` : voice.body,
        url: "/",
        image,
        tag: `evt-${kind}`,
      }),
    );
  }

  const flags = await readFlags();
  return Response.json({ ok: true, id: eventId, ...deviceFlagView(flags) });
}
