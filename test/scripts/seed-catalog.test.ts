/**
 * `seedCatalog` (core logic behind `scripts/seed-catalog.ts`) against PGlite:
 * imports categories/products/variants from the rich v2 shape, is idempotent,
 * derives categories (labelled from CATEGORY_DEFS, order preserved), bumps the
 * catalog version, and Zod-validates its consumed shape.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { catalogItems, categories, products, productVariants } from '../../src/db/schema.js'
import { getCatalogVersion } from '../../src/services/catalogVersion.js'
import { CatalogFileSchema, seedCatalog, type CatalogFile } from '../../scripts/seed-catalog.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

const IMG = { thumb: 't', grid: 'g', pdp: 'p', zoom: 'z' }

function catalogFile(overrides: Partial<CatalogFile> = {}): CatalogFile {
  return {
    products: [
      {
        id: 'dan-hair-oil',
        slug: 'hair-oil',
        name: 'Daniya Hair Oil',
        category: 'hair oil',
        description: 'An oil.',
        bullets: ['a', 'b'],
        highlights: [{ icon: 'leaf-outline', label: 'Key', value: 'Amla' }],
        images: { main: IMG, gallery: [IMG], hero: IMG },
        // Intentionally out of size order to prove variant sort-by-size_ml.
        variants: [
          {
            sku: 'B-500',
            asin: 'x2',
            size: '500ml',
            size_ml: 500,
            price_inr: 399,
            mrp_inr: 450,
            in_stock: true,
            best_before_mode: 'printed_on_pack',
          },
          {
            sku: 'A-200',
            asin: 'x1',
            size: '200ml',
            size_ml: 200,
            price_inr: 249,
            mrp_inr: 280,
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
        id: 'dan-cream',
        slug: 'cream-rose',
        name: 'Daniya Cream',
        category: 'cream',
        description: 'A cream.',
        bullets: [],
        highlights: [],
        images: { main: IMG, gallery: [] },
        variants: [
          {
            sku: 'C-50',
            asin: 'x3',
            size: '50g',
            size_ml: 50,
            price_inr: 199,
            mrp_inr: 220,
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
    ...overrides,
  }
}

describe('seedCatalog', () => {
  it('imports categories, products, and variants', async () => {
    const summary = await seedCatalog(db, catalogFile())
    expect(summary).toEqual({ categories: 2, products: 2, variants: 3 })

    const prodRows = await db.select().from(products)
    expect(prodRows).toHaveLength(2)
    const catRows = await db.select().from(categories)
    expect(catRows).toHaveLength(2)
    const varRows = await db.select().from(productVariants)
    expect(varRows).toHaveLength(3)
  })

  it('preserves rich jsonb fields (bullets, highlights, images map)', async () => {
    await seedCatalog(db, catalogFile())
    const [p] = await db.select().from(products).where(eq(products.id, 'dan-hair-oil'))
    expect(p?.bullets).toEqual(['a', 'b'])
    expect(p?.highlights).toEqual([{ icon: 'leaf-outline', label: 'Key', value: 'Amla' }])
    expect(p?.images).toEqual({ main: IMG, gallery: [IMG], hero: IMG })
  })

  it('labels known categories from CATEGORY_DEFS and orders them', async () => {
    await seedCatalog(db, catalogFile())
    const rows = await db.select().from(categories)
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]))
    expect(bySlug['hair oil']).toMatchObject({ label: 'Hair Oil', sortOrder: 0 })
    expect(bySlug['cream']).toMatchObject({ label: 'Cream', sortOrder: 4 })
  })

  it('sorts variants by size_ml (ascending) via sort_order', async () => {
    await seedCatalog(db, catalogFile())
    const rows = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, 'dan-hair-oil'))
    const bySku = Object.fromEntries(rows.map((r) => [r.sku, r]))
    expect(bySku['A-200']?.sortOrder).toBe(0) // 200ml first
    expect(bySku['B-500']?.sortOrder).toBe(1) // 500ml second
  })

  it('bumps the catalog version', async () => {
    expect(await getCatalogVersion(db)).toBe(0)
    await seedCatalog(db, catalogFile())
    expect(await getCatalogVersion(db)).toBe(1)
  })

  it('projects every variant into catalog_items (cart price authority) self-consistently', async () => {
    await seedCatalog(db, catalogFile())
    const items = await db.select().from(catalogItems)
    // 3 variants total in the fixture (2 hair-oil + 1 cream).
    expect(items).toHaveLength(3)
    const bySku = Object.fromEntries(items.map((i) => [i.sku, i]))
    expect(bySku['A-200']).toMatchObject({
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 249,
      imageUrl: 'g',
      active: true,
    })
  })

  it('is idempotent: re-running changes nothing observable (no duplicate rows)', async () => {
    await seedCatalog(db, catalogFile())
    const summary = await seedCatalog(db, catalogFile())
    expect(summary).toEqual({ categories: 2, products: 2, variants: 3 })

    expect(await db.select().from(products)).toHaveLength(2)
    expect(await db.select().from(productVariants)).toHaveLength(3)
    expect(await db.select().from(categories)).toHaveLength(2)
  })

  it('updates a product/variant when the file changes on re-seed', async () => {
    await seedCatalog(db, catalogFile())
    const updated = catalogFile()
    updated.products[0]!.name = 'Renamed Oil'
    updated.products[0]!.variants[1]!.price_inr = 299 // the 200ml
    await seedCatalog(db, updated)

    const [p] = await db.select().from(products).where(eq(products.id, 'dan-hair-oil'))
    expect(p?.name).toBe('Renamed Oil')
    const [v] = await db.select().from(productVariants).where(eq(productVariants.sku, 'A-200'))
    expect(v?.priceInr).toBe(299)
  })

  it('labels an unlisted category from its slug (title-cased) with a high sort order', async () => {
    const file = catalogFile({
      products: [
        {
          id: 'p1',
          slug: 's1',
          name: 'N',
          category: 'face wash', // not in CATEGORY_DEFS
          description: '',
          bullets: [],
          highlights: [],
          images: { main: IMG, gallery: [] },
          variants: [
            {
              sku: 'K1',
              asin: '',
              size: '1',
              size_ml: 1,
              price_inr: 1,
              mrp_inr: 1,
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
    })
    await seedCatalog(db, file)
    const [c] = await db.select().from(categories).where(eq(categories.slug, 'face wash'))
    expect(c).toMatchObject({ label: 'Face Wash', sortOrder: 100 })
  })
})

describe('CatalogFileSchema', () => {
  it('parses a well-formed file', () => {
    expect(CatalogFileSchema.safeParse(catalogFile()).success).toBe(true)
  })

  it('rejects a product missing required fields', () => {
    expect(CatalogFileSchema.safeParse({ products: [{ id: 'x' }] }).success).toBe(false)
  })

  it('rejects a product with no variants', () => {
    const bad = catalogFile()
    bad.products[0]!.variants = []
    expect(CatalogFileSchema.safeParse(bad).success).toBe(false)
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
