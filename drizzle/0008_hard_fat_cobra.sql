ALTER TABLE "runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;