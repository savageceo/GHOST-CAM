import { put } from "@vercel/blob";
import { hasValidSession } from "@/lib/auth";
import {
  BLOB_ACCESS,
  MOTION_PREFIX,
  recordEvent,
  signedUrlFor,
} from "@/lib/store";
import { CAMERA_DEVICE_ID, listTimelineRange, validDeviceId } from "@/lib/lab";

// Save-from-timeline: copy a [from, to] slice of the rolling snapshot window
// into a permanent clip event. Pure Blob byte copies — no transcode — so the
// clip plays in the existing event player and survives timeline pruning.
// Frames land under motion/<eventId>/ (the prefix the viewer proxy already
// allows and event delete already cleans up).
export const maxDuration = 60; // long ranges = many copies; give them room

const MAX_SPAN_MS = 10 * 60 * 1000; // 10 minutes per saved clip
const MAX_FRAMES = 240; // hard cap on copied frames
const COPY_BATCH = 10; // parallel copies per wave

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function rangeLabel(fromMs: number, toMs: number): string {
  const f = new Date(fromMs);
  const t = new Date(toMs);
  return `saved ${two(f.getUTCHours())}:${two(f.getUTCMinutes())}–${two(
    t.getUTCHours(),
  )}:${two(t.getUTCMinutes())}Z`;
}

export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    device?: unknown;
    fromMs?: unknown;
    toMs?: unknown;
    label?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const device =
    typeof body.device === "string" && body.device ? body.device : CAMERA_DEVICE_ID;
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }
  const fromMs = typeof body.fromMs === "number" ? Math.floor(body.fromMs) : NaN;
  const toMs = typeof body.toMs === "number" ? Math.floor(body.toMs) : NaN;
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    toMs <= fromMs ||
    toMs - fromMs > MAX_SPAN_MS
  ) {
    return Response.json(
      { error: "bad range (max 10 minutes)" },
      { status: 400 },
    );
  }

  const points = await listTimelineRange(device, fromMs, toMs, MAX_FRAMES);
  if (points.length === 0) {
    return Response.json({ error: "no frames in range" }, { status: 404 });
  }

  const eventId = `clip${String(fromMs).padStart(13, "0")}`;
  const prefix = `${MOTION_PREFIX}${eventId}/`;
  const outPaths: string[] = [];

  // Copy in parallel waves: read each source frame via its signed CDN URL and
  // put it under the permanent clip prefix (same pattern pinFrame uses).
  for (let i = 0; i < points.length; i += COPY_BATCH) {
    const wave = points.slice(i, i + COPY_BATCH);
    const copied = await Promise.all(
      wave.map(async (p, j) => {
        const seq = i + j;
        const dest = `${prefix}${String(seq).padStart(3, "0")}.jpg`;
        try {
          const res = await fetch(await signedUrlFor(p.path), {
            cache: "no-store",
          });
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          await put(dest, buf, {
            access: BLOB_ACCESS,
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "image/jpeg",
          });
          return dest;
        } catch {
          return null;
        }
      }),
    );
    for (const c of copied) if (c) outPaths.push(c);
  }

  if (outPaths.length === 0) {
    return Response.json({ error: "copy failed" }, { status: 500 });
  }

  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.slice(0, 60)
      : rangeLabel(fromMs, toMs);
  await recordEvent(eventId, device, fromMs, "clip", label, outPaths.sort());

  return Response.json({
    ok: true,
    id: eventId,
    frames: outPaths.length,
    skipped: points.length - outPaths.length,
  });
}
