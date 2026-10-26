/**
 * Route tests: /v1/admin/catalog/* — auth gates (401/403), product/variant/
 * category CRUD, referential-integrity errors, the catalog version bumping on
 * every write, and — critically — the projection into `catalog_items` (cart's
 * price authority) staying correct on create/update/delete so cart never sees
 * a stale price or a missing sku.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { catalogItems } from '../../src/db/schema.js'
import { getCatalogVersion } from '../../src/services/catalogVersion.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

/** Promote USER_ADMIN (first authed request creates the row, then flip role). */
async function makeAdmin(): Promise<void> {
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/catalog/products',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
}

const A = () => auth(USER_ADMIN.token)

const IMG = { thumb: 't', grid: 'GRID_URL', pdp: 'p', zoom: 'z' }

async function seedCategory(slug = 'hair oil', label = 'Hair Oil') {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/catalog/categories',
    headers: A(),
    payload: { slug, label },
  })
}

async function seedProduct(id = 'dan-hair-oil', over: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/catalog/products',
    headers: A(),
    payload: {
      id,
      slug: id,
      name: 'Daniya Hair Oil',
      category: 'hair oil',
      images: { main: IMG, gallery: [] },
      // Legal Metrology fields — required whenever active resolves true
      // (the default), see assertProductLegalMetrologyComplete.
      manufacturerName: 'Saman Products Company',
      manufacturerAddress: 'Gujarat, India',
      manufacturerLicence: 'GC1299',
      countryOfOrigin: 'India',
      consumerCareContact: 'care@example.com',
      ...over,
    },
  })
}

async function seedVariant(productId = 'dan-hair-oil', sku = 'SKU-200', over: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/admin/catalog/products/${productId}/variants`,
    headers: A(),
    payload: { sku, size: '200ml', priceInr: 249, ...over },
  })
}

// --- Auth gates --------------------------------------------------------------

describe('admin catalog auth', () => {
  it('401 without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/admin/catalog/products' })
    expect(res.statusCode).toBe(401)
  })

  it('403 for a non-admin user', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('200 for an admin', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products',
      headers: A(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

// --- Category CRUD -----------------------------------------------------------

describe('category CRUD', () => {
  beforeEach(makeAdmin)

  it('creates, lists, updates, and deletes a category, bumping the version each time', async () => {
    const v0 = await getCatalogVersion(ctx.db)

    const created = await seedCategory()
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ slug: 'hair oil', label: 'Hair Oil', active: true })
    expect(await getCatalogVersion(ctx.db)).toBe(v0 + 1)

    const list = await ctx.app.inject({ method: 'GET', url: '/v1/admin/catalog/categories', headers: A() })
    expect(list.json()).toHaveLength(1)

    const upd = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/categories/hair oil',
      headers: A(),
      payload: { label: 'Hair Oils', sortOrder: 3 },
    })
    expect(upd.json()).toMatchObject({ label: 'Hair Oils', sortOrder: 3 })

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/catalog/categories/hair oil',
      headers: A(),
    })
    expect(del.statusCode).toBe(204)
  })

  it('rejects a duplicate category slug', async () => {
    await seedCategory()
    const dup = await seedCategory()
    expect(dup.statusCode).toBe(422)
  })

  it('404 updating a missing category', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/categories/nope',
      headers: A(),
      payload: { label: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to delete a category that still has products', async () => {
    await seedCategory()
    await seedProduct()
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/catalog/categories/hair oil',
      headers: A(),
    })
    expect(res.statusCode).toBe(422)
  })
})

// --- Product CRUD + referential integrity ------------------------------------

describe('product CRUD', () => {
  beforeEach(makeAdmin)

  it('creates a product (201) and reads it back with empty variants', async () => {
    await seedCategory()
    const created = await seedProduct()
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      id: 'dan-hair-oil',
      category: 'hair oil',
      active: true,
      variants: [],
    })

    const got = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
    })
    expect(got.statusCode).toBe(200)
  })

  it('rejects a product in a non-existent category (422, no FK explosion)', async () => {
    const res = await seedProduct('x', { category: 'ghost' })
    expect(res.statusCode).toBe(422)
  })

  it('rejects a duplicate product id', async () => {
    await seedCategory()
    await seedProduct()
    const dup = await seedProduct()
    expect(dup.statusCode).toBe(422)
  })

  it('patches merchandising fields', async () => {
    await seedCategory()
    await seedProduct()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { isBestSeller: true, seasonalDiscountPct: 15, maxQtyPerUser: 3 },
    })
    expect(res.json()).toMatchObject({ isBestSeller: true, seasonalDiscountPct: 15, maxQtyPerUser: 3 })
  })

  it('creates and patches manufacturerLicence and brand (Phase 3)', async () => {
    await seedCategory()
    const created = await seedProduct('dan-hair-oil', { brand: 'Daniya' })
    expect(created.json()).toMatchObject({ manufacturerLicence: 'GC1299', brand: 'Daniya' })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { manufacturerLicence: 'GC9999', brand: 'Saman' },
    })
    expect(res.json()).toMatchObject({ manufacturerLicence: 'GC9999', brand: 'Saman' })
  })

  it('rejects an out-of-range seasonal discount', async () => {
    await seedCategory()
    await seedProduct()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { seasonalDiscountPct: 95 },
    })
    expect(res.statusCode).toBe(422)
  })

  it('404 on a missing product', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products/nope',
      headers: A(),
    })
    expect(res.statusCode).toBe(404)
  })
})

// --- Legal Metrology "can't go live incomplete" gate -------------------------

describe('Legal Metrology completeness gate (products)', () => {
  beforeEach(async () => {
    await makeAdmin()
    await seedCategory()
  })

  it('422s creating an active product missing manufacturer/consumer-care fields', async () => {
    const res = await seedProduct('dan-hair-oil', {
      manufacturerName: '',
      manufacturerAddress: '',
      manufacturerLicence: '',
      countryOfOrigin: '',
      consumerCareContact: '',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s creating an active product with everything else filled but no manufacturerLicence', async () => {
    const res = await seedProduct('dan-hair-oil', { manufacturerLicence: '' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('manufacturerLicence')
  })

  it('allows creating an incomplete product as long as active: false', async () => {
    const res = await seedProduct('dan-hair-oil', {
      active: false,
      manufacturerName: '',
      manufacturerAddress: '',
      manufacturerLicence: '',
      countryOfOrigin: '',
      consumerCareContact: '',
    })
    expect(res.statusCode).toBe(201)
  })

  it('422s flipping a draft product to active while a field is still blank', async () => {
    await seedProduct('dan-hair-oil', { active: false, consumerCareContact: '' })
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { active: true },
    })
    expect(res.statusCode).toBe(422)
  })

  it('allows publishing once every field is filled in', async () => {
    await seedProduct('dan-hair-oil', { active: false, consumerCareContact: '' })
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { active: true, consumerCareContact: 'care@example.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ active: true, consumerCareContact: 'care@example.com' })
  })
})

describe('Legal Metrology completeness gate (variants — best before)', () => {
  beforeEach(async () => {
    await makeAdmin()
    await seedCategory()
    await seedProduct()
  })

  it('422s declaring bestBeforeMode "date" with no date (clean validation error, not a raw DB 500)', async () => {
    const res = await seedVariant('dan-hair-oil', 'SKU-200', { bestBeforeMode: 'date' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('allows a variant once a best-before date is supplied', async () => {
    const res = await seedVariant('dan-hair-oil', 'SKU-200', {
      bestBeforeMode: 'date',
      bestBeforeDate: '2027-01-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ bestBeforeMode: 'date' })
  })

  it('422s a PUT that flips an existing variant to bestBeforeMode "date" without a date', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200')
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
      payload: { bestBeforeMode: 'date' },
    })
    expect(res.statusCode).toBe(422)
  })
})

// --- Variant CRUD ------------------------------------------------------------

describe('variant CRUD', () => {
  beforeEach(async () => {
    await makeAdmin()
    await seedCategory()
    await seedProduct()
  })

  it('adds a variant (201) and it appears under the product', async () => {
    const res = await seedVariant()
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ sku: 'SKU-200', size: '200ml', priceInr: 249 })

    const prod = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
    })
    expect(prod.json().variants).toHaveLength(1)
  })

  it('rejects a variant on a missing product (404)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/catalog/products/ghost/variants',
      headers: A(),
      payload: { sku: 'X', size: '1', priceInr: 1 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a duplicate sku', async () => {
    await seedVariant()
    const dup = await seedVariant()
    expect(dup.statusCode).toBe(422)
  })

  it('patches a variant price', async () => {
    await seedVariant()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
      payload: { priceInr: 299 },
    })
    expect(res.json()).toMatchObject({ priceInr: 299 })
  })

  it('deletes a variant (204)', async () => {
    await seedVariant()
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
    })
    expect(res.statusCode).toBe(204)
  })
})

// --- Projection into catalog_items (cart price authority) --------------------

describe('projection to catalog_items', () => {
  beforeEach(async () => {
    await makeAdmin()
    await seedCategory()
    await seedProduct()
  })

  async function itemBySku(sku: string) {
    const [row] = await ctx.db.select().from(catalogItems).where(eq(catalogItems.sku, sku))
    return row
  }

  it('projects a new variant into catalog_items (active, priced, named)', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200', { priceInr: 249 })
    const item = await itemBySku('SKU-200')
    expect(item).toMatchObject({
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 249,
      imageUrl: 'GRID_URL',
      active: true,
    })
  })

  it('updates the projected price when a variant price changes', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200', { priceInr: 249 })
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
      payload: { priceInr: 299 },
    })
    expect((await itemBySku('SKU-200'))?.priceInr).toBe(299)
  })

  it('projects the EFFECTIVE (seasonally-discounted) price into catalog_items', async () => {
    // Product created with a 20% seasonal discount; the price authority the cart
    // reads must already be discounted (400, not the raw 500).
    await seedProduct('dan-discounted', { slug: 'dan-discounted', seasonalDiscountPct: 20 })
    await seedVariant('dan-discounted', 'SKU-DISC', { priceInr: 500 })
    expect((await itemBySku('SKU-DISC'))?.priceInr).toBe(400)
  })

  it('re-projects every variant price when the seasonal discount changes', async () => {
    await seedProduct('dan-sale', { slug: 'dan-sale', seasonalDiscountPct: 0 })
    await seedVariant('dan-sale', 'SKU-SALE', { priceInr: 1000 })
    expect((await itemBySku('SKU-SALE'))?.priceInr).toBe(1000) // no discount yet

    // Turning on a 10% seasonal discount must flow to the projection.
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-sale',
      headers: A(),
      payload: { seasonalDiscountPct: 10 },
    })
    expect((await itemBySku('SKU-SALE'))?.priceInr).toBe(900)

    // Clearing it back to 0 restores the raw price.
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-sale',
      headers: A(),
      payload: { seasonalDiscountPct: 0 },
    })
    expect((await itemBySku('SKU-SALE'))?.priceInr).toBe(1000)
  })

  it('updates the projected name/image when the product changes', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200')
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { name: 'Renamed', images: { main: { ...IMG, grid: 'NEW_GRID' }, gallery: [] } },
    })
    const item = await itemBySku('SKU-200')
    expect(item).toMatchObject({ name: 'Renamed', imageUrl: 'NEW_GRID' })
  })

  it('deactivates a variant projection when it goes out of stock', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200', { inStock: true })
    expect((await itemBySku('SKU-200'))?.active).toBe(true)
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
      payload: { inStock: false },
    })
    expect((await itemBySku('SKU-200'))?.active).toBe(false)
  })

  it('deactivates all a product’s projections when the product is unpublished', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200')
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { active: false },
    })
    expect((await itemBySku('SKU-200'))?.active).toBe(false)
  })

  it('deactivates (not deletes) the projection when a variant is deleted', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200')
    await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/catalog/variants/SKU-200',
      headers: A(),
    })
    const item = await itemBySku('SKU-200')
    expect(item).toBeDefined() // row kept for cart refs
    expect(item?.active).toBe(false)
  })

  it('deactivates (not deletes) all projections when a product is deleted', async () => {
    await seedVariant('dan-hair-oil', 'SKU-200')
    await seedVariant('dan-hair-oil', 'SKU-500', { size: '500ml', priceInr: 399 })
    await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
    })
    expect((await itemBySku('SKU-200'))?.active).toBe(false)
    expect((await itemBySku('SKU-500'))?.active).toBe(false)
  })
})

// --- Public snapshot reflects admin writes -----------------------------------

describe('admin writes surface in GET /v1/catalog', () => {
  beforeEach(makeAdmin)

  it('a created product+variant appears in the public catalog with a bumped ETag', async () => {
    const before = (await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })).headers.etag

    await seedCategory()
    await seedProduct()
    await seedVariant()

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.headers.etag).not.toBe(before)
    const body = res.json()
    expect(body.products).toHaveLength(1)
    expect(body.products[0].variants).toHaveLength(1)
    expect(body.categories).toHaveLength(1)
  })

  it('an unpublished (active:false) product is hidden from the public catalog', async () => {
    await seedCategory()
    await seedProduct()
    await seedVariant()
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/catalog/products/dan-hair-oil',
      headers: A(),
      payload: { active: false },
    })
    const body = (await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })).json()
    expect(body.products).toHaveLength(0)
  })
})
