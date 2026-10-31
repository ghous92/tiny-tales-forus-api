ALTER TABLE "custom_requests" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX "custom_requests_device_id_idx" ON "custom_requests" USING btree ("device_id");