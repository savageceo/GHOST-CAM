import { hasValidSession } from "@/lib/auth";
import { listDevices } from "@/lib/lab";

// The device grid: every registered node with its latest telemetry snapshot.
export async function GET() {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(
    { devices: await listDevices(), now: Date.now() },
    { headers: { "cache-control": "private, no-store" } },
  );
}
