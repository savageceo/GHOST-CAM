import { put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import {
  BLOB_ACCESS,
  checkDeviceAuth,
  liveFramePath,
  MOTION_PREFIX,
  pruneLiveFrames,
  readFlags,
  recordMotionFrame,
  signedUrlFor,
} from "@/lib/store";
import { sendPushToAll } from "@/lib/push";
import {
  CAMERA_DEVICE_ID,
  pruneTimeline,
  recordFrame,
  timelinePath,
  validDeviceId,
} from "@/lib/lab";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const LIVE_FRAMES_KEPT = 4;

// The camera POSTs raw JPEG bodies here:
//   kind=timeline|idle → archived to the 24h scrubbable timeline + heartbeat
//   kind=live          → rolling low-latency frames while someone watches
//   kind=motion        → burst frames grouped under an event id
// The response echoes the control flags so a streaming camera hears
// "stop"/"disarm"/"test" without a separate poll round-trip.
export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") ?? "live";
  const device = searchParams.get("device") ?? CAMERA_DEVICE_ID;
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length < 100 || body.length > MAX_FRAME_BYTES) {
    return Response.json({ error: "bad frame" }, { status: 400 });
  }

  const sd = searchParams.get("sd") === "1";
  const rssi = Number(searchParams.get("rssi") ?? "0");
  const cleanRssi = Number.isFinite(rssi) ? rssi : 0;
  const now = Date.now();

  let path: string;
  let pruneLive = false;
  let pruneTl = false;
  let motionEvent = "";
  let motionSeq = -1;

  if (kind === "motion") {
    motionEvent = searchParams.get("event") ?? "";
    motionSeq = Number(searchParams.get("seq") ?? "");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(motionEvent) ||
      !Number.isInteger(motionSeq) ||
      motionSeq < 0 ||
      motionSeq > 99
    ) {
      return Response.json({ error: "bad event" }, { status: 400 });
    }
    path = `${MOTION_PREFIX}${motionEvent}/${String(motionSeq).padStart(2, "0")}.jpg`;
  } else if (kind === "timeline" || kind === "idle") {
    path = timelinePath(device, now);
    pruneTl = Math.random() < 0.05; // opportunistic 24h retention sweep
  } else {
    path = liveFramePath(sd, cleanRssi);
    const seq = Number(searchParams.get("seq") ?? "0");
    pruneLive = !Number.isInteger(seq) || seq % 15 === 0;
  }

  await put(path, body, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/jpeg",
  });

  // Index the frame. Motion bursts group under their event id; the first burst
  // frame also lands in `frames` so it becomes the newest hero shot.
  if (kind === "motion") {
    try {
      await recordMotionFrame(motionEvent, device, now, path, motionSeq);
    } catch {}
    if (motionSeq === 0) {
      try {
        await recordFrame(device, "motion", now, path, { sd, rssi: cleanRssi });
      } catch {}
    }
    // One Web Push per motion session. New firmware sets notify=1 on the very
    // first frame of a session (and notify=0 after); older firmware sends no
    // notify param, so fall back to seq 0 to stay compatible.
    const notifyParam = searchParams.get("notify");
    const shouldNotify =
      notifyParam === "1" || (notifyParam === null && motionSeq === 0);
    if (shouldNotify) {
      try {
        const image = await signedUrlFor(path);
        waitUntil(
          sendPushToAll({
            title: "🚨 Motion in your lab",
            body: "Tap to watch the live camera.",
            url: "/",
            image,
            tag: "motion",
          }),
        );
      } catch {}
    }
  } else {
    try {
      await recordFrame(device, kind === "idle" ? "timeline" : kind, now, path, {
        sd,
        rssi: cleanRssi,
      });
    } catch {}
  }

  if (pruneLive) {
    try {
      await pruneLiveFrames(LIVE_FRAMES_KEPT);
    } catch {}
  }
  if (pruneTl) {
    try {
      await pruneTimeline(device);
    } catch {}
  }

  const flags = await readFlags();
  return Response.json({
    ok: true,
    arm: flags.arm,
    live: flags.liveUntil > Date.now(),
    testAt: flags.testAt,
    orient: flags.orient,
  });
}
