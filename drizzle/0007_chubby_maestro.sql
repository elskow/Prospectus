ALTER TABLE "runs" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_active_campaign_idx" ON "runs" USING btree ("campaign_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_campaign_idempotency_idx" ON "runs" USING btree ("campaign_id","idempotency_key") WHERE idempotency_key is not null;