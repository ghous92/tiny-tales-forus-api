CREATE TABLE "review_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"buyer_label" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "review_invites_token_unique" UNIQUE("token"),
	CONSTRAINT "review_invites_channel_valid" CHECK ("review_invites"."channel" in ('whatsapp', 'instagram', 'website', 'other'))
);
--> statement-breakpoint
CREATE TABLE "store_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"rating" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"product_label" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moderated_at" timestamp with time zone,
	CONSTRAINT "store_reviews_invite_id_unique" UNIQUE("invite_id"),
	CONSTRAINT "store_reviews_rating_range" CHECK ("store_reviews"."rating" between 1 and 5),
	CONSTRAINT "store_reviews_status_valid" CHECK ("store_reviews"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "store_reviews" ADD CONSTRAINT "store_reviews_invite_id_review_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."review_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_invites_created_at_idx" ON "review_invites" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_reviews_status_created_at_idx" ON "store_reviews" USING btree ("status","created_at" DESC NULLS LAST);