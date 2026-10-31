CREATE TABLE "magic_checkouts" (
	"order_id" text PRIMARY KEY NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cart_snapshot" jsonb NOT NULL,
	"terms_accepted_at" timestamp with time zone NOT NULL,
	"analytics_anonymous_id" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"gclid" text,
	"oppref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "magic_checkouts_status_created_idx" ON "magic_checkouts" USING btree ("status","created_at");