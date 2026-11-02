CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"city" text NOT NULL,
	"province" text,
	"sector" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"discovered" integer DEFAULT 0 NOT NULL,
	"emailed" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_gain_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "markets_campaign_city_sector_idx" ON "markets" USING btree ("campaign_id","city","sector");--> statement-breakpoint
CREATE INDEX "markets_campaign_status_idx" ON "markets" USING btree ("campaign_id","status");