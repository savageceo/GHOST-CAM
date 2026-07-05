import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "room_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getConfig() {
  const password = process.env.STORAGE_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!password || !secret || !blobToken) return null;
  return { password, secret, blobToken };
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createSessionToken(secret: string): string {
  const payload = `v1.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${hmac(secret, payload).toString("base64url")}`;
}

export function verifySessionToken(
  secret: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = hmac(secret, `v1.${parts[1]}`);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Hash both sides to fixed length so timingSafeEqual accepts unequal-length inputs.
export function checkPassword(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

export async function hasValidSession(): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;
  const store = await cookies();
  return verifySessionToken(config.secret, store.get(SESSION_COOKIE)?.value);
}

// Best-effort brute-force damper. State is per serverless instance, which is
// fine for a personal camera: the constant-time compare is the real defense.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
}
