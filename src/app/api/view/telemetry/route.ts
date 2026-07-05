import { hasValidSession } from "@/lib/auth";
import {
  CAMERA_DEVICE_ID,
  listTelemetry,
  retentionMs,
  validDeviceId,
} from "@/lib/lab";

const HOUR_MS = 3_600_000;

// Time series for a device's sensor charts.
export async function GET(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const device = searchParams.get("device") ?? CAMERA_DEVICE_ID;
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }
  const hours = Number(searchParams.get("hours") ?? "");
  const windowMs =
    Number.isFinite(hours) && hours > 0
      ? Math.min(hours, 24 * 14) * HOUR_MS
      : retentionMs();
  const points = await listTelemetry(device, Date.now() - windowMs);
  return Response.json(
    { device, points, now: Date.now() },
    { headers: { "cache-control": "private, no-store" } },
  );
}
