import { experimental_upgradeWebSocket } from "@vercel/functions";
import { connection } from "next/server";
import { hasValidSession } from "@/lib/auth";
import { createSubscriber, streamChannel } from "@/lib/redis";
import { CAMERA_DEVICE_ID } from "@/lib/store";

// The browser opens `wss://…/api/stream/watch` (session cookie sent on the
// upgrade, same-origin). It subscribes to the device's Redis channel and
// forwards every JPEG frame to the page for near-real-time playback.
export async function GET(request: Request) {
  if (!(await hasValidSession())) {
    return new Response("unauthorized", { status: 401 });
  }
  const device =
    new URL(request.url).searchParams.get("device") || CAMERA_DEVICE_ID;

  await connection();
  return experimental_upgradeWebSocket((ws) => {
    const sub = createSubscriber();
    const channel = streamChannel(device);
    void sub.subscribe(channel).catch(() => {});
    sub.on("messageBuffer", (_channel: Buffer, message: Buffer) => {
      try {
        ws.send(message);
      } catch {}
    });
    const cleanup = () => {
      try {
        sub.disconnect();
      } catch {}
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
