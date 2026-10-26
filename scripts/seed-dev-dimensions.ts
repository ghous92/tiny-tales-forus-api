#!/usr/bin/env tsx
/**
 * `npm run db:seed-dev-dimensions` — DEV ONLY. Fills `product_variants` (and
 * the projected `catalog_items`) with ESTIMATED packed weights and carton
 * dimensions so the shipping engine has something real to compute against
 * before anybody owns a scale.
 *
 * **These are estimates, not measurements.** They are derived, not typed:
 * a fill weight from the variant's `size_ml` times a per-category density,
 * plus a container tare, with a bounding box for the primary pack. That makes
 * every number reproducible and reviewable — a table of 27 hand-typed weights
 * is a table nobody can check. Real numbers come off a scale and a ruler and
 * land in `product_variants` via the admin catalog editor; staging and
 * production never run this script.
 *
 * Non-destructive by default: only rows with `weight_g = 0` ("unmeasured") are
 * touched, so a real measurement, once entered, is never overwritten by an
 * estimate. `--overwrite` forces every row, for re-deriving the whole table
 * after a tweak to the constants below.
 *
 * What this does NOT model: the outer shipping carton. That is one
 * `shipping.packagingTareG` added once per cart, not per line. The dimensions
 * here are the product's own pack, which is what a courier's volumetric
 * divisor is applied to.
 */

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { catalogItems, products, productVariants } from '../src/db/schema.js'
import { assertDevOnly } from './dev-only.js'

/** How a category is packed — decides tare and shape, not just density. */
type Form = 'jar' | 'bottle'

/**
 * Contents density in g/ml, and the container it ships in.
 *
 * Water is 1.0. Oils sit below it, aqueous shampoos just above, and an emulsion
 * cream lands near 0.95. Petroleum jelly is the lightest of the set. None of
 * these move the chargeable weight across a slab boundary on their own — the
 * TARE and the slab edges do — but getting them roughly right keeps a 1 L jar
 * from looking like a 1 L bottle.
 */
const CATEGORY_PACK: Record<string, { density: number; form: Form }> = {
  cream: { density: 0.95, form: 'jar' },
  pomade: { density: 0.9, form: 'jar' },
  'hair oil': { density: 0.92, form: 'bottle' },
  'hair serum': { density: 1.0, form: 'bottle' },
  shampoo: { density: 1.02, form: 'bottle' },
}

/** Fallback for a category added after this file was written. */
const DEFAULT_PACK = { density: 1.0, form: 'bottle' as Form }

/**
 * Empty-container weight and bounding box by fill volume, per form.
 *
 * A jar is squat and wide, a bottle tall and narrow — which matters because
 * volumetric weight is L×W×H, so the same 500 ml bills differently depending on
 * which one it ships in. Bands are `uptoMl`, first match wins.
 */
const PACK_TABLE: Record<Form, { uptoMl: number; tareG: number; l: number; w: number; h: number }[]> =
  {
    jar: [
      { uptoMl: 30, tareG: 20, l: 5, w: 5, h: 4 },
      { uptoMl: 50, tareG: 28, l: 6, w: 6, h: 5 },
      { uptoMl: 100, tareG: 40, l: 7, w: 7, h: 6 },
      { uptoMl: 200, tareG: 62, l: 8, w: 8, h: 8 },
      { uptoMl: 500, tareG: 110, l: 11, w: 11, h: 10 },
      { uptoMl: 1000, tareG: 180, l: 13, w: 13, h: 13 },
    ],
    bottle: [
      { uptoMl: 50, tareG: 25, l: 4, w: 4, h: 12 },
      { uptoMl: 100, tareG: 32, l: 5, w: 5, h: 14 },
      { uptoMl: 200, tareG: 45, l: 6, w: 6, h: 17 },
      { uptoMl: 500, tareG: 72, l: 8, w: 8, h: 22 },
      { uptoMl: 1000, tareG: 115, l: 10, w: 10, h: 26 },
    ],
  }

export interface EstimatedPack {
  weightG: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

/**
 * Estimate a variant's packed weight and box from its category and fill volume.
 *
 * Returns null for a variant with no usable `size_ml`. That is on purpose: an
 * unmeasured SKU must stay at weight 0 so `shipping.unknownWeightBehavior`
 * refuses to quote it, rather than being handed a fabricated number. Guessing
 * here would defeat the one safeguard that catches a missing measurement.
 */
export function estimatePack(category: string, sizeMl: number): EstimatedPack | null {
  if (!Number.isFinite(sizeMl) || sizeMl <= 0) return null

  const pack = CATEGORY_PACK[category.trim().toLowerCase()] ?? DEFAULT_PACK
  const bands = PACK_TABLE[pack.form]
  // Above the largest band, keep the largest box rather than extrapolating a
  // shape — a 5 L tub is a different product, not a scaled-up jar.
  const band = bands.find((b) => sizeMl <= b.uptoMl) ?? bands[bands.length - 1]!

  return {
    weightG: Math.round(sizeMl * pack.density) + band.tareG,
    lengthCm: band.l,
    widthCm: band.w,
    heightCm: band.h,
  }
}

export interface DimensionSeedSummary {
  /** Variants updated. */
  variants: number
  /** `catalog_items` rows updated to match. */
  catalogItems: number
  /** Variants left alone because `size_ml` is 0 — these still cannot quote. */
  skipped: string[]
}

/**
 * Write estimated packs into `product_variants` and mirror them into
 * `catalog_items`, which is the only catalog table the cart may read.
 */
export async function seedDevDimensions(
  db: Db,
  options: { overwrite?: boolean } = {}
): Promise<DimensionSeedSummary> {
  const rows = await db
    .select({
      sku: productVariants.sku,
      sizeMl: productVariants.sizeMl,
      weightG: productVariants.weightG,
      category: products.category,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))

  const summary: DimensionSeedSummary = { variants: 0, catalogItems: 0, skipped: [] }

  for (const row of rows) {
    if (!options.overwrite && row.weightG > 0) continue

    const pack = estimatePack(row.category, row.sizeMl)
    if (!pack) {
      summary.skipped.push(row.sku)
      continue
    }

    const updated = await db
      .update(productVariants)
      .set(pack)
      .where(eq(productVariants.sku, row.sku))
      .returning({ sku: productVariants.sku })
    summary.variants += updated.length

    // Projection, not a second source of truth: catalog_items mirrors whatever
    // product_variants now says. Keep the two writes adjacent so a future edit
    // cannot update one and forget the other.
    const projected = await db
      .update(catalogItems)
      .set(pack)
      .where(eq(catalogItems.sku, row.sku))
      .returning({ sku: catalogItems.sku })
    summary.catalogItems += projected.length
  }

  return summary
}

async function main(): Promise<void> {
  assertDevOnly('db:seed-dev-dimensions')

  const overwrite = process.argv.includes('--overwrite')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-dev-dimensions: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    await db.execute(sql`select 1 from product_variants limit 1`)
    const summary = await seedDevDimensions(db, { overwrite })

    /* eslint-disable no-console */
    console.log(
      `db:seed-dev-dimensions: ${summary.variants} variant(s) and ${summary.catalogItems} catalog_items row(s) updated${overwrite ? ' (--overwrite)' : ''}.`
    )
    if (summary.skipped.length > 0) {
      console.warn(
        `  ${summary.skipped.length} sku(s) have no size_ml and stay unmeasured: ${summary.skipped.join(', ')}`
      )
    }
    console.log(
      'REMINDER: these are DERIVED ESTIMATES. Replace with scale-and-ruler figures before shipping.enabled is turned on anywhere real.'
    )
    /* eslint-enable no-console */
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
