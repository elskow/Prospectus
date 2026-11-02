ALTER TABLE "leads" ADD COLUMN "enrichment_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "research_signals";