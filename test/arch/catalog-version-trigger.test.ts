/**
 * Architectural guard: the `GET /v1/catalog` ETag cannot go stale.
 *
 * The catalog ETag is the `catalog_version` counter rather than a hash of the
 * payload (config took the hash route and is self-healing; catalog took the
 * counter route to keep the 304 path down to one cheap read). A counter is only
 * as correct as its least careful writer, and in July 2026 that cost us a live
 * incident: someone ran `UPDATE products SET images = ...` by hand, the counter
 * never moved, and the API answered `304 Not Modified` to clients whose cached
 * catalog was genuinely out of date. Nothing on the client could recover from
 * that — it was asking the right question and being told the wrong answer.
 *
 * Migration 0017 pushed the bump into a database trigger so no writer can miss
 * it. This test is the thing that keeps it there. Every case below writes with
 * RAW SQL through the PGlite handle — no drizzle, no service, no route — which
 * is precisely the path that broke. If the trigger is dropped, renamed, or
 * missed by a future table, these fail.
 *
 * `test/routes/catalog-admin.test.ts` covers the same counter from the other
 * side (the sanctioned admin path); this file covers everything else.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PGlite } from '@electric-sql/pglite'
import type { Db } from '../../src/db/client.js'
import { getCatalogVersion } from '../../src/services/catalogVersion.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let pglite: PGlite

/** Minimum viable catalog row set, inserted raw so the trigger is what runs. */
async function seedRawCatalog(): Promise<void> {
  await pglite.exec(`
    INSERT INTO categories (slug, label) VALUES ('cream', 'Cream');
    INSERT INTO products (id, slug, name, category)
      VALUES ('p-cream', 'cream', 'Daniya Cream', 'cream');
    INSERT INTO product_variants (sku, product_id, size, price_inr)
      VALUES ('SKU-1', 'p-cream', '50g', 199);
  `)
}

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
  pglite = ctx.pglite
})

describe('catalog_version trigger', () => {
  it('bumps on a raw UPDATE that bypasses every service (the July 2026 incident)', async () => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    // The exact shape of the write that went stale in production.
    await pglite.exec(`
      UPDATE products
      SET images = images || jsonb_build_object('hero', '{"pdp":"https://cdn/hero"}'::jsonb)
      WHERE slug = 'cream';
    `)

    expect(await getCatalogVersion(db)).toBeGreaterThan(before)
  })

  it.each([
    ['categories', `INSERT INTO categories (slug, label) VALUES ('oil', 'Oil');`],
    ['products', `UPDATE products SET name = 'Renamed' WHERE id = 'p-cream';`],
    ['product_variants', `UPDATE product_variants SET price_inr = 249 WHERE sku = 'SKU-1';`],
  ])('bumps on a raw write to %s', async (_table, sql) => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    await pglite.exec(sql)

    expect(await getCatalogVersion(db)).toBe(before + 1)
  })

  it('bumps on DELETE, including the cascade from a deleted product', async () => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    await pglite.exec(`DELETE FROM products WHERE id = 'p-cream';`)

    expect(await getCatalogVersion(db)).toBeGreaterThan(before)
  })

  it('counts a multi-statement transaction once, not once per statement', async () => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    // An admin write touches products AND variants; that is one catalog
    // change, so clients should revalidate once rather than three times.
    await pglite.exec('BEGIN;')
    await pglite.exec(`UPDATE products SET name = 'A' WHERE id = 'p-cream';`)
    await pglite.exec(`UPDATE products SET sort_order = 3 WHERE id = 'p-cream';`)
    await pglite.exec(`UPDATE product_variants SET price_inr = 250 WHERE sku = 'SKU-1';`)
    await pglite.exec('COMMIT;')

    expect(await getCatalogVersion(db)).toBe(before + 1)
  })

  it('does not bump for a rolled-back transaction', async () => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    await pglite.exec('BEGIN;')
    await pglite.exec(`UPDATE products SET name = 'Never committed' WHERE id = 'p-cream';`)
    await pglite.exec('ROLLBACK;')

    expect(await getCatalogVersion(db)).toBe(before)
  })

  it('bumps again on the next transaction (the guard is transaction-local)', async () => {
    await seedRawCatalog()
    await pglite.exec(`UPDATE products SET name = 'One' WHERE id = 'p-cream';`)
    const after = await getCatalogVersion(db)

    await pglite.exec(`UPDATE products SET name = 'Two' WHERE id = 'p-cream';`)

    expect(await getCatalogVersion(db)).toBe(after + 1)
  })

  it('does not bump for writes to tables outside the public catalog', async () => {
    await seedRawCatalog()
    const before = await getCatalogVersion(db)

    // catalog_items is the cart's read model, not the storefront payload —
    // a projection refresh must not invalidate every client's catalog cache.
    await pglite.exec(`
      INSERT INTO catalog_items (sku, product_id, name, size, price_inr)
      VALUES ('SKU-1', 'p-cream', 'Daniya Cream', '50g', 199);
    `)

    expect(await getCatalogVersion(db)).toBe(before)
  })
})
