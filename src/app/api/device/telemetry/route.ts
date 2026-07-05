import { checkDeviceAuth, readFlags } from "@/lib/store";
import {
  type DeviceMeta,
  type Metrics,
  pruneTelemetry,
  registerDevice,
  validDeviceId,
  writeTelemetry,
} from "@/lib/lab";

// Any lab node (camera, LillyGo, NRF bridge, a bare sensor) POSTs readings
// here. Metrics are arbitrary key→number/string/bool. Optional `meta` upserts
// the device registry so a node can announce itself in the same call.
export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { device?: unknown; metrics?: unknown; meta?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const device = typeof body.device === "string" ? body.device : "";
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }

  const metrics = sanitizeMetrics(body.metrics);
  if (!metrics) {
    return Response.json({ error: "bad metrics" }, { status: 400 });
  }

  const meta = sanitizeMeta(body.meta);
  if (meta) {
    try {
      await registerDevice(device, meta);
    } catch {}
  }

  await writeTelemetry(device, metrics);
  if (Math.random() < 0.05) {
    try {
      await pruneTelemetry(device);
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

function sanitizeMetrics(raw: unknown): Metrics | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Metrics = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 32) break;
    if (!/^[A-Za-z0-9_]{1,24}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.round(v * 1000) / 1000;
      count++;
    } else if (typeof v === "boolean") {
      out[k] = v;
      count++;
    } else if (typeof v === "string" && v.length <= 40) {
      out[k] = v;
      count++;
    }
  }
  return count > 0 ? out : null;
}

function sanitizeMeta(raw: unknown): DeviceMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.slice(0, 40) : "";
  if (!name) return null;
  const type = typeof r.type === "string" ? r.type.slice(0, 24) : "sensor";
  const caps = Array.isArray(r.caps)
    ? r.caps
        .filter((c): c is string => typeof c === "string")
        .slice(0, 12)
        .map((c) => c.slice(0, 24))
    : [];
  const firmware =
    typeof r.firmware === "string" ? r.firmware.slice(0, 40) : undefined;
  return { name, type, caps, firmware };
}
