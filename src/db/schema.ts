/**
 * Drizzle schema — the single source of truth for the database shape.
 * Migrations are generated from this file via `npm run db:generate` and
 * committed under `drizzle/`.
 *
 * Conventions (see docs/CONTRACTS.md):
 * - Phone numbers are stored E.164 (`+91` + 10 digits) in BOTH tables and
 *   serialized back to bare 10-digit strings at the API boundary.
 * - The partial unique index `addresses_one_default_per_user` enforces the
 *   one-default-per-user invariant at the DB level; the service layer keeps
 *   it true transactionally so the index never actually fires in practice.
 */

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * jsonb with a correct driver mapping. Drizzle's built-in `jsonb` re-parses
 * the driver value when it is a string — but pg and PGlite both return jsonb
 * ALREADY parsed, so a stored JSON string like "919999999999" (which the
 * driver hands back as a JS string) gets JSON.parse'd a second time and
 * silently becomes a number (same for "true", "null", …). Identity
 * `fromDriver` keeps the driver's one-and-only parse; `toDriver` stringifies
 * exactly like the built-in type, so the wire format is unchanged and
 * drizzle-kit still sees plain `jsonb` (no migration).
 */
const jsonbSafe = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb'
  },
  toDriver(value) {
    return JSON.stringify(value)
  },
  fromDriver(value) {
    return value
  },
})

/** One row per authenticated shopper, keyed by their Firebase phone-auth identity. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Firebase `uid` from the verified ID token. Upsert target on every authed request. */
  firebaseUid: text('firebase_uid').notNull().unique(),
  /** E.164 phone from the token's `phone_number` claim, e.g. "+919876543210". */
  phone: text('phone').notNull().unique(),
  /**
   * Display name, captured by the app's post-login profile prompt
   * (`PATCH /v1/me`). Null until the shopper fills it in — phone auth carries
   * no name of its own.
   */
  name: text('name'),
  /**
   * Contact email, captured alongside `name` by `PATCH /v1/me`. Nullable and
   * deliberately NOT unique: it is a marketing/contact field, never an identity
   * — the Firebase uid + phone remain the only login keys.
   */
  email: text('email'),
  /**
   * Title, 'miss' | 'mr'. Optional analytics field, captured alongside `dob`
   * by `PATCH /v1/me` — only ever entered from the profile screen, never
   * inferred or defaulted server-side.
   */
  gender: text('gender'),
  /**
   * Date of birth (date-only, no time/zone). Same optional-analytics rule as
   * `gender` — nullable, freely editable, never an identity field.
   */
  dob: date('dob', { mode: 'string' }),
  /** 'customer' | 'admin'. Promotion is manual (SQL) — no self-serve route. */
  role: text('role').notNull().default('customer'),
  /**
   * Terms of Use + Privacy Policy acceptance (DPDP Act 2023 + Consumer
   * Protection (E-Commerce) Rules 2020). Captured on the login screen — the
   * auth upsert forces it true whenever it isn't already (see plugins/auth.ts)
   * — rather than per-order at checkout. Defaults true so existing rows
   * backfill clean.
   */
  consentAccepted: boolean('consent_accepted').notNull().default(true),
  /**
   * WhatsApp MARKETING opt-in — the replenishment reminder and nothing else.
   * Transactional sends (order confirmed, shipped) do NOT read this: they are
   * UTILITY templates tied to an order the shopper placed.
   *
   * THREE-VALUED on purpose, and `consentAccepted`'s `default(true)` is exactly
   * the wrong shape here:
   *
   *   null   never asked — the opt-in checkbox has not shipped, or predates
   *          this shopper. Recoverable: a reminder parked against such an order
   *          delivers itself if they later opt in.
   *   false  explicitly declined, or opted out afterwards. TERMINAL — an
   *          opt-out that a later code path could quietly re-interpret as
   *          "unknown, ask again" is not an opt-out.
   *   true   opted in, with `marketingWhatsappOptInAt` as the timestamp.
   *
   * DPDP Act 2023 requires the consent be recorded, and Meta degrades a WABA's
   * quality rating for marketing sends to numbers that never asked for them —
   * the rating is GREEN today and is a business asset.
   *
   * This is the CURRENT state and the only thing a send may consult. The
   * order-time evidence is frozen separately in `payments.consent_snapshot`,
   * which is a legal record and is never read to decide whether to send.
   */
  marketingWhatsappOptIn: boolean('marketing_whatsapp_opt_in'),
  /** When {@link marketingWhatsappOptIn} last changed. Null while it is null. */
  marketingWhatsappOptInAt: timestamp('marketing_whatsapp_opt_in_at', { withTimezone: true }),
  /**
   * Ad-audience opt-in: consent to share this shopper's HASHED email and phone
   * with ad platforms (ChatGPT Ads custom audiences) so they can be matched —
   * in practice to EXCLUDE existing buyers from acquisition spend, or to show
   * them relevant offers.
   *
   * A separate purpose from {@link marketingWhatsappOptIn} under DPDP, so a
   * separate flag: agreeing to WhatsApp reminders is not agreeing to be
   * uploaded to OpenAI, and hashing does not make the upload anything other
   * than a disclosure of personal data. Same three-valued shape and for the
   * same reasons — null never asked, false declined or withdrawn (TERMINAL),
   * true opted in at {@link adAudienceOptInAt}.
   *
   * The audience export (`scripts/export-ad-audience.ts`) reads ONLY this
   * column, and only `true`. A withdrawal takes effect at the next export;
   * the upload already at OpenAI must then be replaced, not appended to.
   */
  adAudienceOptIn: boolean('ad_audience_opt_in'),
  /** When {@link adAudienceOptIn} last changed. Null while it is null. */
  adAudienceOptInAt: timestamp('ad_audience_opt_in_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A saved delivery address. Field names mirror mobile's AddressForm (snake_cased). */
export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Contact name for the delivery, 1..100. */
    name: text('name').notNull(),
    /** Contact phone, stored E.164 ("+91" + 10 digits). */
    phone: text('phone').notNull(),
    pincode: text('pincode').notNull(),
    city: text('city').notNull().default(''),
    state: text('state').notNull().default(''),
    /** Mobile field `houseNumber` ("House/ Flat/ Office No"). */
    houseNumber: text('house_number').notNull(),
    /** Mobile field `roadArea` ("Road Name/ Area/ Colony"). */
    roadArea: text('road_area').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One default address per user, enforced by the database itself. */
    uniqueIndex('addresses_one_default_per_user')
      .on(table.userId)
      .where(sql`${table.isDefault}`),
    /** List query: caller's addresses, newest first. */
    index('addresses_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
  ]
)

/**
 * Runtime config (SPEC-V2.md §2): key → arbitrary JSON value, admin-managed.
 * Read by other modules exclusively through `services/config.ts` — never
 * queried directly (see docs/ARCHITECTURE.md module rules).
 */
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonbSafe('value').notNull(),
  description: text('description').notNull().default(''),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One row per config write (upsert or delete) — full history, never mutated. */
export const appConfigAudit = pgTable(
  'app_config_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    /** Null on create (no prior value). */
    oldValue: jsonbSafe('old_value'),
    /** Null on delete (no value after the change). */
    newValue: jsonbSafe('new_value'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('app_config_audit_key_changed_at_idx').on(table.key, table.changedAt.desc())]
)

/**
 * Catalog read model (SPEC-V2.md §3): one row per sku, synced from the
 * tiny-tales-forus mobile catalog via `scripts/catalog-sync.ts`. Price authority
 * for cart/payments — never trust client-sent prices.
 */
export const catalogItems = pgTable(
  'catalog_items',
  {
    sku: text('sku').primaryKey(),
    productId: text('product_id').notNull(),
    name: text('name').notNull(),
    size: text('size').notNull(),
    priceInr: integer('price_inr').notNull(),
    /**
     * Projected from `product_variants.weight_g`. Cart may read `catalog_items`
     * and nothing else from catalog (ARCHITECTURE.md rule 3), so the shipping
     * weight has to be projected in alongside the price. 0 = unmeasured.
     */
    weightG: integer('weight_g').notNull().default(0),
    /**
     * Carton dimensions, projected alongside the weight for the same reason:
     * volumetric weight is part of what a courier bills, and the cart read path
     * cannot reach `product_variants`. 0 = unmeasured (volumetric contributes
     * nothing and dead weight decides).
     */
    lengthCm: integer('length_cm').notNull().default(0),
    widthCm: integer('width_cm').notNull().default(0),
    heightCm: integer('height_cm').notNull().default(0),
    imageUrl: text('image_url').notNull().default(''),
    /**
     * Projected from `products.hsnCode`/`gstRatePct`, same reason `weightG`
     * and the carton dimensions are duplicated here: cart/payments may read
     * only `catalog_items` (ARCHITECTURE.md rule 3), and tax needs these two
     * facts at order time. See the doc comment on `products.hsnCode`.
     */
    hsnCode: text('hsn_code').notNull().default(''),
    gstRatePct: integer('gst_rate_pct').notNull().default(0),
    /** False when the sku is absent from the most recent synced catalog file. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('catalog_items_product_id_idx').on(table.productId),
    check('catalog_items_price_inr_non_negative', sql`${table.priceInr} >= 0`),
    check('catalog_items_weight_g_range', sql`${table.weightG} >= 0 and ${table.weightG} <= 50000`),
    // 0 = unmeasured, same convention as weightG (a fresh import lands here
    // before seed-dev-dimensions/the admin editor measures it — see lib/
    // shipping.ts, which already treats all-zero dims as "no dims" and
    // refuses to quote). Partial data (some dims set, some still 0) is what
    // this actually guards against — measurement is all-or-nothing.
    check(
      'catalog_items_dimensions_positive',
      sql`(${table.lengthCm} = 0 and ${table.widthCm} = 0 and ${table.heightCm} = 0) or (${table.lengthCm} > 0 and ${table.widthCm} > 0 and ${table.heightCm} > 0)`
    ),
    check('catalog_items_gst_rate_pct_valid', sql`${table.gstRatePct} in (0, 5, 12, 18, 28)`),
  ]
)

/**
 * Catalog source of truth (SPEC-V2.md §3.2). Unlike `catalog_items` — a thin,
 * sku-keyed read model that stays cart's price authority — these three tables
 * (`categories`, `products`, `product_variants`) are the RICH, admin-editable
 * catalog: the data the mobile app renders. `GET /v1/catalog` joins them into
 * the exact shape mobile/src/lib/types.ts expects. On every admin write the
 * affected skus are re-projected into `catalog_items`, so cart/payments keep
 * their untouched price authority (see services/catalogAdmin.ts).
 *
 * A single-row `catalog_version` counter is bumped on every catalog write; its
 * value is the ETag for `GET /v1/catalog` (edge + on-device cache invalidation,
 * mirrors the app_config snapshot pattern).
 */
export const categories = pgTable(
  'categories',
  {
    /** Stable key matching a product's `category`, e.g. "hair oil". */
    slug: text('slug').primaryKey(),
    /** Display label, e.g. "Hair Oil". */
    label: text('label').notNull(),
    /** Category tile image (CDN URL). Empty until set from the admin UI. */
    imageUrl: text('image_url').notNull().default(''),
    /** Home-screen ordering; lower sorts first. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Hidden from the catalog when false (soft delete). */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('categories_sort_order_idx').on(table.sortOrder)]
)

/** One product family (e.g. Hair Oil), grouping its purchasable variants. */
export const products = pgTable(
  'products',
  {
    /** Stable product id, e.g. "dan-hair-oil". */
    id: text('id').primaryKey(),
    /** URL slug, e.g. "hair-oil". Route: /products/[slug]. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** FK to categories.slug — the product's category key. */
    category: text('category')
      .notNull()
      .references(() => categories.slug),
    description: text('description').notNull().default(''),
    /** string[] — PDP feature bullets. */
    bullets: jsonbSafe('bullets')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Highlight[] — {icon,label,value} fact tiles. */
    highlights: jsonbSafe('highlights')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** { main: ImageSet; gallery: ImageSet[]; hero?: ImageSet } — the 4-size image map. */
    images: jsonbSafe('images')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Merchandising: featured on the home best-seller rail. */
    isBestSeller: boolean('is_best_seller').notNull().default(false),
    /** Merchandising: shown in "recommended" surfaces. */
    isRecommended: boolean('is_recommended').notNull().default(false),
    /** Home/category ordering; lower sorts first. */
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Seasonal discount applied across this product's variants, 0..90 percent.
     * 0 = no discount. Display/price math applies it to each variant's price.
     */
    seasonalDiscountPct: integer('seasonal_discount_pct').notNull().default(0),
    /** Per-user purchase cap for this product (retail). Null = use the global cart limit. */
    maxQtyPerUser: integer('max_qty_per_user'),
    /** ISO date; when in the future the app badges the product "new". Null = never. */
    newUntil: timestamp('new_until', { withTimezone: true }),
    /** Soft delete / unpublish — excluded from the public catalog when false. */
    active: boolean('active').notNull().default(true),
    /**
     * Takedown flag. A hidden product disappears from the public catalog and
     * its skus stop being purchasable, exactly like `active: false`, but it is
     * a separate switch on purpose: `active` is merchandising (is it on sale?)
     * while `hidden` is compliance (a rights-holder complaint or an ad
     * rejection). Flipping it must not lose the merchandising state, and an
     * operator unhiding a product must not accidentally publish one that was
     * never meant to be live. The edge Worker also answers 410 for a hidden
     * product's URLs until the next static build drops its page.
     */
    hidden: boolean('hidden').notNull().default(false),
    /** Why it was hidden (free text for the audit trail); '' while visible. */
    hiddenReason: text('hidden_reason').notNull().default(''),
    /**
     * Legal Metrology (Packaged Commodities) Rules + Consumer Protection
     * (E-Commerce) Rules mandatory PDP disclosures. Additive NOT NULL columns
     * with safe defaults (never breaks an existing migration on already-live
     * rows) — "can't go live incomplete" is enforced in application code
     * (services/catalogAdmin.ts, `assertProductLegalMetrologyComplete`) at the
     * moment a product is set `active: true`, not by a DB CHECK, since a hard
     * CHECK tied to `active` would fail the migration itself against any
     * currently-live product still missing this data.
     */
    manufacturerName: text('manufacturer_name').notNull().default(''),
    manufacturerAddress: text('manufacturer_address').notNull().default(''),
    countryOfOrigin: text('country_of_origin').notNull().default('India'),
    consumerCareContact: text('consumer_care_contact').notNull().default(''),
    /**
     * Marketplace catalogue attributes mirrored from the Amazon listing, shown
     * in the PDP "Product details" spec block (docs/SPEC-PDP-DETAILS.md). Same
     * additive-with-safe-default rule as the Legal Metrology block above: an
     * empty string means "not known yet" and the PDP omits the row entirely
     * rather than rendering a blank value. `packerName`/`packerAddress` are the
     * Legal Metrology packer declaration — usually the same entity as the
     * manufacturer, but the rule requires it stated separately.
     */
    unspscCode: text('unspsc_code').notNull().default(''),
    genericName: text('generic_name').notNull().default(''),
    includedComponents: text('included_components').notNull().default(''),
    packerName: text('packer_name').notNull().default(''),
    packerAddress: text('packer_address').notNull().default(''),
    /** "Date First Available" on the marketplace listing. Null = unknown. */
    firstAvailableAt: timestamp('first_available_at', { withTimezone: true }),
    /**
     * GST (docs plan `there-s-a-big-strategy-validated-clover.md` §2.1-2.2).
     * `hsnCode`/`gstRatePct` are the two facts that decide a line's tax and are
     * PROJECTED into `catalog_items` on every admin save so cart/payments can
     * see them without crossing the read-model boundary (ARCHITECTURE.md rule
     * 3) — then FROZEN into `payments.cart_snapshot` at order time, same
     * pattern as price, so a rate change never alters an already-issued
     * invoice. `gstRatePct` 0 default is a real 0% slab, not "unset" — the
     * catalog `active: true` gate (services/catalogAdmin.ts) is what actually
     * requires it be set deliberately once the seller is GST-registered.
     */
    hsnCode: text('hsn_code').notNull().default(''),
    gstRatePct: integer('gst_rate_pct').notNull().default(0),
    /**
     * Per-product manufacturing licence number (Cosmetics Rules 2020) — LIVE
     * as of Phase 3. `lib/invoiceDocument.ts` prints this against the product's
     * OWN manufacturer; the configured `legal.manufacturer.licence` is used
     * only for a product that declares no manufacturer of its own and therefore
     * inherits that entity wholesale.
     *
     * Required by `assertProductLegalMetrologyComplete` before a product that
     * names its own manufacturer can go `active: true` — a second supplier's
     * product must not ship with a blank licence, and it must never inherit the
     * first supplier's.
     */
    manufacturerLicence: text('manufacturer_licence').notNull().default(''),
    /**
     * Marketing brand, e.g. "Tiny Tales" / "Daniya". `''` ⇒ the store-wide
     * `legal.company.brand`, which is what every product carried before this
     * column existed.
     *
     * Distinct from `manufacturerName` on purpose: the brand is who MARKETS the
     * product, the manufacturer is who MAKES it, and the Legal Metrology and
     * Cosmetics Rules declarations are about the latter. One maker can supply
     * several brands and one brand can be made by several makers, so neither
     * field can be derived from the other.
     */
    brand: text('brand').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('products_category_idx').on(table.category),
    index('products_sort_order_idx').on(table.sortOrder),
    check('products_seasonal_discount_range', sql`${table.seasonalDiscountPct} between 0 and 90`),
    check(
      'products_max_qty_per_user_positive',
      sql`${table.maxQtyPerUser} is null or ${table.maxQtyPerUser} > 0`
    ),
    check('products_gst_rate_pct_valid', sql`${table.gstRatePct} in (0, 5, 12, 18, 28)`),
  ]
)

/** One purchasable size of a product. `sku` is the cart line identity. */
export const productVariants = pgTable(
  'product_variants',
  {
    /** MFN seller-sku — matches catalog_items.sku (projected on write). */
    sku: text('sku').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Amazon ASIN, informational. */
    asin: text('asin').notNull().default(''),
    /** Manufacturer's part number for this pack (e.g. "DCM500"). '' = unknown. */
    itemPartNumber: text('item_part_number').notNull().default(''),
    /** Display size copy, e.g. "200ml". */
    size: text('size').notNull(),
    /** Numeric size in ml (1L = 1000) for per-ml math. */
    sizeMl: integer('size_ml').notNull().default(0),
    /** Shade/color slug (e.g. "lavender-blue"), for products sold in multiple colors. Null when the product has none. */
    color: text('color'),
    /**
     * Packed product weight in grams, EXCLUDING the outer shipping carton
     * (that is `shipping.packagingTareG`, added once per cart). 0 means "not
     * measured yet" — shipping treats it as unknown and refuses to quote
     * rather than pricing a parcel at tare (see lib/shipping.ts).
     */
    weightG: integer('weight_g').notNull().default(0),
    /** Carton dimensions in cm, for volumetric weight (L×W×H×1000/divisor). 0 = unmeasured. */
    lengthCm: integer('length_cm').notNull().default(0),
    widthCm: integer('width_cm').notNull().default(0),
    heightCm: integer('height_cm').notNull().default(0),
    /**
     * Selling price in whole rupees, or NULL while the price is not set yet.
     * An unpriced variant is shown ("Coming soon / Notify me") but is never
     * projected as purchasable, so cart and checkout refuse it server-side.
     * Prices are never hard-coded anywhere else.
     */
    priceInr: integer('price_inr'),
    /** MRP (strike-through) in INR. */
    mrpInr: integer('mrp_inr').notNull().default(0),
    /** Per-variant availability. */
    inStock: boolean('in_stock').notNull().default(true),
    /** On-hand quantity; null = untracked (treat as available while in_stock). */
    stockQty: integer('stock_qty'),
    /** Variant ordering within a product; ascending by size by default. */
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Legal Metrology "best before/use by" disclosure. Most SKUs don't carry a
     * single fixed expiry the DB can track (batches rotate) — 'printed_on_pack'
     * is the honest default and satisfies the rule on its own. Set 'date' only
     * when this specific sku/batch has one fixed date to declare.
     */
    bestBeforeMode: text('best_before_mode').notNull().default('printed_on_pack'),
    /** Required when `bestBeforeMode = 'date'`; null (and ignored) otherwise. */
    bestBeforeDate: timestamp('best_before_date', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('product_variants_product_id_idx').on(table.productId),
    uniqueIndex('product_variants_product_size_color_idx').on(
      table.productId,
      table.size,
      table.color
    ),
    check(
      'product_variants_price_inr_non_negative',
      sql`${table.priceInr} is null or ${table.priceInr} >= 0`
    ),
    check(
      'product_variants_stock_qty_non_negative',
      sql`${table.stockQty} is null or ${table.stockQty} >= 0`
    ),
    /** 50 kg is far above anything this catalog ships — a fat-fingered 1050000 must not price a parcel. */
    check(
      'product_variants_weight_g_range',
      sql`${table.weightG} >= 0 and ${table.weightG} <= 50000`
    ),
    check(
      'product_variants_dimensions_non_negative',
      sql`${table.lengthCm} >= 0 and ${table.widthCm} >= 0 and ${table.heightCm} >= 0`
    ),
    check(
      'product_variants_best_before_mode_valid',
      sql`${table.bestBeforeMode} in ('date', 'printed_on_pack')`
    ),
    check(
      'product_variants_best_before_date_required_when_dated',
      sql`${table.bestBeforeMode} <> 'date' or ${table.bestBeforeDate} is not null`
    ),
  ]
)

/**
 * Single-row catalog version counter. Bumped on every catalog write; its value
 * is the ETag for `GET /v1/catalog`. `id` is pinned to a constant so there is
 * exactly one row (see services/catalogVersion.ts).
 */
export const catalogVersion = pgTable('catalog_version', {
  /** Always the string 'catalog' — enforces a single row. */
  id: text('id').primaryKey(),
  /** Monotonic counter; the current ETag value (as a string). */
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Cart lines (SPEC-V2.md §4): one row per (user, sku). `priceInrSnapshot` is
 * refreshed from `catalog_items` on every write — it's the audit/orders
 * record, not what's displayed (display always joins the live catalog price
 * at read time, see `services/cart.ts`).
 */
export const cartItems = pgTable(
  'cart_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sku: text('sku')
      .notNull()
      .references(() => catalogItems.sku),
    qty: integer('qty').notNull(),
    /** Catalog price at the time of last write — audit trail, not display. */
    priceInrSnapshot: integer('price_inr_snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.sku] }),
    check('cart_items_qty_range', sql`${table.qty} between 1 and 99`),
  ]
)

/**
 * Coupons — order-level discounts, applied on top of the post-wholesale cart
 * subtotal (see lib/coupons.ts / services/cart.ts). `code` is the PK
 * (uppercase-normalized in the service on every write), so the natural
 * identity is the code and admin routes are `/:code`. This table is itself
 * the admin-CRUD-edited config surface for "per-coupon" facts (code, discount,
 * validity window); the ONE genuinely global coupon knob — how many cards
 * `GET /v1/coupons` returns — lives in `app_config` as
 * `coupons.autoSuggestCount` instead, since it's a display policy, not a
 * per-coupon fact. All-scalar columns, so no jsonb/jsonbSafe needed.
 */
export const coupons = pgTable(
  'coupons',
  {
    /** Uppercase-normalized in the service on every write. PK — also the admin route param. */
    code: text('code').primaryKey(),
    /** Rendered as PLAIN TEXT only (React auto-escape / RN Text) — free-text admin input. */
    label: text('label').notNull(),
    /** Card subline; same plain-text rendering rule as `label`. */
    description: text('description').notNull().default(''),
    /** 'flat' | 'percent' — enforced by the `coupons_discount_type_valid` check. */
    discountType: text('discount_type').notNull(),
    /** Percent 1..90 when `discountType = 'percent'`; whole rupees > 0 when 'flat'. */
    discountValue: integer('discount_value').notNull(),
    /** Evaluated against the post-wholesale coupon subtotal, not the retail one. */
    minCartInr: integer('min_cart_inr').notNull().default(0),
    /** Cap on a percent coupon's discount; null = uncapped. Unused for 'flat'. */
    maxDiscountInr: integer('max_discount_inr'),
    /** Null = no lower bound. */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    /** Null = no upper bound. Time-valid when now is within [validFrom, validTo]. */
    validTo: timestamp('valid_to', { withTimezone: true }),
    /** Soft on/off; the public list and pricing both require `active = true`. */
    active: boolean('active').notNull().default(true),
    /** Ascending display order in the offers strip. */
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Waive the delivery fee outright while this coupon is APPLIED, regardless
     * of `shipping.freeAboveTiers`. Exists because retention copy can promise
     * free delivery to a shopper whose refill cart never clears the threshold
     * — `tinytales_refill_reminder` says "10% OFF + Free Express Shipping", and
     * ten of fourteen active SKUs sit under the ₹249 tier, so without this the
     * message is a promise the pricing engine cannot keep.
     *
     * A COLUMN, not a hardcoded `code === 'REFILL10'`: the next retention code
     * would otherwise need a code change and a deploy to make the same promise.
     *
     * Defaults false — every coupon written before this column existed keeps
     * charging freight, so this is inert until an operator turns it on.
     */
    waivesShipping: boolean('waives_shipping').notNull().default(false),
    /**
     * Total redemptions this code allows across all shoppers; null = unlimited
     * (every coupon written before this column existed). Counted against
     * `coupon_redemptions` rows that are not revoked, so a refunded order gives
     * its slot back.
     *
     * Enforced at PRICING time, not with a constraint: an exhausted coupon
     * simply stops discounting (`reason: 'usage_exceeded'`), exactly as an
     * expired one does. Two checkouts racing on the last slot can therefore both
     * take it — the same bounded overshoot the stock module accepts, and for the
     * same reason: refusing a sale to protect a discount counter is the more
     * expensive failure.
     */
    usageLimit: integer('usage_limit'),
    /** Redemptions one shopper may make of this code; null = unlimited. Same enforcement as {@link usageLimit}. */
    perUserLimit: integer('per_user_limit'),
    /** Light audit, mirrors `app_config.updated_by`. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('coupons_sort_order_idx').on(table.sortOrder),
    check('coupons_discount_type_valid', sql`${table.discountType} in ('flat','percent')`),
    check(
      'coupons_discount_value_valid',
      sql`(${table.discountType} = 'percent' and ${table.discountValue} between 1 and 90) or (${table.discountType} = 'flat' and ${table.discountValue} > 0)`
    ),
    check('coupons_min_cart_inr_non_negative', sql`${table.minCartInr} >= 0`),
    check(
      'coupons_max_discount_inr_valid',
      sql`${table.maxDiscountInr} is null or ${table.maxDiscountInr} > 0`
    ),
    check('coupons_usage_limit_valid', sql`${table.usageLimit} is null or ${table.usageLimit} > 0`),
    check(
      'coupons_per_user_limit_valid',
      sql`${table.perUserLimit} is null or ${table.perUserLimit} > 0`
    ),
  ]
)

/**
 * Coupon redemption ledger — one row per PAID order that actually took a
 * discount. This is what makes `coupons.usage_limit` / `per_user_limit`
 * enforceable, and the only place that answers "which code did this order
 * use": `cart_snapshot` froze the discount in rupees, not the code that
 * produced it (rows written before `couponCode` joined the snapshot still
 * carry no code at all, which is why this ledger starts empty rather than
 * being backfillable).
 *
 * Written INSIDE the `paid` transition, from a hook wired in
 * `routes/payments.ts` (ARCHITECTURE.md rule 2 — payments may not import the
 * coupon service). Not written at order-create: a pending order that is
 * abandoned or expires by the recover sweep must not burn a slot, and there is
 * no reliable moment to hand one back.
 *
 * `order_id` is the PK, which is what makes the hook idempotent under
 * verify/webhook/recover racing on the same capture — the insert is an
 * `ON CONFLICT DO NOTHING`.
 */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    /** The paid order that redeemed the coupon. PK — one redemption per order, at most. */
    orderId: text('order_id')
      .primaryKey()
      .references(() => payments.orderId, { onDelete: 'cascade' }),
    /**
     * No cascade and no set-null: a redeemed coupon must not be erasable, and a
     * ledger row with no code is not a ledger row. `services/coupons.ts`
     * pre-checks this in `deleteCoupon` so an admin gets a readable 422 rather
     * than a constraint violation — deactivate the coupon instead.
     */
    code: text('code')
      .notNull()
      .references(() => coupons.code),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Rupees actually taken off this order — the ledger's own copy, not re-derived from the snapshot. */
    discountInr: integer('discount_inr').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Stamped when the order is refunded, which RELEASES the slot: the limit
     * counts only unrevoked rows. The row itself is never deleted — the ledger
     * has to still show that this shopper redeemed and then cancelled.
     *
     * The trade is deliberate. Keeping a refunded redemption consumed would
     * punish an ordinary cancellation; releasing it lets someone cycle
     * order → refund → order, which costs them the goods and gains them
     * nothing but a retry of a discount they were already entitled to.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    /** Both count queries: total per code, and per (code, user). Live rows only. */
    index('coupon_redemptions_code_idx')
      .on(table.code)
      .where(sql`${table.revokedAt} is null`),
    index('coupon_redemptions_code_user_idx')
      .on(table.code, table.userId)
      .where(sql`${table.revokedAt} is null`),
  ]
)

/**
 * Payments (SPEC-PAYMENTS.md v3): one row per Razorpay order. `order_id` (the
 * Razorpay order id) is the PK, so a replayed webhook/verify targets the same
 * row. Rows are user-scoped (cross-user access reads as 404). Both snapshots
 * are frozen at order-create time: `cart_snapshot` is the priced lines +
 * totals (the amount authority for the webhook amount/currency re-check),
 * `address_snapshot` is the shipping address. The `paid` transition is a
 * single guarded UPDATE (`status = 'pending'` predicate) so it is idempotent,
 * and it clears the user's `cart_items` in the SAME transaction.
 *
 * Owned by the `payments` module; consumes the shared `users`, `cart_items`,
 * `catalog_items`, `addresses` read models but its table is its own (clean
 * extraction seam — see docs/ARCHITECTURE.md).
 */
export const payments = pgTable(
  'payments',
  {
    /** Razorpay order id (e.g. "order_XXXX"). PK — replays are no-ops on the same row. */
    orderId: text('order_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Server-computed amount in paise (INR × 100). Never client-supplied. */
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    status: text('status').notNull().default('pending'),
    /** Razorpay payment id — null until a payment is captured/verified against the order. */
    razorpayPaymentId: text('razorpay_payment_id'),
    /**
     * What the Razorpay order was created for. Every Tiny Tales order is
     * prepaid (no cash on delivery), so this always equals `amountPaise`. It is
     * kept as a generated column because the gateway-amount checks (verify,
     * webhook, recover, refund) read it by that name.
     */
    prepaidAmountPaise: integer('prepaid_amount_paise')
      .notNull()
      .generatedAlwaysAs(sql`"amount_paise"`),
    /** Priced cart lines + totals at order time (the amount authority). */
    cartSnapshot: jsonbSafe('cart_snapshot').notNull(),
    /** Shipping address at order time (physical-goods orders capture it at payment). */
    addressSnapshot: jsonbSafe('address_snapshot').notNull(),
    /**
     * The delivery quote frozen at order-create — `{ nodeId, nodeCode,
     * courierCode, zone, chargeableWeightG, customerFeeInr, trueCostInr,
     * etaDays, destPincode }`. Null for orders created before shipping existed
     * (and while `shipping.enabled` is false). This is what the ops/margin
     * report reads: the fee charged AND the cost incurred, per order.
     */
    shippingSnapshot: jsonbSafe('shipping_snapshot'),
    /**
     * Order-time consent record — `{ terms: { version, acceptedAt }, privacy:
     * { version, acceptedAt } }`, itemised (not one bundled acceptance) and
     * frozen at the instant the order was created. Null only for orders
     * created before this capture existed; every order-create request since
     * requires both acceptances (contracts/payment.ts `PaymentOrderCreateSchema`).
     */
    consentSnapshot: jsonbSafe('consent_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set the moment the row transitions to `paid`; null otherwise. */
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Shopper-picked reason on cancel (from `orders.cancelReasons` config); null until cancelled. */
    cancelReason: text('cancel_reason'),
    /**
     * The refund record, written when the `paid → refunded` transition happens.
     *
     * `status = 'refunded'` alone answers "did the money go back" but none of
     * the questions a shopper staring at a cancelled order actually asks — how
     * much, to which account, has the bank released it yet, when does it land.
     * These columns are what the order screen's Refund details sheet reads, and
     * they are all NULLABLE on purpose: orders refunded before this existed
     * keep only their status, and the sheet degrades to amount + "processed"
     * rather than inventing a destination it does not know.
     *
     * Refund state is Razorpay's, mirrored here — never derived. `pending`
     * means the gateway has accepted the refund but the bank has not released
     * it; `processed` is the `refund.processed` webhook (or an instant-speed
     * refund that came back processed on the spot); `failed` is the
     * `refund.failed` webhook, which is exactly the case a shopper must not be
     * told "Success" about. The order stays `refunded` either way — the money
     * left our side, and a failed remittance is a support case, not a reversal.
     */
    razorpayRefundId: text('razorpay_refund_id'),
    refundStatus: text('refund_status'),
    /** Refunded amount in paise. Always the full `amount_paise` today; stored so partials don't need a migration. */
    refundAmountPaise: integer('refund_amount_paise'),
    /** Razorpay's `speed_processed` — 'instant' lands the same day, 'normal'/'optimum' take working days. */
    refundSpeed: text('refund_speed'),
    /** When we asked Razorpay for the refund — the clock the "credit by" date counts from. */
    refundInitiatedAt: timestamp('refund_initiated_at', { withTimezone: true }),
    /** When Razorpay reported it processed; null while `refund_status` is 'pending'. */
    refundProcessedAt: timestamp('refund_processed_at', { withTimezone: true }),
    /**
     * Where the money went, read off the PAYMENT entity at refund time (a
     * refund entity carries no instrument): `{ method, upiVpa?, cardLast4?,
     * cardNetwork?, bank?, wallet? }`. A refund always returns to the source
     * instrument, so the payment's instrument IS the destination.
     *
     * Nothing here is a full instrument identifier — a VPA, a network name, a
     * card's last four. The shopper needs to recognise the account, not to be
     * able to pay from it.
     */
    refundDestination: jsonbSafe('refund_destination'),
    /**
     * The CLIENT's RudderStack `anonymousId`, captured at order-create.
     *
     * `Order Completed` is emitted server-side (it is the only place that knows
     * the money actually moved), but the shopper's whole pre-purchase session —
     * every product view, every search, the add-to-cart — was recorded against
     * this id by the app. Without carrying it onto the order, the purchase
     * arrives as an unattributed event and every funnel breaks at the last step:
     * the warehouse cannot join the sale to the session that produced it, and
     * the ad platforms cannot credit the click that started it.
     *
     * It is an opaque client-generated UUID, not personal data on its own, and
     * it is written once at create and never updated — a later session gets a
     * new id, but this order belongs to the session that placed it.
     *
     * Null for orders created before this existed, and for any client that did
     * not send one (analytics is a supported no-op when unconfigured).
     */
    analyticsAnonymousId: text('analytics_anonymous_id'),
    /**
     * Campaign attribution, frozen at CREATE from the landing URL the shopper
     * arrived on. Same freezing rule as `analyticsAnonymousId` above and for
     * the same reason: at capture time the request may be a Razorpay webhook
     * or the recovery sweep, neither of which knows anything about the device.
     *
     * This is what makes realised CAC computable — `spend / orders where
     * utm_campaign = '<the campaign>'`. Without it a click and a sale can both
     * be counted but never joined, and a campaign's kill rule cannot be
     * enforced.
     *
     * All nullable: most orders are organic and carry nothing here. Null means
     * "arrived with no campaign", which an empty string could not distinguish.
     */
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    /**
     * Google's click id. Nothing reads it today; it is stored so an offline
     * conversion upload back to Ads is possible later without a backfill —
     * that upload is the only path that ever makes Ads itself report CAC.
     */
    gclid: text('gclid'),
    /** Creative label and OpenAI click ID, frozen with the order. */
    utmContent: text('utm_content'),
    oppref: text('oppref'),
    /**
     * "How did you hear about us?", answered by the shopper at checkout.
     *
     * Deliberately NOT an attribution field, and never summed with `utmCampaign`
     * or with Ads conversions. `utm_*` records what the click claimed; this
     * records what the person says, and the two disagree in the case that
     * matters most — someone who saw the product on Instagram, searched the
     * brand three days later and converted on a paid click is both
     * `utmCampaign: '<the campaign>'` and `heardAbout: 'instagram'`. Realised
     * CAC stays `spend / orders where utm_campaign = ...`; this answers the
     * different question of which channel created the demand paid search then
     * harvested.
     *
     * One of the values in `payments_heard_about_valid`. Null is the common
     * case and means "not answered" — the question is optional at checkout on
     * purpose, because making a stranger complete a survey to hand over ₹700
     * costs more conversion than the answer is worth.
     */
    heardAbout: text('heard_about'),
    /**
     * Free text, only ever set when `heardAbout === 'other'` (enforced by
     * `payments_heard_about_other_requires_other`). This is the half that finds
     * the channel the pick-list forgot — read it before adding a value to the
     * list.
     */
    heardAboutOther: text('heard_about_other'),
  },
  (table) => [
    index('payments_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
    /** Campaign roll-ups scan by campaign over a date window. */
    index('payments_utm_campaign_idx').on(table.utmCampaign, table.createdAt),
    /** The only read on the survey: count answers over a date window. */
    index('payments_heard_about_idx').on(table.heardAbout, table.createdAt),
    /** The recover sweep scans by status + age. */
    index('payments_status_created_at_idx').on(table.status, table.createdAt),
    check('payments_amount_paise_positive', sql`${table.amountPaise} > 0`),
    check('payments_status_valid', sql`${table.status} in ('pending','paid','failed','refunded')`),
    /**
     * The checkout survey's pick-list, held as a CHECK rather than a pg enum
     * for the same reason as `payments_status_valid`: adding a value is a
     * one-line migration and nothing has to be cast.
     */
    check(
      'payments_heard_about_valid',
      sql`${table.heardAbout} is null or ${table.heardAbout} in ('google_search','instagram','facebook','youtube','whatsapp','amazon','friend_family','other')`
    ),
    /**
     * Free text without the 'other' choice is a client bug, not a report shape.
     *
     * `is not distinct from`, not `=`: a CHECK passes when it evaluates to
     * NULL, and `heard_about = 'other'` is NULL on the very row this exists to
     * reject — free text with no choice beside it.
     */
    check(
      'payments_heard_about_other_requires_other',
      sql`${table.heardAboutOther} is null or ${table.heardAbout} is not distinct from 'other'`
    ),
    check(
      'payments_refund_status_valid',
      sql`${table.refundStatus} is null or ${table.refundStatus} in ('pending','processed','failed')`
    ),
  ]
)

/**
 * Gateway attempt log — every payment attempt we ever OBSERVE against an order,
 * one row each, append-only.
 *
 * `payments` carries a single `razorpay_payment_id` because it is the ORDER: it
 * records the attempt that succeeded and nothing else. A shopper whose card is
 * declined twice before their UPI works produces three payment entities at
 * Razorpay and, today, one id here — so "why was I charged twice", "did the
 * decline reach us", and "which of these ids is the refundable one" are all
 * questions only the Razorpay dashboard can answer. This table is the local
 * copy that makes them answerable from our own database.
 *
 * It is a LOG, not a state machine: it never drives a transition, and nothing
 * reads it to make a decision. The order's status remains the single authority
 * (SPEC-PAYMENTS.md invariants #5/#6). That is deliberate — a reconciliation
 * trail that can change behaviour is a second source of truth, which is the
 * problem it exists to solve, not to recreate.
 *
 * Writes are best-effort and swallow their own errors: every insert here
 * happens on a path where money has already moved, and an exception would roll
 * back a captured payment to protect a log line.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: text('order_id')
      .notNull()
      .references(() => payments.orderId, { onDelete: 'cascade' }),
    /**
     * Razorpay's `payment.entity.id` for this attempt — the id a refund or a
     * support ticket is keyed by. Nullable because not every observation has
     * one (a sweep that expires an order never saw a payment entity at all).
     */
    razorpayPaymentId: text('razorpay_payment_id'),
    /**
     * 'captured' — the attempt that paid the order.
     * 'failed' — Razorpay reported `payment.failed` for it.
     * 'mismatched' — money exists but its amount/currency does not match the
     *   order, so no transition was made (both the webhook and the recover
     *   sweep refuse this case and log it; this is where it becomes queryable).
     */
    status: text('status').notNull(),
    /** As reported by the gateway for THIS attempt — not copied from the order. */
    amountPaise: integer('amount_paise'),
    /** `card` / `upi` / `netbanking` / … as Razorpay names it; null when the event omits it. */
    method: text('method'),
    /** Razorpay's `error_code` / `error_description` / `error_reason` / `error_source` / `error_step`. */
    errorCode: text('error_code'),
    errorDescription: text('error_description'),
    errorReason: text('error_reason'),
    errorSource: text('error_source'),
    errorStep: text('error_step'),
    /** Which path saw it: 'verify' | 'webhook' | 'recover' | 'poll'. */
    observedBy: text('observed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('payment_attempts_order_id_created_at_idx').on(table.orderId, table.createdAt),
    /**
     * Razorpay retries a webhook until it gets a 200, and verify races the
     * webhook on the same capture — so the same payment entity arrives more
     * than once and must log once. Partial, because the rows with no payment
     * id have nothing to deduplicate on.
     */
    uniqueIndex('payment_attempts_razorpay_payment_id_key')
      .on(table.razorpayPaymentId)
      .where(sql`${table.razorpayPaymentId} is not null`),
    check(
      'payment_attempts_status_valid',
      sql`${table.status} in ('captured','failed','mismatched')`
    ),
    check(
      'payment_attempts_observed_by_valid',
      sql`${table.observedBy} in ('verify','webhook','recover','poll')`
    ),
  ]
)

/**
 * Complaint tickets (Consumer Protection (E-Commerce) Rules 2020, Rule 4(6)):
 * every shopper complaint gets an auto-generated, shopper-facing tracking
 * number and a one-month resolution SLA (`due_at = created_at + 30 days`).
 * Owned by its own `complaints` module — consumes the shared `users`/
 * `payments` read models, never another module's service.
 */
export const complaintTickets = pgTable(
  'complaint_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Shopper-facing tracking id, e.g. "TT-20260725-7K3QZM". Generated in the service; retried on the rare collision. */
    ticketNumber: text('ticket_number').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional — not every complaint concerns a specific order. */
    orderId: text('order_id').references(() => payments.orderId, { onDelete: 'set null' }),
    /**
     * Optional seller-sku the complaint is about. Deliberately NOT a foreign
     * key to `catalog_items`: a complaint has to outlive the listing it names
     * (a delisted/renamed sku must not blank the ticket it was filed against),
     * so this is a frozen copy of what the shopper picked, same rule as the
     * order line items.
     */
    sku: text('sku'),
    /** Enforced by `complaint_tickets_category_valid`. */
    category: text('category').notNull(),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    /** 'open' | 'in_progress' | 'resolved' | 'closed' — enforced by `complaint_tickets_status_valid`. */
    status: text('status').notNull().default('open'),
    /** Admin-facing resolution note; set on resolve/close, null until then. */
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** `createdAt` + 30 days — Rule 4(6)'s one-month resolution SLA. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** Set the moment status moves to 'resolved' or 'closed'; null otherwise. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('complaint_tickets_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
    /** An SLA sweep scans open/in_progress tickets ordered by how close they are to `dueAt`. */
    index('complaint_tickets_status_due_at_idx').on(table.status, table.dueAt),
    check(
      'complaint_tickets_category_valid',
      sql`${table.category} in ('product_quality','delivery_shipping','billing_payment','order_issue','other')`
    ),
    check(
      'complaint_tickets_status_valid',
      sql`${table.status} in ('open','in_progress','resolved','closed')`
    ),
  ]
)

/**
 * Damage claims: the ONLY return path. Tiny Tales takes no change-of-mind
 * returns; a piece that arrives broken is reported here with photos (and an
 * optional unboxing video) inside the `returns.damageWindowHours` window,
 * counted from the shipment's recorded delivery.
 *
 * One row per (order, sku) claim. An admin decides it: a refund (through the
 * existing refund / credit-note path) or a replacement. `sku` is a frozen copy,
 * not a foreign key, for the same reason as complaint tickets: the claim must
 * outlive a renamed or delisted listing.
 */
export const damageClaims = pgTable(
  'damage_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Shopper-facing id, e.g. "TT-DC-20261026-7K3QZM". */
    claimNumber: text('claim_number').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderId: text('order_id')
      .notNull()
      .references(() => payments.orderId, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    qty: integer('qty').notNull().default(1),
    description: text('description').notNull(),
    /** string[] of image-intake keys for the damage photos (1 to 6). */
    photoKeys: jsonbSafe('photo_keys').notNull(),
    /** Optional link to an unboxing video the shopper recorded. */
    unboxingVideoUrl: text('unboxing_video_url'),
    /** The delivery the window was measured from, frozen at submission. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
    /** 'submitted' | 'in_review' | 'approved_refund' | 'approved_replacement' | 'rejected'. */
    status: text('status').notNull().default('submitted'),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('damage_claims_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
    index('damage_claims_status_created_at_idx').on(table.status, table.createdAt),
    /** One live claim per order line; a rejected claim does not block a corrected one. */
    uniqueIndex('damage_claims_open_per_line_idx')
      .on(table.orderId, table.sku)
      .where(sql`${table.status} in ('submitted','in_review')`),
    check(
      'damage_claims_status_valid',
      sql`${table.status} in ('submitted','in_review','approved_refund','approved_replacement','rejected')`
    ),
    check('damage_claims_qty_positive', sql`${table.qty} > 0`),
  ]
)

/**
 * A custom miniature or caricature made from the shopper's photographs
 * (contracts/customRequests.ts). The photos live in image-intake under
 * random UUID keys; `photos` keeps each key with the browser's check report
 * so the team can see what the shopper was shown before uploading.
 */
export const customRequests = pgTable(
  'custom_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Shopper-facing id, e.g. "TT-CR-20261028-7K3QZM". */
    requestNumber: text('request_number').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'miniature' | 'caricature'. */
    kind: text('kind').notNull(),
    /** { key, metrics?, checks? }[] (1 to 6). */
    photos: jsonbSafe('photos').notNull(),
    /** { mode: 'as_photo' | 'custom', notes? }. */
    colours: jsonbSafe('colours').notNull(),
    notes: text('notes'),
    pincode: text('pincode'),
    /** YYYY-MM-DD, if the shopper has a date. */
    neededBy: text('needed_by'),
    /** 'submitted' | 'in_review' | 'quoted' | 'declined' | 'closed'. */
    status: text('status').notNull().default('submitted'),
    adminNote: text('admin_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('custom_requests_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
    index('custom_requests_status_created_at_idx').on(table.status, table.createdAt),
    check('custom_requests_kind_valid', sql`${table.kind} in ('miniature','caricature')`),
    check(
      'custom_requests_status_valid',
      sql`${table.status} in ('submitted','in_review','quoted','declined','closed')`
    ),
  ]
)

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType() {
    return 'bytea'
  },
  // node-postgres gives a Buffer; PGlite (tests) a plain Uint8Array.
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value)
  },
})

/**
 * Every caricature preview a shopper asked for (routes/caricaturePreviews.ts).
 * Each one is a paid OpenAI call, so this is also the ledger the limits count:
 * per photo, per shopper per India day, and across everyone per day. A row is
 * written as `pending` before the call (so two requests at once cannot both
 * slip under a limit) and settled after it; `failed` rows are ours, not the
 * shopper's, and do not count.
 */
export const caricaturePreviews = pgTable(
  'caricature_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the photo bytes: "this photo" for the per-photo limit. */
    photoHash: text('photo_hash').notNull(),
    /** 'tpl:<gallery id>' or 'up:<sha-256 of the uploaded character picture>'. */
    character: text('character').notNull(),
    /** 'pending' | 'ok' | 'refused' | 'failed'. */
    status: text('status').notNull().default('pending'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** image-intake key of the rendered preview, when it was stored. */
    previewKey: text('preview_key'),
    /** The rendered JPEG itself, so the shopper can come back to it. */
    image: bytea('image'),
    /** The photo it was made from, so the shopper can order it without adding it again. */
    photo: bytea('photo'),
    /** The shopper's own character picture, for 'up:' characters. */
    characterImage: bytea('character_image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('caricature_previews_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('caricature_previews_created_at_idx').on(table.createdAt),
    check(
      'caricature_previews_status_valid',
      sql`${table.status} in ('pending','ok','refused','failed')`
    ),
  ]
)

/**
 * "Notify me" requests for a piece that is unpriced or out of stock. Either a
 * signed-in shopper (userId) or an email address; drained when the piece
 * becomes purchasable (`notifiedAt` set once a message has gone out).
 */
export const restockRequests = pgTable(
  'restock_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sku: text('sku').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (table) => [
    index('restock_requests_sku_pending_idx')
      .on(table.sku)
      .where(sql`${table.notifiedAt} is null`),
    /** Asking twice is one request, per person and piece. */
    uniqueIndex('restock_requests_user_sku_idx')
      .on(table.userId, table.sku)
      .where(sql`${table.userId} is not null and ${table.notifiedAt} is null`),
    uniqueIndex('restock_requests_email_sku_idx')
      .on(table.email, table.sku)
      .where(sql`${table.email} is not null and ${table.notifiedAt} is null`),
    check('restock_requests_who', sql`${table.userId} is not null or ${table.email} is not null`),
  ]
)

/**
 * Issued customer invoices (docs/SPEC-INVOICES.md). One row per paid order,
 * minted exactly once inside the `paid` transition's transaction and NEVER
 * rewritten afterwards — an issued invoice is a document that has left the
 * building.
 *
 * Owned by its own `invoices` module. It consumes the shared `payments`/`users`
 * read models but its tables are its own; the ROUTE layer composes the document
 * from config + catalog + payments and hands it in already built.
 *
 * Two things this table is deliberately NOT:
 *
 * 1. **Not a tax invoice.** Adix AI is not registered under GST
 *    (`legal.company.gstRegistered: false`), so there is no GSTIN, no
 *    CGST/SGST/IGST, and no HSN column here or in `document` — an unregistered
 *    supplier must not collect tax (CGST s.32) or issue a tax invoice (s.31).
 * 2. **Not a view over `payments`.** `document` is a complete denormalised
 *    snapshot: seller block, manufacturer attribution, buyer address, resolved
 *    product names/sizes, totals, footer copy. A later catalog rename or a
 *    change of registered office must not alter an invoice already issued.
 */
export const invoices = pgTable(
  'invoices',
  {
    /** Human-facing document number, e.g. "TT/26-27/000142". PK — one per order. */
    invoiceNumber: text('invoice_number').primaryKey(),
    /**
     * `onDelete: 'restrict'`, not cascade: the invoice is the record of a sale
     * and must outlive any attempt to remove the order behind it. Safe with
     * `services/profile.ts` `deleteAccount`, which TOMBSTONES the user (and
     * leaves `payments` intact) rather than deleting rows.
     */
    orderId: text('order_id')
      .notNull()
      .unique()
      .references(() => payments.orderId, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Indian financial year, 1 Apr–31 Mar, as "26-27". The numbering series resets per FY. */
    fy: text('fy').notNull(),
    /** Position within `fy`'s series — gapless and consecutive, allocated by `invoice_counters`. */
    seq: integer('seq').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /** Document grand total in paise, denormalised out of `document` so the register can sum without parsing jsonb. */
    totalPaise: integer('total_paise').notNull(),
    /** The frozen invoice — see the class note above. Shape: contracts/invoices.ts `InvoiceDocumentSchema`. */
    document: jsonbSafe('document').notNull(),
    /**
     * Delivery state of the customer's emailed copy — enforced by
     * `invoices_email_status_valid`.
     *
     * `sending` is a CLAIM rather than a delivery state, exactly as on
     * `ops_notifications.status`: the sender takes the row with a guarded UPDATE
     * before it calls Brevo, so a concurrent pass over the same backlog cannot
     * mail the customer the same invoice twice. `reapStuckInvoiceEmails` returns
     * rows abandoned there by a dead process.
     */
    emailStatus: text('email_status').notNull().default('pending'),
    /** The address the copy was (or will be) sent to; null when we hold no email for the shopper. */
    emailTo: text('email_to'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    /** Bounded by the recover sweep's retry cap, so a permanently bad address stops being retried. */
    emailAttempts: integer('email_attempts').notNull().default(0),
    lastEmailError: text('last_email_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The gapless-series invariant, enforced by the database and not merely by the allocator. */
    uniqueIndex('invoices_fy_seq_idx').on(table.fy, table.seq),
    /** Admin register: newest first. */
    index('invoices_issued_at_idx').on(table.issuedAt.desc()),
    index('invoices_user_id_idx').on(table.userId),
    /** The email-retry sweep scans by delivery state. */
    index('invoices_email_status_idx').on(table.emailStatus),
    check('invoices_total_paise_non_negative', sql`${table.totalPaise} >= 0`),
    check('invoices_seq_positive', sql`${table.seq} > 0`),
    check(
      'invoices_email_status_valid',
      sql`${table.emailStatus} in ('pending','sending','sent','failed','skipped_no_email','skipped_backfill')`
    ),
  ]
)

/**
 * The per-financial-year sequence allocator. A dedicated row (rather than a
 * Postgres SEQUENCE) because the series must be GAPLESS: a sequence hands out
 * numbers outside the transaction and keeps the value when that transaction
 * rolls back, which would leave holes in a statutory document series. Allocation
 * is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the issuing
 * transaction, so a rolled-back issuance releases its number too.
 */
export const invoiceCounters = pgTable('invoice_counters', {
  /** Indian financial year, "26-27". */
  fy: text('fy').primaryKey(),
  /** The number the NEXT invoice in this FY will take. */
  nextSeq: integer('next_seq').notNull().default(1),
})

/**
 * Credit notes (GST s.34): the reversal document a refund or post-invoice
 * cancellation requires once the seller is GST-registered, so output tax
 * collected on the original invoice is formally reversed (reported in GSTR-1
 * Table 9B). Mirrors `invoices`/`invoice_counters` exactly — same gapless
 * per-FY numbering, same frozen-`document` immutability, same reasons. Table
 * exists from the tax-engine migration onward; the issuing service/hook
 * (docs plan §2.6) lands separately, wired to the refund transition.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    /** e.g. "TT/CN/26-27/000001". PK — one per issuance. */
    creditNoteNumber: text('credit_note_number').primaryKey(),
    /**
     * `onDelete: 'restrict'`, same reasoning as `invoices.invoice_number`: the
     * original tax invoice must outlive any attempt to remove it while a
     * credit note references it.
     */
    invoiceNumber: text('invoice_number')
      .notNull()
      .references(() => invoices.invoiceNumber, { onDelete: 'restrict' }),
    orderId: text('order_id')
      .notNull()
      .references(() => payments.orderId, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Indian financial year the credit note is issued in — may differ from the invoice's FY. */
    fy: text('fy').notNull(),
    /** Position within `fy`'s series — gapless, allocated by `credit_note_counters`. */
    seq: integer('seq').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /** Document total reversed, in paise, denormalised out of `document` same as `invoices.total_paise`. */
    totalPaise: integer('total_paise').notNull(),
    /** The frozen document, shape TBD alongside the issuing service. */
    document: jsonbSafe('document').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('credit_notes_fy_seq_idx').on(table.fy, table.seq),
    index('credit_notes_issued_at_idx').on(table.issuedAt.desc()),
    index('credit_notes_invoice_number_idx').on(table.invoiceNumber),
    index('credit_notes_order_id_idx').on(table.orderId),
    check('credit_notes_total_paise_non_negative', sql`${table.totalPaise} >= 0`),
    check('credit_notes_seq_positive', sql`${table.seq} > 0`),
  ]
)

/** Same gapless-series allocator pattern as `invoice_counters`, its own series. */
export const creditNoteCounters = pgTable('credit_note_counters', {
  fy: text('fy').primaryKey(),
  nextSeq: integer('next_seq').notNull().default(1),
})

/**
 * Shipping (docs/SPEC-SHIPPING.md). Seven tables owned by the shipping module:
 * where parcels leave from (`pickup_nodes`, `pickup_node_skus`), who carries
 * them and at what cost (`couriers`, `courier_rate_slabs`), where they will go
 * (`courier_service_areas`, `courier_service_exceptions`), and the reference
 * data that turns a pincode pair into a zone (`pincodes`).
 *
 * Two invariants run through all of them:
 *
 * 1. **Every percentage is integer basis points** (`1150` = 11.50%). Shipping
 *    money is whole rupees end to end; floats in a rate card is how Σ(lines)
 *    stops equalling the total. Same reason lib/pricing.ts rounds per line.
 * 2. **Absence never means free.** A destination with no `pincodes` row, no
 *    serviceable courier, or no matching slab is NOT SERVICEABLE — it is never
 *    a ₹0 shipment. See lib/shipping.ts.
 */

/** A warehouse/store a parcel can be dispatched from. Address fields mirror `addresses` (and mobile's AddressForm). */
export const pickupNodes = pgTable(
  'pickup_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short operator-facing handle, e.g. "AHM-01". Unique — it is what shows up in ops tooling. */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    /** Pickup contact for the courier, not a shopper. */
    contactName: text('contact_name').notNull().default(''),
    /** E.164 ("+91" + 10 digits), same convention as `users.phone` / `addresses.phone`. */
    contactPhone: text('contact_phone').notNull().default(''),
    houseNumber: text('house_number').notNull().default(''),
    roadArea: text('road_area').notNull().default(''),
    city: text('city').notNull().default(''),
    state: text('state').notNull().default(''),
    pincode: text('pincode').notNull(),
    /** Null until an operator resolves + confirms the geocode (admin UI, never auto-saved). */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * 'warehouse' | 'retail' | 'hub'. Shipping treats all three identically —
     * a parcel leaves from a node, and which kind it is does not change a
     * quote. The stock cascade does not: `hub` is the LAST resort it falls
     * back to after every retail candidate misses (docs/SPEC-STOCK.md §3
     * step 7), so a hub mislabelled as retail gets ranked by distance and can
     * be skipped by `max_cascade_stores`, which defeats the fallback.
     */
    kind: text('kind').notNull().default('warehouse'),
    /**
     * May the stock cascade SOURCE from this node? Deliberately not `is_active`.
     * `is_active` means "can ship parcels", and the two come apart in both
     * directions: a partner retailer we ship from but do not track stock at is
     * active with `stock_enabled = false`, and a shop whose count we trust
     * while its courier pickup is suspended is the reverse. Overloading one
     * flag would make disabling a courier lane silently mark a shop's stock
     * unsellable.
     *
     * Defaults FALSE: a node only starts serving the cascade once an operator
     * has said it should. A new node inheriting "yes, sell from here" would be
     * the wrong default to be wrong about.
     */
    stockEnabled: boolean('stock_enabled').notNull().default(false),
    /**
     * May this node appear in a customer-facing store list? Separate again,
     * and also default-false. The owner's decision (SPEC-STOCK.md §1) is that
     * a shopper is NEVER told which store their parcel came from, so nothing
     * reads this yet — it exists so that a future `/v1/stores` cannot be built
     * by exposing the ops-facing node table wholesale.
     */
    publicVisible: boolean('public_visible').notNull().default(false),
    /** Tie-break only — cost decides first (see lib/shipping.ts selectShipment). Lower wins. */
    priority: integer('priority').notNull().default(0),
    /** Daily handover cutoff, IST "HH:MM". Informational at v1; ETA display will use it. */
    cutoffIst: text('cutoff_ist').notNull().default('15:00'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pickup_nodes_active_priority_idx').on(table.isActive, table.priority),
    check('pickup_nodes_pincode_format', sql`${table.pincode} ~ '^[1-9][0-9]{5}$'`),
    check('pickup_nodes_kind_valid', sql`${table.kind} in ('warehouse', 'retail', 'hub')`),
  ]
)

/**
 * A delivery partner and its complete cost formula. Everything needed to
 * reproduce `Total = Base + Fuel + COD + Docket + Risk + GST` lives here, so
 * changing a carrier's fuel surcharge is a config edit, not a deploy.
 */
export const couriers = pgTable(
  'couriers',
  {
    /** 'delhivery' | 'xpressbees' | 'shadowfax' — PK, and the admin route param. */
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** 'surface' | 'express'. v1 is surface-only (B2C). */
    mode: text('mode').notNull().default('surface'),
    /**
     * 'weight' | 'distance'. Indian B2C surface freight is billed on the
     * pincode PAIR (zone), not per km — but some within-city same-day products
     * genuinely are distance-slabbed. 'distance' is the seam for that; v1 seeds
     * only 'weight' and lib/shipping.ts prices only 'weight'.
     */
    rateModel: text('rate_model').notNull().default('weight'),
    /** Volumetric divisor: grams = L×W×H(cm)×1000/divisor. 5000 standard; some bulk carriers 4000. */
    volumetricDivisor: integer('volumetric_divisor').notNull().default(5000),
    /** Carrier's minimum billable weight in grams — a 200 g parcel still bills at 500 g. */
    minChargeableG: integer('min_chargeable_g').notNull().default(500),
    /** Fuel surcharge, basis points of BASE FREIGHT (not of the whole bill). */
    fuelBps: integer('fuel_bps').notNull().default(0),
    /** GST, basis points, applied to (base + fuel + docket + risk + cod). 1800 = 18%. */
    gstBps: integer('gst_bps').notNull().default(1800),
    /** Flat per-waybill/docket fee in whole rupees. */
    docketFeeInr: integer('docket_fee_inr').notNull().default(0),
    /** Insurance/risk, basis points of declared value; charged as max(riskMinInr, value×bps). 0 disables. */
    riskBps: integer('risk_bps').notNull().default(0),
    riskMinInr: integer('risk_min_inr').notNull().default(0),
    /** COD handling: max(flat, value×bps). Both 0 at v1 — prepaid only (SPEC-SHIPPING D6). */
    codFlatInr: integer('cod_flat_inr').notNull().default(0),
    codBps: integer('cod_bps').notNull().default(0),
    /** Return-to-origin cost as bps of forward freight. Reporting only at v1; not in the quoted cost. */
    rtoBps: integer('rto_bps').notNull().default(0),
    slaDaysZoneA: integer('sla_days_zone_a').notNull().default(2),
    slaDaysZoneB: integer('sla_days_zone_b').notNull().default(4),
    /** 0..100, operator-set from experience. Tie-break after cost and SLA. */
    reliabilityScore: integer('reliability_score').notNull().default(50),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('couriers_rate_model_valid', sql`${table.rateModel} in ('weight','distance')`),
    check('couriers_volumetric_divisor_positive', sql`${table.volumetricDivisor} > 0`),
    check('couriers_min_chargeable_g_non_negative', sql`${table.minChargeableG} >= 0`),
    check('couriers_reliability_score_range', sql`${table.reliabilityScore} between 0 and 100`),
    check(
      'couriers_bps_non_negative',
      sql`${table.fuelBps} >= 0 and ${table.gstBps} >= 0 and ${table.riskBps} >= 0 and ${table.codBps} >= 0 and ${table.rtoBps} >= 0`
    ),
  ]
)

/**
 * One courier's base freight for a (zone, weight-slab) cell — the carrier's
 * INTERNAL cost, never what the shopper sees (that is `shipping.customerSlabs`
 * in app_config). Lookup: the smallest `uptoG >= chargeableG`.
 *
 * Above the top slab the charge extrapolates as
 * `topRate + ceil((g − topUptoG)/addlPerG) × addlRateInr`, and ONLY the top
 * row's `addlPerG`/`addlRateInr` are ever read — they sit on every row for
 * schema simplicity, and seeds set them to 0 on non-top rows.
 */
export const courierRateSlabs = pgTable(
  'courier_rate_slabs',
  {
    courierCode: text('courier_code')
      .notNull()
      .references(() => couriers.code, { onDelete: 'cascade' }),
    /** 'A'..'F'. Gujarat-only v1 seeds A and B; a zone with no row is NOT SERVICEABLE. */
    zone: text('zone').notNull(),
    /** Slab ceiling in grams: 500, 1000, 2000, 5000, 10000. */
    uptoG: integer('upto_g').notNull(),
    /** Base freight for the slab, whole rupees, pre-fuel/pre-GST. */
    rateInr: integer('rate_inr').notNull(),
    addlPerG: integer('addl_per_g').notNull().default(500),
    addlRateInr: integer('addl_rate_inr').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.courierCode, table.zone, table.uptoG] }),
    check('courier_rate_slabs_zone_valid', sql`${table.zone} in ('A','B','C','D','E','F')`),
    check('courier_rate_slabs_upto_g_positive', sql`${table.uptoG} > 0`),
    check('courier_rate_slabs_rate_inr_non_negative', sql`${table.rateInr} >= 0`),
    check('courier_rate_slabs_addl_per_g_positive', sql`${table.addlPerG} > 0`),
  ]
)

/** Coarse serviceability: an inclusive pincode range a courier covers. */
export const courierServiceAreas = pgTable(
  'courier_service_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courierCode: text('courier_code')
      .notNull()
      .references(() => couriers.code, { onDelete: 'cascade' }),
    fromPincode: text('from_pincode').notNull(),
    toPincode: text('to_pincode').notNull(),
    prepaid: boolean('prepaid').notNull().default(true),
    cod: boolean('cod').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('courier_service_areas_courier_idx').on(table.courierCode, table.isActive),
    check(
      'courier_service_areas_pincode_format',
      sql`${table.fromPincode} ~ '^[1-9][0-9]{5}$' and ${table.toPincode} ~ '^[1-9][0-9]{5}$'`
    ),
    check('courier_service_areas_range_ordered', sql`${table.fromPincode} <= ${table.toPincode}`),
  ]
)

/**
 * Per-pincode serviceability truth, and it OVERRIDES the ranges in both
 * directions. Carrier coverage is non-contiguous and republished regularly as
 * ~19k-row files; ranges are the coarse default, this is where an imported
 * carrier file lands (scripts/import-serviceability.ts, Phase 2).
 */
export const courierServiceExceptions = pgTable(
  'courier_service_exceptions',
  {
    courierCode: text('courier_code')
      .notNull()
      .references(() => couriers.code, { onDelete: 'cascade' }),
    pincode: text('pincode').notNull(),
    serviceable: boolean('serviceable').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.courierCode, table.pincode] }),
    check('courier_service_exceptions_pincode_format', sql`${table.pincode} ~ '^[1-9][0-9]{5}$'`),
  ]
)

/**
 * India Post reference data, so zone derivation needs no network call on the
 * cart read path. Column mapping from the public dataset:
 * `OfficeName → officeName, Taluk → taluk, DistrictName → district,
 * StateName → state` — note there is NO city column, which is why Zone A is
 * defined as same-TALUK (district equality over-counts across the rural
 * Ahmedabad/Surat districts).
 *
 * Gujarat spans 360001–396xxx, but 396xxx also covers Daman & Diu and Dadra &
 * Nagar Haveli — the state fence filters on `state`, never on a prefix.
 */
export const pincodes = pgTable(
  'pincodes',
  {
    pincode: text('pincode').primaryKey(),
    officeName: text('office_name').notNull().default(''),
    taluk: text('taluk').notNull().default(''),
    district: text('district').notNull().default(''),
    state: text('state').notNull().default(''),
    /** Centroid, for the haversine RANKING tie-break only — never a price input. */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
  },
  (table) => [
    index('pincodes_state_taluk_idx').on(table.state, table.taluk),
    check('pincodes_pincode_format', sql`${table.pincode} ~ '^[1-9][0-9]{5}$'`),
  ]
)

/**
 * Optional per-node stock allowlist. **A node with ZERO rows stocks
 * everything** — the v1 case (one or two nodes holding the full catalog). A
 * node with rows stocks only those skus. A cart no single node can fulfil is
 * `no_single_node`: an ops signal, not a customer-facing split-parcel flow
 * (split shipments are explicitly out of scope).
 */
export const pickupNodeSkus = pgTable(
  'pickup_node_skus',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => pickupNodes.id, { onDelete: 'cascade' }),
    /**
     * FK to the sku registry, same target as `cart_items.sku`. `catalog_items`
     * rows are never deleted — the projection deactivates a dead variant
     * instead (services/catalogProjection.ts) — so the constraint costs nothing
     * at catalog-sync time and stops an allowlist entry for a sku that does not
     * exist. This table has no write path in the app; rows are entered by hand,
     * which is exactly the case a typo needs catching in.
     */
    sku: text('sku')
      .notNull()
      .references(() => catalogItems.sku),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.sku] })]
)

/**
 * Multi-location stock (docs/SPEC-STOCK.md). Three tables: what is on each
 * shelf (`store_stock`), the per-sku overrides an operator can apply on top of
 * it (`sku_stock_policy`), and an append-only record of every count change
 * (`store_stock_audit`).
 *
 * **This is consignment stock: we own it, the retailer holds it.** That is a
 * property fact, not a bookkeeping one — the qty here is OUR inventory sitting
 * on someone else's shelf, so it is ours to sell and ours to write down when
 * it goes missing. It is deliberately NOT modelled as a sale to the retailer.
 *
 * Two invariants, both learned from `app_config`:
 *
 * 1. **None of this may live in `app_config`.** `GET /v1/config` is public and
 *    `services/config.ts` returns every key it finds without filtering, so a
 *    stock policy stored there would publish per-sku counts and store
 *    identities to anyone with curl. Stock gets its own tables and its own
 *    admin routes for exactly that reason (SPEC-STOCK.md §8).
 * 2. **Every write is audited in the same transaction**, mirroring
 *    `app_config_audit`. A count that changes with no row explaining why is
 *    indistinguishable from shrinkage, and shrinkage on consignment stock is a
 *    conversation with a retailer that needs a record behind it.
 */
export const storeStock = pgTable(
  'store_stock',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => pickupNodes.id, { onDelete: 'cascade' }),
    /**
     * FK to the sku registry, same target as `cart_items.sku`. Safe because
     * `catalog_items` rows are never deleted — the projection deactivates a dead
     * variant instead (services/catalogProjection.ts) — so a discontinued sku
     * keeps its shelf row and its audit trail. No cascade/set-null: a stock
     * count must not vanish silently.
     */
    sku: text('sku')
      .notNull()
      .references(() => catalogItems.sku),
    /**
     * Units on that shelf. May go NEGATIVE, and there is no check constraint
     * stopping it: the decrement runs inside `markOrderPaid` on a payment that
     * has already been captured, and a constraint violation there would roll
     * back a transition the money has already made (SPEC-STOCK.md §9). An
     * oversell is an ops alert; a failed capture is a refund and a lost order.
     */
    qty: integer('qty').notNull().default(0),
    /**
     * False = "stocked here, count unknown". The shop confirmed it carries the
     * sku but nobody counts units. Such a row is a cascade CANDIDATE regardless
     * of `qty` — which is why the candidate filter is `qty > 0 OR NOT tracked`
     * rather than a plain `qty > 0`. It is never decremented, because there is
     * no number to decrement.
     */
    tracked: boolean('tracked').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Admin user id, or a system marker like 'order_paid'. Free text — see the audit table. */
    updatedBy: text('updated_by').notNull().default(''),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.sku] }),
    // The cascade's ONLY read is "every node holding this sku", so the sku
    // side of the composite PK needs its own index — the PK's leading column
    // is node_id and cannot serve it.
    index('store_stock_sku_idx').on(table.sku),
  ]
)

/**
 * Per-sku overrides on top of the computed availability. A sku with no row here
 * behaves as `mode = 'auto'` with the service's default limits, so the table
 * stays small: it holds exceptions, not a row per catalog item.
 */
export const skuStockPolicy = pgTable(
  'sku_stock_policy',
  {
    /**
     * FK to the sku registry (see `store_stock.sku`). An override row for a sku
     * that does not exist is dead weight the precedence ladder would never
     * consult, and a typo'd `force_out` reads as "kill switch applied" while
     * doing nothing — the failure mode a constraint exists to prevent.
     */
    sku: text('sku')
      .primaryKey()
      .references(() => catalogItems.sku),
    /**
     * 'auto' | 'force_in' | 'force_out'.
     *
     * `force_out` is an operator's kill switch and outranks everything,
     * including a shelf that genuinely has units — that is the point of it
     * (a recall, a labelling problem, a batch pulled for testing).
     *
     * `force_in` is the dangerous one and is deliberately WEAKER than
     * `product_variants.in_stock = false`: it can only override a missing
     * `store_stock` row, never a variant the catalog has marked dead. Ranking
     * it above the catalog flag would let a stale policy row sell a
     * discontinued sku. Precedence ladder in full: SPEC-STOCK.md §8.
     */
    mode: text('mode').notNull().default('auto'),
    /** At or below this many units the app shows "low stock" instead of "in stock". Null = service default. */
    lowStockAt: integer('low_stock_at'),
    /** How many ranked retail candidates the cascade will walk before giving up. Null = service default. */
    maxCascadeStores: integer('max_cascade_stores'),
    /** Candidates further than this from the shopper are not considered at all. Null = service default. */
    maxRadiusKm: integer('max_radius_km'),
    /** False = this sku never falls back to a hub; retail shelves or nothing. */
    hubFallback: boolean('hub_fallback').notNull().default(true),
    /** Operator note — why this override exists. Shown in the admin panel, never to a shopper. */
    note: text('note').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').notNull().default(''),
  },
  (table) => [
    check('sku_stock_policy_mode_valid', sql`${table.mode} in ('auto', 'force_in', 'force_out')`),
    check(
      'sku_stock_policy_low_stock_at_non_negative',
      sql`${table.lowStockAt} is null or ${table.lowStockAt} >= 0`
    ),
    check(
      'sku_stock_policy_max_cascade_stores_positive',
      sql`${table.maxCascadeStores} is null or ${table.maxCascadeStores} >= 1`
    ),
    check(
      'sku_stock_policy_max_radius_km_positive',
      sql`${table.maxRadiusKm} is null or ${table.maxRadiusKm} >= 1`
    ),
  ]
)

/**
 * Append-only log of every `store_stock` change, written in the SAME
 * transaction as the change itself. Never updated, never deleted — the whole
 * value of it is that it cannot be tidied after the fact.
 *
 * `delta` is stored alongside the before/after so a reconciliation can sum a
 * period without re-deriving it, and so a row written by a decrement is
 * self-describing even if the stock row is later deleted with its node.
 */
export const storeStockAudit = pgTable(
  'store_stock_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Intentionally NOT a foreign key. An audit row must survive its node being
     * deleted — a shop we stopped working with is exactly the one whose stock
     * history someone will later want to read.
     */
    nodeId: uuid('node_id').notNull(),
    sku: text('sku').notNull(),
    /** Null when the row did not exist before (first count entered). */
    oldQty: integer('old_qty'),
    newQty: integer('new_qty').notNull(),
    delta: integer('delta').notNull(),
    /** 'manual' | 'order_paid' | 'restock' | 'correction' | 'import'. */
    reason: text('reason').notNull(),
    /** Order id for `order_paid`, else a free-text operator note. */
    reference: text('reference').notNull().default(''),
    changedBy: text('changed_by').notNull().default(''),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('store_stock_audit_sku_changed_at_idx').on(table.sku, table.changedAt.desc()),
    index('store_stock_audit_node_changed_at_idx').on(table.nodeId, table.changedAt.desc()),
    check(
      'store_stock_audit_reason_valid',
      sql`${table.reason} in ('manual', 'order_paid', 'restock', 'correction', 'import')`
    ),
  ]
)

/**
 * Product ratings & reviews (PDP "Ratings & Reviews" section). Owned by its
 * own `reviews` module — reads `products`/`payments` only through
 * `services/payments.ts`'s `hasPurchasedProduct` at write time (ARCHITECTURE.md
 * rule 2: services never import another module's service; the ROUTE layer
 * does that cross-module call, same as `resolveWholesaleRule` in cart).
 *
 * `authorName` is denormalized onto the row (not joined from `users`) so an
 * Amazon-imported review — which has no `users` row at all — displays exactly
 * like a real one. `source` distinguishes where a row came from: `user` =
 * written through this app by a signed-in shopper, `amazon` = imported from
 * Amazon once that feed is live (docs/SPEC-REVIEWS.md), and the app labels it
 * as such so no review is ever passed off as one written here.
 *
 * There is deliberately NO placeholder/seed source: fabricated reviews shown
 * as real would be a misleading representation under the Consumer Protection
 * Act 2019 s.2(28)/s.2(47). A product with no reviews shows none — the check
 * constraint below is what keeps it that way. `helpfulCount` is a denormalized
 * counter guarded by `review_helpful_votes` for one-vote-per-user idempotency.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Null for Amazon-imported rows — no `users` row backs them. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    authorName: text('author_name').notNull().default(''),
    rating: integer('rating').notNull(),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    /** Frozen at write time from `hasPurchasedProduct` — never recomputed later. */
    verifiedPurchase: boolean('verified_purchase').notNull().default(false),
    source: text('source').notNull().default('user'),
    helpfulCount: integer('helpful_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('reviews_product_id_helpful_idx').on(
      table.productId,
      table.helpfulCount.desc(),
      table.createdAt.desc()
    ),
    /** One review per user per product — a resubmission edits it (upsert). */
    uniqueIndex('reviews_one_per_user_product')
      .on(table.productId, table.userId)
      .where(sql`${table.userId} is not null`),
    check('reviews_rating_range', sql`${table.rating} between 1 and 5`),
    check('reviews_helpful_count_non_negative', sql`${table.helpfulCount} >= 0`),
    check('reviews_source_valid', sql`${table.source} in ('user', 'amazon')`),
  ]
)

/** One user's "helpful" vote on a review — guards `reviews.helpfulCount` against double-counting. */
export const reviewHelpfulVotes = pgTable(
  'review_helpful_votes',
  {
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.reviewId, table.userId] })]
)

/**
 * One parcel handed to a carrier (docs/SPEC-LOGISTICS.md §3.1). Owned by the
 * `fulfilment` module; consumes the shared `payments`/`users` read models.
 *
 * **This table is not an order-status table.** `payments.status` stays the sole
 * money state and nothing here writes it — the inbound telemetry channel is an
 * UNSIGNED third-party webhook, and an unsigned channel must never be able to
 * move money (SPEC-LOGISTICS §1.1).
 *
 * The milestone timestamps (`manifested_at` … `cancelled_at`) are written
 * ONCE and never rewritten, while `status` may legitimately oscillate as
 * out-of-order scans arrive. That split is deliberate: `status` answers "where
 * is it now", the milestones are the transit-time dataset the SLA claims in
 * FEASIBILITY-LOGISTICS §3.2 have to be settled against.
 */
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `onDelete: 'restrict'` — a shipment is the record that goods physically
     * left the building and must outlive any attempt to remove the order.
     * Deliberately NOT unique: a cancelled shipment can be re-manifested.
     */
    orderId: text('order_id')
      .notNull()
      .references(() => payments.orderId, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    courierCode: text('courier_code').notNull(),
    /** Carrier waybill. Null until manifested; unique once assigned. */
    awb: text('awb'),
    /** Canonical status — `lib/fulfilmentStatus.ts` owns the vocabulary. */
    status: text('status').notNull().default('pending_manifest'),
    /** The carrier's own words for the last scan, verbatim. Never parsed. */
    statusDetail: text('status_detail'),
    /** Last granular carrier code (Delhivery `NSLCode`, e.g. "X-UCI"). */
    nslCode: text('nsl_code'),
    /** What we sent as the carrier's `order_id`; comes back as `ReferenceNo`. */
    referenceNo: text('reference_no'),
    pickupId: text('pickup_id'),
    /** Exactly what we sent to manifest — the parcel as declared. */
    manifestPayload: jsonbSafe('manifest_payload'),
    manifestError: text('manifest_error'),
    manifestAttempts: integer('manifest_attempts').notNull().default(0),
    /** Frozen from `payments.shipping_snapshot` at paid — what the shopper was promised. */
    promisedEtaDays: integer('promised_eta_days'),
    /** Frozen from `payments.shipping_snapshot` at paid, 'YYYY-MM-DD' IST — the calendar date form of `promisedEtaDays`, what the checkout screen actually showed the shopper. Null for shipments frozen before this column existed. */
    promisedDeliveryDate: text('promised_delivery_date'),
    carrierEdd: timestamp('carrier_edd', { withTimezone: true }),
    /**
     * Newest SCAN time seen — the carrier's clock, not ours. The ordering key
     * for the whole out-of-order rule (SPEC-LOGISTICS §4.3); comparing arrival
     * times instead would let a late "In Transit" un-deliver a parcel.
     */
    lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    ndrReason: text('ndr_reason'),
    ndrRaisedAt: timestamp('ndr_raised_at', { withTimezone: true }),
    manifestedAt: timestamp('manifested_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    outForDeliveryAt: timestamp('out_for_delivery_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    rtoAt: timestamp('rto_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * Manual fulfilment mode (docs/SPEC-MANUAL-FULFILMENT.md §4B). Not a new
     * status — `manifested`'s existing customer label ("Order packed, awaiting
     * pickup") already covers the manual state, so acknowledgement is a
     * TIMESTAMP, not a vocabulary addition. `courierCode`/`awb` stay the
     * carrier-mode columns; these two are the human's own record of who is
     * physically carrying the parcel, set by `POST …/shipments/:id/dispatch`.
     */
    manualCourierName: text('manual_courier_name'),
    manualTrackingUrl: text('manual_tracking_url'),
    /** "A human has seen this." Set once by `POST …/shipments/:id/ack`. */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    /** Freeform standing ops note on the shipment (distinct from a per-event `shipment_events.note`). */
    opsNote: text('ops_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('shipments_order_id_idx').on(table.orderId),
    /** Both sweeps (manifest, reconcile) scan by status + age. */
    index('shipments_status_updated_at_idx').on(table.status, table.updatedAt),
    uniqueIndex('shipments_awb_idx').on(table.awb),
    check(
      'shipments_status_valid',
      sql`${table.status} in ('pending_manifest','manifested','picked_up','in_transit','out_for_delivery','ndr','rto_in_transit','delivered','rto_delivered','cancelled','exception')`
    ),
    check('shipments_manifest_attempts_non_negative', sql`${table.manifestAttempts} >= 0`),
    check('shipments_delivery_attempts_non_negative', sql`${table.deliveryAttempts} >= 0`),
  ]
)

/**
 * Append-only carrier telemetry (docs/SPEC-LOGISTICS.md §3.2). Every scan, from
 * either channel, lands here exactly once.
 *
 * Two properties worth stating because both look like mistakes:
 *
 * 1. **`shipment_id` is nullable.** Delhivery can push a scan for an AWB we
 *    have not committed yet, or one manifested out-of-band from their panel.
 *    Refusing it would discard the only copy of an event we cannot ask for
 *    again, so orphans are stored and re-linked when the AWB appears.
 * 2. **`raw` is never read on any request path.** It exists so a status nobody
 *    had mapped in August is still recoverable in October.
 */
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'cascade' }),
    /** Always present even when `shipment_id` is null — it is what re-links an orphan. */
    awb: text('awb').notNull(),
    /** 'webhook' | 'poll' | 'manual' — enforced by `shipment_events_source_valid`. */
    source: text('source').notNull(),
    carrierStatus: text('carrier_status'),
    carrierStatusType: text('carrier_status_type'),
    nslCode: text('nsl_code'),
    /** e.g. "EOD-74" — the NDR discriminator (`lib/fulfilmentStatus.ts`). */
    statusCode: text('status_code'),
    /** Our canonical status AT INGEST TIME. Frozen: re-mapping later must not rewrite history. */
    mappedStatus: text('mapped_status').notNull(),
    scanLocation: text('scan_location'),
    instructions: text('instructions'),
    /** The CARRIER's timestamp — the ordering key (SPEC-LOGISTICS §4.3). */
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    raw: jsonbSafe('raw').notNull(),
    /**
     * sha256 over (awb, status, statusType, nslCode, statusCode, scannedAt) for
     * webhook/poll scans. A MANUAL event has no carrier tuple to hash — two
     * operator entries made in the same second against the same status would
     * hash identically and the second would be silently swallowed by
     * `onConflictDoNothing` — so manual events hash a per-event nonce
     * (`manual:<uuid>`) instead (docs/SPEC-MANUAL-FULFILMENT.md §4B trap #1).
     */
    dedupeHash: text('dedupe_hash').notNull(),
    /** Who made a MANUAL entry. Null for webhook/poll scans, which have no operator. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Operator free text on a MANUAL entry (e.g. dispatch details, a status note). Null otherwise. */
    note: text('note'),
  },
  (table) => [
    uniqueIndex('shipment_events_dedupe_hash_idx').on(table.dedupeHash),
    index('shipment_events_shipment_id_scanned_at_idx').on(
      table.shipmentId,
      table.scannedAt.desc()
    ),
    /** Orphan adoption scans by AWB. */
    index('shipment_events_awb_idx').on(table.awb),
    check('shipment_events_source_valid', sql`${table.source} in ('webhook','poll','manual')`),
  ]
)

/**
 * What we did about a failed delivery (docs/SPEC-LOGISTICS.md §3.3).
 *
 * Delhivery's NDR API is asynchronous: it answers with a UPL id, never with a
 * result. So the row records that we ASKED, and `upl_status` is filled by a
 * follow-up poll — without it, "we requested a re-attempt" and "a re-attempt
 * was accepted" would be indistinguishable.
 */
export const ndrActions = pgTable(
  'ndr_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    awb: text('awb').notNull(),
    /** 'DEFER_DLV' | 'EDIT_DETAILS' | 'RE-ATTEMPT' — the carrier's verbs. */
    act: text('act').notNull(),
    payload: jsonbSafe('payload').notNull(),
    uplId: text('upl_id'),
    uplStatus: text('upl_status').notNull().default('requested'),
    lastError: text('last_error'),
    /** Null means an automated action — the audit distinction ops will want. */
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ndr_actions_shipment_id_created_at_idx').on(table.shipmentId, table.createdAt.desc()),
    check('ndr_actions_act_valid', sql`${table.act} in ('DEFER_DLV','EDIT_DETAILS','RE-ATTEMPT')`),
    check(
      'ndr_actions_upl_status_valid',
      sql`${table.uplStatus} in ('requested','accepted','rejected','unknown')`
    ),
  ]
)

/**
 * The ops notification outbox (docs/SPEC-MANUAL-FULFILMENT.md §4A). One row
 * per (kind, order, channel, target) — the whole point of manual fulfilment is
 * that a paid order reaches a human, and this table is what turns "send a
 * WhatsApp message" from a fire-and-hope HTTP call into a durable, retryable
 * fact, the same outbox-with-retry shape `invoices.emailStatus` /
 * `emailAttempts` / `lastEmailError` already established for the customer's
 * invoice copy.
 *
 * `dedupeKey` — not the enqueuing hook — is what actually guarantees
 * exactly-once: `${kind}:${orderId}:${channel}:${target}`, unique, so a repeat
 * enqueue (verify/webhook/recover racing the same order) is a no-op.
 *
 * Owned by its own `opsNotifications` module; consumes the shared `payments`
 * read model but its table is its own (ARCHITECTURE.md rule 2).
 */
export const opsNotifications = pgTable(
  'ops_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'order_paid' today; the shape is open for 'ndr_raised' / 'delivery_failed' later. */
    kind: text('kind').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => payments.orderId, { onDelete: 'restrict' }),
    /** 'whatsapp_cloud' — the only channel adapter built at v1 (SPEC §8 decision 2). */
    channel: text('channel').notNull(),
    /** Channel-specific recipient — a WhatsApp msisdn today (E.164, no leading `+`). */
    target: text('target').notNull(),
    /** Template params, FROZEN at enqueue time — shape: `lib/notify/types.ts` `NotificationMessage`. */
    payload: jsonbSafe('payload').notNull(),
    /**
     * 'pending' | 'sending' | 'sent' | 'failed' | 'skipped_unconfigured' |
     * 'skipped_no_consent'.
     *
     * `skipped_no_consent` is TERMINAL, and the only skip status that is. It
     * means a MARKETING row was refused because the shopper declined or opted
     * out (`users.marketing_whatsapp_opt_in = false`). It is deliberately NOT
     * in `OPS_NOTIFICATION_SENDABLE_STATUSES`: `skipped_unconfigured` exists to
     * be retried once the missing config appears, and treating a withdrawn
     * consent as the same kind of "not yet" would have the sweep re-examine —
     * and one config change away from deliver — a message the recipient
     * refused. An opt-out has to be a wall, not a pause.
     *
     * `sending` is a CLAIM, not a delivery state: a sender moves a row into it
     * with a guarded UPDATE before it touches the channel, so a second concurrent
     * pass over the same backlog matches zero rows and sends nothing. Without it
     * the sweep read rows, sent, and only then wrote status — a window wide
     * enough for the inline post-commit send and a scheduled sweep (or a Cloud
     * Scheduler retry firing while the first attempt is still in flight) to
     * deliver the same WhatsApp message twice.
     *
     * A row can be abandoned in `sending` if the process dies mid-send. That is
     * what `reapStuckOpsNotifications` is for — see it for why the reaper returns
     * rows to `failed` rather than `pending`.
     */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** The channel provider's own message id (e.g. Meta's `messages[0].id`), once sent. */
    providerMessageId: text('provider_message_id'),
    dedupeKey: text('dedupe_key').notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ops_notifications_dedupe_key_idx').on(table.dedupeKey),
    /** The retry sweep scans by delivery state, same shape as `invoices_email_status_idx`. */
    index('ops_notifications_status_enqueued_at_idx').on(table.status, table.enqueuedAt),
    index('ops_notifications_order_id_idx').on(table.orderId),
    check(
      'ops_notifications_status_valid',
      sql`${table.status} in ('pending','sending','sent','failed','skipped_unconfigured','skipped_no_consent')`
    ),
    check('ops_notifications_attempts_non_negative', sql`${table.attempts} >= 0`),
  ]
)

export type UserRow = typeof users.$inferSelect
export type AddressRow = typeof addresses.$inferSelect
export type NewAddressRow = typeof addresses.$inferInsert
export type AppConfigRow = typeof appConfig.$inferSelect
export type AppConfigAuditRow = typeof appConfigAudit.$inferSelect
export type CatalogItemRow = typeof catalogItems.$inferSelect
export type NewCatalogItemRow = typeof catalogItems.$inferInsert
export type CartItemRow = typeof cartItems.$inferSelect
export type NewCartItemRow = typeof cartItems.$inferInsert
export type PaymentRow = typeof payments.$inferSelect
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect
export type NewPaymentAttemptRow = typeof paymentAttempts.$inferInsert
export type NewPaymentRow = typeof payments.$inferInsert
export type ComplaintTicketRow = typeof complaintTickets.$inferSelect
export type NewComplaintTicketRow = typeof complaintTickets.$inferInsert
export type InvoiceRow = typeof invoices.$inferSelect
export type NewInvoiceRow = typeof invoices.$inferInsert
export type CreditNoteRow = typeof creditNotes.$inferSelect
export type NewCreditNoteRow = typeof creditNotes.$inferInsert
export type CategoryRow = typeof categories.$inferSelect
export type NewCategoryRow = typeof categories.$inferInsert
export type ProductRow = typeof products.$inferSelect
export type NewProductRow = typeof products.$inferInsert
export type ProductVariantRow = typeof productVariants.$inferSelect
export type NewProductVariantRow = typeof productVariants.$inferInsert
export type CatalogVersionRow = typeof catalogVersion.$inferSelect
export type CouponRow = typeof coupons.$inferSelect
export type NewCouponRow = typeof coupons.$inferInsert
export type CouponRedemptionRow = typeof couponRedemptions.$inferSelect
export type NewCouponRedemptionRow = typeof couponRedemptions.$inferInsert
export type PickupNodeRow = typeof pickupNodes.$inferSelect
export type NewPickupNodeRow = typeof pickupNodes.$inferInsert
export type CourierRow = typeof couriers.$inferSelect
export type NewCourierRow = typeof couriers.$inferInsert
export type CourierRateSlabRow = typeof courierRateSlabs.$inferSelect
export type NewCourierRateSlabRow = typeof courierRateSlabs.$inferInsert
export type CourierServiceAreaRow = typeof courierServiceAreas.$inferSelect
export type NewCourierServiceAreaRow = typeof courierServiceAreas.$inferInsert
export type CourierServiceExceptionRow = typeof courierServiceExceptions.$inferSelect
export type NewCourierServiceExceptionRow = typeof courierServiceExceptions.$inferInsert
export type PincodeRow = typeof pincodes.$inferSelect
export type NewPincodeRow = typeof pincodes.$inferInsert
export type ReviewRow = typeof reviews.$inferSelect
export type NewReviewRow = typeof reviews.$inferInsert
export type ReviewHelpfulVoteRow = typeof reviewHelpfulVotes.$inferSelect
export type PickupNodeSkuRow = typeof pickupNodeSkus.$inferSelect
export type NewPickupNodeSkuRow = typeof pickupNodeSkus.$inferInsert
export type StoreStockRow = typeof storeStock.$inferSelect
export type NewStoreStockRow = typeof storeStock.$inferInsert
export type SkuStockPolicyRow = typeof skuStockPolicy.$inferSelect
export type NewSkuStockPolicyRow = typeof skuStockPolicy.$inferInsert
export type StoreStockAuditRow = typeof storeStockAudit.$inferSelect
export type NewStoreStockAuditRow = typeof storeStockAudit.$inferInsert
export type ShipmentRow = typeof shipments.$inferSelect
export type NewShipmentRow = typeof shipments.$inferInsert
export type ShipmentEventRow = typeof shipmentEvents.$inferSelect
export type NewShipmentEventRow = typeof shipmentEvents.$inferInsert
export type NdrActionRow = typeof ndrActions.$inferSelect
export type NewNdrActionRow = typeof ndrActions.$inferInsert
export type OpsNotificationRow = typeof opsNotifications.$inferSelect
export type NewOpsNotificationRow = typeof opsNotifications.$inferInsert

/**
 * One WhatsApp thread, keyed by the shopper's phone number.
 *
 * **The phone number IS the identity.** Accounts are Firebase phone-auth, so a
 * verified inbound `from` resolves straight to a `users` row — no linking flow.
 * That is also why the webhook must verify `X-Hub-Signature-256` BEFORE it
 * trusts `from`: an unsigned payload naming someone else's number would read
 * their cart and orders. `userId` is nullable because a stranger who has never
 * ordered is a perfectly normal first contact — most of them, at first.
 *
 * `waPhone` is stored exactly as Meta sends it: E.164 digits with NO leading
 * `+` (`919876543210`), matching `ops_notifications.target`. `users.phone`
 * stores the `+`, so the join normalises one side — see `lib/whatsapp/inbound.ts`.
 */
export const waConversations = pgTable(
  'wa_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164 digits, no leading `+`. Unique: one live thread per number, forever. */
    waPhone: text('wa_phone').notNull().unique(),
    /** Resolved from `users.phone`; null while the shopper has no account. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Display name Meta supplies in `contacts[].profile.name`; null when absent. */
    profileName: text('profile_name'),
    /**
     * The FIRST ref code seen on this thread (`TT-4F2A9C`), from the `wa.me`
     * deep-link prefill. First, not last: it is the entry point that earned the
     * conversation, and overwriting it on a later message would re-attribute
     * the thread to whichever page the shopper happened to revisit.
     */
    refCode: text('ref_code'),
    /** 'open' | 'closed'. Closing is a human marking it handled; it never blocks a new inbound. */
    status: text('status').notNull().default('open'),
    /**
     * When the last inbound arrived. This is what the 24-hour free-form service
     * window is measured from — the single fact that decides whether a reply can
     * be free text or must be an approved template. Stored rather than derived
     * so `/admin` can sort by it without recomputing over the message table.
     */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    /** Inbound messages with no outbound after them — the `/admin` unread badge. */
    unreadCount: integer('unread_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wa_conversations_last_inbound_idx').on(table.lastInboundAt),
    index('wa_conversations_user_idx').on(table.userId),
    check('wa_conversations_status_valid', sql`${table.status} in ('open','closed')`),
  ]
)

/**
 * Every message on a thread, inbound and outbound, in one table.
 *
 * `waMessageId` is UNIQUE and that is load-bearing: Meta retries a webhook it
 * did not get a 200 for, and without the unique constraint a retry would append
 * the shopper's message a second time and re-fire whatever it triggers. The
 * insert is `onConflictDoNothing` against it, which makes the whole webhook
 * idempotent — the only correct posture for an endpoint someone else retries.
 */
export const waMessages = pgTable(
  'wa_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => waConversations.id, { onDelete: 'cascade' }),
    /** 'inbound' | 'outbound' — enforced by `wa_messages_direction_valid`. */
    direction: text('direction').notNull(),
    /**
     * Meta's own message id (`wamid.*`). The dedupe key for inbound; set on
     * outbound too once Meta acknowledges the send. Nullable because an
     * outbound row is written BEFORE the send returns, and a failed send never
     * gets one.
     */
    waMessageId: text('wa_message_id').unique(),
    /** 'text' | 'image' | 'unsupported' — what Meta said the message was. */
    msgType: text('msg_type').notNull().default('text'),
    /** Body text. Empty for a media message we chose not to download. */
    body: text('body').notNull().default(''),
    /**
     * Outbound only: 'sent' | 'delivered' | 'read' | 'failed'. Null on inbound —
     * an inbound message already happened, there is nothing to report about it.
     *
     * Written as 'sent' when Meta accepts the send, then advanced in place by
     * the webhook's `statuses` receipts. It only ever moves FORWARD along that
     * order (see `applyStatusUpdate`), because Meta re-sends receipts and
     * delivers them out of order — a late 'delivered' must not un-read a
     * message. This is what `/admin` draws its ticks from.
     */
    status: text('status'),
    /** Outbound only: why the send failed, verbatim from the adapter. */
    error: text('error'),
    /** The admin who wrote an outbound reply; null for automated replies. */
    sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wa_messages_conversation_idx').on(table.conversationId, table.createdAt),
    check('wa_messages_direction_valid', sql`${table.direction} in ('inbound','outbound')`),
    check(
      'wa_messages_status_valid',
      sql`${table.status} is null or ${table.status} in ('sent','delivered','read','failed')`
    ),
  ]
)

export type WaConversationRow = typeof waConversations.$inferSelect
export type NewWaConversationRow = typeof waConversations.$inferInsert
export type WaMessageRow = typeof waMessages.$inferSelect
export type NewWaMessageRow = typeof waMessages.$inferInsert

/**
 * Browsers an admin has granted notification permission on.
 *
 * One row per browser install, not per person: the owner has a phone home-screen
 * app and a laptop, and a message must reach whichever one is in their hand.
 *
 * `token` is the FCM registration token and is UNIQUE across the whole table,
 * not per user — the token identifies a browser, and if that browser is later
 * signed in as somebody else the registration must MOVE rather than duplicate.
 * Two rows with one token would push the same alert twice.
 *
 * `ON DELETE CASCADE` on the user: a person who loses their account loses their
 * devices with it. There is no state here worth keeping past that.
 */
export const adminPushDevices = pgTable(
  'admin_push_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** FCM registration token for one browser. Rotated by the browser itself. */
    token: text('token').notNull().unique(),
    /** Free text for the `/admin` device list — "iPhone home screen". */
    label: text('label').notNull().default(''),
    /**
     * Bumped every time the browser re-registers, which the SDK does on its own
     * schedule. A token that has not been seen in months belongs to a browser
     * that is gone, and pushing to it is how you learn that the slow way.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('admin_push_devices_user_idx').on(table.userId)]
)

export type AdminPushDeviceRow = typeof adminPushDevices.$inferSelect
export type DamageClaimRow = typeof damageClaims.$inferSelect
export type CustomRequestRow = typeof customRequests.$inferSelect
export type CaricaturePreviewRow = typeof caricaturePreviews.$inferSelect
export type RestockRequestRow = typeof restockRequests.$inferSelect
