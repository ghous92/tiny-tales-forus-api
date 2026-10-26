CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"pincode" text NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"house_number" text NOT NULL,
	"road_area" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_push_devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"user_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"price_inr_snapshot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_user_id_sku_pk" PRIMARY KEY("user_id","sku"),
	CONSTRAINT "cart_items_qty_range" CHECK ("cart_items"."qty" between 1 and 99)
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"sku" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"size" text NOT NULL,
	"price_inr" integer NOT NULL,
	"weight_g" integer DEFAULT 0 NOT NULL,
	"length_cm" integer DEFAULT 0 NOT NULL,
	"width_cm" integer DEFAULT 0 NOT NULL,
	"height_cm" integer DEFAULT 0 NOT NULL,
	"image_url" text DEFAULT '' NOT NULL,
	"hsn_code" text DEFAULT '' NOT NULL,
	"gst_rate_pct" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_price_inr_non_negative" CHECK ("catalog_items"."price_inr" >= 0),
	CONSTRAINT "catalog_items_weight_g_range" CHECK ("catalog_items"."weight_g" >= 0 and "catalog_items"."weight_g" <= 50000),
	CONSTRAINT "catalog_items_dimensions_positive" CHECK (("catalog_items"."length_cm" = 0 and "catalog_items"."width_cm" = 0 and "catalog_items"."height_cm" = 0) or ("catalog_items"."length_cm" > 0 and "catalog_items"."width_cm" > 0 and "catalog_items"."height_cm" > 0)),
	CONSTRAINT "catalog_items_gst_rate_pct_valid" CHECK ("catalog_items"."gst_rate_pct" in (0, 5, 12, 18, 28))
);
--> statement-breakpoint
CREATE TABLE "catalog_version" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"image_url" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" text NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" text,
	"sku" text,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "complaint_tickets_ticket_number_unique" UNIQUE("ticket_number"),
	CONSTRAINT "complaint_tickets_category_valid" CHECK ("complaint_tickets"."category" in ('product_quality','delivery_shipping','billing_payment','order_issue','other')),
	CONSTRAINT "complaint_tickets_status_valid" CHECK ("complaint_tickets"."status" in ('open','in_progress','resolved','closed'))
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"order_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"user_id" uuid NOT NULL,
	"discount_inr" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" integer NOT NULL,
	"min_cart_inr" integer DEFAULT 0 NOT NULL,
	"max_discount_inr" integer,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"waives_shipping" boolean DEFAULT false NOT NULL,
	"usage_limit" integer,
	"per_user_limit" integer,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_discount_type_valid" CHECK ("coupons"."discount_type" in ('flat','percent')),
	CONSTRAINT "coupons_discount_value_valid" CHECK (("coupons"."discount_type" = 'percent' and "coupons"."discount_value" between 1 and 90) or ("coupons"."discount_type" = 'flat' and "coupons"."discount_value" > 0)),
	CONSTRAINT "coupons_min_cart_inr_non_negative" CHECK ("coupons"."min_cart_inr" >= 0),
	CONSTRAINT "coupons_max_discount_inr_valid" CHECK ("coupons"."max_discount_inr" is null or "coupons"."max_discount_inr" > 0),
	CONSTRAINT "coupons_usage_limit_valid" CHECK ("coupons"."usage_limit" is null or "coupons"."usage_limit" > 0),
	CONSTRAINT "coupons_per_user_limit_valid" CHECK ("coupons"."per_user_limit" is null or "coupons"."per_user_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "courier_rate_slabs" (
	"courier_code" text NOT NULL,
	"zone" text NOT NULL,
	"upto_g" integer NOT NULL,
	"rate_inr" integer NOT NULL,
	"addl_per_g" integer DEFAULT 500 NOT NULL,
	"addl_rate_inr" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_rate_slabs_courier_code_zone_upto_g_pk" PRIMARY KEY("courier_code","zone","upto_g"),
	CONSTRAINT "courier_rate_slabs_zone_valid" CHECK ("courier_rate_slabs"."zone" in ('A','B','C','D','E','F')),
	CONSTRAINT "courier_rate_slabs_upto_g_positive" CHECK ("courier_rate_slabs"."upto_g" > 0),
	CONSTRAINT "courier_rate_slabs_rate_inr_non_negative" CHECK ("courier_rate_slabs"."rate_inr" >= 0),
	CONSTRAINT "courier_rate_slabs_addl_per_g_positive" CHECK ("courier_rate_slabs"."addl_per_g" > 0)
);
--> statement-breakpoint
CREATE TABLE "courier_service_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_code" text NOT NULL,
	"from_pincode" text NOT NULL,
	"to_pincode" text NOT NULL,
	"prepaid" boolean DEFAULT true NOT NULL,
	"cod" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_service_areas_pincode_format" CHECK ("courier_service_areas"."from_pincode" ~ '^[1-9][0-9]{5}$' and "courier_service_areas"."to_pincode" ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "courier_service_areas_range_ordered" CHECK ("courier_service_areas"."from_pincode" <= "courier_service_areas"."to_pincode")
);
--> statement-breakpoint
CREATE TABLE "courier_service_exceptions" (
	"courier_code" text NOT NULL,
	"pincode" text NOT NULL,
	"serviceable" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_service_exceptions_courier_code_pincode_pk" PRIMARY KEY("courier_code","pincode"),
	CONSTRAINT "courier_service_exceptions_pincode_format" CHECK ("courier_service_exceptions"."pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "couriers" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'surface' NOT NULL,
	"rate_model" text DEFAULT 'weight' NOT NULL,
	"volumetric_divisor" integer DEFAULT 5000 NOT NULL,
	"min_chargeable_g" integer DEFAULT 500 NOT NULL,
	"fuel_bps" integer DEFAULT 0 NOT NULL,
	"gst_bps" integer DEFAULT 1800 NOT NULL,
	"docket_fee_inr" integer DEFAULT 0 NOT NULL,
	"risk_bps" integer DEFAULT 0 NOT NULL,
	"risk_min_inr" integer DEFAULT 0 NOT NULL,
	"cod_flat_inr" integer DEFAULT 0 NOT NULL,
	"cod_bps" integer DEFAULT 0 NOT NULL,
	"rto_bps" integer DEFAULT 0 NOT NULL,
	"sla_days_zone_a" integer DEFAULT 2 NOT NULL,
	"sla_days_zone_b" integer DEFAULT 4 NOT NULL,
	"reliability_score" integer DEFAULT 50 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "couriers_rate_model_valid" CHECK ("couriers"."rate_model" in ('weight','distance')),
	CONSTRAINT "couriers_volumetric_divisor_positive" CHECK ("couriers"."volumetric_divisor" > 0),
	CONSTRAINT "couriers_min_chargeable_g_non_negative" CHECK ("couriers"."min_chargeable_g" >= 0),
	CONSTRAINT "couriers_reliability_score_range" CHECK ("couriers"."reliability_score" between 0 and 100),
	CONSTRAINT "couriers_bps_non_negative" CHECK ("couriers"."fuel_bps" >= 0 and "couriers"."gst_bps" >= 0 and "couriers"."risk_bps" >= 0 and "couriers"."cod_bps" >= 0 and "couriers"."rto_bps" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_note_counters" (
	"fy" text PRIMARY KEY NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"credit_note_number" text PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"order_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_paise" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_total_paise_non_negative" CHECK ("credit_notes"."total_paise" >= 0),
	CONSTRAINT "credit_notes_seq_positive" CHECK ("credit_notes"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"fy" text PRIMARY KEY NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"invoice_number" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_paise" integer NOT NULL,
	"document" jsonb NOT NULL,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"email_to" text,
	"emailed_at" timestamp with time zone,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"last_email_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "invoices_total_paise_non_negative" CHECK ("invoices"."total_paise" >= 0),
	CONSTRAINT "invoices_seq_positive" CHECK ("invoices"."seq" > 0),
	CONSTRAINT "invoices_email_status_valid" CHECK ("invoices"."email_status" in ('pending','sending','sent','failed','skipped_no_email','skipped_backfill'))
);
--> statement-breakpoint
CREATE TABLE "ndr_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"awb" text NOT NULL,
	"act" text NOT NULL,
	"payload" jsonb NOT NULL,
	"upl_id" text,
	"upl_status" text DEFAULT 'requested' NOT NULL,
	"last_error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ndr_actions_act_valid" CHECK ("ndr_actions"."act" in ('DEFER_DLV','EDIT_DETAILS','RE-ATTEMPT')),
	CONSTRAINT "ndr_actions_upl_status_valid" CHECK ("ndr_actions"."upl_status" in ('requested','accepted','rejected','unknown'))
);
--> statement-breakpoint
CREATE TABLE "ops_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"order_id" text NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"dedupe_key" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_notifications_status_valid" CHECK ("ops_notifications"."status" in ('pending','sending','sent','failed','skipped_unconfigured','skipped_no_consent')),
	CONSTRAINT "ops_notifications_attempts_non_negative" CHECK ("ops_notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"status" text NOT NULL,
	"amount_paise" integer,
	"method" text,
	"error_code" text,
	"error_description" text,
	"error_reason" text,
	"error_source" text,
	"error_step" text,
	"observed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_status_valid" CHECK ("payment_attempts"."status" in ('captured','failed','mismatched')),
	CONSTRAINT "payment_attempts_observed_by_valid" CHECK ("payment_attempts"."observed_by" in ('verify','webhook','recover','poll'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"order_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"razorpay_payment_id" text,
	"prepaid_amount_paise" integer GENERATED ALWAYS AS ("amount_paise") STORED NOT NULL,
	"cart_snapshot" jsonb NOT NULL,
	"address_snapshot" jsonb NOT NULL,
	"shipping_snapshot" jsonb,
	"consent_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"cancel_reason" text,
	"razorpay_refund_id" text,
	"refund_status" text,
	"refund_amount_paise" integer,
	"refund_speed" text,
	"refund_initiated_at" timestamp with time zone,
	"refund_processed_at" timestamp with time zone,
	"refund_destination" jsonb,
	"analytics_anonymous_id" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"gclid" text,
	"utm_content" text,
	"oppref" text,
	"heard_about" text,
	"heard_about_other" text,
	CONSTRAINT "payments_amount_paise_positive" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_status_valid" CHECK ("payments"."status" in ('pending','paid','failed','refunded')),
	CONSTRAINT "payments_heard_about_valid" CHECK ("payments"."heard_about" is null or "payments"."heard_about" in ('google_search','instagram','facebook','youtube','whatsapp','amazon','friend_family','other')),
	CONSTRAINT "payments_heard_about_other_requires_other" CHECK ("payments"."heard_about_other" is null or "payments"."heard_about" is not distinct from 'other'),
	CONSTRAINT "payments_refund_status_valid" CHECK ("payments"."refund_status" is null or "payments"."refund_status" in ('pending','processed','failed'))
);
--> statement-breakpoint
CREATE TABLE "pickup_node_skus" (
	"node_id" uuid NOT NULL,
	"sku" text NOT NULL,
	CONSTRAINT "pickup_node_skus_node_id_sku_pk" PRIMARY KEY("node_id","sku")
);
--> statement-breakpoint
CREATE TABLE "pickup_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"contact_phone" text DEFAULT '' NOT NULL,
	"house_number" text DEFAULT '' NOT NULL,
	"road_area" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"pincode" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"is_active" boolean DEFAULT true NOT NULL,
	"kind" text DEFAULT 'warehouse' NOT NULL,
	"stock_enabled" boolean DEFAULT false NOT NULL,
	"public_visible" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"cutoff_ist" text DEFAULT '15:00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_nodes_code_unique" UNIQUE("code"),
	CONSTRAINT "pickup_nodes_pincode_format" CHECK ("pickup_nodes"."pincode" ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "pickup_nodes_kind_valid" CHECK ("pickup_nodes"."kind" in ('warehouse', 'retail', 'hub'))
);
--> statement-breakpoint
CREATE TABLE "pincodes" (
	"pincode" text PRIMARY KEY NOT NULL,
	"office_name" text DEFAULT '' NOT NULL,
	"taluk" text DEFAULT '' NOT NULL,
	"district" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	CONSTRAINT "pincodes_pincode_format" CHECK ("pincodes"."pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"sku" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"asin" text DEFAULT '' NOT NULL,
	"item_part_number" text DEFAULT '' NOT NULL,
	"size" text NOT NULL,
	"size_ml" integer DEFAULT 0 NOT NULL,
	"color" text,
	"weight_g" integer DEFAULT 0 NOT NULL,
	"length_cm" integer DEFAULT 0 NOT NULL,
	"width_cm" integer DEFAULT 0 NOT NULL,
	"height_cm" integer DEFAULT 0 NOT NULL,
	"price_inr" integer,
	"mrp_inr" integer DEFAULT 0 NOT NULL,
	"in_stock" boolean DEFAULT true NOT NULL,
	"stock_qty" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"best_before_mode" text DEFAULT 'printed_on_pack' NOT NULL,
	"best_before_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_price_inr_non_negative" CHECK ("product_variants"."price_inr" is null or "product_variants"."price_inr" >= 0),
	CONSTRAINT "product_variants_stock_qty_non_negative" CHECK ("product_variants"."stock_qty" is null or "product_variants"."stock_qty" >= 0),
	CONSTRAINT "product_variants_weight_g_range" CHECK ("product_variants"."weight_g" >= 0 and "product_variants"."weight_g" <= 50000),
	CONSTRAINT "product_variants_dimensions_non_negative" CHECK ("product_variants"."length_cm" >= 0 and "product_variants"."width_cm" >= 0 and "product_variants"."height_cm" >= 0),
	CONSTRAINT "product_variants_best_before_mode_valid" CHECK ("product_variants"."best_before_mode" in ('date', 'printed_on_pack')),
	CONSTRAINT "product_variants_best_before_date_required_when_dated" CHECK ("product_variants"."best_before_mode" <> 'date' or "product_variants"."best_before_date" is not null)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_best_seller" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"seasonal_discount_pct" integer DEFAULT 0 NOT NULL,
	"max_qty_per_user" integer,
	"new_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"hidden_reason" text DEFAULT '' NOT NULL,
	"manufacturer_name" text DEFAULT '' NOT NULL,
	"manufacturer_address" text DEFAULT '' NOT NULL,
	"country_of_origin" text DEFAULT 'India' NOT NULL,
	"consumer_care_contact" text DEFAULT '' NOT NULL,
	"unspsc_code" text DEFAULT '' NOT NULL,
	"generic_name" text DEFAULT '' NOT NULL,
	"included_components" text DEFAULT '' NOT NULL,
	"packer_name" text DEFAULT '' NOT NULL,
	"packer_address" text DEFAULT '' NOT NULL,
	"first_available_at" timestamp with time zone,
	"hsn_code" text DEFAULT '' NOT NULL,
	"gst_rate_pct" integer DEFAULT 0 NOT NULL,
	"manufacturer_licence" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_seasonal_discount_range" CHECK ("products"."seasonal_discount_pct" between 0 and 90),
	CONSTRAINT "products_max_qty_per_user_positive" CHECK ("products"."max_qty_per_user" is null or "products"."max_qty_per_user" > 0),
	CONSTRAINT "products_gst_rate_pct_valid" CHECK ("products"."gst_rate_pct" in (0, 5, 12, 18, 28))
);
--> statement-breakpoint
CREATE TABLE "review_helpful_votes" (
	"review_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_helpful_votes_review_id_user_id_pk" PRIMARY KEY("review_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"user_id" uuid,
	"author_name" text DEFAULT '' NOT NULL,
	"rating" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"verified_purchase" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_helpful_count_non_negative" CHECK ("reviews"."helpful_count" >= 0),
	CONSTRAINT "reviews_source_valid" CHECK ("reviews"."source" in ('user', 'amazon'))
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid,
	"awb" text NOT NULL,
	"source" text NOT NULL,
	"carrier_status" text,
	"carrier_status_type" text,
	"nsl_code" text,
	"status_code" text,
	"mapped_status" text NOT NULL,
	"scan_location" text,
	"instructions" text,
	"scanned_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb NOT NULL,
	"dedupe_hash" text NOT NULL,
	"actor_id" uuid,
	"note" text,
	CONSTRAINT "shipment_events_source_valid" CHECK ("shipment_events"."source" in ('webhook','poll','manual'))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"courier_code" text NOT NULL,
	"awb" text,
	"status" text DEFAULT 'pending_manifest' NOT NULL,
	"status_detail" text,
	"nsl_code" text,
	"reference_no" text,
	"pickup_id" text,
	"manifest_payload" jsonb,
	"manifest_error" text,
	"manifest_attempts" integer DEFAULT 0 NOT NULL,
	"promised_eta_days" integer,
	"promised_delivery_date" text,
	"carrier_edd" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"ndr_reason" text,
	"ndr_raised_at" timestamp with time zone,
	"manifested_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"out_for_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"rto_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"manual_courier_name" text,
	"manual_tracking_url" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"ops_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_status_valid" CHECK ("shipments"."status" in ('pending_manifest','manifested','picked_up','in_transit','out_for_delivery','ndr','rto_in_transit','delivered','rto_delivered','cancelled','exception')),
	CONSTRAINT "shipments_manifest_attempts_non_negative" CHECK ("shipments"."manifest_attempts" >= 0),
	CONSTRAINT "shipments_delivery_attempts_non_negative" CHECK ("shipments"."delivery_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sku_stock_policy" (
	"sku" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"low_stock_at" integer,
	"max_cascade_stores" integer,
	"max_radius_km" integer,
	"hub_fallback" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	CONSTRAINT "sku_stock_policy_mode_valid" CHECK ("sku_stock_policy"."mode" in ('auto', 'force_in', 'force_out')),
	CONSTRAINT "sku_stock_policy_low_stock_at_non_negative" CHECK ("sku_stock_policy"."low_stock_at" is null or "sku_stock_policy"."low_stock_at" >= 0),
	CONSTRAINT "sku_stock_policy_max_cascade_stores_positive" CHECK ("sku_stock_policy"."max_cascade_stores" is null or "sku_stock_policy"."max_cascade_stores" >= 1),
	CONSTRAINT "sku_stock_policy_max_radius_km_positive" CHECK ("sku_stock_policy"."max_radius_km" is null or "sku_stock_policy"."max_radius_km" >= 1)
);
--> statement-breakpoint
CREATE TABLE "store_stock" (
	"node_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"tracked" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	CONSTRAINT "store_stock_node_id_sku_pk" PRIMARY KEY("node_id","sku")
);
--> statement-breakpoint
CREATE TABLE "store_stock_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"old_qty" integer,
	"new_qty" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"changed_by" text DEFAULT '' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_stock_audit_reason_valid" CHECK ("store_stock_audit"."reason" in ('manual', 'order_paid', 'restock', 'correction', 'import'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"gender" text,
	"dob" date,
	"role" text DEFAULT 'customer' NOT NULL,
	"consent_accepted" boolean DEFAULT true NOT NULL,
	"marketing_whatsapp_opt_in" boolean,
	"marketing_whatsapp_opt_in_at" timestamp with time zone,
	"ad_audience_opt_in" boolean,
	"ad_audience_opt_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "wa_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_phone" text NOT NULL,
	"user_id" uuid,
	"profile_name" text,
	"ref_code" text,
	"status" text DEFAULT 'open' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_conversations_wa_phone_unique" UNIQUE("wa_phone"),
	CONSTRAINT "wa_conversations_status_valid" CHECK ("wa_conversations"."status" in ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"wa_message_id" text,
	"msg_type" text DEFAULT 'text' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text,
	"error" text,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_messages_wa_message_id_unique" UNIQUE("wa_message_id"),
	CONSTRAINT "wa_messages_direction_valid" CHECK ("wa_messages"."direction" in ('inbound','outbound')),
	CONSTRAINT "wa_messages_status_valid" CHECK ("wa_messages"."status" is null or "wa_messages"."status" in ('sent','delivered','read','failed'))
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_push_devices" ADD CONSTRAINT "admin_push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_config_audit" ADD CONSTRAINT "app_config_audit_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_sku_catalog_items_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."catalog_items"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_tickets" ADD CONSTRAINT "complaint_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_tickets" ADD CONSTRAINT "complaint_tickets_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_code_coupons_code_fk" FOREIGN KEY ("code") REFERENCES "public"."coupons"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_rate_slabs" ADD CONSTRAINT "courier_rate_slabs_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_service_areas" ADD CONSTRAINT "courier_service_areas_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_service_exceptions" ADD CONSTRAINT "courier_service_exceptions_courier_code_couriers_code_fk" FOREIGN KEY ("courier_code") REFERENCES "public"."couriers"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_number_invoices_invoice_number_fk" FOREIGN KEY ("invoice_number") REFERENCES "public"."invoices"("invoice_number") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndr_actions" ADD CONSTRAINT "ndr_actions_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndr_actions" ADD CONSTRAINT "ndr_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_notifications" ADD CONSTRAINT "ops_notifications_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_node_skus" ADD CONSTRAINT "pickup_node_skus_node_id_pickup_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."pickup_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_node_skus" ADD CONSTRAINT "pickup_node_skus_sku_catalog_items_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."catalog_items"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_categories_slug_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_helpful_votes" ADD CONSTRAINT "review_helpful_votes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_helpful_votes" ADD CONSTRAINT "review_helpful_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_payments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payments"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_stock_policy" ADD CONSTRAINT "sku_stock_policy_sku_catalog_items_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."catalog_items"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_stock" ADD CONSTRAINT "store_stock_node_id_pickup_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."pickup_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_stock" ADD CONSTRAINT "store_stock_sku_catalog_items_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."catalog_items"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_one_default_per_user" ON "addresses" USING btree ("user_id") WHERE "addresses"."is_default";--> statement-breakpoint
CREATE INDEX "addresses_user_id_created_at_idx" ON "addresses" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_push_devices_user_idx" ON "admin_push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_config_audit_key_changed_at_idx" ON "app_config_audit" USING btree ("key","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_items_product_id_idx" ON "catalog_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "categories_sort_order_idx" ON "categories" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "complaint_tickets_user_id_created_at_idx" ON "complaint_tickets" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "complaint_tickets_status_due_at_idx" ON "complaint_tickets" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_code_idx" ON "coupon_redemptions" USING btree ("code") WHERE "coupon_redemptions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_code_user_idx" ON "coupon_redemptions" USING btree ("code","user_id") WHERE "coupon_redemptions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "coupons_sort_order_idx" ON "coupons" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "courier_service_areas_courier_idx" ON "courier_service_areas" USING btree ("courier_code","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_fy_seq_idx" ON "credit_notes" USING btree ("fy","seq");--> statement-breakpoint
CREATE INDEX "credit_notes_issued_at_idx" ON "credit_notes" USING btree ("issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_number_idx" ON "credit_notes" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "credit_notes_order_id_idx" ON "credit_notes" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_fy_seq_idx" ON "invoices" USING btree ("fy","seq");--> statement-breakpoint
CREATE INDEX "invoices_issued_at_idx" ON "invoices" USING btree ("issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_user_id_idx" ON "invoices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invoices_email_status_idx" ON "invoices" USING btree ("email_status");--> statement-breakpoint
CREATE INDEX "ndr_actions_shipment_id_created_at_idx" ON "ndr_actions" USING btree ("shipment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ops_notifications_dedupe_key_idx" ON "ops_notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ops_notifications_status_enqueued_at_idx" ON "ops_notifications" USING btree ("status","enqueued_at");--> statement-breakpoint
CREATE INDEX "ops_notifications_order_id_idx" ON "ops_notifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_id_created_at_idx" ON "payment_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_razorpay_payment_id_key" ON "payment_attempts" USING btree ("razorpay_payment_id") WHERE "payment_attempts"."razorpay_payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_user_id_created_at_idx" ON "payments" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_utm_campaign_idx" ON "payments" USING btree ("utm_campaign","created_at");--> statement-breakpoint
CREATE INDEX "payments_heard_about_idx" ON "payments" USING btree ("heard_about","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_created_at_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pickup_nodes_active_priority_idx" ON "pickup_nodes" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX "pincodes_state_taluk_idx" ON "pincodes" USING btree ("state","taluk");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_size_color_idx" ON "product_variants" USING btree ("product_id","size","color");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");--> statement-breakpoint
CREATE INDEX "products_sort_order_idx" ON "products" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "reviews_product_id_helpful_idx" ON "reviews" USING btree ("product_id","helpful_count" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_one_per_user_product" ON "reviews" USING btree ("product_id","user_id") WHERE "reviews"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_events_dedupe_hash_idx" ON "shipment_events" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_id_scanned_at_idx" ON "shipment_events" USING btree ("shipment_id","scanned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipment_events_awb_idx" ON "shipment_events" USING btree ("awb");--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_status_updated_at_idx" ON "shipments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_awb_idx" ON "shipments" USING btree ("awb");--> statement-breakpoint
CREATE INDEX "store_stock_sku_idx" ON "store_stock" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "store_stock_audit_sku_changed_at_idx" ON "store_stock_audit" USING btree ("sku","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_stock_audit_node_changed_at_idx" ON "store_stock_audit" USING btree ("node_id","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wa_conversations_last_inbound_idx" ON "wa_conversations" USING btree ("last_inbound_at");--> statement-breakpoint
CREATE INDEX "wa_conversations_user_idx" ON "wa_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wa_messages_conversation_idx" ON "wa_messages" USING btree ("conversation_id","created_at");