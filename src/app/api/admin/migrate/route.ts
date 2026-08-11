import { sql } from "drizzle-orm";
import { checkDeviceAuth } from "@/lib/store";
import { getDb } from "@/lib/db";

// One-shot schema migrator — runs the SAME idempotent statements as
// drizzle/0002 + 0003, so the DB can be upgraded with a single authed POST
// when there's no machine around with DATABASE_URL + drizzle-kit (the studio
// Mac deploys via git push). Every statement is IF NOT EXISTS, so calling
// this repeatedly — or running drizzle-kit migrate later — is harmless.
//
//   curl -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
//        https://www.ghostk.ing/api/admin/migrate
//
// Auth: the shared DEVICE_TOKEN (same trust level as the camera itself).
// No request input reaches SQL — the statement list is fixed at build time.
const STATEMENTS: { name: string; ddl: string }[] = [
  {
    name: "push_subscriptions table",
    ddl: `CREATE TABLE IF NOT EXISTS "push_subscriptions" (
      "endpoint" text PRIMARY KEY NOT NULL,
      "p256dh" text NOT NULL,
      "auth" text NOT NULL,
      "ua" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "device_state.tl_sec",
    ddl: `ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "tl_sec" integer DEFAULT 0 NOT NULL`,
  },
  {
    name: "motion_events.kind",
    ddl: `ALTER TABLE "motion_events" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'motion' NOT NULL`,
  },
  {
    name: "motion_events.label",
    ddl: `ALTER TABLE "motion_events" ADD COLUMN IF NOT EXISTS "label" text`,
  },
  {
    name: "device_state.bts",
    ddl: `ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "bts" boolean DEFAULT false NOT NULL`,
  },
  {
    name: "device_state.capture_at",
    ddl: `ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "capture_at" bigint DEFAULT 0 NOT NULL`,
  },
];

export async function POST(request: Request) {
  if (!checkDeviceAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const applied: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const s of STATEMENTS) {
    try {
      await db.execute(sql.raw(s.ddl));
      applied.push(s.name);
    } catch (e) {
      failed.push({ name: s.name, error: e instanceof Error ? e.message : "?" });
    }
  }
  return Response.json(
    { ok: failed.length === 0, applied, failed },
    { status: failed.length === 0 ? 200 : 500 },
  );
}
