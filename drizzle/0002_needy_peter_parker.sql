CREATE TABLE "geo_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"niche_norm" text NOT NULL,
	"cell_hash" text NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"sweep_count" integer DEFAULT 0 NOT NULL,
	"companies_found" integer DEFAULT 0 NOT NULL,
	"consecutive_empty" integer DEFAULT 0 NOT NULL,
	"cap_hit" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"last_swept_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_cells" ADD CONSTRAINT "geo_cells_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_cells_campaign_niche_cell_idx" ON "geo_cells" USING btree ("campaign_id","niche_norm","cell_hash");