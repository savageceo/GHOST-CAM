CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"ua" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_state" ADD COLUMN IF NOT EXISTS "tl_sec" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "motion_events" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'motion' NOT NULL;--> statement-breakpoint
ALTER TABLE "motion_events" ADD COLUMN IF NOT EXISTS "label" text;
