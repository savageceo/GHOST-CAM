import {
  del,
  type IssuedSignedToken,
  issueSignedToken,
  list,
  presignUrl,
  put,
} from "@vercel/blob";
import { checkPassword } from "@/lib/auth";

export const BLOB_ACCESS = "private" as const;
export const LIVE_PREFIX = "live/";
export const MOTION_PREFIX = "motion/";
const FLAGS_PREFIX = "state/flags-";

// ── device auth ──────────────────────────────────────────────────────────
// Shared-secret gate for the camera. Rotate by changing the DEVICE_TOKEN env
// var and reflashing the camera's config.h.
export function checkDeviceAuth(request: Request): boolean {
  const expected = process.env.DEVICE_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  return given.length > 0 && checkPassword(expected, given);
}

// ── control flags ────────────────────────────────────────────────────────
// The flags live IN a blob pathname, not in blob content: list() reads come
// straight from the API (no CDN cache), so a "go live" press reaches the
// camera on its next poll instead of after a cached-content TTL.

export type Flags = { arm: boolean; liveUntil: number; testAt: number };
export const DEFAULT_FLAGS: Flags = { arm: true, liveUntil: 0, testAt: 0 };

function flagsToPath(f: Flags): string {
  return `${FLAGS_PREFIX}a${f.arm ? 1 : 0}-l${f.liveUntil}-t${f.testAt}.json`;
}

function parseFlagsPath(pathname: string): Flags | null {
  const m = pathname.match(/a([01])-l(\d+)-t(\d+)\.json$/);
  if (!m) return null;
  return { arm: m[1] === "1", liveUntil: Number(m[2]), testAt: Number(m[3]) };
}

export async function readFlags(): Promise<Flags> {
  const page = await list({ prefix: FLAGS_PREFIX, limit: 20 });
  let newest: { at: number; flags: Flags } | null = null;
  for (const blob of page.blobs) {
    const flags = parseFlagsPath(blob.pathname);
    if (!flags) continue;
    const at = new Date(blob.uploadedAt).getTime();
    if (!newest || at > newest.at) newest = { at, flags };
  }
  return newest ? newest.flags : { ...DEFAULT_FLAGS };
}

export async function writeFlags(next: Flags): Promise<Flags> {
  const path = flagsToPath(next);
  await put(path, "1", {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  // Sweep older flag files; last-writer-wins races settle on the next write.
  const page = await list({ prefix: FLAGS_PREFIX, limit: 20 });
  const stale = page.blobs
    .map((b) => b.pathname)
    .filter((p) => p !== path);
  if (stale.length > 0) await del(stale);
  return next;
}

// ── frames ───────────────────────────────────────────────────────────────

export type NewestFrame = {
  path: string;
  at: number;
  sd: boolean;
  rssi: number;
};

// live/<ms>_sd<0|1>_r<abs rssi>.jpg — telemetry rides in the filename.
export function liveFramePath(sd: boolean, rssi: number): string {
  const ms = String(Date.now()).padStart(13, "0");
  return `${LIVE_PREFIX}${ms}_sd${sd ? 1 : 0}_r${Math.min(99, Math.abs(rssi))}.jpg`;
}

export async function newestLiveFrame(): Promise<NewestFrame | null> {
  const page = await list({ prefix: LIVE_PREFIX, limit: 1000 });
  let newest: NewestFrame | null = null;
  for (const blob of page.blobs) {
    const at = new Date(blob.uploadedAt).getTime();
    if (newest && at <= newest.at) continue;
    const m = blob.pathname.match(/_sd([01])_r(\d+)\.jpg$/);
    newest = {
      path: blob.pathname,
      at,
      sd: m ? m[1] === "1" : false,
      rssi: m ? -Number(m[2]) : 0,
    };
  }
  return newest;
}

export async function pruneLiveFrames(keep: number): Promise<void> {
  const page = await list({ prefix: LIVE_PREFIX, limit: 1000 });
  const sorted = page.blobs
    .map((b) => b.pathname)
    .sort((a, b) => b.localeCompare(a));
  const stale = sorted.slice(keep);
  if (stale.length > 0) await del(stale);
}

// ── signed CDN reads ─────────────────────────────────────────────────────
// One wildcard read token, presignUrl() is pure local HMAC. Frame paths are
// unique per capture, so CDN caching of a signed URL can never serve stale.

const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
let readToken: IssuedSignedToken | null = null;

async function getReadToken(): Promise<IssuedSignedToken> {
  if (readToken && readToken.validUntil - Date.now() > 5 * 60 * 1000) {
    return readToken;
  }
  readToken = await issueSignedToken({
    pathname: "*",
    operations: ["get"],
    validUntil: Date.now() + SIGNED_URL_TTL_MS,
  });
  return readToken;
}

export async function signedUrlFor(pathname: string): Promise<string> {
  const token = await getReadToken();
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: BLOB_ACCESS,
  });
  return presignedUrl;
}

// ── motion events ────────────────────────────────────────────────────────

export type MotionEvent = { id: string; at: number; frames: string[] };

export async function listMotionEvents(cap: number): Promise<MotionEvent[]> {
  const groups = new Map<string, MotionEvent>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: MOTION_PREFIX, limit: 1000, cursor });
    for (const blob of page.blobs) {
      const rest = blob.pathname.slice(MOTION_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash <= 0) continue;
      const id = rest.slice(0, slash);
      const at = new Date(blob.uploadedAt).getTime();
      const group = groups.get(id);
      if (group) {
        group.frames.push(blob.pathname);
        if (at < group.at) group.at = at;
      } else {
        groups.set(id, { id, at, frames: [blob.pathname] });
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const events = [...groups.values()];
  for (const event of events) event.frames.sort();
  events.sort((a, b) => b.at - a.at);
  return events.slice(0, cap);
}

export async function deleteMotionEvent(id: string): Promise<number> {
  const page = await list({ prefix: `${MOTION_PREFIX}${id}/`, limit: 1000 });
  const paths = page.blobs.map((b) => b.pathname);
  if (paths.length > 0) await del(paths);
  return paths.length;
}
