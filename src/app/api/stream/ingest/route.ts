import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from "@vercel/functions";
import { connection } from "next/server";
import { checkPassword } from "@/lib/auth";
import { getPublisher, streamChannel } from "@/lib/redis";
import { CAMERA_DEVICE_ID } from "@/lib/store";

// The camera opens `wss://…/api/stream/ingest?token=<DEVICE_TOKEN>&device=<id>`
// and pushes binary JPEG frames while a viewer is watching. Each frame is
// published to Redis, which fans it out to every connected watcher.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const expected = process.env.DEVICE_TOKEN ?? "";
  if (!expected || !token || !checkPassword(expected, token)) {
    return new Response("unauthorized", { status: 401 });
  }
  const device = url.searchParams.get("device") || CAMERA_DEVICE_ID;

  await connection();
  return experimental_upgradeWebSocket((ws) => {
    const pub = getPublisher();
    const channel = streamChannel(device);
    ws.on("message", (data: WebSocketData) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data as ArrayBuffer);
      // publish() is binary-safe with a Buffer arg; watchers read via the
      // `messageBuffer` event to get the raw JPEG bytes back.
      if (buf.length > 0) void pub.publish(channel, buf).catch(() => {});
    });
  });
}
