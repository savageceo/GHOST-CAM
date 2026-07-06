import { inArray } from "drizzle-orm";
import webpush from "web-push";
import { getDb, schema } from "@/lib/db";

// Web Push (VAPID) — the installed PWA subscribes; the server pushes a native
// notification when motion fires. Keys live in env (VAPID_* set in Vercel).
export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let vapidReady = false;
function ensureVapid(): void {
  if (vapidReady) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@savage.lab",
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  );
  vapidReady = true;
}

export type PushSub = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export async function saveSubscription(
  sub: PushSub,
  ua?: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      ua,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, ua },
    });
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.pushSubscriptions)
    .where(inArray(schema.pushSubscriptions.endpoint, [endpoint]));
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  image?: string;
  tag?: string;
};

// Fan a notification out to every subscription; drop any the push service says
// are gone (404/410). Safe to call fire-and-forget.
export async function sendPushToAll(
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!pushConfigured()) return { sent: 0, pruned: 0 };
  ensureVapid();
  const db = getDb();
  const rows = await db.select().from(schema.pushSubscriptions);
  if (!rows.length) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          body,
          { TTL: 120, urgency: "high" },
        );
        sent++;
      } catch (e: unknown) {
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) dead.push(r.endpoint);
      }
    }),
  );
  if (dead.length) {
    try {
      await db
        .delete(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.endpoint, dead));
    } catch {}
  }
  return { sent, pruned: dead.length };
}
