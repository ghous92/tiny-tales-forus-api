/**
 * Zod contracts for the catalog resource (SPEC-V2.md §3.2). Source of truth for
 * request validation AND response types; imports only `zod` so it can be shared
 * with the mobile repo (same rule as contracts/config.ts).
 *
 * The PUBLIC shape (`CatalogProductSchema`) is a superset of the mobile app's
 * `Product` type (mobile/src/lib/types.ts): every field the app already reads
 * (id/slug/name/category/description/bullets/highlights/images/variants/
 * in_stock/new_until) is present with identical names, PLUS merchandising
 * fields the app may adopt (is_best_seller, is_recommended, sort_order,
 * seasonal_discount_pct, max_qty_per_user). Field naming stays snake_case to
 * match the existing bundled JSON so the app needs no remapping.
 */

import { z } from 'zod'

// --- Shared value shapes -----------------------------------------------------

/** Four pre-sized image URLs for one photo. Matches mobile ImageSet. */
export const ImageSetSchema = z.object({
  thumb: z.string(),
  grid: z.string(),
  pdp: z.string(),
  zoom: z.string(),
  /**
   * Blur-up placeholder: a ~24px WebP inlined as a `data:` URI (a few hundred
   * bytes), NOT a URL. It travels inside the catalog blob precisely so it costs
   * no network of its own — the app paints it on the first frame while the real
   * image downloads, and on a cold offline install it is the only product
   * imagery there is.
   *
   * Optional because it is backfilled asynchronously (scripts/
   * backfill-image-placeholders.ts) and a product created before that run has
   * none. The app must degrade to a plain background when it is absent.
   */
  lqip: z.string().optional(),
})

/** The product image map: main + gallery, optional marketing hero. */
export const ProductImagesSchema = z.object({
  main: ImageSetSchema,
  gallery: z.array(ImageSetSchema),
  hero: ImageSetSchema.optional(),
})

/** One PDP highlight tile — Ionicons glyph + label/value. */
export const HighlightSchema = z.object({
  icon: z.string(),
  label: z.string(),
  value: z.string(),
})

/** One purchasable size, public view. `sku` is the cart line identity. */
export const CatalogVariantSchema = z.object({
  sku: z.string(),
  asin: z.string(),
  size: z.string(),
  size_ml: z.number().int(),
  /** Shade/color slug (e.g. "lavender-blue"), for products sold in multiple colors. Null when the product has none. */
  color: z.string().nullable(),
  price_inr: z.number().int(),
  mrp_inr: z.number().int(),
  /**
   * What the shopper actually pays: `price_inr` with the product's seasonal
   * discount applied (see lib/pricing.ts). Equals `price_inr` when there is no
   * seasonal discount. This is the number the cart charges (via catalog_items),
   * so the app must display THIS as the price and strike `price_inr`/`mrp_inr`
   * — showing `price_inr` as the payable price would disagree with the cart.
   */
  effective_price_inr: z.number().int(),
  in_stock: z.boolean(),
  /** On-hand quantity, or null when untracked. */
  stock_qty: z.number().int().nullable(),
  /** Legal Metrology "best before" disclosure — see products.consumer_care_contact doc. */
  best_before_mode: z.enum(['date', 'printed_on_pack']),
  /** Set only when `best_before_mode = 'date'`. */
  best_before_date: z.string().nullable(),
  /**
   * Pack facts for the PDP "Product details" / "Shipping details" spec blocks
   * (docs/SPEC-PDP-DETAILS.md). `weight_g` and the three dimensions are the
   * same numbers shipping prices the parcel with — 0 means UNMEASURED, and the
   * app must omit the row rather than print "0 g". `item_part_number` is '' when
   * unknown, same omit rule.
   */
  item_part_number: z.string(),
  weight_g: z.number().int(),
  length_cm: z.number().int(),
  width_cm: z.number().int(),
  height_cm: z.number().int(),
})

/** One product family, public view — the app's render contract. */
export const CatalogProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  bullets: z.array(z.string()),
  highlights: z.array(HighlightSchema),
  images: ProductImagesSchema,
  variants: z.array(CatalogVariantSchema),
  in_stock: z.boolean(),
  is_best_seller: z.boolean(),
  is_recommended: z.boolean(),
  sort_order: z.number().int(),
  seasonal_discount_pct: z.number().int(),
  max_qty_per_user: z.number().int().nullable(),
  new_until: z.string().nullable(),
  /**
   * Legal Metrology (Packaged Commodities) Rules + Consumer Protection
   * (E-Commerce) Rules mandatory PDP disclosures — always shown on the
   * product page, never in a collapsed accordion.
   */
  manufacturer_name: z.string(),
  manufacturer_address: z.string(),
  country_of_origin: z.string(),
  consumer_care_contact: z.string(),
  /**
   * Marketplace catalogue attributes for the PDP spec block. '' / null mean
   * "not known yet" — the app omits that row, it never renders an empty value.
   */
  unspsc_code: z.string(),
  generic_name: z.string(),
  included_components: z.string(),
  packer_name: z.string(),
  packer_address: z.string(),
  first_available_at: z.string().nullable(),
})

/** One category, public view. */
export const CatalogCategorySchema = z.object({
  slug: z.string(),
  label: z.string(),
  image_url: z.string(),
  sort_order: z.number().int(),
})

/**
 * GET /v1/catalog — the pre-joined, denormalized catalog blob. One request
 * gives the app everything the home + PDP screens need: products (with variants
 * and merchandising), categories (ordered), and a version for cache validation.
 */
export const CatalogSnapshotSchema = z.object({
  version: z.string(),
  products: z.array(CatalogProductSchema),
  categories: z.array(CatalogCategorySchema),
})

// --- Admin write contracts ---------------------------------------------------
//
// Admin bodies are strict (unknown keys rejected). Create requires the
// identifying + required fields; update is a partial patch (every field
// optional) so the visual admin can PATCH one field at a time. Server-managed
// fields (timestamps, derived in_stock) are never accepted.

const slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[- ][a-z0-9]+)*$/, 'lowercase words separated by "-" or a single space')

const productId = z.string().min(1).max(120)
const sku = z.string().min(1).max(120)
const discountPct = z.number().int().min(0).max(90)
const positiveInt = z.number().int().positive()
const nonNegInt = z.number().int().min(0)
/** Mirrors the DB check `products_gst_rate_pct_valid` / `catalog_items_gst_rate_pct_valid`. */
const gstRatePct = z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)])

/** POST /v1/admin/catalog/categories */
export const CategoryCreateSchema = z.strictObject({
  slug,
  label: z.string().min(1).max(120),
  imageUrl: z.string().max(2048).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
})

/** PUT /v1/admin/catalog/categories/:slug — partial patch. */
export const CategoryUpdateSchema = z.strictObject({
  label: z.string().min(1).max(120).optional(),
  imageUrl: z.string().max(2048).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
})

/** POST /v1/admin/catalog/products */
export const ProductCreateSchema = z.strictObject({
  id: productId,
  slug,
  name: z.string().min(1).max(300),
  category: z.string().min(1).max(120),
  description: z.string().max(20000).optional(),
  bullets: z.array(z.string().max(2000)).max(50).optional(),
  highlights: z.array(HighlightSchema).max(50).optional(),
  images: ProductImagesSchema.optional(),
  isBestSeller: z.boolean().optional(),
  isRecommended: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  seasonalDiscountPct: discountPct.optional(),
  maxQtyPerUser: positiveInt.nullish(),
  newUntil: z.iso.datetime().nullish(),
  active: z.boolean().optional(),
  manufacturerName: z.string().max(300).optional(),
  manufacturerAddress: z.string().max(2000).optional(),
  countryOfOrigin: z.string().max(120).optional(),
  consumerCareContact: z.string().max(300).optional(),
  unspscCode: z.string().max(60).optional(),
  genericName: z.string().max(300).optional(),
  includedComponents: z.string().max(1000).optional(),
  packerName: z.string().max(300).optional(),
  packerAddress: z.string().max(2000).optional(),
  firstAvailableAt: z.iso.datetime().nullish(),
  hsnCode: z.string().max(20).optional(),
  gstRatePct: gstRatePct.optional(),
  manufacturerLicence: z.string().max(120).optional(),
  brand: z.string().max(200).optional(),
})

/** PUT /v1/admin/catalog/products/:id — partial patch. `id` is immutable (path only). */
export const ProductUpdateSchema = z.strictObject({
  slug: slug.optional(),
  name: z.string().min(1).max(300).optional(),
  category: z.string().min(1).max(120).optional(),
  description: z.string().max(20000).optional(),
  bullets: z.array(z.string().max(2000)).max(50).optional(),
  highlights: z.array(HighlightSchema).max(50).optional(),
  images: ProductImagesSchema.optional(),
  isBestSeller: z.boolean().optional(),
  isRecommended: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  seasonalDiscountPct: discountPct.optional(),
  maxQtyPerUser: positiveInt.nullish(),
  newUntil: z.iso.datetime().nullish(),
  active: z.boolean().optional(),
  manufacturerName: z.string().max(300).optional(),
  manufacturerAddress: z.string().max(2000).optional(),
  countryOfOrigin: z.string().max(120).optional(),
  consumerCareContact: z.string().max(300).optional(),
  unspscCode: z.string().max(60).optional(),
  genericName: z.string().max(300).optional(),
  includedComponents: z.string().max(1000).optional(),
  packerName: z.string().max(300).optional(),
  packerAddress: z.string().max(2000).optional(),
  firstAvailableAt: z.iso.datetime().nullish(),
  hsnCode: z.string().max(20).optional(),
  gstRatePct: gstRatePct.optional(),
  manufacturerLicence: z.string().max(120).optional(),
  brand: z.string().max(200).optional(),
})

/** Packed weight in grams; 50 kg ceiling mirrors the DB check. 0 = unmeasured (shipping refuses to quote). */
const weightG = z.number().int().min(0).max(50000)
/** Carton dimension in cm; 300 cm ceiling is well past any parcel this catalog ships. */
const dimensionCm = z.number().int().min(0).max(300)

const bestBeforeMode = z.enum(['date', 'printed_on_pack'])

/** POST /v1/admin/catalog/products/:productId/variants */
export const VariantCreateSchema = z.strictObject({
  sku,
  size: z.string().min(1).max(60),
  sizeMl: nonNegInt.optional(),
  color: z.string().min(1).max(60).nullish(),
  weightG: weightG.optional(),
  lengthCm: dimensionCm.optional(),
  widthCm: dimensionCm.optional(),
  heightCm: dimensionCm.optional(),
  priceInr: nonNegInt,
  mrpInr: nonNegInt.optional(),
  asin: z.string().max(20).optional(),
  itemPartNumber: z.string().max(120).optional(),
  inStock: z.boolean().optional(),
  stockQty: nonNegInt.nullish(),
  sortOrder: z.number().int().optional(),
  bestBeforeMode: bestBeforeMode.optional(),
  bestBeforeDate: z.iso.datetime().nullish(),
})

/** PUT /v1/admin/catalog/variants/:sku — partial patch. `sku` immutable (path only). */
export const VariantUpdateSchema = z.strictObject({
  size: z.string().min(1).max(60).optional(),
  sizeMl: nonNegInt.optional(),
  color: z.string().min(1).max(60).nullish(),
  weightG: weightG.optional(),
  lengthCm: dimensionCm.optional(),
  widthCm: dimensionCm.optional(),
  heightCm: dimensionCm.optional(),
  priceInr: nonNegInt.optional(),
  mrpInr: nonNegInt.optional(),
  asin: z.string().max(20).optional(),
  itemPartNumber: z.string().max(120).optional(),
  inStock: z.boolean().optional(),
  stockQty: nonNegInt.nullish(),
  sortOrder: z.number().int().optional(),
  bestBeforeMode: bestBeforeMode.optional(),
  bestBeforeDate: z.iso.datetime().nullish(),
})

/** Path param schemas. */
export const ProductIdParamsSchema = z.strictObject({ id: productId })
export const ProductVariantsParamsSchema = z.strictObject({ productId })
export const SkuParamsSchema = z.strictObject({ sku })
export const SlugParamsSchema = z.strictObject({ slug })

/**
 * Admin product view — the full DB row (camelCase), including inactive/unpublished
 * products the public snapshot hides. Includes variants for convenience.
 */
export const AdminVariantSchema = z.object({
  sku: z.string(),
  productId: z.string(),
  asin: z.string(),
  itemPartNumber: z.string(),
  size: z.string(),
  sizeMl: z.number().int(),
  color: z.string().nullable(),
  /** Shipping inputs — see docs/SPEC-SHIPPING.md §4.1. 0 means unmeasured. */
  weightG: z.number().int(),
  lengthCm: z.number().int(),
  widthCm: z.number().int(),
  heightCm: z.number().int(),
  priceInr: z.number().int(),
  mrpInr: z.number().int(),
  inStock: z.boolean(),
  stockQty: z.number().int().nullable(),
  sortOrder: z.number().int(),
  bestBeforeMode,
  bestBeforeDate: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const AdminProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  bullets: z.array(z.string()),
  highlights: z.array(HighlightSchema),
  images: ProductImagesSchema,
  isBestSeller: z.boolean(),
  isRecommended: z.boolean(),
  sortOrder: z.number().int(),
  seasonalDiscountPct: z.number().int(),
  maxQtyPerUser: z.number().int().nullable(),
  newUntil: z.iso.datetime().nullable(),
  active: z.boolean(),
  manufacturerName: z.string(),
  manufacturerAddress: z.string(),
  countryOfOrigin: z.string(),
  consumerCareContact: z.string(),
  unspscCode: z.string(),
  genericName: z.string(),
  includedComponents: z.string(),
  packerName: z.string(),
  packerAddress: z.string(),
  firstAvailableAt: z.iso.datetime().nullable(),
  hsnCode: z.string(),
  gstRatePct: z.number().int(),
  manufacturerLicence: z.string(),
  brand: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  variants: z.array(AdminVariantSchema),
})

export const AdminProductListSchema = z.array(AdminProductSchema)

export const AdminCategorySchema = z.object({
  slug: z.string(),
  label: z.string(),
  imageUrl: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const AdminCategoryListSchema = z.array(AdminCategorySchema)

export type ImageSet = z.infer<typeof ImageSetSchema>
export type Highlight = z.infer<typeof HighlightSchema>
export type CatalogVariant = z.infer<typeof CatalogVariantSchema>
export type CatalogProduct = z.infer<typeof CatalogProductSchema>
export type CatalogCategory = z.infer<typeof CatalogCategorySchema>
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>
export type CategoryCreate = z.infer<typeof CategoryCreateSchema>
export type CategoryUpdate = z.infer<typeof CategoryUpdateSchema>
export type ProductCreate = z.infer<typeof ProductCreateSchema>
export type ProductUpdate = z.infer<typeof ProductUpdateSchema>
export type VariantCreate = z.infer<typeof VariantCreateSchema>
export type VariantUpdate = z.infer<typeof VariantUpdateSchema>
export type AdminProduct = z.infer<typeof AdminProductSchema>
export type AdminVariant = z.infer<typeof AdminVariantSchema>
export type AdminCategory = z.infer<typeof AdminCategorySchema>
