/**
 * Route tests: `/v1/reviews` (docs/SPEC-REVIEWS.md).
 *
 * Covers: public GET works unauthenticated and returns the empty-state shape
 * for an unknown product; write routes 401 without a token; POST 404s
 * against an unknown product; POST computes `verifiedPurchase` from the
 * caller's real `paid` order history (services/payments.ts
 * `hasPurchasedProduct`) rather than trusting the client; a resubmission
 * edits the same row instead of duplicating; the helpful-vote route is
 * idempotent per caller.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { catalogItems, categories, payments, products, users } from '../../src/db/schema.js'
import { auth, createTestApp, USER_A, USER_B, type TestContext } from '../helpers/app.js'

const PRODUCT_ID = 'dan-hair-oil'
const OTHER_PRODUCT_ID = 'dan-shampoo'
const SKU = 'DHO-100'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()

  await ctx.db.insert(categories).values({ slug: 'hair oil', label: 'Hair Oil' })
  await ctx.db.insert(products).values([
    { id: PRODUCT_ID, slug: 'hair-oil', name: 'Bhringraj Hair Oil', category: 'hair oil' },
    { id: OTHER_PRODUCT_ID, slug: 'shampoo', name: 'Onion Shampoo', category: 'hair oil' },
  ])
  await ctx.db.insert(catalogItems).values({
    sku: SKU,
    productId: PRODUCT_ID,
    name: 'Bhringraj Hair Oil',
    size: '100ml',
    priceInr: 199,
    lengthCm: 5,
    widthCm: 5,
    heightCm: 5,
    imageUrl: '/products/oil.jpg',
    active: true,
  })
})

describe('GET /v1/reviews/products/:productId', () => {
  it('is public — no Authorization header needed', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/reviews/products/${PRODUCT_ID}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ productId: PRODUCT_ID, average: 0, count: 0, reviews: [] })
  })

  it('returns the same empty shape for a product id that does not exist — never a 404 on read', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/reviews/products/ghost-product' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ average: 0, count: 0 })
  })
})

describe('POST /v1/reviews/products/:productId', () => {
  it('401s without a token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      payload: { rating: 5 },
    })
    expect(res.statusCode).toBe(401)
  })

  it('404s against an unknown product', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reviews/products/ghost-product',
      headers: auth(USER_A.token),
      payload: { rating: 5 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('creates a review; verifiedPurchase is false with no order history', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 4, title: 'Good stuff', body: 'Works well' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      rating: 4,
      title: 'Good stuff',
      verifiedPurchase: false,
      source: 'user',
    })
  })

  it('verifiedPurchase is true when the caller has a PAID order containing this product — computed server-side, never client-supplied', async () => {
    // The contract has no verifiedPurchase field on the write body at all — it
    // comes entirely from this seeded paid order. A cheap authed request first
    // forces the lazy `users` row upsert (plugins/auth.ts) so the payment row
    // below can reference a real userId.
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    const [me] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid)).limit(1)
    if (!me) throw new Error('user upsert did not happen')

    await ctx.db.insert(payments).values({
      orderId: 'order_verified_1',
      userId: me.id,
      amountPaise: 19900,
      status: 'paid',
      cartSnapshot: { items: [{ sku: SKU, qty: 1, priceInr: 199, active: true }], totalInr: 199 },
      addressSnapshot: {},
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 5 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().verifiedPurchase).toBe(true)

    // A paid order for a DIFFERENT product must not verify this one.
    const other = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${OTHER_PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 5 },
    })
    expect(other.json().verifiedPurchase).toBe(false)
  })

  it("a resubmission edits the caller's own review rather than creating a second one", async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 2, title: 'Meh' },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 5, title: 'Changed my mind' },
    })

    const list = await ctx.app.inject({ method: 'GET', url: `/v1/reviews/products/${PRODUCT_ID}` })
    const json = list.json()
    expect(json.count).toBe(1)
    expect(json.reviews[0]).toMatchObject({ rating: 5, title: 'Changed my mind' })
  })
})

describe('POST /v1/reviews/:reviewId/helpful', () => {
  it('401s without a token', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 5 },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/${created.json().id}/helpful`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('is idempotent per caller', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/products/${PRODUCT_ID}`,
      headers: auth(USER_A.token),
      payload: { rating: 5 },
    })
    const reviewId = created.json().id

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/${reviewId}/helpful`,
      headers: auth(USER_B.token),
    })
    expect(first.json()).toEqual({ helpfulCount: 1, alreadyVoted: false })

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reviews/${reviewId}/helpful`,
      headers: auth(USER_B.token),
    })
    expect(second.json()).toEqual({ helpfulCount: 1, alreadyVoted: true })
  })
})
