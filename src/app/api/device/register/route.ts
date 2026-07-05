import { checkDeviceAuth, readFlags } from "@/lib/store";
import { type DeviceMeta, registerDevice, validDeviceId } from "@/lib/lab";

// A node announces itself once on boot. Cameras, RF tools, sensors — anything
// with the DEVICE_TOKEN can join the lab and appear in the device grid.
export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    device?: unknown;
    name?: unknown;
    type?: unknown;
    caps?: unknown;
    firmware?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const device = typeof body.device === "string" ? body.device : "";
  if (!validDeviceId(device)) {
    return Response.json({ error: "bad device" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 40) : "";
  if (!name) {
    return Response.json({ error: "name required" }, { status: 400 });
  }
  const type = typeof body.type === "string" ? body.type.slice(0, 24) : "sensor";
  const caps = Array.isArray(body.caps)
    ? body.caps
        .filter((c): c is string => typeof c === "string")
        .slice(0, 12)
        .map((c) => c.slice(0, 24))
    : [];
  const firmware =
    typeof body.firmware === "string" ? body.firmware.slice(0, 40) : undefined;

  const meta: DeviceMeta = { name, type, caps, firmware };
  await registerDevice(device, meta);

  const flags = await readFlags();
  return Response.json({
    ok: true,
    arm: flags.arm,
    live: flags.liveUntil > Date.now(),
    testAt: flags.testAt,
    orient: flags.orient,
  });
}
