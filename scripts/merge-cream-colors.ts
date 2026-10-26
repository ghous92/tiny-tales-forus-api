#!/usr/bin/env tsx
/**
 * `npm run catalog:merge-cream-colors` — one-time migration collapsing the 3
 * separate Daniya body-cream products (`dan-cream-lavender-blue`,
 * `dan-cream-lily-green`, `dan-cream-rose-pink`) into a single `dan-cream`
 * product, with color promoted to a variant dimension alongside size
 * (`product_variants.color`, added by migration 0008).
 *
 * SKUs are untouched — only `product_variants.product_id` is repointed and
 * `color` is stamped in — so cart_items/payments (both sku-keyed) need no
 * migration. Not idempotent by design: run once. A second run is a no-op
 * guarded by `dan-cream` already existing.
 */

import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { products, productVariants } from '../src/db/schema.js'
import { projectProduct } from '../src/services/catalogProjection.js'

const OLD_IDS_TO_COLOR: Record<string, string> = {
  'dan-cream-lavender-blue': 'lavender-blue',
  'dan-cream-lily-green': 'lily-green',
  'dan-cream-rose-pink': 'rose-pink',
}

const MERGED_ID = 'dan-cream'
const MERGED_SLUG = 'cream'

const MERGED_NAME = 'Daniya Multi-Purpose Body Cream with Vitamin E'

const MERGED_DESCRIPTION = `Daniya Multi-Purpose Body Cream is a Vitamin E enriched cream made for all skin types, built around a simple idea: one jar that handles everyday moisturising for the hands, face, feet, and body. It is formulated to protect skin against dryness, winter rash, rough cheeks, and skin cracks, keeping skin feeling soft and comfortable through the cold, dry months. Being multi-purpose, it works as a hand cream, face cream, foot cream, and massage cream, and can also be used as a gentle makeup remover at the end of the day, so one jar of Daniya Cream covers several steps of a daily skincare routine.

Available in three shades — Lavender Blue, Lily Green, and Rose Pink — across four sizes, so you can pick whichever combination of size and colour suits you.

Daniya Cream is suitable for all skin types and is meant for regular, everyday use rather than as a one-time treatment. Apply a small amount to clean, dry skin on the hands, face, elbows, or feet whenever skin feels dry or tight, and reapply as needed through the day. For makeup removal, apply the cream to the face, massage gently, and wipe clean. Keep the jar tightly closed after use and store it in a cool, dry place away from direct sunlight to help the cream stay fresh between uses. Please check the jar label to confirm shade and size before use.`

const MERGED_BULLETS = [
  'Multi-purpose Daniya body cream, available in 3 shades — Lavender Blue, Lily Green, and Rose Pink.',
  'Enriched with Vitamin E to help protect skin against dryness, winter rash, rough cheeks, and skin cracks.',
  'Multi-purpose formula usable as a hand cream, face cream, foot cream, and massage cream for all skin types.',
  'Doubles as a gentle makeup remover, so one jar covers skincare and light makeup cleanup.',
  'Compact 100ml size fits easily in a handbag or travel kit for on-the-go hydration.',
]

export interface MergeSummary {
  alreadyMerged: boolean
  variantsRepointed: number
}

export async function mergeCreamColors(db: Db): Promise<MergeSummary> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, MERGED_ID))
      .limit(1)
    if (existing) {
      return { alreadyMerged: true, variantsRepointed: 0 }
    }

    const oldIds = Object.keys(OLD_IDS_TO_COLOR)
    const oldRows = await tx.select().from(products).where(inArray(products.id, oldIds))
    if (oldRows.length !== oldIds.length) {
      const found = new Set(oldRows.map((r) => r.id))
      const missing = oldIds.filter((id) => !found.has(id))
      throw new Error(`merge-cream-colors: missing expected product(s): ${missing.join(', ')}`)
    }

    // Shade-neutral copy for the merged product; images/highlights/category
    // are shared identically across all 3 shades today, so any one row's
    // values are reused as-is.
    const base = oldRows.find((r) => r.id === 'dan-cream-lavender-blue')!

    await tx.insert(products).values({
      id: MERGED_ID,
      slug: MERGED_SLUG,
      name: MERGED_NAME,
      category: base.category,
      description: MERGED_DESCRIPTION,
      bullets: MERGED_BULLETS,
      highlights: base.highlights,
      images: base.images,
      isBestSeller: base.isBestSeller,
      isRecommended: base.isRecommended,
      sortOrder: base.sortOrder,
      seasonalDiscountPct: base.seasonalDiscountPct,
      maxQtyPerUser: base.maxQtyPerUser,
      newUntil: base.newUntil,
      active: true,
    })

    let variantsRepointed = 0
    for (const [oldId, color] of Object.entries(OLD_IDS_TO_COLOR)) {
      const result = await tx
        .update(productVariants)
        .set({ productId: MERGED_ID, color, updatedAt: new Date() })
        .where(eq(productVariants.productId, oldId))
        .returning({ sku: productVariants.sku })
      variantsRepointed += result.length
    }

    await tx.delete(products).where(inArray(products.id, oldIds))

    // Re-project by sku (unchanged) onto the merged product id — corrects
    // catalog_items.productId/name/imageUrl for all 12 skus in place.
    await projectProduct(tx, MERGED_ID)

    return { alreadyMerged: false, variantsRepointed }
  })
}

// --- CLI wrapper (skipped when imported by tests) ----------------------------

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('merge-cream-colors: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString })
  const db = drizzle(pool) as unknown as Db
  try {
    const summary = await mergeCreamColors(db)
    if (summary.alreadyMerged) {
      console.error('merge-cream-colors: dan-cream already exists — nothing to do')
    } else {
      console.error(
        `merge-cream-colors: repointed ${summary.variantsRepointed} variants onto dan-cream`
      )
    }
  } finally {
    await pool.end()
  }
}

// Only run the CLI when executed directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
