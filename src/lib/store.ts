import {
  del,
  type IssuedSignedToken,
  issueSignedToken,
  presignUrl,
  put,
} from "@vercel/blob";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { checkPassword } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";

// JPEG/PNG bytes live in Vercel Blob; the index + state live in Neon (see
// src/lib/db/schema.ts). Frame/pin rows point at their bytes via `blobPath`.
export const BLOB_ACCESS = "private" as const;
export const LIVE_PREFIX = "live/";
export const MOTION_PREFIX = "motion/";

// Device #1 in the grid. Defined here so lab.ts can re-export without a cycle.
export const CAMERA_DEVICE_ID = "roomcam";

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

// ── control flags (device_state row) ───────────────────────────────────────
// arm/live/test are the camera's fast-path flags; `orient` (0|180) is the
// server side of the cloud "Rotate" control. Default 0 = no sensor flip,
// matching the firmware's compiled default (CAM_VFLIP/CAM_HMIRROR).
// `tlSec` is the dashboard-set timeline cadence: 0 = firmware default
// (TIMELINE_SECONDS in config.h), 1-10 = seconds between snapshots.
// `bts` = 🎬 shoot mode (alerts suppressed, timeline = content);
// `captureAt` = on-demand capture-burst edge trigger (like testAt, silent).
export type Flags = {
  arm: boolean;
  liveUntil: number;
  testAt: number;
  orient: number;
  tlSec: number;
  bts: boolean;
  captureAt: number;
};
export const DEFAULT_FLAGS: Flags = {
  arm: true,
  liveUntil: 0,
  testAt: 0,
  orient: 0,
  tlSec: 0,
  bts: false,
  captureAt: 0,
};

export async function readFlags(
  deviceId = CAMERA_DEVICE_ID,
): Promise<Flags> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.deviceState)
    .where(eq(schema.deviceState.deviceId, deviceId))
    .limit(1);
  if (!row) return { ...DEFAULT_FLAGS };
  return {
    arm: row.arm,
    liveUntil: Number(row.liveUntil),
    testAt: Number(row.testAt),
    orient: row.orient,
    tlSec: row.tlSec,
    bts: row.bts,
    captureAt: Number(row.captureAt),
  };
}

export async function writeFlags(
  next: Flags,
  deviceId = CAMERA_DEVICE_ID,
): Promise<Flags> {
  const db = getDb();
  const set = {
    arm: next.arm,
    liveUntil: next.liveUntil,
    testAt: next.testAt,
    orient: next.orient,
    tlSec: next.tlSec,
    bts: next.bts,
    captureAt: next.captureAt,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.deviceState)
    .values({ deviceId, ...set })
    .onConflictDoUpdate({ target: schema.deviceState.deviceId, set });
  return next;
}

// Shared shape of the device-facing flag echo (poll/frame/telemetry/register
// responses). `tl` is the timeline cadence override the camera should adopt.
export function deviceFlagView(flags: Flags) {
  return {
    arm: flags.arm,
    live: flags.liveUntil > Date.now(),
    testAt: flags.testAt,
    orient: flags.orient,
    tl: flags.tlSec,
    bts: flags.bts,
    captureAt: flags.captureAt,
  };
}

// ── frame paths (bytes live in Blob) ───────────────────────────────────────
// live/<ms>_sd<0|1>_r<abs rssi>.jpg
export function liveFramePath(sd: boolean, rssi: number): string {
  const ms = String(Date.now()).padStart(13, "0");
  return `${LIVE_PREFIX}${ms}_sd${sd ? 1 : 0}_r${Math.min(99, Math.abs(rssi))}.jpg`;
}

// Keep only the newest `keep` live frames (rows + their blobs).
export async function pruneLiveFrames(keep: number): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.frames.id, blobPath: schema.frames.blobPath })
    .from(schema.frames)
    .where(eq(schema.frames.kind, "live"))
    .orderBy(desc(schema.frames.at));
  const stale = rows.slice(keep);
  if (!stale.length) return;
  try {
    await del(stale.map((r) => r.blobPath));
  } catch {}
  await db.delete(schema.frames).where(
    inArray(
      schema.frames.id,
      stale.map((r) => r.id),
    ),
  );
}

// ── signed CDN reads ───────────────────────────────────────────────────────
// One wildcard read token; presignUrl() is pure local HMAC. Frame paths are
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

// ── events (motion_events table + Blob bytes) ───────────────────────────────
// One table for every event kind: camera bursts (motion/sound — frames), clips
// saved from the timeline (clip — frames), and sensor pings (trip/door/panic/…
// — no frames, just a kind + label).
export type MotionEvent = {
  id: string;
  at: number;
  kind: string;
  label: string | null;
  device: string;
  frames: string[];
};

export function validEventKind(kind: string): boolean {
  return /^[a-z][a-z0-9_-]{0,15}$/.test(kind);
}

// Each burst frame POSTs separately; upsert appends its blob path to the event.
export async function recordMotionFrame(
  eventId: string,
  deviceId: string,
  atMs: number,
  blobPath: string,
  seq: number,
  kind = "motion",
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.motionEvents)
    .values({
      id: eventId,
      deviceId,
      at: new Date(atMs),
      kind,
      framePaths: [blobPath],
    })
    .onConflictDoUpdate({
      target: schema.motionEvents.id,
      set: {
        framePaths: sql`${schema.motionEvents.framePaths} || ${JSON.stringify([blobPath])}::jsonb`,
        at:
          seq === 0
            ? new Date(atMs)
            : sql`${schema.motionEvents.at}`,
      },
    });
}

// A frameless event from any lab node (laser trip, reed contact, panic button…)
// — or a pre-built frame list (the save-from-timeline clip exporter).
export async function recordEvent(
  eventId: string,
  deviceId: string,
  atMs: number,
  kind: string,
  label?: string,
  framePaths: string[] = [],
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.motionEvents)
    .values({
      id: eventId,
      deviceId,
      at: new Date(atMs),
      kind,
      label: label ?? null,
      framePaths,
      disposition: "alerted",
    })
    .onConflictDoNothing();
}

export async function listMotionEvents(cap: number): Promise<MotionEvent[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.motionEvents)
    .orderBy(desc(schema.motionEvents.at))
    .limit(cap);
  return rows.map((r) => ({
    id: r.id,
    at: r.at.getTime(),
    kind: r.kind ?? "motion",
    label: r.label ?? null,
    device: r.deviceId,
    frames: [...(r.framePaths ?? [])].sort(),
  }));
}

export async function deleteMotionEvent(id: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ framePaths: schema.motionEvents.framePaths })
    .from(schema.motionEvents)
    .where(eq(schema.motionEvents.id, id))
    .limit(1);
  const paths = row?.framePaths ?? [];
  if (paths.length) {
    try {
      await del(paths);
    } catch {}
  }
  await db.delete(schema.motionEvents).where(eq(schema.motionEvents.id, id));
  return paths.length;
}
