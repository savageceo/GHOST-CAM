// Govee lights — studio lighting control from the same dashboard.
// Uses the Govee Developer Platform API (the key from Govee Home → Settings →
// "Apply for API Key"). Set GOVEE_API_KEY in the Vercel env; everything here
// no-ops cleanly when it's absent.
//
// Endpoints:
//   GET  https://openapi.api.govee.com/router/api/v1/user/devices
//   POST https://openapi.api.govee.com/router/api/v1/device/control
// Auth header: Govee-API-Key. Rate limit is generous for a two-strip studio
// (per-minute per-device), but we still cache the device list.

const GOVEE_BASE = "https://openapi.api.govee.com";

export function goveeConfigured(): boolean {
  return !!process.env.GOVEE_API_KEY;
}

export type GoveeLight = {
  device: string; // MAC-style id
  sku: string; // model, e.g. H6159
  name: string;
  controllable: boolean;
};

type GoveeDeviceRaw = {
  device?: string;
  sku?: string;
  deviceName?: string;
  type?: string;
  capabilities?: { type?: string; instance?: string }[];
};

async function goveeFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const key = process.env.GOVEE_API_KEY;
  if (!key) throw new Error("GOVEE_API_KEY not set");
  return fetch(`${GOVEE_BASE}${path}`, {
    ...init,
    headers: {
      "Govee-API-Key": key,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

// Device list, cached for 5 minutes (it changes when you buy a lamp, not
// per-request).
let lightCache: { at: number; lights: GoveeLight[] } | null = null;

export async function listLights(force = false): Promise<GoveeLight[]> {
  if (!force && lightCache && Date.now() - lightCache.at < 5 * 60 * 1000) {
    return lightCache.lights;
  }
  const res = await goveeFetch("/router/api/v1/user/devices");
  if (!res.ok) throw new Error(`govee devices → ${res.status}`);
  const data = (await res.json()) as { data?: GoveeDeviceRaw[] };
  const lights: GoveeLight[] = (data.data ?? [])
    .filter((d) => d.device && d.sku)
    .map((d) => ({
      device: d.device as string,
      sku: d.sku as string,
      name: d.deviceName || (d.sku as string),
      controllable: (d.capabilities ?? []).some((c) =>
        (c.type ?? "").includes("on_off"),
      ),
    }));
  lightCache = { at: Date.now(), lights };
  return lights;
}

type Capability = {
  type: string;
  instance: string;
  value: number | Record<string, unknown>;
};

async function control(
  device: string,
  sku: string,
  capability: Capability,
): Promise<boolean> {
  const res = await goveeFetch("/router/api/v1/device/control", {
    method: "POST",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      payload: { sku, device, capability },
    }),
  });
  if (!res.ok) {
    try {
      console.error("[govee] control failed", res.status, await res.text());
    } catch {}
  }
  return res.ok;
}

export function rgbToGovee(r: number, g: number, b: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

export async function setPower(
  device: string,
  sku: string,
  on: boolean,
): Promise<boolean> {
  return control(device, sku, {
    type: "devices.capabilities.on_off",
    instance: "powerSwitch",
    value: on ? 1 : 0,
  });
}

export async function setBrightness(
  device: string,
  sku: string,
  pct: number,
): Promise<boolean> {
  return control(device, sku, {
    type: "devices.capabilities.range",
    instance: "brightness",
    value: Math.max(1, Math.min(100, Math.round(pct))),
  });
}

export async function setColor(
  device: string,
  sku: string,
  r: number,
  g: number,
  b: number,
): Promise<boolean> {
  return control(device, sku, {
    type: "devices.capabilities.color_setting",
    instance: "colorRgb",
    value: rgbToGovee(r, g, b),
  });
}

export async function setColorTemp(
  device: string,
  sku: string,
  kelvin: number,
): Promise<boolean> {
  return control(device, sku, {
    type: "devices.capabilities.color_setting",
    instance: "colorTemperatureK",
    value: Math.max(2000, Math.min(9000, Math.round(kelvin))),
  });
}

// SECURITY TIE-IN: slam every light to full-bright red. Wired to alarm events
// (default: panic only — GOVEE_ALERT_KINDS env, comma-separated kinds).
// Best-effort and fire-and-forget: a light API hiccup must never break the
// alert path that pages the phones.
export async function alertLights(): Promise<void> {
  try {
    const lights = await listLights();
    await Promise.all(
      lights.map(async (l) => {
        await setPower(l.device, l.sku, true);
        await setBrightness(l.device, l.sku, 100);
        await setColor(l.device, l.sku, 255, 0, 0);
      }),
    );
  } catch (e) {
    console.error("[govee] alertLights failed", e);
  }
}

export function alertKinds(): Set<string> {
  return new Set(
    (process.env.GOVEE_ALERT_KINDS ?? "panic")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
