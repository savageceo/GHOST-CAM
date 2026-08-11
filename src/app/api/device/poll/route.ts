import { checkDeviceAuth, deviceFlagView, readFlags, writeFlags } from "@/lib/store";

// Camera asks "what should I be doing?" every few seconds while idle.
export async function GET(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(deviceFlagView(await readFlags()));
}

// Camera reports an arm/disarm made on its local page, so the cloud flag
// (the single source of truth) follows the button on the wall.
export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let arm: unknown;
  try {
    ({ arm } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof arm !== "boolean") {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const flags = await readFlags();
  if (flags.arm !== arm) await writeFlags({ ...flags, arm });
  return Response.json(deviceFlagView({ ...flags, arm }));
}
