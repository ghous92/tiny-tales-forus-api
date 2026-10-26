/**
 * `scripts/catalog-doctor.ts` — the detector for the one catalog invariant a
 * database trigger cannot enforce: `catalog_items` (cart's price/weight
 * authority) agreeing with `products × product_variants`.
 *
 * The failure it has to catch is a hand-edited price: the storefront reads the
 * rich catalog and shows the new number, the cart reads `catalog_items` and
 * charges the old one. Nothing errors, nothing 500s, and the first report is a
 * customer whose total does not match the price tag.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PGlite } from '@electric-sql/pglite'
import type { Db } from '../../src/db/client.js'
import { categories, products, productVariants } from '../../src/db/schema.js'
import { projectProduct } from '../../src/services/catalogProjection.js'
import { diagnoseCatalog, repairCatalog } from '../../scripts/catalog-doctor.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let pglite: PGlite

/** A two-variant product, projected — i.e. a consistent starting state. */
beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
  pglite = ctx.pglite

  await db.insert(categories).values({ slug: 'cream', label: 'Cream' })
  await db.insert(products).values({
    id: 'p-cream',
    slug: 'cream',
    name: 'Daniya Cream',
    category: 'cream',
    images: { main: { grid: 'https://cdn/grid.jpg' } },
  })
  await db.insert(productVariants).values([
    { sku: 'SKU-50', productId: 'p-cream', size: '50g', priceInr: 199, weightG: 60 },
    { sku: 'SKU-100', productId: 'p-cream', size: '100g', priceInr: 349, weightG: 115 },
  ])
  await db.transaction(async (tx) => projectProduct(tx, 'p-cream'))
})

describe('diagnoseCatalog', () => {
  it('reports no drift for a freshly projected catalog', async () => {
    const report = await diagnoseCatalog(db)
    expect(report.drift).toEqual([])
    expect(report.variantsChecked).toBe(2)
    expect(report.affectedProductIds).toEqual([])
  })

  it('catches a hand-edited price the cart would still charge at the old value', async () => {
    await pglite.exec(`UPDATE product_variants SET price_inr = 249 WHERE sku = 'SKU-50';`)

    const report = await diagnoseCatalog(db)

    expect(report.drift).toHaveLength(1)
    expect(report.drift[0]).toMatchObject({
      sku: 'SKU-50',
      kind: 'stale_field',
      field: 'priceInr',
      expected: 249,
      actual: 199,
    })
    expect(report.affectedProductIds).toEqual(['p-cream'])
  })

  it('catches a seasonal discount that never reached the charged price', async () => {
    // The discount lives on the product; the charged price lives on the
    // projection. Editing one without re-projecting splits display from charge.
    await pglite.exec(`UPDATE products SET seasonal_discount_pct = 10 WHERE id = 'p-cream';`)

    const report = await diagnoseCatalog(db)

    const prices = report.drift.filter((d) => d.field === 'priceInr')
    expect(prices).toHaveLength(2)
    expect(prices.map((d) => d.expected).sort((a, b) => Number(a) - Number(b))).toEqual([179, 314])
  })

  it('catches a variant inserted without a projection', async () => {
    await pglite.exec(`
      INSERT INTO product_variants (sku, product_id, size, price_inr)
      VALUES ('SKU-200', 'p-cream', '200g', 599);
    `)

    const report = await diagnoseCatalog(db)

    expect(report.drift).toEqual([{ sku: 'SKU-200', productId: 'p-cream', kind: 'missing' }])
  })

  it('catches a deleted variant left purchasable in catalog_items', async () => {
    await pglite.exec(`DELETE FROM product_variants WHERE sku = 'SKU-100';`)

    const report = await diagnoseCatalog(db)

    expect(report.drift).toEqual([
      { sku: 'SKU-100', productId: 'p-cream', kind: 'orphan_still_active' },
    ])
  })

  it('catches a renamed or re-imaged product the cart still shows stale', async () => {
    await pglite.exec(`
      UPDATE products
      SET name = 'Daniya Super Rich Cream',
          images = '{"main":{"grid":"https://cdn/new-grid.jpg"}}'::jsonb
      WHERE id = 'p-cream';
    `)

    const report = await diagnoseCatalog(db)

    const fields = new Set(report.drift.map((d) => d.field))
    expect(fields).toEqual(new Set(['name', 'imageUrl']))
  })
})

describe('repairCatalog', () => {
  it('re-projects every drifted product back to clean', async () => {
    await pglite.exec(`UPDATE product_variants SET price_inr = 249 WHERE sku = 'SKU-50';`)
    await pglite.exec(`UPDATE products SET seasonal_discount_pct = 10 WHERE id = 'p-cream';`)
    const before = await diagnoseCatalog(db)
    expect(before.drift.length).toBeGreaterThan(0)

    await repairCatalog(db, before.affectedProductIds)

    expect((await diagnoseCatalog(db)).drift).toEqual([])
  })

  it('is a no-op on an empty product list', async () => {
    await repairCatalog(db, [])
    expect((await diagnoseCatalog(db)).drift).toEqual([])
  })
})
