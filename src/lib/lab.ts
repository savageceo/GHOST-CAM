// SAVAGE LAB — multi-device blob helpers layered on the room-watch store.
// Design mirrors store.ts: state + telemetry ride in blob PATHNAMES so list()
// reads come straight from the API (no CDN cache) and can never serve stale.
import { del, list, put } from "@vercel/blob";
import {
  BLOB_ACCESS,
  LIVE_PREFIX,
  MOTION_PREFIX,
  signedUrlFor,
} from "@/lib/store";

export const TIMELINE_PREFIX = "timeline/";
export const TELEMETRY_PREFIX = "telemetry/";
export const DEVICE_PREFIX = "devices/";
export const PINNED_PREFIX = "pinned/";
const LATEST_PREFIX = "state/latest-";

export const CAMERA_DEVICE_ID = "roomcam";
const HOUR_MS = 3_600_000;

export function retentionMs(): number {
  const h = Number(process.env.TIMELINE_RETENTION_HOURS ?? "24");
  return (Number.isFinite(h) && h > 0 ? h : 24) * HOUR_MS;
}

export function validDeviceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id);
}

// ── tiny helpers ───────────────────────────────────────────────────────────
export type Metrics = Record<string, number | string | boolean>;

function enc(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function dec<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString()) as T;
  } catch {
    return null;
  }
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function decimate<T extends { at: number }>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

type Listed = { pathname: string; at: number };
async function listAll(prefix: string, cap = 6000): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: 1000, cursor });
    for (const b of page.blobs) {
      out.push({ pathname: b.pathname, at: new Date(b.uploadedAt).getTime() });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && out.length < cap);
  return out;
}

async function delMany(paths: string[]): Promise<number> {
  for (const c of chunk(paths, 100)) {
    try {
      await del(c);
    } catch {}
  }
  return paths.length;
}

async function putState(path: string): Promise<void> {
  await put(path, "1", {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

// ── latest-frame pointer (keeps status polls O(1)-cheap) ────────────────────
export type NewestFrame = {
  path: string;
  at: number;
  sd: boolean;
  rssi: number;
  kind: string;
};

export async function writeLatest(meta: NewestFrame): Promise<void> {
  const path = `${LATEST_PREFIX}${enc(meta)}.json`;
  await putState(path);
  const page = await list({ prefix: LATEST_PREFIX, limit: 20 });
  const stale = page.blobs.map((b) => b.pathname).filter((p) => p !== path);
  if (stale.length) await del(stale);
}

export async function readLatest(): Promise<NewestFrame | null> {
  const page = await list({ prefix: LATEST_PREFIX, limit: 20 });
  let newest: NewestFrame | null = null;
  for (const b of page.blobs) {
    const raw = b.pathname.slice(LATEST_PREFIX.length).replace(/\.json$/, "");
    const meta = dec<NewestFrame>(raw);
    if (!meta) continue;
    if (!newest || meta.at > newest.at) newest = meta;
  }
  return newest;
}

// ── timeline (rolling snapshots you can scrub) ──────────────────────────────
export function timelinePath(deviceId: string, ms: number): string {
  return `${TIMELINE_PREFIX}${deviceId}/${String(ms).padStart(13, "0")}.jpg`;
}

export type TimelinePoint = { path: string; at: number };

export async function listTimeline(
  deviceId: string,
  sinceMs: number,
  cap = 1600,
): Promise<TimelinePoint[]> {
  const prefix = `${TIMELINE_PREFIX}${deviceId}/`;
  const pts: TimelinePoint[] = [];
  for (const b of await listAll(prefix)) {
    const m = b.pathname.slice(prefix.length).match(/^(\d+)\.jpg$/);
    const at = m ? Number(m[1]) : b.at;
    if (at >= sinceMs) pts.push({ path: b.pathname, at });
  }
  pts.sort((a, b) => a.at - b.at);
  return decimate(pts, cap);
}

export async function pruneTimeline(deviceId: string): Promise<number> {
  const cutoff = Date.now() - retentionMs();
  const prefix = `${TIMELINE_PREFIX}${deviceId}/`;
  const stale: string[] = [];
  for (const b of await listAll(prefix)) {
    const m = b.pathname.slice(prefix.length).match(/^(\d+)\.jpg$/);
    const at = m ? Number(m[1]) : b.at;
    if (at < cutoff) stale.push(b.pathname);
  }
  return delMany(stale);
}

// ── telemetry (metrics ride in the filename — cache-proof, read-cheap) ──────
export function telemetryPath(
  deviceId: string,
  ms: number,
  metrics: Metrics,
): string {
  return `${TELEMETRY_PREFIX}${deviceId}/${String(ms).padStart(13, "0")}_${enc(metrics)}.json`;
}

export type TelemetryPoint = { at: number; metrics: Metrics };

export async function writeTelemetry(
  deviceId: string,
  metrics: Metrics,
): Promise<void> {
  await putState(telemetryPath(deviceId, Date.now(), metrics));
}

export async function listTelemetry(
  deviceId: string,
  sinceMs: number,
  cap = 800,
): Promise<TelemetryPoint[]> {
  const prefix = `${TELEMETRY_PREFIX}${deviceId}/`;
  const pts: TelemetryPoint[] = [];
  for (const b of await listAll(prefix)) {
    const m = b.pathname.slice(prefix.length).match(/^(\d+)_(.+)\.json$/);
    if (!m) continue;
    const at = Number(m[1]);
    if (at < sinceMs) continue;
    const metrics = dec<Metrics>(m[2]);
    if (metrics) pts.push({ at, metrics });
  }
  pts.sort((a, b) => a.at - b.at);
  return decimate(pts, cap);
}

export async function newestTelemetry(
  deviceId: string,
): Promise<TelemetryPoint | null> {
  const prefix = `${TELEMETRY_PREFIX}${deviceId}/`;
  let best: TelemetryPoint | null = null;
  for (const b of await listAll(prefix)) {
    const m = b.pathname.slice(prefix.length).match(/^(\d+)_(.+)\.json$/);
    if (!m) continue;
    const at = Number(m[1]);
    if (best && at <= best.at) continue;
    const metrics = dec<Metrics>(m[2]);
    if (metrics) best = { at, metrics };
  }
  return best;
}

export async function pruneTelemetry(deviceId: string): Promise<number> {
  const cutoff = Date.now() - retentionMs();
  const prefix = `${TELEMETRY_PREFIX}${deviceId}/`;
  const stale: string[] = [];
  for (const b of await listAll(prefix)) {
    const m = b.pathname.slice(prefix.length).match(/^(\d+)_/);
    const at = m ? Number(m[1]) : b.at;
    if (at < cutoff) stale.push(b.pathname);
  }
  return delMany(stale);
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
  const path = `${DEVICE_PREFIX}${deviceId}__${enc(meta)}.json`;
  await putState(path);
  const page = await list({
    prefix: `${DEVICE_PREFIX}${deviceId}__`,
    limit: 20,
  });
  const stale = page.blobs.map((b) => b.pathname).filter((p) => p !== path);
  if (stale.length) await del(stale);
}

export type Device = {
  id: string;
  meta: DeviceMeta;
  lastSeen: number | null;
  latest: Metrics | null;
};

export async function listDevices(): Promise<Device[]> {
  const devices: Device[] = [];
  for (const b of await listAll(DEVICE_PREFIX)) {
    const rest = b.pathname.slice(DEVICE_PREFIX.length);
    const m = rest.match(/^([A-Za-z0-9_-]+)__(.+)\.json$/);
    if (!m) continue;
    const meta = dec<DeviceMeta>(m[2]);
    if (!meta) continue;
    devices.push({ id: m[1], meta, lastSeen: null, latest: null });
  }
  await Promise.all(
    devices.map(async (d) => {
      const last = await newestTelemetry(d.id);
      if (last) {
        d.lastSeen = last.at;
        d.latest = last.metrics;
      }
    }),
  );
  devices.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return devices;
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
  const path = `${PINNED_PREFIX}${String(at).padStart(13, "0")}_${enc(info)}.jpg`;
  await put(path, buf, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/jpeg",
  });
  return { path, at, ...info };
}

export async function listPins(cap = 200): Promise<Pin[]> {
  const pins: Pin[] = [];
  for (const b of await listAll(PINNED_PREFIX)) {
    const m = b.pathname.slice(PINNED_PREFIX.length).match(/^(\d+)_(.+)\.jpg$/);
    if (!m) continue;
    const info = dec<PinInfo>(m[2]);
    pins.push({
      path: b.pathname,
      at: Number(m[1]),
      src: info?.src ?? "",
      label: info?.label ?? "pinned",
      kind: info?.kind ?? "frame",
    });
  }
  pins.sort((a, b) => b.at - a.at);
  return pins.slice(0, cap);
}

export async function deletePin(path: string): Promise<boolean> {
  if (!path.startsWith(PINNED_PREFIX)) return false;
  await del(path);
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
