import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// The DB holds the INDEX + state + command queue. JPEG/PNG bytes stay in Vercel
// Blob; frames/pins reference them by `blobPath`. This replaces the old
// "state encoded in the blob pathname" scheme (src/lib/store.ts, lab.ts).

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("sensor"),
  caps: jsonb("caps").$type<string[]>().notNull().default([]),
  firmware: text("firmware"),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per device. Fast-path flags the camera polls for (arm/live/test) plus
// orientation (0|180) — the server side of the cloud "Rotate" control — and
// tlSec, the dashboard-set timeline cadence (0 = use the firmware's compiled
// TIMELINE_SECONDS; 1-10 = override, no reflash).
// bts = Behind-The-Scenes shoot mode: motion/sound alerts fully suppressed,
// timeline keeps rolling as content. captureAt = on-demand 🎬 capture-burst
// request (same edge-trigger pattern as testAt, but silent + kind "bts").
export const deviceState = pgTable("device_state", {
  deviceId: text("device_id").primaryKey(),
  arm: boolean("arm").notNull().default(true),
  liveUntil: bigint("live_until", { mode: "number" }).notNull().default(0),
  testAt: bigint("test_at", { mode: "number" }).notNull().default(0),
  orient: integer("orient").notNull().default(180), // degrees: 0 or 180
  tlSec: integer("tl_sec").notNull().default(0), // timeline cadence override (s)
  bts: boolean("bts").notNull().default(false), // 🎬 shoot mode
  captureAt: bigint("capture_at", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Generalized command queue the device drains on poll. Backbone for rotate now,
// and play_alarm / greet / shades / scene for the actuator nodes later.
export const commands = pgTable(
  "commands",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("commands_pending_idx").on(t.deviceId, t.consumedAt)],
);

// Frame index. Bytes live in Blob at `blobPath`.
export const frames = pgTable(
  "frames",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id").notNull(),
    kind: text("kind").notNull(), // live | timeline | motion | pinned
    at: timestamp("at", { withTimezone: true }).notNull(),
    blobPath: text("blob_path").notNull(),
    w: integer("w"),
    h: integer("h"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
  },
  (t) => [
    index("frames_device_kind_at_idx").on(t.deviceId, t.kind, t.at),
    index("frames_device_at_idx").on(t.deviceId, t.at), // newest-frame lookup
  ],
);

export const telemetry = pgTable(
  "telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics")
      .$type<Record<string, number | string | boolean>>()
      .notNull(),
  },
  (t) => [index("telemetry_device_at_idx").on(t.deviceId, t.at)],
);

// Events of every kind live here — camera bursts and sensor pings alike.
// kind: motion | sound | clip (saved-from-timeline) | trip | door | panic | …
// Sensor-node events have no frames (framePaths []); `label` is free text
// shown on the event card ("entry beam", "saved 14:02–14:03").
export const motionEvents = pgTable(
  "motion_events",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("motion"),
    label: text("label"),
    framePaths: jsonb("frame_paths").$type<string[]>().notNull().default([]),
    personId: bigint("person_id", { mode: "number" }), // Phase 2
    disposition: text("disposition"), // recorded | ignored | alerted
  },
  (t) => [index("motion_device_at_idx").on(t.deviceId, t.at)],
);

export const pins = pgTable("pins", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deviceId: text("device_id"),
  blobPath: text("blob_path").notNull(),
  label: text("label").notNull(),
  kind: text("kind").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// Web Push subscriptions (the PWA's home-screen install → native motion alerts).
// One row per browser/device push endpoint; `p256dh`/`auth` are the encryption
// keys web-push needs. Pruned when a push comes back 404/410 (unsubscribed).
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  ua: text("ua"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Phase-2 tables (people / face_embeddings / sightings, pgvector) land with the
// people milestone; the `pgvector` extension is enabled at migration time so
// they drop in cleanly.
