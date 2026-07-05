import { hasValidSession } from "@/lib/auth";
import { readFlags, writeFlags } from "@/lib/store";

const LIVE_WINDOW_MS = 90 * 1000;

// Page controls: arm/disarm, request/stop live view, fire a test alert.
export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    arm?: unknown;
    goLive?: unknown;
    stopLive?: unknown;
    test?: unknown;
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

  if (
    next.arm !== flags.arm ||
    next.liveUntil !== flags.liveUntil ||
    next.testAt !== flags.testAt
  ) {
    await writeFlags(next);
  }
  return Response.json({ ...next, now: Date.now() });
}
