"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Newest = {
  path: string;
  at: number;
  sd: boolean;
  rssi: number;
  kind: string;
} | null;
type Status = {
  arm: boolean;
  liveUntil: number;
  tlSec?: number;
  bts?: boolean;
  now: number;
  newest: Newest;
};
type Light = {
  device: string;
  sku: string;
  name: string;
  controllable: boolean;
};
type MotionEvent = {
  id: string;
  at: number;
  kind?: string;
  label?: string | null;
  device?: string;
  frames: string[];
};
type TimelinePoint = { path: string; at: number };
type Metrics = Record<string, number | string | boolean>;
type TelemetryPoint = { at: number; metrics: Metrics };
type DeviceMeta = {
  name: string;
  type: string;
  caps: string[];
  firmware?: string;
};
type Device = {
  id: string;
  meta: DeviceMeta;
  lastSeen: number | null;
  latest: Metrics | null;
};
type Pin = { path: string; at: number; src: string; label: string; kind: string };

const LIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 8000;
const OFFLINE_AFTER_MS = 6.5 * 60 * 1000;
const DEVICE_ONLINE_MS = 3 * 60 * 1000;
const CAMERA_ID = "roomcam";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// VAPID keys are URL-safe base64; PushManager wants the raw bytes.
function urlB64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

type NotifState =
  | "idle" // supported, not yet enabled
  | "on" // subscribed
  | "blocked" // permission denied
  | "unsupported" // no push support / no key
  | "need-install" // iOS: must Add to Home Screen first
  | "busy";

const METRIC_INFO: Record<
  string,
  { label: string; unit: string; color: string }
> = {
  tempC: { label: "Chip temp", unit: "°C", color: "#fb7185" },
  rssi: { label: "WiFi signal", unit: "dBm", color: "#38bdf8" },
  heapKB: { label: "Free memory", unit: "KB", color: "#a78bfa" },
  uptimeMin: { label: "Uptime", unit: "m", color: "#34d399" },
  rfDbm: { label: "RF floor", unit: "dBm", color: "#f59e0b" },
  battPct: { label: "Battery", unit: "%", color: "#4ade80" },
  humidity: { label: "Humidity", unit: "%", color: "#22d3ee" },
  lux: { label: "Light", unit: "lx", color: "#facc15" },
  motion: { label: "Motion", unit: "", color: "#f472b6" },
  soundDb: { label: "Sound level", unit: "dB", color: "#fb923c" },
  soundPk: { label: "Sound peak", unit: "dB", color: "#f97316" },
};

// Event-kind chrome: icon + accent for each event source. Unknown kinds get
// the generic ping look.
const EVENT_KIND_INFO: Record<string, { icon: string; label: string }> = {
  motion: { icon: "🚨", label: "motion" },
  sound: { icon: "🔊", label: "loud noise" },
  clip: { icon: "💾", label: "saved clip" },
  bts: { icon: "🎬", label: "BTS capture" },
  trip: { icon: "⚡", label: "tripwire" },
  door: { icon: "🚪", label: "door" },
  panic: { icon: "🆘", label: "panic" },
  presence: { icon: "👤", label: "presence" },
};
const TL_WINDOWS = [1, 3, 6, 24] as const; // scrubber window (hours)
const TL_CADENCES = [0, 1, 2, 5, 10] as const; // 0 = firmware default

// Studio light presets — SAVAGE palette for shoots + a plain white.
const LIGHT_PRESETS: { name: string; hex: string; r: number; g: number; b: number }[] = [
  { name: "Savage red", hex: "#ff0033", r: 255, g: 0, b: 51 },
  { name: "Purple", hex: "#7c3aed", r: 124, g: 58, b: 237 },
  { name: "Cyan", hex: "#22d3ee", r: 34, g: 211, b: 238 },
  { name: "Orange", hex: "#f97316", r: 249, g: 115, b: 22 },
  { name: "Pink", hex: "#f472b6", r: 244, g: 114, b: 182 },
  { name: "White", hex: "#ffffff", r: 255, g: 255, b: 255 },
];

function frameUrl(path: string, v: number | string): string {
  return `/api/view/frame?path=${encodeURIComponent(path)}&v=${v}`;
}
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function metricLabel(key: string): string {
  return METRIC_INFO[key]?.label ?? key;
}
function fmtMetric(key: string, val: number | string | boolean): string {
  const info = METRIC_INFO[key];
  if (typeof val === "boolean") return val ? "yes" : "no";
  if (typeof val === "number") return `${trim(val)}${info?.unit ?? ""}`;
  return String(val);
}
function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
function eventLabel(id: string, atMs?: number): string {
  const m = id.match(/^e(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  const at = m
    ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    : atMs; // server-stamped events (clips, sensor pings) carry their own time
  if (!at) return "before clock sync";
  return new Date(at).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── SVG line chart ──────────────────────────────────────────────────────────
function LineChart({
  label,
  unit,
  color,
  series,
}: {
  label: string;
  unit: string;
  color: string;
  series: { at: number; v: number }[];
}) {
  const w = 320;
  const h = 90;
  const pad = 5;
  const min = Math.min(...series.map((p) => p.v));
  const max = Math.max(...series.map((p) => p.v));
  const span = max - min || 1;
  const t0 = series[0].at;
  const t1 = series[series.length - 1].at;
  const tspan = t1 - t0 || 1;
  const x = (t: number) => pad + ((t - t0) / tspan) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const line = series
    .map((p) => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const area = `${x(t0).toFixed(1)},${h - pad} ${line} ${x(t1).toFixed(1)},${h - pad}`;
  const last = series[series.length - 1].v;
  return (
    <div className="chart">
      <div className="chart-top">
        <span className="chart-label">{label}</span>
        <span className="chart-last" style={{ color }}>
          {trim(last)}
          {unit}
        </span>
      </div>
      <div className="chart-body">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="chart-svg"
        >
          <polygon points={area} fill={color} opacity="0.13" />
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="chart-scale">
          <span>
            {trim(max)}
            {unit}
          </span>
          <span>
            {trim(min)}
            {unit}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── device card ─────────────────────────────────────────────────────────────
function DeviceCard({
  device,
  now,
  selected,
  onSelect,
}: {
  device: Device;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const online =
    device.lastSeen !== null && now - device.lastSeen < DEVICE_ONLINE_MS;
  const chips = device.latest
    ? Object.entries(device.latest).slice(0, 4)
    : [];
  return (
    <button
      type="button"
      className={`devcard ${selected ? "sel" : ""}`}
      onClick={onSelect}
    >
      <div className="devcard-head">
        <span className={`dot ${online ? "ok" : "bad"}`} />
        <span className="devname">{device.meta.name}</span>
      </div>
      <div className="devtype">{device.meta.type}</div>
      <div className="devchips">
        {chips.length === 0 && <span className="devchip dim">no telemetry</span>}
        {chips.map(([k, v]) => (
          <span className="devchip" key={k}>
            <em>{metricLabel(k)}</em> {fmtMetric(k, v)}
          </span>
        ))}
      </div>
      <div className="devfoot">
        {device.lastSeen ? agoText(now - device.lastSeen) : "never seen"}
      </div>
    </button>
  );
}

// ── motion clip player ────────────────────────────────────────────────────
// Plays a motion event's frames as a short clip. Preloads them so playback is
// smooth, with a scrubber and a jump-to-fullscreen link.
function ClipPlayer({
  frames,
  transform,
}: {
  frames: string[];
  transform?: string;
}) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(frames.length <= 1);

  useEffect(() => {
    let alive = true;
    let loaded = 0;
    for (const p of frames) {
      const img = new Image();
      img.onload = img.onerror = () => {
        loaded += 1;
        if (alive && loaded >= frames.length) setReady(true);
      };
      img.src = frameUrl(p, "clip");
    }
    return () => {
      alive = false;
    };
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => {
      setIdx((i) => {
        const next = i + 1;
        if (next >= frames.length) {
          setPlaying(false);
          return frames.length - 1;
        }
        return next;
      });
    }, 130); // ~7.5 fps playback
    return () => clearInterval(id);
  }, [playing, frames.length]);

  const safe = Math.min(idx, frames.length - 1);
  const cur = frames[safe];
  return (
    <div className="clip">
      <div className="clip-stage">
        <img
          src={frameUrl(cur, "clip")}
          alt="motion clip frame"
          style={transform ? { transform } : undefined}
        />
        <button
          type="button"
          className="clip-play"
          onClick={() => {
            if (safe >= frames.length - 1) setIdx(0);
            setPlaying((p) => !p);
          }}
          disabled={frames.length < 2}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="clip-count">
          {safe + 1}/{frames.length}
          {ready ? "" : " · loading"}
        </span>
        <a
          className="clip-full"
          href={frameUrl(cur, "full")}
          target="_blank"
          rel="noreferrer"
          title="Open frame"
        >
          ⤢
        </a>
      </div>
      <input
        type="range"
        className="clip-scrub"
        min={0}
        max={Math.max(1, frames.length - 1)}
        value={safe}
        onChange={(e) => {
          setPlaying(false);
          setIdx(Number(e.target.value));
        }}
      />
    </div>
  );
}

export default function Viewer() {
  const [status, setStatus] = useState<Status | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [events, setEvents] = useState<MotionEvent[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [selDevice, setSelDevice] = useState<string>(CAMERA_ID);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [reviewSrc, setReviewSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tlWin, setTlWin] = useState<number>(1); // scrubber window (hours)
  const [tlSec, setTlSec] = useState<number>(0); // cadence knob (0 = firmware)
  const [clipIn, setClipIn] = useState<number | null>(null); // save-range in (ms)
  const [clipOut, setClipOut] = useState<number | null>(null); // save-range out (ms)
  const [bts, setBts] = useState(false); // 🎬 shoot mode
  const [captureSent, setCaptureSent] = useState(false);
  const [lights, setLights] = useState<Light[] | null>(null); // null = not loaded
  const [lightsOn, setLightsOn] = useState(true); // govee configured?
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState("");
  const [testSent, setTestSent] = useState(false);
  const [orient, setOrient] = useState(0); // display rotation (deg): instant, pre-reflash fix
  const [wantLive, setWantLive] = useState(false); // WebSocket live stream requested
  const [livePainting, setLivePainting] = useState(false); // live WS frames on screen
  const [notif, setNotif] = useState<NotifState>("idle"); // push-notification status
  const [cinema, setCinema] = useState(false); // fullscreen live "box"

  const skewRef = useRef(0);
  const liveWantedRef = useRef(false);
  const lastFramePathRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<() => void>(() => {});
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const streamingRef = useRef(false); // true once the live WS is painting frames
  const liveWsRef = useRef<WebSocket | null>(null);
  const liveUrlRef = useRef<string | null>(null);
  const heroImgRef = useRef<HTMLImageElement>(null); // hero <img>, painted imperatively
  const paintingRef = useRef(false); // guards the one-time livePainting reveal

  const serverNow = () => Date.now() + skewRef.current;
  const isLive = status ? status.liveUntil > serverNow() : false;
  const reviewing = reviewIndex !== null;

  const flashMsg = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 2600);
  }, []);

  const applyStatus = useCallback((s: Status) => {
    skewRef.current = s.now - Date.now();
    setStatus(s);
    if (typeof s.tlSec === "number") setTlSec(s.tlSec);
    if (typeof s.bts === "boolean") setBts(s.bts);
    const newest = s.newest;
    // While the live WebSocket is delivering frames, don't let the status poll
    // overwrite them with the older newest-frame snapshot.
    if (!streamingRef.current && newest && newest.path !== lastFramePathRef.current) {
      lastFramePathRef.current = newest.path;
      const url = frameUrl(newest.path, newest.at);
      const img = new Image();
      img.onload = () => setFrameSrc(url);
      img.src = url;
    }
  }, []);

  const postFlags = useCallback(async (body: Record<string, boolean | number>) => {
    const res = await fetch("/api/view/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("flags failed");
    const flags = (await res.json()) as {
      arm: boolean;
      liveUntil: number;
      tlSec?: number;
      now: number;
    };
    setStatus((prev) =>
      prev
        ? { ...prev, arm: flags.arm, liveUntil: flags.liveUntil, now: flags.now }
        : prev,
    );
    if (typeof flags.tlSec === "number") setTlSec(flags.tlSec);
    skewRef.current = flags.now - Date.now();
  }, []);

  const tick = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    let live = false;
    try {
      const res = await fetch("/api/view/status", { cache: "no-store" });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error("status failed");
      const s = (await res.json()) as Status;
      applyStatus(s);
      setErr("");
      live = s.liveUntil > s.now;
      if (
        liveWantedRef.current &&
        document.visibilityState === "visible" &&
        s.liveUntil - s.now < 45 * 1000
      ) {
        await postFlags({ goLive: true });
        live = true;
      }
    } catch {
      setErr("connection hiccup — retrying…");
    }
    timerRef.current = setTimeout(
      () => tickRef.current(),
      live ? LIVE_POLL_MS : IDLE_POLL_MS,
    );
  }, [applyStatus, postFlags]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/view/events", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { events: MotionEvent[] };
      setEvents(data.events);
    } catch {}
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/view/devices", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { devices: Device[] };
      setDevices(data.devices);
    } catch {}
  }, []);

  const loadTimeline = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/view/timeline?device=${CAMERA_ID}&hours=${tlWin}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { points: TimelinePoint[] };
      setTimeline(data.points);
    } catch {}
  }, [tlWin]);

  const loadPins = useCallback(async () => {
    try {
      const res = await fetch("/api/view/pinned", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { pins: Pin[] };
      setPins(data.pins);
    } catch {}
  }, []);

  const loadLights = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/view/lights${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLights([]);
        return;
      }
      const data = (await res.json()) as {
        configured: boolean;
        lights: Light[];
      };
      setLightsOn(data.configured);
      setLights(data.lights);
    } catch {
      setLights([]);
    }
  }, []);

  const loadTelemetry = useCallback(async (device: string) => {
    try {
      const res = await fetch(`/api/view/telemetry?device=${device}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { points: TelemetryPoint[] };
      setTelemetry(data.points);
    } catch {}
  }, []);

  useEffect(() => {
    tickRef.current();
    loadEvents();
    loadDevices();
    loadTimeline();
    loadPins();
    loadLights();
    const onVisible = () => {
      if (document.visibilityState === "visible") tickRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    const dTimer = setInterval(loadDevices, 25000);
    const tTimer = setInterval(loadTimeline, 90000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(dTimer);
      clearInterval(tTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loadEvents, loadDevices, loadTimeline, loadPins, loadLights]);

  useEffect(() => {
    loadTelemetry(selDevice);
    const id = setInterval(() => loadTelemetry(selDevice), 30000);
    return () => clearInterval(id);
  }, [selDevice, loadTelemetry]);

  // Restore the saved display rotation. Instant, no reflash — the stored
  // frames stay upside-down until the firmware sensor flip lands (device
  // command), at which point this resets to 0.
  useEffect(() => {
    const saved = Number(localStorage.getItem("ghostcam.orient") || 0);
    if (saved === 90 || saved === 180 || saved === 270) setOrient(saved);
  }, []);

  const rotateCam = useCallback(() => {
    setOrient((o) => {
      const next = (o + 90) % 360;
      try {
        localStorage.setItem("ghostcam.orient", String(next));
      } catch {}
      return next;
    });
  }, []);

  // ── push notifications (installed PWA) ──────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      !!VAPID_PUBLIC_KEY;
    if (!supported) return setNotif("unsupported");
    if (Notification.permission === "denied") return setNotif("blocked");
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (sub && Notification.permission === "granted") setNotif("on");
      })
      .catch(() => {});
  }, []);

  const enableAlerts = useCallback(async () => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos && !standalone) return setNotif("need-install");
    setNotif("busy");
    try {
      const reg =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setNotif(perm === "denied" ? "blocked" : "idle");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
        });
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error("subscribe failed");
      setNotif("on");
      flashMsg("Motion alerts on — you'll get a push when something moves ✓");
    } catch {
      setNotif("idle");
      setErr("couldn't enable alerts — try again.");
    }
  }, [flashMsg]);

  const sendTestPush = useCallback(async () => {
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const j = (await res.json()) as { sent?: number };
      flashMsg(
        j.sent && j.sent > 0
          ? `Test push sent to ${j.sent} device${j.sent > 1 ? "s" : ""} ✓`
          : "No subscribed devices yet.",
      );
    } catch {
      setErr("couldn't send test push.");
    }
  }, [flashMsg]);

  const alertsClick = useCallback(() => {
    if (notif === "on") sendTestPush();
    else if (notif === "blocked")
      setErr("alerts are blocked — turn on notifications for this app in Settings.");
    else enableAlerts();
  }, [notif, sendTestPush, enableAlerts]);

  // Live WebSocket stream: when live is requested, subscribe to the relay and
  // paint incoming JPEG frames straight onto the hero (near-real-time). If the
  // camera isn't streaming yet, no frames arrive and status polling stays in
  // charge — so this is a pure enhancement over the existing live view.
  useEffect(() => {
    if (!wantLive) return;
    let closed = false;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/stream/watch`);
    ws.binaryType = "arraybuffer";
    liveWsRef.current = ws;
    ws.onmessage = (ev) => {
      if (closed || !(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 100) {
        return;
      }
      const img = heroImgRef.current;
      if (!img) return;
      const url = URL.createObjectURL(new Blob([ev.data], { type: "image/jpeg" }));
      streamingRef.current = true;
      // Paint straight into the <img> — bypassing React state means we don't
      // re-render the whole dashboard on every frame, which is what lets a
      // 10–20 fps stream stay smooth. Revoke the prior blob after the swap.
      img.src = url;
      const prev = liveUrlRef.current;
      liveUrlRef.current = url;
      if (prev) URL.revokeObjectURL(prev);
      if (!paintingRef.current) {
        paintingRef.current = true;
        setLivePainting(true); // one render to reveal the <img> / hide placeholder
      }
    };
    ws.onclose = () => {
      streamingRef.current = false;
      paintingRef.current = false;
    };
    return () => {
      closed = true;
      streamingRef.current = false;
      paintingRef.current = false;
      setLivePainting(false);
      try {
        ws.close();
      } catch {}
      if (liveUrlRef.current) {
        URL.revokeObjectURL(liveUrlRef.current);
        liveUrlRef.current = null;
      }
      liveWsRef.current = null;
    };
  }, [wantLive]);

  // load the reviewed frame whenever the scrub index moves
  useEffect(() => {
    if (reviewIndex === null) {
      setReviewSrc(null);
      return;
    }
    const p = timeline[reviewIndex];
    if (!p) return;
    const url = frameUrl(p.path, p.at);
    const img = new Image();
    img.onload = () => setReviewSrc(url);
    img.src = url;
  }, [reviewIndex, timeline]);

  // timelapse playback
  useEffect(() => {
    if (!playing) return;
    if (timeline.length < 2) {
      setPlaying(false);
      return;
    }
    const id = setInterval(() => {
      setReviewIndex((cur) => {
        const next = (cur ?? 0) + 1;
        if (next >= timeline.length) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 50);
    return () => clearInterval(id);
  }, [playing, timeline.length]);

  const seekFrac = useCallback(
    (f: number) => {
      if (timeline.length === 0) return;
      const clamped = Math.min(1, Math.max(0, f));
      setReviewIndex(Math.round(clamped * (timeline.length - 1)));
    },
    [timeline.length],
  );

  const onTrackPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      seekFrac((e.clientX - rect.left) / rect.width);
    },
    [seekFrac],
  );

  async function toggleLive() {
    setBusy("live");
    try {
      if (isLive || liveWantedRef.current) {
        liveWantedRef.current = false;
        setWantLive(false);
        await postFlags({ stopLive: true });
      } else {
        liveWantedRef.current = true;
        setWantLive(true);
        setReviewIndex(null);
        setPlaying(false);
        await postFlags({ goLive: true });
      }
      tickRef.current();
    } catch {
      setErr("couldn't reach the server.");
    } finally {
      setBusy("");
    }
  }

  async function toggleArm() {
    if (!status) return;
    setBusy("arm");
    try {
      await postFlags({ arm: !status.arm });
    } catch {
      setErr("couldn't reach the server.");
    } finally {
      setBusy("");
    }
  }

  async function fireTest() {
    setBusy("test");
    try {
      await postFlags({ test: true });
      setTestSent(true);
      setTimeout(() => setTestSent(false), 12000);
    } catch {
      setErr("couldn't reach the server.");
    } finally {
      setBusy("");
    }
  }

  // ── 🎬 BTS: shoot mode + on-demand capture burst ───────────────────────────
  async function toggleBts() {
    setBusy("bts");
    try {
      const next = !bts;
      await postFlags({ bts: next });
      setBts(next);
      flashMsg(
        next
          ? "🎬 BTS mode — alerts off, timeline rolling as content"
          : "Security mode — alerts back on",
      );
    } catch {
      setErr("couldn't reach the server.");
    } finally {
      setBusy("");
    }
  }

  async function fireCapture() {
    setBusy("capture");
    try {
      await postFlags({ capture: true });
      setCaptureSent(true);
      setTimeout(() => setCaptureSent(false), 12000);
      flashMsg("🎬 Capturing — a full-res burst lands in Events in ~20s");
    } catch {
      setErr("couldn't reach the server.");
    } finally {
      setBusy("");
    }
  }

  // ── studio lights (Govee) ──────────────────────────────────────────────────
  async function controlLight(
    light: Light,
    action: "power" | "brightness" | "color" | "ct",
    value: boolean | number | { r: number; g: number; b: number },
  ) {
    setBusy(`light-${light.device}`);
    try {
      const res = await fetch("/api/view/lights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: light.device, sku: light.sku, action, value }),
      });
      if (!res.ok) throw new Error("light control failed");
    } catch {
      setErr(`couldn't reach ${light.name}.`);
    } finally {
      setBusy("");
    }
  }

  async function pinPath(path: string, label: string, kind: string) {
    setBusy("pin");
    try {
      const res = await fetch("/api/view/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, label, kind }),
      });
      if (!res.ok) throw new Error("pin failed");
      flashMsg("Pinned to permanent archive ✓");
      loadPins();
    } catch {
      setErr("couldn't pin that frame.");
    } finally {
      setBusy("");
    }
  }

  function pinCurrent() {
    if (reviewing) {
      const p = timeline[reviewIndex];
      if (p) pinPath(p.path, clockLabel(p.at), "timeline");
    } else if (status?.newest) {
      pinPath(status.newest.path, "live snapshot", "live");
    }
  }

  async function unpin(path: string) {
    setPins((prev) => prev.filter((p) => p.path !== path));
    try {
      await fetch(`/api/view/pinned?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
    } catch {}
  }

  async function removeEvent(id: string) {
    setEvents((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    try {
      await fetch(`/api/view/events?event=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {}
  }

  // ── save-from-timeline: mark in/out while scrubbing, export as a clip ──────
  const reviewAt = reviewIndex !== null ? timeline[reviewIndex]?.at ?? null : null;

  function markIn() {
    if (reviewAt === null) return;
    setClipIn(reviewAt);
    if (clipOut !== null && clipOut <= reviewAt) setClipOut(null);
  }
  function markOut() {
    if (reviewAt === null) return;
    setClipOut(reviewAt);
    if (clipIn !== null && clipIn >= reviewAt) setClipIn(null);
  }
  function clearMarks() {
    setClipIn(null);
    setClipOut(null);
  }

  async function saveClip() {
    if (clipIn === null || clipOut === null || clipOut <= clipIn) return;
    setBusy("clip");
    try {
      const res = await fetch("/api/view/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: CAMERA_ID, fromMs: clipIn, toMs: clipOut }),
      });
      const j = (await res.json()) as { ok?: boolean; frames?: number; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? "save failed");
      flashMsg(`Clip saved — ${j.frames} frames now permanent ✓`);
      clearMarks();
      loadEvents();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't save that range.");
    } finally {
      setBusy("");
    }
  }

  async function setCadence(sec: number) {
    try {
      await postFlags({ tlSec: sec });
      flashMsg(
        sec === 0
          ? "Cadence back to the firmware default"
          : `Timeline cadence → every ${sec}s (camera adopts it within seconds)`,
      );
    } catch {
      setErr("couldn't reach the server.");
    }
  }

  // ms → 0..1 position on the current track (nearest timeline point).
  const fracForMs = useCallback(
    (ms: number): number | null => {
      if (timeline.length < 2) return null;
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < timeline.length; i++) {
        const d = Math.abs(timeline[i].at - ms);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best / (timeline.length - 1);
    },
    [timeline],
  );

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.reload();
  }

  function backToLive() {
    setPlaying(false);
    setReviewIndex(null);
  }

  const charts = useMemo(() => {
    const keys = new Map<string, { at: number; v: number }[]>();
    for (const p of telemetry) {
      for (const [k, val] of Object.entries(p.metrics)) {
        const n = num(val);
        if (n === null) continue;
        const arr = keys.get(k) ?? [];
        arr.push({ at: p.at, v: n });
        keys.set(k, arr);
      }
    }
    return [...keys.entries()]
      .filter(([, s]) => s.length >= 2)
      .slice(0, 8);
  }, [telemetry]);

  const chartDevices = useMemo(() => {
    const ids = new Set<string>([CAMERA_ID]);
    for (const d of devices) ids.add(d.id);
    return [...ids];
  }, [devices]);

  const newest = status?.newest ?? null;
  const age = newest ? serverNow() - newest.at : Number.POSITIVE_INFINITY;
  const online = age < OFFLINE_AFTER_MS;
  const liveLeft = status
    ? Math.max(0, Math.round((status.liveUntil - serverNow()) / 1000))
    : 0;
  const onlineDevices = devices.filter(
    (d) => d.lastSeen !== null && serverNow() - d.lastSeen < DEVICE_ONLINE_MS,
  ).length;
  const reviewPoint = reviewing ? timeline[reviewIndex] : null;
  const heroSrc = reviewing ? reviewSrc : frameSrc;
  const hasImage = !!heroSrc || livePainting;
  const fillPct = reviewing
    ? timeline.length > 1
      ? (reviewIndex / (timeline.length - 1)) * 100
      : 0
    : 100;

  let dotClass = "bad";
  let statusText = "camera offline";
  if (!status) {
    dotClass = "";
    statusText = "connecting…";
  } else if (isLive && online && age < 20 * 1000) {
    dotClass = "ok";
    statusText = `LIVE · ${agoText(age)}`;
  } else if (online) {
    dotClass = newest && age < 40 * 1000 ? "ok" : "warn";
    statusText = newest ? `seen ${agoText(age)}` : "waiting for first frame";
  } else if (newest) {
    statusText = `offline · last seen ${agoText(age)}`;
  }

  const camTransform =
    orient === 0
      ? undefined
      : orient === 180
        ? "rotate(180deg)"
        : `rotate(${orient}deg) scale(0.75)`; // 90/270 fit the 4:3 box
  const thumbTransform = orient ? `rotate(${orient}deg)` : undefined;

  // Paint non-live sources (status snapshots, scrubbed timeline frames) into the
  // same hero <img> the live stream writes to. Skipped while the WS is painting
  // so the two never fight; re-runs when live stops to restore the latest still.
  useEffect(() => {
    if (streamingRef.current) return;
    const img = heroImgRef.current;
    if (img && heroSrc) img.src = heroSrc;
  }, [heroSrc, livePainting]);

  // Dynamic favicon + tab title: GREEN when the system is "on" (camera online
  // AND armed or live), RED when it's "off" (offline or disarmed). Drawn to a
  // canvas each state change and swapped into <link rel="icon">.
  const systemOn = online && (isLive || !!status?.arm);
  useEffect(() => {
    const color = systemOn ? "#34d399" : "#ef4444";
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = "#0b0e13";
    const rr = g as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
    if (typeof rr.roundRect === "function") {
      g.beginPath();
      rr.roundRect(2, 2, 60, 60, 15);
      g.fill();
    } else {
      g.fillRect(2, 2, 60, 60);
    }
    g.strokeStyle = color;
    g.lineWidth = 7;
    g.shadowColor = color;
    g.shadowBlur = 9;
    g.beginPath();
    g.arc(32, 32, 16.5, 0, Math.PI * 2);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = color;
    g.beginPath();
    g.arc(32, 32, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.arc(27.5, 27.5, 2.4, 0, Math.PI * 2);
    g.fill();
    const href = c.toDataURL("image/png");
    let link = document.querySelector<HTMLLinkElement>("link#dynfav");
    if (!link) {
      link = document.createElement("link");
      link.id = "dynfav";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
    document.title = systemOn ? "● SAVAGE LAB" : "○ SAVAGE LAB — off";
  }, [systemOn]);

  return (
    <main className="wrap">
      <header className="topbar">
        <div className="brandwrap">
          <span className="reactor" />
          <div>
            <h1 className="brand">SAVAGE LAB</h1>
            <div className="subbrand">STUDIO CONTROL</div>
          </div>
        </div>
        <span className="pill">
          <span className={`dot ${dotClass}`} />
          {statusText}
        </span>
        {bts && <span className="pill btspill">🎬 BTS</span>}
      </header>

      {flash && <div className="flash">{flash}</div>}

      <section className="hero">
        <div className={`frame${cinema ? " cinema" : ""}`}>
          <img
            ref={heroImgRef}
            alt="lab camera"
            style={{
              display: hasImage ? "block" : "none",
              ...(camTransform ? { transform: camTransform } : {}),
            }}
          />
          {!hasImage && (
            <div className="empty">
              {status
                ? "no frame yet — the camera sends one within a couple minutes of coming online"
                : "connecting…"}
            </div>
          )}
          {hasImage && (
            <span
              className={`stamp ${
                reviewing ? "review" : isLive && age < 20000 ? "live" : ""
              }`}
            >
              {reviewing && reviewPoint
                ? `⟲ ${clockLabel(reviewPoint.at)}`
                : isLive && age < 20000
                  ? `● LIVE ${liveLeft}s`
                  : newest
                    ? agoText(age)
                    : ""}
            </span>
          )}
          {hasImage && (
            <button
              type="button"
              className="pinbtn"
              onClick={pinCurrent}
              disabled={busy === "pin"}
            >
              📌 Pin
            </button>
          )}
          {hasImage && (
            <button
              type="button"
              className="rotbtn"
              onClick={rotateCam}
              title="Rotate view"
            >
              ⟳{orient ? ` ${orient}°` : ""}
            </button>
          )}
          {hasImage && (
            <button
              type="button"
              className="cinebtn"
              onClick={() => setCinema((c) => !c)}
              title={cinema ? "Exit fullscreen" : "Fullscreen live"}
            >
              {cinema ? "✕" : "⛶"}
            </button>
          )}
          {reviewing && (
            <button type="button" className="livejump" onClick={backToLive}>
              ● LIVE
            </button>
          )}
        </div>

        <div className="scrub">
          <div className="scrub-head">
            <span className="scrub-time">
              {reviewing && reviewPoint ? clockLabel(reviewPoint.at) : "LIVE NOW"}
            </span>
            <span className="winsel">
              {TL_WINDOWS.map((h) => (
                <button
                  type="button"
                  key={h}
                  className={`winbtn ${tlWin === h ? "on" : ""}`}
                  onClick={() => {
                    setPlaying(false);
                    setReviewIndex(null);
                    clearMarks();
                    setTlWin(h);
                  }}
                >
                  {h}h
                </button>
              ))}
            </span>
          </div>
          <div
            className="track"
            ref={trackRef}
            onPointerDown={(e) => {
              scrubbingRef.current = true;
              setPlaying(false);
              e.currentTarget.setPointerCapture(e.pointerId);
              onTrackPointer(e);
            }}
            onPointerMove={(e) => {
              if (scrubbingRef.current) onTrackPointer(e);
            }}
            onPointerUp={() => {
              scrubbingRef.current = false;
            }}
          >
            {clipIn !== null &&
              (() => {
                const a = fracForMs(clipIn);
                const b = clipOut !== null ? fracForMs(clipOut) : a;
                if (a === null || b === null) return null;
                return (
                  <div
                    className="track-range"
                    style={{
                      left: `${a * 100}%`,
                      width: `${Math.max(0.5, (b - a) * 100)}%`,
                    }}
                  />
                );
              })()}
            <div className="track-fill" style={{ width: `${fillPct}%` }} />
            <div className="track-head" style={{ left: `${fillPct}%` }} />
          </div>
          <div className="track-labels">
            <span>−{tlWin}h</span>
            <span>−{tlWin / 2}h</span>
            <span>now</span>
          </div>
          <div className="scrub-controls">
            <button
              type="button"
              className={`sbtn ${playing ? "on" : ""}`}
              onClick={() => setPlaying((p) => !p)}
              disabled={timeline.length < 2}
            >
              {playing ? "❚❚ Pause" : "▶ Timelapse"}
            </button>
            <button
              type="button"
              className="sbtn"
              onClick={() => {
                setPlaying(false);
                seekFrac(
                  ((reviewIndex ?? timeline.length - 1) - 1) /
                    Math.max(1, timeline.length - 1),
                );
              }}
              disabled={!timeline.length}
            >
              ‹
            </button>
            <button
              type="button"
              className="sbtn"
              onClick={() => {
                setPlaying(false);
                seekFrac(
                  ((reviewIndex ?? 0) + 1) / Math.max(1, timeline.length - 1),
                );
              }}
              disabled={!timeline.length}
            >
              ›
            </button>
            <button
              type="button"
              className="sbtn"
              onClick={backToLive}
              disabled={!reviewing}
            >
              Live
            </button>
          </div>
          <div className="scrub-controls saveclip">
            <button
              type="button"
              className={`sbtn ${clipIn !== null ? "on" : ""}`}
              onClick={markIn}
              disabled={reviewAt === null}
              title="Mark clip start at the scrubbed moment"
            >
              ⟦ In
            </button>
            <button
              type="button"
              className={`sbtn ${clipOut !== null ? "on" : ""}`}
              onClick={markOut}
              disabled={reviewAt === null}
              title="Mark clip end at the scrubbed moment"
            >
              Out ⟧
            </button>
            <button
              type="button"
              className="sbtn save"
              onClick={saveClip}
              disabled={
                busy === "clip" ||
                clipIn === null ||
                clipOut === null ||
                clipOut <= clipIn
              }
              title="Copy the marked range out of the rolling window — kept forever"
            >
              {busy === "clip" ? "Saving…" : "💾 Save clip"}
            </button>
            {(clipIn !== null || clipOut !== null) && (
              <button type="button" className="sbtn" onClick={clearMarks}>
                ✕
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="row">
        <button
          type="button"
          className={`btn ${isLive ? "live" : ""}`}
          onClick={toggleLive}
          disabled={busy === "live" || !status}
        >
          {isLive ? "■ Stop live" : "● Go live"}
        </button>
        <button
          type="button"
          className={`btn ${status?.arm ? "armed" : ""}`}
          onClick={toggleArm}
          disabled={busy === "arm" || !status}
        >
          {status?.arm ? "Armed ✓" : "Disarmed"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={fireTest}
          disabled={busy === "test" || !status}
        >
          {testSent ? "Sent ✓" : "Test alert"}
        </button>
      </div>
      <div className="row">
        <button
          type="button"
          className={`btn ${bts ? "bts" : ""}`}
          onClick={toggleBts}
          disabled={busy === "bts" || !status}
          title="BTS shoot mode: motion + sound alerts off, timeline keeps rolling as content"
        >
          {bts ? "🎬 BTS ON" : "🎬 BTS mode"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={fireCapture}
          disabled={busy === "capture" || !status}
          title="Record a full-res burst right now — lands in Events, no alert"
        >
          {captureSent ? "Rolling… ✓" : "⏺ Capture"}
        </button>
      </div>
      {bts && (
        <p className="btsnote">
          🎬 BTS mode is on — no alerts will fire. The timeline is your
          b-roll: shoot, then scrub → ⟦ In / Out ⟧ → 💾 Save clip.
        </p>
      )}
      {err && <p className="err">{err}</p>}

      {(notif === "idle" || notif === "need-install") && (
        <button type="button" className="alertcta" onClick={alertsClick}>
          🔔{" "}
          {notif === "need-install"
            ? "On iPhone: Share → Add to Home Screen, open that app, then tap here to arm motion alerts"
            : "Turn on motion push notifications"}
        </button>
      )}

      <div className="section">
        <h2>Devices</h2>
        <span className="count">
          {onlineDevices}/{devices.length || (devices.length === 0 ? 1 : 0)}{" "}
          online
        </span>
      </div>
      <div className="grid">
        {devices.length === 0 && (
          <div className="devcard ghostcard">
            <div className="devcard-head">
              <span className="dot warn" />
              <span className="devname">Room Cam</span>
            </div>
            <div className="devtype">esp32-cam</div>
            <div className="devchips">
              <span className="devchip dim">registers on next boot</span>
            </div>
            <div className="devfoot">flash the lab-cam firmware</div>
          </div>
        )}
        {devices.map((d) => (
          <DeviceCard
            key={d.id}
            device={d}
            now={serverNow()}
            selected={selDevice === d.id}
            onSelect={() => setSelDevice(d.id)}
          />
        ))}
        <button
          type="button"
          className="addcard"
          onClick={() => setShowAdd((v) => !v)}
        >
          <span className="plus">＋</span>
          Add lab node
        </button>
      </div>
      {showAdd && (
        <div className="addhelp">
          <p>
            Any ESP32 gadget can join the lab. Flash the{" "}
            <b>lab-node</b> sketch (in <code>firmware/lab-node/</code>), set its{" "}
            <code>DEVICE_ID</code>, <code>API_HOST</code> and the shared{" "}
            <code>DEVICE_TOKEN</code>, and it registers itself + streams
            telemetry to this dashboard.
          </p>
          <p className="addhelp-eg">
            Ready-made examples: <b>lab-cam</b> (this camera),{" "}
            <b>lillygo-tembed-cc1101</b> (sub-GHz RF scanner + encoder). Same
            token, same API — they just appear here.
          </p>
        </div>
      )}

      <div className="section">
        <h2>Sensors</h2>
        <span className="count">last 24h</span>
      </div>
      <div className="devsel">
        {chartDevices.map((id) => {
          const d = devices.find((x) => x.id === id);
          return (
            <button
              type="button"
              key={id}
              className={`chip ${selDevice === id ? "on" : ""}`}
              onClick={() => setSelDevice(id)}
            >
              {d ? d.meta.name : id}
            </button>
          );
        })}
      </div>
      {charts.length === 0 ? (
        <p className="note">
          no numeric telemetry from {selDevice} yet — sensor charts appear here
          as data arrives.
        </p>
      ) : (
        <div className="charts">
          {charts.map(([key, series]) => (
            <LineChart
              key={key}
              label={metricLabel(key)}
              unit={METRIC_INFO[key]?.unit ?? ""}
              color={METRIC_INFO[key]?.color ?? "#38bdf8"}
              series={series}
            />
          ))}
        </div>
      )}

      {lightsOn && (
        <>
          <div className="section">
            <h2>Studio lights</h2>
            <button type="button" className="linky" onClick={() => loadLights(true)}>
              refresh
            </button>
          </div>
          {lights === null && <p className="note">loading lights…</p>}
          {lights !== null && lights.length === 0 && (
            <p className="note">
              no Govee lights found — check the strips are online in the Govee
              Home app.
            </p>
          )}
          {lights?.map((l) => (
            <div className="light" key={l.device}>
              <div className="light-head">
                <span className="light-name">💡 {l.name}</span>
                <span className="light-sku">{l.sku}</span>
              </div>
              <div className="light-controls">
                <button
                  type="button"
                  className="lbtn"
                  onClick={() => controlLight(l, "power", true)}
                  disabled={busy === `light-${l.device}`}
                >
                  On
                </button>
                <button
                  type="button"
                  className="lbtn"
                  onClick={() => controlLight(l, "power", false)}
                  disabled={busy === `light-${l.device}`}
                >
                  Off
                </button>
                {LIGHT_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.name}
                    className="swatch"
                    style={{ background: p.hex }}
                    title={p.name}
                    onClick={() =>
                      controlLight(l, "color", { r: p.r, g: p.g, b: p.b })
                    }
                    disabled={busy === `light-${l.device}`}
                  />
                ))}
                <input
                  type="range"
                  className="light-dim"
                  min={1}
                  max={100}
                  defaultValue={100}
                  title="Brightness"
                  onPointerUp={(e) =>
                    controlLight(l, "brightness", Number(e.currentTarget.value))
                  }
                />
              </div>
            </div>
          ))}
        </>
      )}

      <div className="section">
        <h2>Events</h2>
        <button type="button" className="linky" onClick={loadEvents}>
          refresh
        </button>
      </div>
      {events === null && <p className="note">loading events…</p>}
      {events !== null && events.length === 0 && (
        <p className="note">
          nothing yet — motion clips, loud-noise clips, saved timeline ranges,
          and sensor-node alerts (tripwires, door contacts, panic button) all
          land here (and ping your phone).
        </p>
      )}
      {events?.map((event) => {
        const kindInfo = EVENT_KIND_INFO[event.kind ?? "motion"] ?? {
          icon: "📟",
          label: event.kind ?? "event",
        };
        return (
          <div className="event" key={event.id}>
            <div className="head">
              <span className="when">
                <em className="evkind" title={kindInfo.label}>
                  {kindInfo.icon}
                </em>{" "}
                {eventLabel(event.id, event.at)}
                {event.frames.length > 0 && (
                  <em className="evlen"> · {event.frames.length}f clip</em>
                )}
                {event.label && <em className="evlen"> · {event.label}</em>}
              </span>
              <div className="evactions">
                {event.frames.length > 0 && (
                  <button
                    type="button"
                    className="evpin"
                    onClick={() =>
                      event.frames[0] &&
                      pinPath(
                        event.frames[0],
                        eventLabel(event.id, event.at),
                        event.kind ?? "motion",
                      )
                    }
                  >
                    📌
                  </button>
                )}
                <button
                  type="button"
                  className="kill"
                  onClick={() => removeEvent(event.id)}
                  aria-label="delete event"
                >
                  ✕
                </button>
              </div>
            </div>
            {event.frames.length > 0 ? (
              <ClipPlayer frames={event.frames} transform={thumbTransform} />
            ) : (
              <div className="evping">
                {kindInfo.icon} {kindInfo.label}
                {event.device ? ` — ${event.device}` : ""}
                {event.label ? ` · ${event.label}` : ""}
              </div>
            )}
          </div>
        );
      })}

      <div className="section">
        <h2>Pinned archive</h2>
        <span className="count">permanent · {pins.length}</span>
      </div>
      {pins.length === 0 ? (
        <p className="note">
          nothing pinned. Hit <b>📌 Pin</b> on any live or scrubbed frame to
          keep it here forever — pinned shots are never auto-deleted.
        </p>
      ) : (
        <div className="pins">
          {pins.map((pin) => (
            <div className="pin" key={pin.path}>
              <a
                href={frameUrl(pin.path, "full")}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={frameUrl(pin.path, "thumb")}
                  alt={pin.label}
                  loading="lazy"
                  style={thumbTransform ? { transform: thumbTransform } : undefined}
                />
              </a>
              <button
                type="button"
                className="pin-kill"
                onClick={() => unpin(pin.path)}
                aria-label="unpin"
              >
                ✕
              </button>
              <span className="pin-label">{pin.label}</span>
            </div>
          ))}
        </div>
      )}

      <p className="note cadence">
        snapshot cadence:{" "}
        {TL_CADENCES.map((s) => (
          <button
            type="button"
            key={s}
            className={`winbtn ${tlSec === s ? "on" : ""}`}
            onClick={() => setCadence(s)}
            title={
              s === 0
                ? "firmware default (config.h TIMELINE_SECONDS)"
                : `one snapshot every ${s}s`
            }
          >
            {s === 0 ? "auto" : `${s}s`}
          </button>
        ))}
      </p>

      <p className="note">
        24h timeline · clips &amp; pins kept forever ·{" "}
        {notif !== "unsupported" && (
          <>
            <button type="button" className="linky" onClick={alertsClick}>
              {notif === "on"
                ? "🔔 alerts on · test"
                : notif === "blocked"
                  ? "🔔 alerts blocked"
                  : "🔔 enable alerts"}
            </button>{" "}
            ·{" "}
          </>
        )}
        <button type="button" className="linky" onClick={logout}>
          lock
        </button>
      </p>
    </main>
  );
}
