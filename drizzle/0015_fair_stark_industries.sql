CREATE TABLE "hunt_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"filter" jsonb,
	"requested_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"emails_found" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "status" text DEFAULT 'valid' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "has_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "validation_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hunt_jobs" ADD CONSTRAINT "hunt_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hunt_jobs_status_idx" ON "hunt_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "companies_status_created_idx" ON "companies" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "companies_email_created_idx" ON "companies" USING btree ("created_at") WHERE has_email;--> statement-breakpoint
UPDATE "companies" SET "has_email" = EXISTS (SELECT 1 FROM "contacts" k WHERE k.company_id = "companies"."id" AND k.email IS NOT NULL);