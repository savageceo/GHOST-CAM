CREATE TABLE "commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_state" (
	"device_id" text PRIMARY KEY NOT NULL,
	"arm" boolean DEFAULT true NOT NULL,
	"live_until" bigint DEFAULT 0 NOT NULL,
	"test_at" bigint DEFAULT 0 NOT NULL,
	"orient" integer DEFAULT 180 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'sensor' NOT NULL,
	"caps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"firmware" text,
	"last_seen" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frames" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"blob_path" text NOT NULL,
	"w" integer,
	"h" integer,
	"meta" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "motion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"frame_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"person_id" bigint,
	"disposition" text
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text,
	"blob_path" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commands_pending_idx" ON "commands" USING btree ("device_id","consumed_at");--> statement-breakpoint
CREATE INDEX "frames_device_kind_at_idx" ON "frames" USING btree ("device_id","kind","at");--> statement-breakpoint
CREATE INDEX "motion_device_at_idx" ON "motion_events" USING btree ("device_id","at");--> statement-breakpoint
CREATE INDEX "telemetry_device_at_idx" ON "telemetry" USING btree ("device_id","at");