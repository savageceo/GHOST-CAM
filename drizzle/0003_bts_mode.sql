ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "bts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "capture_at" bigint DEFAULT 0 NOT NULL;
