import Redis, { type RedisOptions } from "ioredis";

// Redis pub/sub bridges the WebSocket ingest function (camera side) to the watch
// functions (viewer side). Vercel pins each WS connection to a Function
// instance, so a shared bus is required to fan frames across instances.
export function streamChannel(deviceId: string): string {
  return `stream:${deviceId}`;
}

export function hasRedis(): boolean {
  return !!process.env.REDIS_URL;
}

function options(): RedisOptions {
  // Long-lived WS handlers: don't cap retries, keep the socket alive.
  return { maxRetriesPerRequest: null, enableReadyCheck: true };
}

// Publisher is safe to share across invocations on the same instance.
let pub: Redis | null = null;
export function getPublisher(): Redis {
  if (!pub) pub = new Redis(process.env.REDIS_URL as string, options());
  return pub;
}

// Each subscriber needs its own connection; caller disconnects on WS close.
export function createSubscriber(): Redis {
  return new Redis(process.env.REDIS_URL as string, options());
}
