/**
 * `syncCatalog` (core logic behind `scripts/catalog-sync.ts`) against PGlite:
 * upsert-by-sku, idempotent re-run, deactivation of skus missing from the
 * file, and Zod validation of the minimal consumed shape (SPEC-V2.md §7
 * bullet 5).
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { catalogItems } from '../../src/db/schema.js'
import { CatalogFileSchema, syncCatalog, type CatalogFile } from '../../scripts/catalog-sync.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

function catalogFile(overrides: Partial<CatalogFile> = {}): CatalogFile {
  return {
    products: [
      {
        id: 'dan-hair-oil',
        name: 'Daniya Hair Oil',
        images: { main: { grid: 'https://example.com/grid.jpg' } },
        variants: [
          { sku: 'AH-82U3-T29Q', size: '200ml', price_inr: 249 },
          { sku: '04-JPDR-6Z6N', size: '500ml', price_inr: 399 },
        ],
      },
    ],
    ...overrides,
  }
}

describe('syncCatalog', () => {
  it('upserts every variant by sku', async () => {
    const summary = await syncCatalog(db, catalogFile())
    expect(summary).toEqual({ upserted: 2, deactivated: 0 })

    const rows = await db.select().from(catalogItems)
    expect(rows).toHaveLength(2)
    const bySku = Object.fromEntries(rows.map((r) => [r.sku, r]))
    expect(bySku['AH-82U3-T29Q']).toMatchObject({
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 249,
      imageUrl: 'https://example.com/grid.jpg',
      active: true,
    })
  })

  it('running twice against the same file is idempotent (same rows, 0 deactivations second time)', async () => {
    await syncCatalog(db, catalogFile())
    const second = await syncCatalog(db, catalogFile())
    expect(second).toEqual({ upserted: 2, deactivated: 0 })

    const rows = await db.select().from(catalogItems)
    expect(rows).toHaveLength(2)
  })

  it('deactivates (does not delete) a sku removed from the file', async () => {
    await syncCatalog(db, catalogFile())

    const trimmed = catalogFile({
      products: [
        {
          id: 'dan-hair-oil',
          name: 'Daniya Hair Oil',
          images: { main: { grid: 'https://example.com/grid.jpg' } },
          variants: [{ sku: 'AH-82U3-T29Q', size: '200ml', price_inr: 249 }],
        },
      ],
    })
    const summary = await syncCatalog(db, trimmed)
    expect(summary).toEqual({ upserted: 1, deactivated: 1 })

    const rows = await db.select().from(catalogItems)
    expect(rows).toHaveLength(2) // still present, not deleted
    const removed = rows.find((r) => r.sku === '04-JPDR-6Z6N')
    expect(removed?.active).toBe(false)
  })

  it('re-running after a deactivation reports 0 further deactivations (idempotent)', async () => {
    await syncCatalog(db, catalogFile())
    const trimmed = catalogFile({
      products: [
        {
          id: 'dan-hair-oil',
          name: 'Daniya Hair Oil',
          images: { main: { grid: 'https://example.com/grid.jpg' } },
          variants: [{ sku: 'AH-82U3-T29Q', size: '200ml', price_inr: 249 }],
        },
      ],
    })
    await syncCatalog(db, trimmed)
    const again = await syncCatalog(db, trimmed)
    expect(again.deactivated).toBe(0)
  })

  it('reactivates a sku that reappears in a later file', async () => {
    await syncCatalog(db, catalogFile())
    const trimmed = catalogFile({
      products: [
        {
          id: 'dan-hair-oil',
          name: 'Daniya Hair Oil',
          images: { main: { grid: 'https://example.com/grid.jpg' } },
          variants: [{ sku: 'AH-82U3-T29Q', size: '200ml', price_inr: 249 }],
        },
      ],
    })
    await syncCatalog(db, trimmed)
    await syncCatalog(db, catalogFile())

    const [row] = await db.select().from(catalogItems).where(eq(catalogItems.sku, '04-JPDR-6Z6N'))
    expect(row?.active).toBe(true)
  })

  it('updates price/name/size/image on re-sync when the file changes', async () => {
    await syncCatalog(db, catalogFile())
    const updated = catalogFile()
    updated.products[0]!.variants[0]!.price_inr = 299
    await syncCatalog(db, updated)

    const [row] = await db.select().from(catalogItems).where(eq(catalogItems.sku, 'AH-82U3-T29Q'))
    expect(row?.priceInr).toBe(299)
  })
})

describe('CatalogFileSchema', () => {
  it('parses a well-formed file', () => {
    expect(CatalogFileSchema.safeParse(catalogFile()).success).toBe(true)
  })

  it('rejects a file missing required fields', () => {
    expect(CatalogFileSchema.safeParse({ products: [{ id: 'x' }] }).success).toBe(false)
  })

  it('rejects a negative price', () => {
    const bad = catalogFile()
    bad.products[0]!.variants[0]!.price_inr = -1
    expect(CatalogFileSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a non-object payload', () => {
    expect(CatalogFileSchema.safeParse([1, 2, 3]).success).toBe(false)
  })
})
