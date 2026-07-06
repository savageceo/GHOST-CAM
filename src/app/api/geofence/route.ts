import { checkPassword } from "@/lib/auth";
import { CAMERA_DEVICE_ID, readFlags, writeFlags } from "@/lib/store";

// iPhone geofence hook. An iOS Shortcuts "Personal Automation" fires this when
// you leave / arrive home so the camera auto-arms while you're gone — no viewer
// login needed (Shortcuts can't hold the session cookie). Auth is a shared
// secret in `?key=` or a Bearer header; set GEOFENCE_KEY in the Vercel env.
//
//   Leave home  → POST /api/geofence?key=<GEOFENCE_KEY>&arm=1   (arm)
//   Arrive home → POST /api/geofence?key=<GEOFENCE_KEY>&arm=0   (disarm)
//   (omit arm= to toggle)
//
// GET is accepted too, so it also works as a plain URL for testing.
async function handle(request: Request): Promise<Response> {
  const expected = process.env.GEOFENCE_KEY ?? "";
  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const key = url.searchParams.get("key") ?? bearer;
  if (!expected || !key || !checkPassword(expected, key)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const device = url.searchParams.get("device") || CAMERA_DEVICE_ID;
  const armParam = (url.searchParams.get("arm") ?? "").toLowerCase();

  const flags = await readFlags(device);
  let arm: boolean;
  if (armParam === "1" || armParam === "true" || armParam === "away") arm = true;
  else if (armParam === "0" || armParam === "false" || armParam === "home") arm = false;
  else arm = !flags.arm; // no arm param → toggle

  await writeFlags({ ...flags, arm }, device);
  // The camera picks this up on its next poll (≤ POLL_SECONDS) or frame POST.
  return Response.json({ ok: true, device, armed: arm });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
