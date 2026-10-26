/**
 * `seedDevDimensions` (core logic behind `scripts/seed-dev-dimensions.ts`).
 *
 * Two things are checked here, and only one of them is about the code.
 *
 * The first is ordinary: the estimator is deterministic, it refuses to invent a
 * weight for a variant with no volume, and the write lands in BOTH
 * `product_variants` and the projected `catalog_items` without trampling a real
 * measurement.
 *
 * The second matters more. The whole delivery-fee decoy rests on a ₹119 cream
 * plus a companion product still fitting inside the ≤500 g customer slab — that
 * is what makes "₹249 with free delivery" beat "₹179 delivered". If the
 * estimated weights push that cart into the next slab, the ₹60 anchor in the
 * marketing copy is simply false. So the anchor cart's weight is asserted here,
 * against the real catalogue's sizes, rather than being assumed.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { catalogItems, productVariants } from '../../src/db/schema.js'
import { deadWeightG, type ShippingLine } from '../../src/lib/shipping.js'
import { seedCatalog, type CatalogFile } from '../../scripts/seed-catalog.js'
import { estimatePack, seedDevDimensions } from '../../scripts/seed-dev-dimensions.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

const IMG = { thumb: 't', grid: 'g', pdp: 'p', zoom: 'z' }

/** Mirrors the shape of the real catalogue: a jar line, a bottle line, an unsized one. */
function catalogFile(): CatalogFile {
  return {
    products: [
      {
        id: 'dan-cream',
        slug: 'cold-cream',
        name: 'Daniya Cold Cream',
        category: 'cream',
        description: '',
        bullets: [],
        highlights: [],
        images: { main: IMG, gallery: [] },
        variants: [
          {
            sku: 'CREAM-100',
            asin: '',
            size: '100ml',
            size_ml: 100,
            price_inr: 119,
            mrp_inr: 149,
            in_stock: true,
            best_before_mode: 'printed_on_pack',
          },
          {
            sku: 'CREAM-1L',
            asin: '',
            size: '1L',
            size_ml: 1000,
            price_inr: 649,
            mrp_inr: 749,
            in_stock: true,
            best_before_mode: 'printed_on_pack',
          },
        ],
        in_stock: true,
        manufacturer_name: 'Saman Products Company',
        manufacturer_address: 'Gujarat, India',
        country_of_origin: 'India',
        consumer_care_contact: 'care@example.com',
      },
      {
        id: 'dan-serum',
        slug: 'hair-serum',
        name: 'Daniya Hair Serum',
        category: 'hair serum',
        description: '',
        bullets: [],
        highlights: [],
        images: { main: IMG, gallery: [] },
        variants: [
          {
            sku: 'SERUM-50',
            asin: '',
            size: '50ml',
            size_ml: 50,
            price_inr: 140,
            mrp_inr: 160,
            in_stock: true,
            best_before_mode: 'printed_on_pack',
          },
          // No declared volume — must stay unmeasured rather than be guessed.
          {
            sku: 'SERUM-NA',
            asin: '',
            size: 'sachet',
            size_ml: 0,
            price_inr: 20,
            mrp_inr: 25,
            in_stock: true,
            best_before_mode: 'printed_on_pack',
          },
        ],
        in_stock: true,
        manufacturer_name: 'Saman Products Company',
        manufacturer_address: 'Gujarat, India',
        country_of_origin: 'India',
        consumer_care_contact: 'care@example.com',
      },
    ],
  }
}

describe('estimatePack', () => {
  it('derives a jar from category and volume: 100 ml cream = 95 g fill + 40 g jar', () => {
    expect(estimatePack('cream', 100)).toEqual({
      weightG: 135,
      lengthCm: 7,
      widthCm: 7,
      heightCm: 6,
    })
  })

  it('gives a bottle a different box than a jar at the same volume', () => {
    const jar = estimatePack('cream', 100)!
    const bottle = estimatePack('hair oil', 100)!
    // Tall and narrow vs squat and wide — the distinction volumetric billing
    // is sensitive to.
    expect(bottle.heightCm).toBeGreaterThan(jar.heightCm)
    expect(bottle.widthCm).toBeLessThan(jar.widthCm)
  })

  it('refuses to invent a weight for a variant with no volume', () => {
    expect(estimatePack('cream', 0)).toBeNull()
    expect(estimatePack('cream', -1)).toBeNull()
    expect(estimatePack('cream', Number.NaN)).toBeNull()
  })

  it('falls back to a bottle for a category added after this table was written', () => {
    expect(estimatePack('face wash', 100)).not.toBeNull()
  })

  it('keeps the largest box above the top band rather than extrapolating a shape', () => {
    const oneLitre = estimatePack('cream', 1000)!
    const fiveLitre = estimatePack('cream', 5000)!
    expect(fiveLitre.lengthCm).toBe(oneLitre.lengthCm)
    // Weight still scales with the contents, only the box stops growing.
    expect(fiveLitre.weightG).toBeGreaterThan(oneLitre.weightG)
  })
})

describe('seedDevDimensions', () => {
  beforeEach(async () => {
    await seedCatalog(db, catalogFile())
  })

  it('writes estimates into product_variants and mirrors them into catalog_items', async () => {
    const summary = await seedDevDimensions(db)

    expect(summary.variants).toBe(3)
    expect(summary.catalogItems).toBe(3)
    expect(summary.skipped).toEqual(['SERUM-NA'])

    const [variant] = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, 'CREAM-100'))
    expect(variant?.weightG).toBe(135)

    const [item] = await db.select().from(catalogItems).where(eq(catalogItems.sku, 'CREAM-100'))
    expect(item?.weightG).toBe(135)
    expect(item?.heightCm).toBe(6)
  })

  it('leaves an unsized variant at weight 0 so it refuses to quote', async () => {
    await seedDevDimensions(db)
    const [row] = await db.select().from(catalogItems).where(eq(catalogItems.sku, 'SERUM-NA'))
    expect(row?.weightG).toBe(0)
  })

  it('never overwrites a real measurement with an estimate', async () => {
    await db
      .update(productVariants)
      .set({ weightG: 128 })
      .where(eq(productVariants.sku, 'CREAM-100'))

    const summary = await seedDevDimensions(db)
    expect(summary.variants).toBe(2)

    const [row] = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, 'CREAM-100'))
    expect(row?.weightG).toBe(128)
  })

  it('re-derives everything under --overwrite', async () => {
    await db
      .update(productVariants)
      .set({ weightG: 128 })
      .where(eq(productVariants.sku, 'CREAM-100'))

    const summary = await seedDevDimensions(db, { overwrite: true })
    expect(summary.variants).toBe(3)

    const [row] = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, 'CREAM-100'))
    expect(row?.weightG).toBe(135)
  })

  it('is idempotent — a second run finds nothing left unmeasured', async () => {
    await seedDevDimensions(db)
    const second = await seedDevDimensions(db)
    expect(second.variants).toBe(0)
    expect(second.catalogItems).toBe(0)
  })
})

describe('the decoy cart still fits the ≤500 g slab at these weights', () => {
  /** `shipping.packagingTareG` as seeded in scripts/seed-config.ts. */
  const TARE_G = 60

  it('keeps ₹119 cream + ₹140 serum — the qualifying pair — inside 500 g', () => {
    const lines: ShippingLine[] = [
      { sku: 'CREAM-100', qty: 1, ...estimatePack('cream', 100)! },
      { sku: 'SERUM-50', qty: 1, ...estimatePack('hair serum', 50)! },
    ]
    // 135 + 75 + 60 tare = 270 g. If this ever exceeds 500, the ₹60 anchor the
    // whole "add a second product and delivery is free" pitch is built on stops
    // being the fee a shopper would actually have paid.
    expect(deadWeightG(lines, TARE_G)).toBe(270)
    expect(deadWeightG(lines, TARE_G)).toBeLessThanOrEqual(500)
  })

  it('keeps a single ₹119 cream inside 500 g too, so the "before" price is the ₹60 cell', () => {
    const lines: ShippingLine[] = [{ sku: 'CREAM-100', qty: 1, ...estimatePack('cream', 100)! }]
    expect(deadWeightG(lines, TARE_G)).toBeLessThanOrEqual(500)
  })

  it('does NOT claim the same for a 1 L cream — heavy carts are a different slab', () => {
    const lines: ShippingLine[] = [{ sku: 'CREAM-1L', qty: 1, ...estimatePack('cream', 1000)! }]
    expect(deadWeightG(lines, TARE_G)).toBeGreaterThan(1000)
  })
})
