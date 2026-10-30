/**
 * Projection: keep `catalog_items` (cart/payments' sku-keyed price authority)
 * in sync with the DB-owned catalog (products + variants). The rich tables are
 * the source of truth for the storefront; `catalog_items` is a thin read model
 * cart already depends on (FK: cart_items.sku → catalog_items.sku). Rather than
 * migrate cart, every admin catalog write re-projects the affected products'
 * variants here, IN THE SAME TRANSACTION — so the price authority can never lag
 * the catalog.
 *
 * Mapping (mirrors scripts/catalog-sync.ts, which projected from the JSON file):
 *   catalog_items.sku       = variant.sku
 *   catalog_items.productId = product.id
 *   catalog_items.name      = product.name
 *   catalog_items.size      = catalogItemSize(variant.size, variant.color)
 *   catalog_items.priceInr  = effectivePriceInr(variant.priceInr, product.seasonalDiscountPct)
 *   catalog_items.weightG   = variant.weightG
 *   catalog_items.{length,width,height}Cm = variant.{length,width,height}Cm
 *   catalog_items.imageUrl  = product.images.main.grid
 *   catalog_items.hsnCode   = product.hsnCode
 *   catalog_items.gstRatePct = product.gstRatePct
 *   catalog_items.active    = product.active AND variant.inStock
 *
 * `priceInr` is the EFFECTIVE (seasonally-discounted) price, not the raw variant
 * price: `catalog_items` is cart's + payments' price authority, so folding the
 * discount in here makes the charged total reflect it with zero change to cart
 * logic. The formula lives in lib/pricing.ts so display (public catalog) and
 * charge (this projection) can never diverge.
 *
 * A variant that no longer exists (deleted) or whose product is inactive is
 * DEACTIVATED, never deleted — cart lines referencing it must still resolve
 * (they show as unavailable), exactly as the old sync behaved.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { catalogItems, products, productVariants } from '../db/schema.js'
import { catalogItemSize } from '../lib/filamentColors.js'
import { effectivePriceInr } from '../lib/pricing.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface MainImage {
  main?: { grid?: string }
}

/** product.images.main.grid, or '' when images are unset/misshapen. */
function gridUrl(images: unknown): string {
  return (images as MainImage)?.main?.grid ?? ''
}

/**
 * Whether a variant is purchasable: the product is on sale and not taken down,
 * the variant is in stock, and it HAS a price. An unpriced variant is still
 * shown in the public catalog ("Coming soon"), but projecting it as active
 * would let the cart charge ₹0 for it.
 */
export function isPurchasable(
  product: { active: boolean; hidden: boolean },
  variant: { inStock: boolean; priceInr: number | null }
): boolean {
  return product.active && !product.hidden && variant.inStock && variant.priceInr !== null
}

/**
 * Re-project a single product's variants into `catalog_items`. Upserts every
 * current variant and deactivates any `catalog_items` row for this product
 * whose sku is no longer among them (variant deleted). Call inside the same
 * transaction as the product/variant write. `productId` must still exist in
 * `products` UNLESS `productDeleted` is set (then all its skus deactivate).
 */
export async function projectProduct(
  tx: Tx,
  productId: string,
  opts: { productDeleted?: boolean } = {}
): Promise<void> {
  if (opts.productDeleted) {
    // Product gone: deactivate all its catalog_items, keep rows for cart refs.
    await tx
      .update(catalogItems)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(catalogItems.productId, productId))
    return
  }

  const [product] = await tx.select().from(products).where(eq(products.id, productId)).limit(1)
  if (!product) {
    // Defensive: treat a missing product as deleted rather than throwing —
    // keeps the projection total (no half-synced catalog_items).
    await tx
      .update(catalogItems)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(catalogItems.productId, productId))
    return
  }

  const variants = await tx
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId))

  const image = gridUrl(product.images)
  const liveSkus: string[] = []

  for (const v of variants) {
    liveSkus.push(v.sku)
    const active = isPurchasable(product, v)
    // Cart/payments charge this price — fold in the product's seasonal discount
    // so the authority already reflects it (see lib/pricing.ts). pct 0 → raw.
    // An unpriced variant projects as 0 but always inactive (see isPurchasable),
    // so that 0 can never reach a cart total.
    const priceInr = effectivePriceInr(v.priceInr ?? 0, product.seasonalDiscountPct)
    const size = catalogItemSize(v.size, v.color)
    await tx
      .insert(catalogItems)
      .values({
        sku: v.sku,
        productId: product.id,
        name: product.name,
        size,
        priceInr,
        // Shipping's weight authority, same reason as priceInr: cart may only
        // read catalog_items, so an unprojected weight means every cart quotes
        // at tare (see docs/SPEC-SHIPPING.md §4.2).
        weightG: v.weightG,
        lengthCm: v.lengthCm,
        widthCm: v.widthCm,
        heightCm: v.heightCm,
        imageUrl: image,
        hsnCode: product.hsnCode,
        gstRatePct: product.gstRatePct,
        active,
      })
      .onConflictDoUpdate({
        target: catalogItems.sku,
        set: {
          productId: product.id,
          name: product.name,
          size,
          priceInr,
          weightG: v.weightG,
          lengthCm: v.lengthCm,
          widthCm: v.widthCm,
          heightCm: v.heightCm,
          imageUrl: image,
          hsnCode: product.hsnCode,
          gstRatePct: product.gstRatePct,
          active,
          updatedAt: new Date(),
        },
      })
  }

  // Deactivate catalog_items for this product whose variant was removed.
  await tx
    .update(catalogItems)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(catalogItems.productId, productId),
        eq(catalogItems.active, true),
        liveSkus.length > 0 ? notInArray(catalogItems.sku, liveSkus) : sql`true`
      )
    )
}

/**
 * Deactivate a single sku in `catalog_items` (variant deleted while its product
 * stays). Kept separate so a variant-delete needn't re-derive the whole product.
 */
export async function deactivateSku(tx: Tx, sku: string): Promise<void> {
  await tx
    .update(catalogItems)
    .set({ active: false, updatedAt: new Date() })
    .where(inArray(catalogItems.sku, [sku]))
}
