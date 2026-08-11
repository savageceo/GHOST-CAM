import { hasValidSession } from "@/lib/auth";
import { readFlags, writeFlags } from "@/lib/store";

const LIVE_WINDOW_MS = 90 * 1000;
const TL_CHOICES = new Set([0, 1, 2, 5, 10]); // 0 = firmware default cadence

// Page controls: arm/disarm, request/stop live view, fire a test alert,
// rotate, and the timeline cadence knob (tlSec — the camera adopts it on its
// next poll or frame POST, no reflash).
export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    arm?: unknown;
    goLive?: unknown;
    stopLive?: unknown;
    test?: unknown;
    orient?: unknown;
    tlSec?: unknown;
    bts?: unknown;
    capture?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const flags = await readFlags();
  const next = { ...flags };
  if (typeof body.arm === "boolean") next.arm = body.arm;
  if (body.goLive === true) next.liveUntil = Date.now() + LIVE_WINDOW_MS;
  if (body.stopLive === true) next.liveUntil = 0;
  if (body.test === true) next.testAt = Date.now();
  if (body.orient === 0 || body.orient === 180) next.orient = body.orient;
  if (typeof body.tlSec === "number" && TL_CHOICES.has(body.tlSec)) {
    next.tlSec = body.tlSec;
  }
  if (typeof body.bts === "boolean") next.bts = body.bts; // 🎬 shoot mode
  if (body.capture === true) next.captureAt = Date.now(); // 🎬 capture burst

  if (
    next.arm !== flags.arm ||
    next.liveUntil !== flags.liveUntil ||
    next.testAt !== flags.testAt ||
    next.orient !== flags.orient ||
    next.tlSec !== flags.tlSec ||
    next.bts !== flags.bts ||
    next.captureAt !== flags.captureAt
  ) {
    await writeFlags(next);
  }
  return Response.json({ ...next, now: Date.now() });
}
