CREATE TABLE "caricature_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_hash" text NOT NULL,
	"character" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"preview_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caricature_previews_status_valid" CHECK ("caricature_previews"."status" in ('pending','ok','refused','failed'))
);
--> statement-breakpoint
ALTER TABLE "caricature_previews" ADD CONSTRAINT "caricature_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caricature_previews_user_id_created_at_idx" ON "caricature_previews" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "caricature_previews_created_at_idx" ON "caricature_previews" USING btree ("created_at");