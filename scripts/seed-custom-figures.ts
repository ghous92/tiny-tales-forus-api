#!/usr/bin/env tsx
/**
 * `npm run db:custom-figures [-- --price <inr>]` — create or update the
 * custom-figure skus the /custom/ page adds to the bag (lib/customFigures.ts):
 * one per kind and group size, 1 to 4 characters.
 *
 * One unit is one piece: a family of three in one caricature is one unit of the
 * 3-character sku. `--price` is the price of one figure; the group prices follow
 * from it. Like every price on the store today, they include delivery. Re-running corrects drift (name, price, pack) and changes nothing
 * else; the stable ids mean there is never a second copy.
 *
 * What it writes, in one transaction:
 *   1. an inactive `custom-figures` category, so no collection tile appears
 *   2. a product + single variant per kind, active, out of `GET /v1/catalog`
 *      by category (services/catalogRead.ts), so it is never listed or searchable
 *   3. the projection into `catalog_items` (cart's price authority) through
 *      `projectProduct`, the same path an admin catalog save runs
 *   4. a `force_in` stock policy: each figure is made to order, so there is no
 *      shelf to count. As with the live-test sku, the paid order therefore has
 *      no stock origin; the studio ships it by hand.
 *
 * HSN 3926 (other articles of plastics, statuettes) at 18% GST is our reading
 * for resin figures. Confirm it with the accountant before the first invoice.
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { categories, products, productVariants, skuStockPolicy } from '../src/db/schema.js'
import {
  CUSTOM_FIGURE_BASE_PRICE_INR,
  CUSTOM_FIGURE_CATEGORY,
  customFigurePriceInr,
  customFigureSku,
  MAX_FIGURE_CHARACTERS,
} from '../src/lib/customFigures.js'
import { projectProduct } from '../src/services/catalogProjection.js'

const HSN_CODE = '3926'
const GST_RATE_PCT = 18
/** One boxed piece, wider and heavier per extra character. Dims must be > 0 (`catalog_items_dimensions_positive`). */
const pack = (characters: number) => ({
  weightG: 400 + 250 * (characters - 1),
  lengthCm: 15,
  widthCm: 15 + 7 * (characters - 1),
  heightCm: 20,
})
const GROUP_SIZES = Array.from({ length: MAX_FIGURE_CHARACTERS }, (_, i) => i + 1)

const NO_IMAGES = { main: { thumb: '', grid: '', pdp: '', zoom: '' }, gallery: [] }

const KINDS = [
  {
    id: 'custom-miniature',
    kind: 'miniature',
    name: 'Custom miniature',
    description: 'A miniature of up to four people or pets, made from your photo.',
  },
  {
    id: 'custom-caricature',
    kind: 'caricature',
    name: 'Custom caricature',
    description:
      'A caricature of up to four people or pets in the character you chose, made from your photo.',
  },
] as const

export async function seedCustomFigures(db: Db, priceInr: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(categories)
      .values({
        slug: CUSTOM_FIGURE_CATEGORY,
        label: 'Custom figures',
        active: false,
        sortOrder: 99_000,
      })
      .onConflictDoUpdate({
        target: categories.slug,
        set: { label: 'Custom figures', active: false, updatedAt: new Date() },
      })

    for (const kind of KINDS) {
      const product = {
        slug: kind.id,
        name: kind.name,
        category: CUSTOM_FIGURE_CATEGORY,
        description: kind.description,
        active: true,
        hidden: false,
        sortOrder: 99_000,
        hsnCode: HSN_CODE,
        gstRatePct: GST_RATE_PCT,
        // No photography: the shopper's own photo is the picture. Stored in the
        // contract shape so the admin product list can serialize the row.
        images: NO_IMAGES,
      }
      await tx
        .insert(products)
        .values({ id: kind.id, ...product })
        .onConflictDoUpdate({ target: products.id, set: { ...product, updatedAt: new Date() } })

      for (const characters of GROUP_SIZES) {
        const variant = {
          productId: kind.id,
          size: characters === 1 ? '1 character' : `${characters} characters`,
          priceInr: customFigurePriceInr(priceInr, characters),
          mrpInr: customFigurePriceInr(priceInr, characters),
          inStock: true,
          ...pack(characters),
        }
        await tx
          .insert(productVariants)
          .values({ sku: customFigureSku(kind.kind, characters), ...variant })
          .onConflictDoUpdate({
            target: productVariants.sku,
            set: { ...variant, updatedAt: new Date() },
          })
      }

      await projectProduct(tx, kind.id)

      for (const characters of GROUP_SIZES) {
        await tx
          .insert(skuStockPolicy)
          .values({
            sku: customFigureSku(kind.kind, characters),
            mode: 'force_in',
            note: 'Custom figure, made to order. Seeded by `npm run db:custom-figures`.',
            updatedBy: 'seed-custom-figures',
          })
          .onConflictDoUpdate({
            target: skuStockPolicy.sku,
            set: { mode: 'force_in', updatedBy: 'seed-custom-figures', updatedAt: new Date() },
          })
      }
    }
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--price')
  const priceRaw = i >= 0 ? argv[i + 1] : String(CUSTOM_FIGURE_BASE_PRICE_INR)
  const priceInr = Number(priceRaw)
  if (!Number.isInteger(priceInr) || priceInr < 1) {
    console.error(`db:custom-figures: --price must be a whole rupee amount >= 1 (got ${priceRaw})`)
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:custom-figures: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    await seedCustomFigures(db, priceInr)
    const rows = await db
      .select({ sku: productVariants.sku, priceInr: productVariants.priceInr })
      .from(productVariants)
      .where(eq(productVariants.productId, 'custom-miniature'))
      .orderBy(productVariants.priceInr)
    // eslint-disable-next-line no-console
    console.log(
      `db:custom-figures: both kinds at ${rows.map((r) => `₹${r.priceInr}`).join(', ')} for 1 to ${MAX_FIGURE_CHARACTERS} characters.`
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
