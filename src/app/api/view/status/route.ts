import { hasValidSession } from "@/lib/auth";
import { readFlags } from "@/lib/store";
import { readLatest } from "@/lib/lab";

// One cheap page poll: control flags + newest frame pointer (read from a tiny
// state blob, not a full frame listing).
export async function GET() {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const [flags, newest] = await Promise.all([readFlags(), readLatest()]);
  return Response.json(
    {
      arm: flags.arm,
      liveUntil: flags.liveUntil,
      tlSec: flags.tlSec,
      bts: flags.bts,
      now: Date.now(),
      newest,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
