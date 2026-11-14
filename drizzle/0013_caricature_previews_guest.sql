ALTER TABLE "caricature_previews" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "caricature_previews" ADD COLUMN "guest_id" text;--> statement-breakpoint
ALTER TABLE "caricature_previews" ADD CONSTRAINT "caricature_previews_owner_present" CHECK ("caricature_previews"."user_id" is not null or "caricature_previews"."guest_id" is not null);--> statement-breakpoint
CREATE INDEX "caricature_previews_guest_id_created_at_idx" ON "caricature_previews" USING btree ("guest_id","created_at");
