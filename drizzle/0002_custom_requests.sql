CREATE TABLE "custom_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_number" text NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"photos" jsonb NOT NULL,
	"colours" jsonb NOT NULL,
	"notes" text,
	"pincode" text,
	"needed_by" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_requests_request_number_unique" UNIQUE("request_number"),
	CONSTRAINT "custom_requests_kind_valid" CHECK ("custom_requests"."kind" in ('miniature','caricature')),
	CONSTRAINT "custom_requests_status_valid" CHECK ("custom_requests"."status" in ('submitted','in_review','quoted','declined','closed'))
);
--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_requests_user_id_created_at_idx" ON "custom_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "custom_requests_status_created_at_idx" ON "custom_requests" USING btree ("status","created_at");