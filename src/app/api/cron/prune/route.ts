import { hasValidSession } from "@/lib/auth";
import { checkDeviceAuth, pruneLiveFrames } from "@/lib/store";
import { pruneAll } from "@/lib/lab";

// Retention backstop. Vercel Cron hits this (see vercel.json); opportunistic
// prunes on device writes keep the window tight between runs either way.
async function authorized(request: Request): Promise<boolean> {
  if (request.headers.get("x-vercel-cron")) return true;
  if (checkDeviceAuth(request)) return true;
  return hasValidSession();
}

export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const pruned = await pruneAll();
  try {
    await pruneLiveFrames(4);
  } catch {}
  return Response.json({ ok: true, pruned, at: Date.now() });
}
