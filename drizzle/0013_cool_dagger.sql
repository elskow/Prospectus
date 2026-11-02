CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_sealed" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_label_idx" ON "llm_providers" USING btree ("label");--> statement-breakpoint
DELETE FROM "models";--> statement-breakpoint
ALTER TABLE "models" DROP CONSTRAINT IF EXISTS "models_pkey";--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "provider_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_id_pk" PRIMARY KEY("provider_id","id");--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;
