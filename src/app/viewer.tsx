"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Newest = {
  path: string;
  at: number;
  sd: boolean;
  rssi: number;
  kind: string;
} | null;
type Status = { arm: boolean; liveUntil: number; now: number; newest: Newest };
type MotionEvent = { id: string; at: number; frames: string[] };
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
};

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
function eventLabel(id: string): string {
  const m = id.match(/^e(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  if (!m) return "before clock sync";
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
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
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState("");
  const [testSent, setTestSent] = useState(false);
  const [orient, setOrient] = useState(0); // display rotation (deg): instant, pre-reflash fix
  const [wantLive, setWantLive] = useState(false); // WebSocket live stream requested

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

  const postFlags = useCallback(async (body: Record<string, boolean>) => {
    const res = await fetch("/api/view/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("flags failed");
    const flags = (await res.json()) as {
      arm: boolean;
      liveUntil: number;
      now: number;
    };
    setStatus((prev) =>
      prev
        ? { ...prev, arm: flags.arm, liveUntil: flags.liveUntil, now: flags.now }
        : prev,
    );
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
      const res = await fetch(`/api/view/timeline?device=${CAMERA_ID}&hours=1`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { points: TimelinePoint[] };
      setTimeline(data.points);
    } catch {}
  }, []);

  const loadPins = useCallback(async () => {
    try {
      const res = await fetch("/api/view/pinned", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { pins: Pin[] };
      setPins(data.pins);
    } catch {}
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
  }, [loadEvents, loadDevices, loadTimeline, loadPins]);

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
      const url = URL.createObjectURL(new Blob([ev.data], { type: "image/jpeg" }));
      streamingRef.current = true;
      if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
      liveUrlRef.current = url;
      setFrameSrc(url);
    };
    ws.onclose = () => {
      streamingRef.current = false;
    };
    return () => {
      closed = true;
      streamingRef.current = false;
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
      </header>

      {flash && <div className="flash">{flash}</div>}

      <section className="hero">
        <div className="frame">
          {heroSrc ? (
            <img
              src={heroSrc}
              alt="lab camera"
              style={camTransform ? { transform: camTransform } : undefined}
            />
          ) : (
            <div className="empty">
              {status
                ? "no frame yet — the camera sends one within a couple minutes of coming online"
                : "connecting…"}
            </div>
          )}
          {heroSrc && (
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
          {heroSrc && (
            <button
              type="button"
              className="pinbtn"
              onClick={pinCurrent}
              disabled={busy === "pin"}
            >
              📌 Pin
            </button>
          )}
          {heroSrc && (
            <button
              type="button"
              className="rotbtn"
              onClick={rotateCam}
              title="Rotate view"
            >
              ⟳{orient ? ` ${orient}°` : ""}
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
            <span className="scrub-meta">
              {timeline.length
                ? `${timeline.length} frames · last 1h · 1s`
                : "building timeline…"}
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
            <div className="track-fill" style={{ width: `${fillPct}%` }} />
            <div className="track-head" style={{ left: `${fillPct}%` }} />
          </div>
          <div className="track-labels">
            <span>−60m</span>
            <span>−30m</span>
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
      {err && <p className="err">{err}</p>}

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

      <div className="section">
        <h2>Motion events</h2>
        <button type="button" className="linky" onClick={loadEvents}>
          refresh
        </button>
      </div>
      {events === null && <p className="note">loading events…</p>}
      {events !== null && events.length === 0 && (
        <p className="note">
          nothing yet — when the camera is armed and sees motion, photo bursts
          land here (and ping your phone).
        </p>
      )}
      {events?.map((event) => (
        <div className="event" key={event.id}>
          <div className="head">
            <span className="when">{eventLabel(event.id)}</span>
            <div className="evactions">
              <button
                type="button"
                className="evpin"
                onClick={() =>
                  event.frames[0] &&
                  pinPath(event.frames[0], eventLabel(event.id), "motion")
                }
              >
                📌
              </button>
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
          <div className="thumbs">
            {event.frames.map((path) => (
              <a
                key={path}
                href={frameUrl(path, "full")}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={frameUrl(path, "thumb")}
                  alt="motion frame"
                  loading="lazy"
                  style={thumbTransform ? { transform: thumbTransform } : undefined}
                />
              </a>
            ))}
          </div>
        </div>
      ))}

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

      <p className="note">
        1s timeline · last hour · pins kept forever · armed = motion alerts on ·{" "}
        <button type="button" className="linky" onClick={logout}>
          lock
        </button>
      </p>
    </main>
  );
}
