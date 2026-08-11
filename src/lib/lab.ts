// SAVAGE LAB — multi-device data layer. Index/state/telemetry live in Neon
// (src/lib/db/schema.ts); JPEG bytes stay in Vercel Blob, referenced by path.
import { del, put } from "@vercel/blob";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  BLOB_ACCESS,
  CAMERA_DEVICE_ID,
  LIVE_PREFIX,
  MOTION_PREFIX,
  signedUrlFor,
} from "@/lib/store";

export { CAMERA_DEVICE_ID };
export const TIMELINE_PREFIX = "timeline/";
export const PINNED_PREFIX = "pinned/";

const HOUR_MS = 3_600_000;

export function retentionMs(): number {
  const h = Number(process.env.TIMELINE_RETENTION_HOURS ?? "24");
  return (Number.isFinite(h) && h > 0 ? h : 24) * HOUR_MS;
}

export function validDeviceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id);
}

export type Metrics = Record<string, number | string | boolean>;

// Downsample a time series to at most `cap` points (keeps the last one).
function decimate<T extends { at: number }>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

// ── frames index (bytes live in Blob) ──────────────────────────────────────
export type NewestFrame = {
  path: string;
  at: number;
  sd: boolean;
  rssi: number;
  kind: string;
};

export async function recordFrame(
  deviceId: string,
  kind: string,
  atMs: number,
  blobPath: string,
  extra?: { sd?: boolean; rssi?: number; w?: number; h?: number },
): Promise<void> {
  const db = getDb();
  await db.insert(schema.frames).values({
    deviceId,
    kind,
    at: new Date(atMs),
    blobPath,
    w: extra?.w ?? null,
    h: extra?.h ?? null,
    meta: { sd: !!extra?.sd, rssi: extra?.rssi ?? 0 },
  });
}

// Newest frame for the hero view + heartbeat (replaces the old blob pointer).
export async function readLatest(
  deviceId = CAMERA_DEVICE_ID,
): Promise<NewestFrame | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.frames)
    .where(eq(schema.frames.deviceId, deviceId))
    .orderBy(desc(schema.frames.at))
    .limit(1);
  if (!row) return null;
  const meta = (row.meta ?? {}) as { sd?: boolean; rssi?: number };
  return {
    path: row.blobPath,
    at: row.at.getTime(),
    sd: !!meta.sd,
    rssi: Number(meta.rssi ?? 0),
    kind: row.kind,
  };
}

// ── timeline (scrubbable snapshots) ─────────────────────────────────────────
export function timelinePath(deviceId: string, ms: number): string {
  return `${TIMELINE_PREFIX}${deviceId}/${String(ms).padStart(13, "0")}.jpg`;
}

export type TimelinePoint = { path: string; at: number };

// Every frame in [fromMs, toMs], oldest→newest, NOT decimated — the
// save-from-timeline exporter needs the true sequence. Hard-capped.
export async function listTimelineRange(
  deviceId: string,
  fromMs: number,
  toMs: number,
  cap = 300,
): Promise<TimelinePoint[]> {
  const db = getDb();
  const rows = await db
    .select({ path: schema.frames.blobPath, at: schema.frames.at })
    .from(schema.frames)
    .where(
      and(
        eq(schema.frames.deviceId, deviceId),
        eq(schema.frames.kind, "timeline"),
        gte(schema.frames.at, new Date(fromMs)),
        lt(schema.frames.at, new Date(toMs + 1)),
      ),
    )
    .orderBy(schema.frames.at)
    .limit(cap);
  return rows.map((r) => ({ path: r.path, at: r.at.getTime() }));
}

export async function listTimeline(
  deviceId: string,
  sinceMs: number,
  cap = 1600,
): Promise<TimelinePoint[]> {
  const db = getDb();
  const rows = await db
    .select({ path: schema.frames.blobPath, at: schema.frames.at })
    .from(schema.frames)
    .where(
      and(
        eq(schema.frames.deviceId, deviceId),
        eq(schema.frames.kind, "timeline"),
        gte(schema.frames.at, new Date(sinceMs)),
      ),
    )
    .orderBy(schema.frames.at);
  const pts = rows.map((r) => ({ path: r.path, at: r.at.getTime() }));
  return decimate(pts, cap);
}

// Delete frames rows (+ their blobs) of one kind older than a cutoff.
async function pruneFramesOlderThan(
  deviceId: string,
  kind: string,
  cutoffMs: number,
): Promise<number> {
  const db = getDb();
  const stale = await db
    .select({ id: schema.frames.id, blobPath: schema.frames.blobPath })
    .from(schema.frames)
    .where(
      and(
        eq(schema.frames.deviceId, deviceId),
        eq(schema.frames.kind, kind),
        lt(schema.frames.at, new Date(cutoffMs)),
      ),
    );
  if (!stale.length) return 0;
  // Chunked: a 24h window can accumulate tens of thousands of stale rows after
  // downtime or a retention change — one giant del()/inArray would choke.
  for (let i = 0; i < stale.length; i += 400) {
    const batch = stale.slice(i, i + 400);
    try {
      await del(batch.map((r) => r.blobPath));
    } catch {}
    await db.delete(schema.frames).where(
      inArray(
        schema.frames.id,
        batch.map((r) => r.id),
      ),
    );
  }
  return stale.length;
}

// The dense snapshot timeline is kept for TIMELINE_HOURS — default 24h, the
// full scrubbable window. Anything worth keeping longer gets saved out of the
// window as a clip (💾) or a pin, both permanent.
// (Telemetry keeps the retentionMs() window.)
const TIMELINE_HOURS = Number(process.env.TIMELINE_HOURS ?? "24");
export async function pruneTimeline(deviceId: string): Promise<number> {
  const hours =
    Number.isFinite(TIMELINE_HOURS) && TIMELINE_HOURS > 0 ? TIMELINE_HOURS : 24;
  return pruneFramesOlderThan(deviceId, "timeline", Date.now() - hours * HOUR_MS);
}

// ── telemetry ───────────────────────────────────────────────────────────────
export type TelemetryPoint = { at: number; metrics: Metrics };

export async function writeTelemetry(
  deviceId: string,
  metrics: Metrics,
): Promise<void> {
  const db = getDb();
  const at = new Date();
  await db.insert(schema.telemetry).values({ deviceId, at, metrics });
  await db
    .update(schema.devices)
    .set({ lastSeen: at })
    .where(eq(schema.devices.id, deviceId));
}

export async function listTelemetry(
  deviceId: string,
  sinceMs: number,
  cap = 800,
): Promise<TelemetryPoint[]> {
  const db = getDb();
  const rows = await db
    .select({ at: schema.telemetry.at, metrics: schema.telemetry.metrics })
    .from(schema.telemetry)
    .where(
      and(
        eq(schema.telemetry.deviceId, deviceId),
        gte(schema.telemetry.at, new Date(sinceMs)),
      ),
    )
    .orderBy(schema.telemetry.at);
  const pts = rows.map((r) => ({ at: r.at.getTime(), metrics: r.metrics }));
  return decimate(pts, cap);
}

export async function newestTelemetry(
  deviceId: string,
): Promise<TelemetryPoint | null> {
  const db = getDb();
  const [row] = await db
    .select({ at: schema.telemetry.at, metrics: schema.telemetry.metrics })
    .from(schema.telemetry)
    .where(eq(schema.telemetry.deviceId, deviceId))
    .orderBy(desc(schema.telemetry.at))
    .limit(1);
  return row ? { at: row.at.getTime(), metrics: row.metrics } : null;
}

export async function pruneTelemetry(deviceId: string): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionMs());
  const stale = await db
    .select({ id: schema.telemetry.id })
    .from(schema.telemetry)
    .where(
      and(
        eq(schema.telemetry.deviceId, deviceId),
        lt(schema.telemetry.at, cutoff),
      ),
    );
  if (!stale.length) return 0;
  await db.delete(schema.telemetry).where(
    inArray(
      schema.telemetry.id,
      stale.map((r) => r.id),
    ),
  );
  return stale.length;
}

// ── device registry ─────────────────────────────────────────────────────────
export type DeviceMeta = {
  name: string;
  type: string;
  caps: string[];
  firmware?: string;
};

export async function registerDevice(
  deviceId: string,
  meta: DeviceMeta,
): Promise<void> {
  const db = getDb();
  const set = {
    name: meta.name,
    type: meta.type,
    caps: meta.caps,
    firmware: meta.firmware ?? null,
  };
  await db
    .insert(schema.devices)
    .values({ id: deviceId, ...set })
    .onConflictDoUpdate({ target: schema.devices.id, set });
}

export type Device = {
  id: string;
  meta: DeviceMeta;
  lastSeen: number | null;
  latest: Metrics | null;
};

export async function listDevices(): Promise<Device[]> {
  const db = getDb();
  const rows = await db.select().from(schema.devices);
  const out: Device[] = [];
  for (const r of rows) {
    const last = await newestTelemetry(r.id);
    out.push({
      id: r.id,
      meta: {
        name: r.name,
        type: r.type,
        caps: (r.caps ?? []) as string[],
        firmware: r.firmware ?? undefined,
      },
      lastSeen: last?.at ?? (r.lastSeen ? r.lastSeen.getTime() : null),
      latest: last?.metrics ?? null,
    });
  }
  out.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return out;
}

// ── permanent pins (never pruned) ───────────────────────────────────────────
export type PinInfo = { src: string; label: string; kind: string };
export type Pin = { path: string; at: number } & PinInfo;

export async function pinFrame(
  src: string,
  label: string,
  kind: string,
): Promise<Pin> {
  const url = await signedUrlFor(src);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("source read failed");
  const buf = Buffer.from(await res.arrayBuffer());
  const at = Date.now();
  const info: PinInfo = { src, label, kind };
  const path = `${PINNED_PREFIX}${String(at).padStart(13, "0")}_${Buffer.from(
    JSON.stringify({ label, kind }),
  ).toString("base64url")}.jpg`;
  await put(path, buf, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/jpeg",
  });
  const db = getDb();
  await db.insert(schema.pins).values({
    deviceId: CAMERA_DEVICE_ID,
    blobPath: path,
    label,
    kind,
    at: new Date(at),
  });
  return { path, at, ...info };
}

export async function listPins(cap = 200): Promise<Pin[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pins)
    .orderBy(desc(schema.pins.at))
    .limit(cap);
  return rows.map((r) => ({
    path: r.blobPath,
    at: r.at.getTime(),
    src: "",
    label: r.label,
    kind: r.kind,
  }));
}

export async function deletePin(path: string): Promise<boolean> {
  if (!path.startsWith(PINNED_PREFIX)) return false;
  try {
    await del(path);
  } catch {}
  const db = getDb();
  await db.delete(schema.pins).where(eq(schema.pins.blobPath, path));
  return true;
}

// Path allow-list for the signed-frame proxy.
export function isViewablePath(path: string): boolean {
  const ok =
    path.startsWith(LIVE_PREFIX) ||
    path.startsWith(TIMELINE_PREFIX) ||
    path.startsWith(PINNED_PREFIX) ||
    path.startsWith(MOTION_PREFIX);
  return (
    ok &&
    path.length < 240 &&
    /^[A-Za-z0-9/._-]+$/.test(path) &&
    !path.includes("..")
  );
}

// ── retention sweep (cron + opportunistic) ──────────────────────────────────
export async function pruneAll(): Promise<Record<string, number>> {
  const ids = new Set<string>([CAMERA_DEVICE_ID]);
  for (const d of await listDevices()) ids.add(d.id);
  const result: Record<string, number> = {};
  for (const id of ids) {
    result[`timeline:${id}`] = await pruneTimeline(id);
    result[`telemetry:${id}`] = await pruneTelemetry(id);
  }
  return result;
}
