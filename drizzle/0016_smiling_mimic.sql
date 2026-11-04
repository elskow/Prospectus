ALTER TABLE "ingest_jobs" ADD COLUMN "rejected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD COLUMN "flagged" integer DEFAULT 0 NOT NULL;