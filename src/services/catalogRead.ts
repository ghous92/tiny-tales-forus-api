/**
 * Public catalog read model (SPEC-V2.md §3.2) — assembles the denormalized
 * `GET /v1/catalog` blob from the three source tables (products, variants,
 * categories). This is the READ side of the DB-owned catalog; the WRITE side
 * (admin CRUD) lives in services/catalogAdmin.ts, and cart's price authority
 * stays in services/catalog.ts (the thin `catalog_items` model). Nothing here
 * mutates anything.
 *
 * Only active products/categories are returned; variants come along with their
 * product. Ordering: products by (sort_order, id); categories by (sort_order,
 * slug); variants by (sort_order, size_ml) — deterministic so the ETag is
 * stable for identical data.
 */

import { asc, eq, inArray } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { categories, products, productVariants } from '../db/schema.js'
import { effectivePriceInr } from '../lib/pricing.js'
import type {
  CatalogCategory,
  CatalogProduct,
  CatalogSnapshot,
  CatalogVariant,
  Highlight,
  ProductImagesSchema,
} from '../contracts/catalog.js'
import { getCatalogVersion } from './catalogVersion.js'
import type { z } from 'zod'

type ProductImages = z.infer<typeof ProductImagesSchema>

/**
 * The Legal Metrology / Cosmetics Rules declarations a product carries, for one
 * product. Every field may be `''`: the catalog only enforces completeness at
 * the moment a product is set ACTIVE (services/catalogAdmin.ts), and an order
 * can contain a product that went live before that rule existed.
 */
export interface ProductLegalDeclarations {
  productId: string
  manufacturerName: string
  manufacturerAddress: string
  /** Cosmetics Rules 2020 manufacturing licence, e.g. "GC1299". Phase 3 — see `products.manufacturerLicence`. */
  manufacturerLicence: string
  countryOfOrigin: string
  consumerCareContact: string
  /** Marketing brand. `''` ⇒ the store-wide `legal.company.brand`. */
  brand: string
}

/**
 * These declarations for the given products, for the invoice generator — the
 * "Manufactured & marketed by" block is a mandatory disclosure, not a display
 * nicety, so the invoice route reads it through the catalog module rather than
 * querying `products` itself (ARCHITECTURE.md rule 2).
 *
 * Deliberately NOT filtered by `active`: an invoice is issued for what was
 * bought, and a product delisted since the order still has to be attributed on
 * the document that names it.
 */
export async function getProductLegalInfo(
  db: Db,
  productIds: string[]
): Promise<ProductLegalDeclarations[]> {
  if (productIds.length === 0) return []
  const rows = await db
    .select({
      productId: products.id,
      manufacturerName: products.manufacturerName,
      manufacturerAddress: products.manufacturerAddress,
      manufacturerLicence: products.manufacturerLicence,
      countryOfOrigin: products.countryOfOrigin,
      consumerCareContact: products.consumerCareContact,
      brand: products.brand,
    })
    .from(products)
    .where(inArray(products.id, productIds))
  return rows
}

/**
 * Assemble the full public catalog snapshot. One query per table (three total),
 * joined in memory by product id — cheap at this catalog's size and avoids a
 * fan-out join that would duplicate product rows per variant. The `version`
 * string is the catalog counter (the ETag), so an unchanged catalog always
 * serializes identically.
 */
export async function getCatalogSnapshot(db: Db): Promise<CatalogSnapshot> {
  const [version, productRows, variantRows, categoryRows] = await Promise.all([
    getCatalogVersion(db),
    db
      .select()
      .from(products)
      .where(eq(products.active, true))
      .orderBy(asc(products.sortOrder), asc(products.id)),
    db
      .select()
      .from(productVariants)
      .orderBy(asc(productVariants.sortOrder), asc(productVariants.sizeMl)),
    db
      .select()
      .from(categories)
      .where(eq(categories.active, true))
      .orderBy(asc(categories.sortOrder), asc(categories.slug)),
  ])

  // Bucket the raw variant ROWS by product (order preserved). The public
  // `effective_price_inr` needs the product's seasonal discount, which isn't in
  // scope here — so it's computed below when each product is assembled.
  const variantRowsByProduct = new Map<string, typeof variantRows>()
  for (const v of variantRows) {
    const list = variantRowsByProduct.get(v.productId) ?? []
    list.push(v)
    variantRowsByProduct.set(v.productId, list)
  }

  /** Map a variant row to its public shape, folding in the product's discount. */
  const toVariant = (v: (typeof variantRows)[number], seasonalPct: number): CatalogVariant => ({
    sku: v.sku,
    asin: v.asin,
    size: v.size,
    size_ml: v.sizeMl,
    color: v.color,
    price_inr: v.priceInr,
    mrp_inr: v.mrpInr,
    effective_price_inr: effectivePriceInr(v.priceInr, seasonalPct),
    in_stock: v.inStock,
    stock_qty: v.stockQty,
    best_before_mode: v.bestBeforeMode as 'date' | 'printed_on_pack',
    best_before_date: v.bestBeforeDate ? v.bestBeforeDate.toISOString() : null,
    item_part_number: v.itemPartNumber,
    weight_g: v.weightG,
    length_cm: v.lengthCm,
    width_cm: v.widthCm,
    height_cm: v.heightCm,
  })

  const productList: CatalogProduct[] = productRows.map((p) => {
    const variants = (variantRowsByProduct.get(p.id) ?? []).map((v) =>
      toVariant(v, p.seasonalDiscountPct)
    )
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      category: p.category,
      description: p.description,
      bullets: p.bullets as string[],
      highlights: p.highlights as Highlight[],
      images: p.images as ProductImages,
      variants,
      // Product is in stock when ANY of its variants is (mobile Product.in_stock).
      in_stock: variants.some((v) => v.in_stock),
      is_best_seller: p.isBestSeller,
      is_recommended: p.isRecommended,
      sort_order: p.sortOrder,
      seasonal_discount_pct: p.seasonalDiscountPct,
      max_qty_per_user: p.maxQtyPerUser,
      new_until: p.newUntil ? p.newUntil.toISOString() : null,
      manufacturer_name: p.manufacturerName,
      manufacturer_address: p.manufacturerAddress,
      country_of_origin: p.countryOfOrigin,
      consumer_care_contact: p.consumerCareContact,
      unspsc_code: p.unspscCode,
      generic_name: p.genericName,
      included_components: p.includedComponents,
      packer_name: p.packerName,
      packer_address: p.packerAddress,
      first_available_at: p.firstAvailableAt ? p.firstAvailableAt.toISOString() : null,
    }
  })

  const categoryList: CatalogCategory[] = categoryRows.map((c) => ({
    slug: c.slug,
    label: c.label,
    image_url: c.imageUrl,
    sort_order: c.sortOrder,
  }))

  return { version: String(version), products: productList, categories: categoryList }
}
