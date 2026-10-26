/**
 * `scripts/backfill-gst-dummy-data.ts` against a real Postgres (PGlite +
 * committed migrations) — category → HSN mapping, the unmapped-category
 * fallback, re-projection into catalog_items, idempotency, and --dry-run.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { backfillGstDummyData } from '../../scripts/backfill-gst-dummy-data.js'
import type { Db } from '../../src/db/client.js'
import { catalogItems, categories, products, productVariants } from '../../src/db/schema.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

async function seedProduct(id: string, category: string): Promise<void> {
  await db.insert(categories).values({ slug: category, label: category }).onConflictDoNothing()
  await db.insert(products).values({ id, slug: id, name: id, category })
  await db
    .insert(productVariants)
    .values({ sku: `${id}-sku`, productId: id, size: '100ml', priceInr: 100 })
}

describe('backfillGstDummyData', () => {
  it('maps the verified category rates and projects them into catalog_items', async () => {
    await seedProduct('p-hairoil', 'hair oil')
    await seedProduct('p-shampoo', 'shampoo')
    await seedProduct('p-serum', 'hair serum')
    await seedProduct('p-cream', 'cream')

    const result = await backfillGstDummyData(db)
    expect(result).toEqual({ scanned: 4, updated: 4, alreadyCorrect: 0 })

    const rows = await db.select().from(products)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('p-hairoil')).toMatchObject({ hsnCode: '3305', gstRatePct: 5 })
    expect(byId.get('p-shampoo')).toMatchObject({ hsnCode: '3305', gstRatePct: 5 })
    expect(byId.get('p-serum')).toMatchObject({ hsnCode: '3305', gstRatePct: 18 })
    expect(byId.get('p-cream')).toMatchObject({ hsnCode: '3304', gstRatePct: 18 })

    const [catalogRow] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.sku, 'p-hairoil-sku'))
    expect(catalogRow).toMatchObject({ hsnCode: '3305', gstRatePct: 5 })
  })

  it('fails before writing when a category has no verified classification', async () => {
    await seedProduct('p-hairoil', 'hair oil')
    await seedProduct('p-mystery', 'something new')

    await expect(backfillGstDummyData(db)).rejects.toThrow(/no verified GST classification/)
    const rows = await db.select().from(products)
    expect(rows.every((row) => row.hsnCode === '' && row.gstRatePct === 0)).toBe(true)
  })

  it('is idempotent — a second run reports everything already correct', async () => {
    await seedProduct('p-hairoil', 'hair oil')
    await backfillGstDummyData(db)
    const second = await backfillGstDummyData(db)
    expect(second).toEqual({ scanned: 1, updated: 0, alreadyCorrect: 1 })
  })

  it('dry-run reports what would change without writing anything', async () => {
    await seedProduct('p-hairoil', 'hair oil')
    const result = await backfillGstDummyData(db, { dryRun: true })
    expect(result.updated).toBe(1)
    const [row] = await db.select().from(products).where(eq(products.id, 'p-hairoil'))
    expect(row?.hsnCode).toBe('')
    expect(row?.gstRatePct).toBe(0)
  })
})
