/**
 * Route tests: public GET /v1/catalog — empty-state 200, populated snapshot
 * shape (products + variants + categories + merchandising), ETag/304
 * conditional GET, and Cache-Control. No auth required. Data is loaded through
 * the real `seedCatalog` so the route exercises the genuine assembly path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedCatalog, type CatalogFile } from '../../scripts/seed-catalog.js'
import { auth, createTestApp, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

const IMG = { thumb: 't', grid: 'g', pdp: 'p', zoom: 'z' }

function catalogFile(): CatalogFile {
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
        variants: [
          { sku: 'A-200', asin: 'x1', size: '200ml', size_ml: 200, price_inr: 249, mrp_inr: 280, in_stock: true, best_before_mode: 'printed_on_pack' },
          { sku: 'B-500', asin: 'x2', size: '500ml', size_ml: 500, price_inr: 399, mrp_inr: 450, in_stock: false, best_before_mode: 'printed_on_pack' },
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

describe('GET /v1/catalog (public)', () => {
  it('200s with an empty catalog before any product exists', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.products).toEqual([])
    expect(body.categories).toEqual([])
    expect(typeof body.version).toBe('string')
    expect(res.headers.etag).toBe(`"${body.version}"`)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('requires no auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.statusCode).not.toBe(401)
  })

  it('returns the assembled snapshot with variants, categories, and merchandising', async () => {
    await seedCatalog(ctx.db, catalogFile())
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.products).toHaveLength(1)
    const p = body.products[0]
    expect(p).toMatchObject({
      id: 'dan-hair-oil',
      slug: 'hair-oil',
      name: 'Daniya Hair Oil',
      category: 'hair oil',
      bullets: ['a', 'b'],
      is_best_seller: false,
      is_recommended: false,
      seasonal_discount_pct: 0,
      max_qty_per_user: null,
    })
    expect(p.highlights).toEqual([{ icon: 'leaf-outline', label: 'Key', value: 'Amla' }])
    expect(p.images).toEqual({ main: IMG, gallery: [IMG], hero: IMG })
    expect(p.variants).toHaveLength(2)
    expect(p.variants[0]).toMatchObject({ sku: 'A-200', size: '200ml', price_inr: 249, stock_qty: null })
    // No seasonal discount → effective price equals the raw price.
    expect(p.variants[0].effective_price_inr).toBe(249)
    expect(p.variants[1].effective_price_inr).toBe(399)

    // Product in_stock is derived: true because the 200ml variant is in stock.
    expect(p.in_stock).toBe(true)

    expect(body.categories).toHaveLength(1)
    expect(body.categories[0]).toMatchObject({ slug: 'hair oil', label: 'Hair Oil', sort_order: 0 })
  })

  it('exposes effective_price_inr with the seasonal discount applied, keeping price_inr/mrp_inr raw', async () => {
    const file = catalogFile()
    file.products[0]!.seasonal_discount_pct = 25 // 25% off both variants
    await seedCatalog(ctx.db, file)
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    const p = res.json().products[0]

    expect(p.seasonal_discount_pct).toBe(25)
    // Raw price + MRP are unchanged (the app strikes these); only the effective
    // price carries the discount: 249 * 0.75 = 186.75 → 187, 399 * 0.75 = 299.25 → 299.
    expect(p.variants[0]).toMatchObject({ price_inr: 249, mrp_inr: 280, effective_price_inr: 187 })
    expect(p.variants[1]).toMatchObject({ price_inr: 399, mrp_inr: 450, effective_price_inr: 299 })
  })

  it('derives product in_stock=false when every variant is out of stock', async () => {
    const file = catalogFile()
    file.products[0]!.variants.forEach((v) => (v.in_stock = false))
    await seedCatalog(ctx.db, file)
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.json().products[0].in_stock).toBe(false)
  })

  it('returns a bodyless 304 when If-None-Match matches the version', async () => {
    await seedCatalog(ctx.db, catalogFile())
    const first = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    const etag = first.headers.etag as string

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog',
      headers: { 'if-none-match': etag },
    })
    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
    expect(res.headers.etag).toBe(etag)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('returns a bodyless 304 for the WEAK ETag Cloudflare rewrites to', async () => {
    // Regression guard: CF weakens the validator whenever it compresses the
    // response, so the app echoes `W/"n"`, not `"n"`. The old strict compare
    // never matched and the 304 path was dead in production. See lib/etag.ts.
    await seedCatalog(ctx.db, catalogFile())
    const first = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    const weak = `W/${first.headers.etag as string}`

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog',
      headers: { 'if-none-match': weak },
    })
    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
  })

  it('returns 200 with the full body when If-None-Match is stale', async () => {
    await seedCatalog(ctx.db, catalogFile())
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog',
      headers: { 'if-none-match': '"999"' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().products).toHaveLength(1)
  })

  it('returns 200 with the full body when a WEAK If-None-Match is stale', async () => {
    await seedCatalog(ctx.db, catalogFile())
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog',
      headers: { 'if-none-match': 'W/"999"' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().products).toHaveLength(1)
  })

  it('bumps the ETag after the catalog changes (re-seed)', async () => {
    await seedCatalog(ctx.db, catalogFile())
    const before = (await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })).headers.etag
    await seedCatalog(ctx.db, catalogFile()) // second seed bumps version again
    const after = (await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })).headers.etag
    expect(after).not.toBe(before)
  })
})

// Sanity: the public catalog route ignores an Authorization header rather than
// rejecting it (some clients always send one).
describe('GET /v1/catalog with an auth header', () => {
  it('still 200s', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog',
      headers: auth('test-token-user-a'),
    })
    expect(res.statusCode).toBe(200)
  })
})
