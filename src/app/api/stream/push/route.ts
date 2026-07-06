import { waitUntil } from "@vercel/functions";
import { connection } from "next/server";
import { getPublisher, hasRedis, streamChannel } from "@/lib/redis";
import { checkDeviceAuth, CAMERA_DEVICE_ID } from "@/lib/store";

// Low-latency live-frame ingest over plain HTTP POST. The ESP32's TLS WebSocket
// client can't reliably open a second TLS connection to Vercel (heap), but its
// HTTP keep-alive client can — so the camera POSTs each JPEG here and we publish
// it straight to Redis, which the browser's watch WebSocket fans out in
// near-real-time. No Blob/DB work on this path, so it's fast (just a publish).
export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!hasRedis()) return new Response("no relay", { status: 503 });
  const device =
    new URL(request.url).searchParams.get("device") || CAMERA_DEVICE_ID;
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length < 100) return new Response("bad frame", { status: 400 });
  await connection();
  // Publish in the background and return immediately, so the camera's per-frame
  // round-trip isn't waiting on Redis — that directly raises the live frame rate.
  waitUntil(getPublisher().publish(streamChannel(device), buf).catch(() => {}));
  return new Response("ok");
}
