/**
 * Admin catalog business rules (SPEC-V2.md §3.2) — create/update/delete for
 * products, variants, and categories. Routes hand this module validated input;
 * it owns every invariant:
 *
 * - Every write runs in ONE transaction that also re-projects the affected
 *   product into `catalog_items` (cart's price authority), so the price
 *   authority can never lag a catalog change. The catalog version (the
 *   `GET /v1/catalog` ETag) is bumped by a DB trigger on that same transaction
 *   — this module must NOT bump it too, or every admin write counts twice.
 *   See services/catalogVersion.ts for why the bump lives in the database.
 * - The projection, unlike the version, is NOT enforced by the database: it
 *   applies `lib/pricing.ts` and cannot be duplicated in SQL without splitting
 *   that formula in two. `npm run catalog:doctor` detects drift when someone
 *   writes the catalog tables without going through this module.
 * - Referential integrity is checked with clear API errors, not raw FK
 *   explosions: a product's category must exist; a variant's product must exist.
 * - Delete is a hard delete of the source row (products cascade to their
 *   variants); the projection then DEACTIVATES the corresponding catalog_items
 *   rows (never deletes them) so existing cart lines still resolve.
 *
 * Read side (public snapshot) is services/catalogRead.ts; this module never
 * serves GET /v1/catalog.
 */

import { and, asc, eq } from 'drizzle-orm'

import type {
  AdminCategory,
  AdminProduct,
  AdminVariant,
  CategoryCreate,
  CategoryUpdate,
  Highlight,
  ProductCreate,
  ProductImagesSchema,
  ProductUpdate,
  VariantCreate,
  VariantUpdate,
} from '../contracts/catalog.js'
import type { Db } from '../db/client.js'
import {
  categories,
  products,
  productVariants,
  type CategoryRow,
  type ProductRow,
  type ProductVariantRow,
} from '../db/schema.js'
import { notFound, validationFailed } from '../lib/errors.js'
import { deactivateSku, projectProduct } from './catalogProjection.js'
import type { z } from 'zod'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type ProductImages = z.infer<typeof ProductImagesSchema>

const EMPTY_IMAGES: ProductImages = {
  main: { thumb: '', grid: '', pdp: '', zoom: '' },
  gallery: [],
}

/**
 * The stored image map, filled out to the contract shape. A row written
 * without images (the column default is `{}`, e.g. the custom-figure seed)
 * would otherwise fail response serialization and 500 the whole list.
 */
function toProductImages(value: unknown): ProductImages {
  const images = (value ?? {}) as Partial<ProductImages>
  return {
    ...images,
    main: images.main ?? EMPTY_IMAGES.main,
    gallery: images.gallery ?? [],
  }
}

// --- Row → API mappers -------------------------------------------------------

function toAdminVariant(row: ProductVariantRow): AdminVariant {
  return {
    sku: row.sku,
    productId: row.productId,
    asin: row.asin,
    itemPartNumber: row.itemPartNumber,
    size: row.size,
    sizeMl: row.sizeMl,
    color: row.color,
    weightG: row.weightG,
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    priceInr: row.priceInr,
    mrpInr: row.mrpInr,
    inStock: row.inStock,
    stockQty: row.stockQty,
    sortOrder: row.sortOrder,
    bestBeforeMode: row.bestBeforeMode as 'date' | 'printed_on_pack',
    bestBeforeDate: row.bestBeforeDate ? row.bestBeforeDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toAdminProduct(row: ProductRow, variants: ProductVariantRow[]): AdminProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    description: row.description,
    bullets: row.bullets as string[],
    highlights: row.highlights as Highlight[],
    images: toProductImages(row.images),
    isBestSeller: row.isBestSeller,
    isRecommended: row.isRecommended,
    sortOrder: row.sortOrder,
    seasonalDiscountPct: row.seasonalDiscountPct,
    maxQtyPerUser: row.maxQtyPerUser,
    newUntil: row.newUntil ? row.newUntil.toISOString() : null,
    active: row.active,
    hidden: row.hidden,
    hiddenReason: row.hiddenReason,
    manufacturerName: row.manufacturerName,
    manufacturerAddress: row.manufacturerAddress,
    countryOfOrigin: row.countryOfOrigin,
    consumerCareContact: row.consumerCareContact,
    unspscCode: row.unspscCode,
    genericName: row.genericName,
    includedComponents: row.includedComponents,
    packerName: row.packerName,
    packerAddress: row.packerAddress,
    firstAvailableAt: row.firstAvailableAt ? row.firstAvailableAt.toISOString() : null,
    hsnCode: row.hsnCode,
    gstRatePct: row.gstRatePct,
    manufacturerLicence: row.manufacturerLicence,
    brand: row.brand,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    variants: variants.map(toAdminVariant),
  }
}

// --- Legal Metrology / E-Commerce Rules "can't go live incomplete" gate -----
//
// Enforced here (the sole write path for products/variants) rather than as a
// DB CHECK constraint tied to `active`/`inStock`, because a hard CHECK would
// fail the migration itself against any product already live today without
// this data. Existing rows keep serving until an admin touches them; from
// this point on, no create/update can leave a PUBLISHED product or IN-STOCK
// variant missing a mandatory disclosure.

/**
 * Throws 422 listing every missing Legal Metrology field, if `active` and
 * something's blank. `gstRegistered` (resolved from `legal.company` by the
 * ROUTE layer — this service may not read config itself, ARCHITECTURE.md
 * rule 5) additionally requires `hsnCode` + a non-zero `gstRatePct` once the
 * seller is GST-registered: an unregistered seller charges no tax, so an
 * unset rate is fine, but a registered one publishing a product with no rate
 * decided would silently undertax it (docs plan §2.2). NO LONGER DORMANT —
 * `gstRegistered` has been `true` in prod since 2026-08-13, and the real GSTIN
 * landed 2026-09-04, so this check is live. Note every product's `hsnCode` and
 * `gstRatePct` are still CA-unconfirmed placeholders (`scripts/backfill-gst-
 * dummy-data.ts`), so the check passes on values that may be wrong.
 */
function assertProductLegalMetrologyComplete(fields: {
  active: boolean
  manufacturerName: string
  manufacturerAddress: string
  manufacturerLicence: string
  countryOfOrigin: string
  consumerCareContact: string
  gstRegistered: boolean
  hsnCode: string
  gstRatePct: number
}): void {
  if (!fields.active) return
  const missing: string[] = []
  if (!fields.manufacturerName.trim()) missing.push('manufacturerName')
  if (!fields.manufacturerAddress.trim()) missing.push('manufacturerAddress')
  // Phase 3: a product that names its own maker must carry that maker's own
  // licence. `lib/invoiceDocument.ts` attributes such a product entirely to
  // itself, so a blank here prints a manufacturer block with no licence number
  // at all — and it must NOT fall back to `legal.manufacturer.licence`, which
  // belongs to a different entity.
  if (!fields.manufacturerLicence.trim()) missing.push('manufacturerLicence')
  if (!fields.countryOfOrigin.trim()) missing.push('countryOfOrigin')
  if (!fields.consumerCareContact.trim()) missing.push('consumerCareContact')
  if (fields.gstRegistered) {
    if (!fields.hsnCode.trim()) missing.push('hsnCode')
    if (fields.gstRatePct === 0) missing.push('gstRatePct')
  }
  if (missing.length > 0) {
    throw validationFailed(
      `Cannot publish product (active: true) — missing required Legal Metrology field(s): ${missing.join(', ')}`
    )
  }
}

/**
 * Throws a clean 422 if bestBeforeMode "date" has no date — same invariant the
 * DB CHECK (`product_variants_best_before_date_required_when_dated`) enforces
 * unconditionally, checked here first so a bad request gets a clear
 * `validation_failed` instead of a raw constraint-violation 500.
 */
function assertVariantBestBeforeValid(fields: {
  bestBeforeMode: string
  bestBeforeDate: Date | null
}): void {
  if (fields.bestBeforeMode === 'date' && !fields.bestBeforeDate) {
    throw validationFailed('bestBeforeMode "date" requires a bestBeforeDate')
  }
}

function toAdminCategory(row: CategoryRow): AdminCategory {
  return {
    slug: row.slug,
    label: row.label,
    imageUrl: row.imageUrl,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// --- Reads (admin view: includes inactive) -----------------------------------

/** Every product with its variants, admin view (active + inactive), ordered. */
export async function listAdminProducts(db: Db): Promise<AdminProduct[]> {
  const [productRows, variantRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.sortOrder), asc(products.id)),
    db
      .select()
      .from(productVariants)
      .orderBy(asc(productVariants.sortOrder), asc(productVariants.sizeMl)),
  ])
  const byProduct = new Map<string, ProductVariantRow[]>()
  for (const v of variantRows) {
    const list = byProduct.get(v.productId) ?? []
    list.push(v)
    byProduct.set(v.productId, list)
  }
  return productRows.map((p) => toAdminProduct(p, byProduct.get(p.id) ?? []))
}

/** One product with variants, or 404. */
export async function getAdminProduct(db: Db, id: string): Promise<AdminProduct> {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1)
  if (!row) throw notFound(`Product "${id}" not found`)
  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, id))
    .orderBy(asc(productVariants.sortOrder), asc(productVariants.sizeMl))
  return toAdminProduct(row, variants)
}

/** Every category, admin view (active + inactive), ordered. */
export async function listAdminCategories(db: Db): Promise<AdminCategory[]> {
  const rows = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.slug))
  return rows.map(toAdminCategory)
}

// --- Category writes ---------------------------------------------------------

export async function createCategory(db: Db, input: CategoryCreate): Promise<AdminCategory> {
  const row = await db.transaction(async (tx: Tx) => {
    const [existing] = await tx
      .select({ slug: categories.slug })
      .from(categories)
      .where(eq(categories.slug, input.slug))
      .limit(1)
    if (existing) throw validationFailed(`Category "${input.slug}" already exists`)

    const [created] = await tx
      .insert(categories)
      .values({
        slug: input.slug,
        label: input.label,
        imageUrl: input.imageUrl ?? '',
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true,
      })
      .returning()
    return created!
  })
  return toAdminCategory(row)
}

export async function updateCategory(
  db: Db,
  slug: string,
  input: CategoryUpdate
): Promise<AdminCategory> {
  const row = await db.transaction(async (tx: Tx) => {
    const [updated] = await tx
      .update(categories)
      .set({
        ...(input.label !== undefined && { label: input.label }),
        ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.active !== undefined && { active: input.active }),
        updatedAt: new Date(),
      })
      .where(eq(categories.slug, slug))
      .returning()
    if (!updated) throw notFound(`Category "${slug}" not found`)
    return updated
  })
  return toAdminCategory(row)
}

/**
 * Delete a category. Rejected (validation_failed) if any product still
 * references it — the caller must reassign or delete those products first, so
 * the FK on products.category can never dangle.
 */
export async function deleteCategory(db: Db, slug: string): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const [inUse] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.category, slug))
      .limit(1)
    if (inUse) {
      throw validationFailed(`Category "${slug}" still has products; reassign or delete them first`)
    }
    const [deleted] = await tx.delete(categories).where(eq(categories.slug, slug)).returning()
    if (!deleted) throw notFound(`Category "${slug}" not found`)
  })
}

// --- Product writes ----------------------------------------------------------

/**
 * `gstRegistered` is resolved from `legal.company` by the caller (the route
 * layer — see `assertProductLegalMetrologyComplete`'s doc comment) and
 * defaults to `false`, matching the seller's actual status today, so every
 * existing caller (including tests that predate GST) is unaffected.
 */
export async function createProduct(
  db: Db,
  input: ProductCreate,
  opts: { gstRegistered?: boolean } = {}
): Promise<AdminProduct> {
  const gstRegistered = opts.gstRegistered ?? false
  await db.transaction(async (tx: Tx) => {
    await assertCategoryExists(tx, input.category)

    const [existing] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, input.id))
      .limit(1)
    if (existing) throw validationFailed(`Product "${input.id}" already exists`)

    const active = input.active ?? true
    const manufacturerName = input.manufacturerName ?? ''
    const manufacturerAddress = input.manufacturerAddress ?? ''
    const manufacturerLicence = input.manufacturerLicence ?? ''
    const countryOfOrigin = input.countryOfOrigin ?? 'India'
    const consumerCareContact = input.consumerCareContact ?? ''
    const hsnCode = input.hsnCode ?? ''
    const gstRatePct = input.gstRatePct ?? 0
    assertProductLegalMetrologyComplete({
      active,
      manufacturerName,
      manufacturerAddress,
      manufacturerLicence,
      countryOfOrigin,
      consumerCareContact,
      gstRegistered,
      hsnCode,
      gstRatePct,
    })

    await tx.insert(products).values({
      id: input.id,
      slug: input.slug,
      name: input.name,
      category: input.category,
      description: input.description ?? '',
      bullets: input.bullets ?? [],
      highlights: input.highlights ?? [],
      images: input.images ?? EMPTY_IMAGES,
      isBestSeller: input.isBestSeller ?? false,
      isRecommended: input.isRecommended ?? false,
      sortOrder: input.sortOrder ?? 0,
      seasonalDiscountPct: input.seasonalDiscountPct ?? 0,
      maxQtyPerUser: input.maxQtyPerUser ?? null,
      newUntil: input.newUntil ? new Date(input.newUntil) : null,
      active,
      hidden: input.hidden ?? false,
      hiddenReason: input.hiddenReason ?? '',
      manufacturerName,
      manufacturerAddress,
      countryOfOrigin,
      consumerCareContact,
      unspscCode: input.unspscCode ?? '',
      genericName: input.genericName ?? '',
      includedComponents: input.includedComponents ?? '',
      packerName: input.packerName ?? '',
      packerAddress: input.packerAddress ?? '',
      firstAvailableAt: input.firstAvailableAt ? new Date(input.firstAvailableAt) : null,
      hsnCode,
      gstRatePct,
      manufacturerLicence,
      brand: input.brand ?? '',
    })
    await projectProduct(tx, input.id) // no variants yet — deactivates nothing
  })
  return getAdminProduct(db, input.id)
}

export async function updateProduct(
  db: Db,
  id: string,
  input: ProductUpdate,
  opts: { gstRegistered?: boolean } = {}
): Promise<AdminProduct> {
  const gstRegistered = opts.gstRegistered ?? false
  await db.transaction(async (tx: Tx) => {
    if (input.category !== undefined) await assertCategoryExists(tx, input.category)

    const [current] = await tx.select().from(products).where(eq(products.id, id)).limit(1)
    if (!current) throw notFound(`Product "${id}" not found`)
    assertProductLegalMetrologyComplete({
      active: input.active ?? current.active,
      manufacturerName: input.manufacturerName ?? current.manufacturerName,
      manufacturerAddress: input.manufacturerAddress ?? current.manufacturerAddress,
      manufacturerLicence: input.manufacturerLicence ?? current.manufacturerLicence,
      countryOfOrigin: input.countryOfOrigin ?? current.countryOfOrigin,
      consumerCareContact: input.consumerCareContact ?? current.consumerCareContact,
      gstRegistered,
      hsnCode: input.hsnCode ?? current.hsnCode,
      gstRatePct: input.gstRatePct ?? current.gstRatePct,
    })

    const [updated] = await tx
      .update(products)
      .set({
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.bullets !== undefined && { bullets: input.bullets }),
        ...(input.highlights !== undefined && { highlights: input.highlights }),
        ...(input.images !== undefined && { images: input.images }),
        ...(input.isBestSeller !== undefined && { isBestSeller: input.isBestSeller }),
        ...(input.isRecommended !== undefined && { isRecommended: input.isRecommended }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.seasonalDiscountPct !== undefined && {
          seasonalDiscountPct: input.seasonalDiscountPct,
        }),
        ...(input.maxQtyPerUser !== undefined && { maxQtyPerUser: input.maxQtyPerUser }),
        ...(input.newUntil !== undefined && {
          newUntil: input.newUntil ? new Date(input.newUntil) : null,
        }),
        ...(input.active !== undefined && { active: input.active }),
        ...(input.hidden !== undefined && { hidden: input.hidden }),
        ...(input.hiddenReason !== undefined && { hiddenReason: input.hiddenReason }),
        ...(input.manufacturerName !== undefined && { manufacturerName: input.manufacturerName }),
        ...(input.manufacturerAddress !== undefined && {
          manufacturerAddress: input.manufacturerAddress,
        }),
        ...(input.countryOfOrigin !== undefined && { countryOfOrigin: input.countryOfOrigin }),
        ...(input.consumerCareContact !== undefined && {
          consumerCareContact: input.consumerCareContact,
        }),
        ...(input.unspscCode !== undefined && { unspscCode: input.unspscCode }),
        ...(input.genericName !== undefined && { genericName: input.genericName }),
        ...(input.includedComponents !== undefined && {
          includedComponents: input.includedComponents,
        }),
        ...(input.packerName !== undefined && { packerName: input.packerName }),
        ...(input.packerAddress !== undefined && { packerAddress: input.packerAddress }),
        ...(input.firstAvailableAt !== undefined && {
          firstAvailableAt: input.firstAvailableAt ? new Date(input.firstAvailableAt) : null,
        }),
        ...(input.hsnCode !== undefined && { hsnCode: input.hsnCode }),
        ...(input.gstRatePct !== undefined && { gstRatePct: input.gstRatePct }),
        ...(input.manufacturerLicence !== undefined && {
          manufacturerLicence: input.manufacturerLicence,
        }),
        ...(input.brand !== undefined && { brand: input.brand }),
        updatedAt: new Date(),
      })
      .where(eq(products.id, id))
      .returning()
    if (!updated) throw notFound(`Product "${id}" not found`)
    // name/images/active affect the projection (name+image copied, active gates
    // catalog_items.active), so re-project regardless of which field changed.
    await projectProduct(tx, id)
  })
  return getAdminProduct(db, id)
}

/** Hard-delete a product (variants cascade); projection deactivates its skus. */
export async function deleteProduct(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const [deleted] = await tx.delete(products).where(eq(products.id, id)).returning()
    if (!deleted) throw notFound(`Product "${id}" not found`)
    await projectProduct(tx, id, { productDeleted: true })
  })
}

// --- Variant writes ----------------------------------------------------------

export async function createVariant(
  db: Db,
  productIdParam: string,
  input: VariantCreate
): Promise<AdminVariant> {
  const row = await db.transaction(async (tx: Tx) => {
    await assertProductExists(tx, productIdParam)

    const [existing] = await tx
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(eq(productVariants.sku, input.sku))
      .limit(1)
    if (existing) throw validationFailed(`Variant sku "${input.sku}" already exists`)

    const bestBeforeMode = input.bestBeforeMode ?? 'printed_on_pack'
    const bestBeforeDate = input.bestBeforeDate ? new Date(input.bestBeforeDate) : null
    assertVariantBestBeforeValid({ bestBeforeMode, bestBeforeDate })

    const [created] = await tx
      .insert(productVariants)
      .values({
        sku: input.sku,
        productId: productIdParam,
        size: input.size,
        sizeMl: input.sizeMl ?? 0,
        color: input.color ?? null,
        weightG: input.weightG ?? 0,
        lengthCm: input.lengthCm ?? 0,
        widthCm: input.widthCm ?? 0,
        heightCm: input.heightCm ?? 0,
        priceInr: input.priceInr ?? null,
        mrpInr: input.mrpInr ?? 0,
        asin: input.asin ?? '',
        itemPartNumber: input.itemPartNumber ?? '',
        inStock: input.inStock ?? true,
        stockQty: input.stockQty ?? null,
        sortOrder: input.sortOrder ?? 0,
        bestBeforeMode,
        bestBeforeDate,
      })
      .returning()
    await projectProduct(tx, productIdParam)
    return created!
  })
  return toAdminVariant(row)
}

export async function updateVariant(
  db: Db,
  sku: string,
  input: VariantUpdate
): Promise<AdminVariant> {
  const row = await db.transaction(async (tx: Tx) => {
    const [current] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, sku))
      .limit(1)
    if (!current) throw notFound(`Variant "${sku}" not found`)

    const bestBeforeMode = input.bestBeforeMode ?? current.bestBeforeMode
    const bestBeforeDate =
      input.bestBeforeDate !== undefined
        ? input.bestBeforeDate
          ? new Date(input.bestBeforeDate)
          : null
        : current.bestBeforeDate
    assertVariantBestBeforeValid({ bestBeforeMode, bestBeforeDate })

    const [updated] = await tx
      .update(productVariants)
      .set({
        ...(input.size !== undefined && { size: input.size }),
        ...(input.sizeMl !== undefined && { sizeMl: input.sizeMl }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.weightG !== undefined && { weightG: input.weightG }),
        ...(input.lengthCm !== undefined && { lengthCm: input.lengthCm }),
        ...(input.widthCm !== undefined && { widthCm: input.widthCm }),
        ...(input.heightCm !== undefined && { heightCm: input.heightCm }),
        ...(input.priceInr !== undefined && { priceInr: input.priceInr }),
        ...(input.mrpInr !== undefined && { mrpInr: input.mrpInr }),
        ...(input.asin !== undefined && { asin: input.asin }),
        ...(input.itemPartNumber !== undefined && { itemPartNumber: input.itemPartNumber }),
        ...(input.inStock !== undefined && { inStock: input.inStock }),
        ...(input.stockQty !== undefined && { stockQty: input.stockQty }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.bestBeforeMode !== undefined && { bestBeforeMode: input.bestBeforeMode }),
        ...(input.bestBeforeDate !== undefined && { bestBeforeDate }),
        updatedAt: new Date(),
      })
      .where(eq(productVariants.sku, sku))
      .returning()
    if (!updated) throw notFound(`Variant "${sku}" not found`)
    await projectProduct(tx, updated.productId)
    return updated
  })
  return toAdminVariant(row)
}

/** Delete a single variant; its catalog_items row is deactivated (cart-safe). */
export async function deleteVariant(db: Db, sku: string): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const [deleted] = await tx
      .delete(productVariants)
      .where(eq(productVariants.sku, sku))
      .returning()
    if (!deleted) throw notFound(`Variant "${sku}" not found`)
    await deactivateSku(tx, sku)
  })
}

// --- Helpers -----------------------------------------------------------------

async function assertCategoryExists(tx: Tx, slug: string): Promise<void> {
  const [cat] = await tx
    .select({ slug: categories.slug })
    .from(categories)
    .where(and(eq(categories.slug, slug)))
    .limit(1)
  if (!cat) throw validationFailed(`Category "${slug}" does not exist`)
}

async function assertProductExists(tx: Tx, id: string): Promise<void> {
  const [p] = await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, id))
    .limit(1)
  if (!p) throw notFound(`Product "${id}" not found`)
}
