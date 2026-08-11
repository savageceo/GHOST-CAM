import { hasValidSession } from "@/lib/auth";
import {
  goveeConfigured,
  listLights,
  setBrightness,
  setColor,
  setColorTemp,
  setPower,
} from "@/lib/govee";

// Studio lights (Govee). GET lists the strips; POST controls one:
//   { device, sku, action: "power",      value: true|false }
//   { device, sku, action: "brightness", value: 1-100 }
//   { device, sku, action: "color",      value: {r,g,b} }
//   { device, sku, action: "ct",         value: 2000-9000 }
export async function GET(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!goveeConfigured()) {
    return Response.json({ configured: false, lights: [] });
  }
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const lights = await listLights(force);
    return Response.json(
      { configured: true, lights },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { configured: true, lights: [], error: "govee unreachable" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!goveeConfigured()) {
    return Response.json({ error: "GOVEE_API_KEY not set" }, { status: 503 });
  }
  let body: {
    device?: unknown;
    sku?: unknown;
    action?: unknown;
    value?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const device = typeof body.device === "string" ? body.device : "";
  const sku = typeof body.sku === "string" ? body.sku : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!device || !sku) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }

  let ok = false;
  try {
    if (action === "power" && typeof body.value === "boolean") {
      ok = await setPower(device, sku, body.value);
    } else if (action === "brightness" && typeof body.value === "number") {
      ok = await setBrightness(device, sku, body.value);
    } else if (action === "ct" && typeof body.value === "number") {
      ok = await setColorTemp(device, sku, body.value);
    } else if (
      action === "color" &&
      typeof body.value === "object" &&
      body.value !== null
    ) {
      const v = body.value as { r?: unknown; g?: unknown; b?: unknown };
      const n = (x: unknown) => (typeof x === "number" ? x : 0);
      ok = await setColor(device, sku, n(v.r), n(v.g), n(v.b));
    } else {
      return Response.json({ error: "bad action" }, { status: 400 });
    }
  } catch {
    ok = false;
  }
  return Response.json({ ok }, { status: ok ? 200 : 502 });
}
