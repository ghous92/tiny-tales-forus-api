/**
 * Catalog read model (SPEC-V2.md §3). No public routes in v2 — this module
 * exists to give cart/payments a server-trusted price source (see
 * docs/ARCHITECTURE.md "Price integrity"). Rows are written exclusively by
 * `scripts/catalog-sync.ts`; nothing here mutates the table.
 */

import { eq, inArray } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { catalogItems, type CatalogItemRow } from '../db/schema.js'

/** A single catalog row, as read by other modules (cart/payments). */
export interface CatalogItem {
  sku: string
  productId: string
  name: string
  size: string
  priceInr: number
  /** Packed weight in grams, projected from the variant. 0 = unmeasured — shipping refuses to quote. */
  weightG: number
  /** Carton dimensions in cm, projected from the variant. 0 = unmeasured. */
  lengthCm: number
  widthCm: number
  heightCm: number
  imageUrl: string
  active: boolean
  /** Projected from `products.hsnCode`/`gstRatePct` — see the doc comment on `db/schema.ts` `products.hsnCode`. */
  hsnCode: string
  gstRatePct: number
}

function toCatalogItem(row: CatalogItemRow): CatalogItem {
  return {
    sku: row.sku,
    productId: row.productId,
    name: row.name,
    size: row.size,
    priceInr: row.priceInr,
    weightG: row.weightG,
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    imageUrl: row.imageUrl,
    active: row.active,
    hsnCode: row.hsnCode,
    gstRatePct: row.gstRatePct,
  }
}

/** Look up any of the given skus (active or not) — cart display needs inactive rows too. */
export async function getItemsBySkus(db: Db, skus: string[]): Promise<CatalogItem[]> {
  if (skus.length === 0) return []
  const rows = await db.select().from(catalogItems).where(inArray(catalogItems.sku, skus))
  return rows.map(toCatalogItem)
}

/** Only the active rows among the given skus — the price/eligibility authority for new cart lines. */
export async function getActiveItems(db: Db, skus: string[]): Promise<CatalogItem[]> {
  const items = await getItemsBySkus(db, skus)
  return items.filter((item) => item.active)
}

/** Single-sku lookup, or `undefined` if the sku doesn't exist at all. */
export async function getItemBySku(db: Db, sku: string): Promise<CatalogItem | undefined> {
  const [row] = await db.select().from(catalogItems).where(eq(catalogItems.sku, sku)).limit(1)
  return row ? toCatalogItem(row) : undefined
}

/** Every sku belonging to a product — used by `payments.hasPurchasedProduct` to match order lines to a product. */
export async function getSkusByProductId(db: Db, productId: string): Promise<string[]> {
  const rows = await db
    .select({ sku: catalogItems.sku })
    .from(catalogItems)
    .where(eq(catalogItems.productId, productId))
  return rows.map((row) => row.sku)
}
