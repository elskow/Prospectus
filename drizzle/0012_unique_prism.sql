CREATE TABLE "ingest_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"pages_target" integer NOT NULL,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_with_email" integer DEFAULT 0 NOT NULL,
	"new_companies" integer DEFAULT 0 NOT NULL,
	"new_leads" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_jobs_status_idx" ON "ingest_jobs" USING btree ("status","created_at");