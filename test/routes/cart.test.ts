/**
 * Route tests: /v1/cart (SPEC-V2.md §7 bullet 3) — GET empty + populated;
 * PUT unknown sku 404 / inactive sku 422 / qty bounds / 50-line cap;
 * DELETE line + 404; clear 204; merge max-rule + skipped + idempotency.
 * Business-rule depth lives in test/services/cart.test.ts; this file proves
 * the HTTP wiring: auth gate, validation codes, envelopes, serialized shapes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SHIPPING_NONE } from '../../src/contracts/cart.js'
import { appConfig, catalogItems, coupons } from '../../src/db/schema.js'
import { auth, createTestApp, USER_A, USER_B, type TestContext } from '../helpers/app.js'

let ctx: TestContext

const SKU_A = 'AH-82U3-T29Q'
const SKU_B = '04-JPDR-6Z6N'
const SKU_INACTIVE = 'ZZ-INACTIVE'

beforeEach(async () => {
  ctx = await createTestApp()
  await ctx.db.insert(catalogItems).values([
    {
      sku: SKU_A,
      productId: 'aloe-gel',
      name: 'Aloe Vera Gel',
      size: '100g',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/products/aloe.jpg',
      active: true,
    },
    {
      sku: SKU_B,
      productId: 'rose-water',
      name: 'Rose Water',
      size: '200ml',
      priceInr: 199,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/products/rose.jpg',
      active: true,
    },
    {
      sku: SKU_INACTIVE,
      productId: 'retired',
      name: 'Retired Item',
      size: '50g',
      priceInr: 99,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '',
      active: false,
    },
  ])
})

afterEach(async () => {
  await ctx.app.close()
})

describe('auth gate', () => {
  it.each([
    ['GET', '/v1/cart'],
    ['PUT', `/v1/cart/items/${SKU_A}`],
    ['DELETE', `/v1/cart/items/${SKU_A}`],
    ['DELETE', '/v1/cart'],
    ['POST', '/v1/cart/merge'],
  ] as const)('401s %s %s without a token', async (method, url) => {
    const res = await ctx.app.inject({ method, url })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })
})

describe('GET /v1/cart', () => {
  it('200s with an empty cart (epoch updatedAt) before any writes', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [],
      count: 0,
      totalInr: 0,
      // The seeded config leaves wholesale off, so the route resolves the
      // OFF rule and the cart reports it as unavailable rather than omitting it.
      wholesale: {
        applied: false,
        enabled: false,
        thresholdInr: 0,
        discountPct: 0,
        retailTotalInr: 0,
        remainingInr: 0,
        savedInr: 0,
      },
      // No `?coupon=` query param → the always-present block reports no code requested.
      coupon: {
        applied: false,
        code: null,
        label: '',
        discountType: null,
        discountValue: 0,
        minCartInr: 0,
        maxDiscountInr: null,
        discountInr: 0,
        subtotalInr: 0,
        reason: null,
      },
      // Shipping seeds OFF, so the block is present but inert and `totalInr`
      // is unchanged from before delivery fees existed.
      shipping: SHIPPING_NONE,
      // COD seeds OFF too, so the block is present and says so — a client that
      // had to special-case a missing block would eventually render the wrong one.
      updatedAt: new Date(0).toISOString(),
    })
  })

  it('200s with populated lines joined live from the catalog', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 2 },
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toEqual([
      {
        sku: SKU_A,
        productId: 'aloe-gel',
        name: 'Aloe Vera Gel',
        size: '100g',
        qty: 2,
        priceInr: 249,
        imageUrl: '/products/aloe.jpg',
        active: true,
      },
    ])
    expect(body.count).toBe(2)
    expect(body.totalInr).toBe(498)
  })

  it("never shows another user's cart", async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_B.token),
    })
    expect(res.json().items).toEqual([])
  })
})

describe('PUT /v1/cart/items/:sku', () => {
  it('200s with the full cart and SETs qty idempotently (not increment)', async () => {
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 3 },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items[0].qty).toBe(3)

    const second = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 3 },
    })
    expect(second.json().items[0].qty).toBe(3)
    expect(second.json().count).toBe(3)
  })

  it('404s not_found for an unknown sku', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/cart/items/no-such-sku',
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('422s validation_failed for an inactive sku', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_INACTIVE}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it.each([0, 100, 1.5, -1])('422s for out-of-bounds qty %s', async (qty) => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s for unknown body fields (strict)', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 1, note: 'gift wrap' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('422s limit_exceeded for a new line past the 50-line cap', async () => {
    const bulk = Array.from({ length: 50 }, (_, i) => ({
      sku: `bulk-sku-${i}`,
      productId: 'bulk',
      name: `Bulk ${i}`,
      size: '1u',
      priceInr: 10,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '',
      active: true,
    }))
    await ctx.db.insert(catalogItems).values(bulk)
    for (const item of bulk) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/v1/cart/items/${item.sku}`,
        headers: auth(USER_A.token),
        payload: { qty: 1 },
      })
    }

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('limit_exceeded')

    // An EXISTING line can still be updated at the cap.
    const update = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/cart/items/bulk-sku-0',
      headers: auth(USER_A.token),
      payload: { qty: 5 },
    })
    expect(update.statusCode).toBe(200)
  })
})

describe('DELETE /v1/cart/items/:sku', () => {
  it('200s with the remaining cart after removing a line', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_B}`,
      headers: auth(USER_A.token),
      payload: { qty: 2 },
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].sku).toBe(SKU_B)
  })

  it('404s for a line that is not in the cart', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('DELETE /v1/cart (clear)', () => {
  it('204s with an empty body and empties the cart', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')

    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(cart.json().items).toEqual([])
  })

  it('204s even when the cart is already empty', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('POST /v1/cart/merge', () => {
  it('applies qty = max(existing, incoming) and reports skipped skus', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_A}`,
      headers: auth(USER_A.token),
      payload: { qty: 5 },
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cart/merge',
      headers: auth(USER_A.token),
      payload: {
        items: [
          { sku: SKU_A, qty: 2 }, // existing 5 > incoming 2 → stays 5
          { sku: SKU_B, qty: 3 }, // new line
          { sku: SKU_INACTIVE, qty: 1 }, // skipped (inactive)
          { sku: 'no-such-sku', qty: 1 }, // skipped (unknown)
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.skipped).toEqual([SKU_INACTIVE, 'no-such-sku'])
    const bySku = Object.fromEntries(
      body.cart.items.map((line: { sku: string; qty: number }) => [line.sku, line.qty])
    )
    expect(bySku).toEqual({ [SKU_A]: 5, [SKU_B]: 3 })
  })

  it('is idempotent — double-merging the same payload changes nothing', async () => {
    const payload = {
      items: [
        { sku: SKU_A, qty: 4 },
        { sku: SKU_B, qty: 2 },
      ],
    }
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cart/merge',
      headers: auth(USER_A.token),
      payload,
    })
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cart/merge',
      headers: auth(USER_A.token),
      payload,
    })
    expect(second.statusCode).toBe(200)
    const strip = (cart: { items: unknown[]; count: number; totalInr: number }) => ({
      items: cart.items,
      count: cart.count,
      totalInr: cart.totalInr,
    })
    expect(strip(second.json().cart)).toEqual(strip(first.json().cart))
    expect(second.json().skipped).toEqual([])
  })

  it('422s for duplicate skus in the payload', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cart/merge',
      headers: auth(USER_A.token),
      payload: {
        items: [
          { sku: SKU_A, qty: 1 },
          { sku: SKU_A, qty: 2 },
        ],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s for a payload of more than 50 items', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cart/merge',
      headers: auth(USER_A.token),
      payload: {
        items: Array.from({ length: 51 }, (_, i) => ({ sku: `s-${i}`, qty: 1 })),
      },
    })
    expect(res.statusCode).toBe(422)
  })
})

/**
 * The wholesale knobs live in `app_config` and the ROUTE resolves them (the cart
 * service takes a plain rule — see the note in services/cart.ts). These prove
 * the config → route → service wiring, which the service tests can't cover.
 */
describe('wholesale wiring (config → route)', () => {
  async function setWholesale(enabled: unknown, thresholdInr: unknown, discountPct: unknown) {
    await ctx.db.insert(appConfig).values([
      { key: 'wholesale.enabled', value: enabled, description: 'test' },
      { key: 'wholesale.thresholdInr', value: thresholdInr, description: 'test' },
      { key: 'wholesale.discountPct', value: discountPct, description: 'test' },
    ])
  }

  async function getCartJson() {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    return res.json()
  }

  async function addLine(sku: string, qty: number) {
    return ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${sku}`,
      headers: auth(USER_A.token),
      payload: { qty },
    })
  }

  it('applies the discount over HTTP once the configured threshold is met', async () => {
    await setWholesale(true, 1000, 10)
    await addLine(SKU_A, 5) // 5 × 249 = 1245 ≥ 1000

    const cart = await getCartJson()
    expect(cart.wholesale).toMatchObject({
      applied: true,
      enabled: true,
      thresholdInr: 1000,
      discountPct: 10,
      retailTotalInr: 1245,
      savedInr: 1245 - 5 * 224,
    })
    expect(cart.items[0].priceInr).toBe(224) // 249 → 224.1 → 224
    expect(cart.totalInr).toBe(5 * 224)
  })

  it('reports progress toward the threshold when the cart is short', async () => {
    await setWholesale(true, 1000, 10)
    await addLine(SKU_A, 2) // 498

    const cart = await getCartJson()
    expect(cart.wholesale).toMatchObject({ applied: false, remainingInr: 502 })
    expect(cart.totalInr).toBe(498)
  })

  it('honours the config kill switch even when the cart is over the threshold', async () => {
    await setWholesale(false, 1000, 10)
    await addLine(SKU_A, 5)

    const cart = await getCartJson()
    expect(cart.wholesale).toMatchObject({ applied: false, enabled: false })
    expect(cart.totalInr).toBe(1245)
  })

  it('falls back to wholesale OFF when the keys are malformed (never mis-charges)', async () => {
    // `value` is NOT NULL, so a "missing" key is modelled as a junk value.
    await setWholesale(true, 'not-a-number', 'also-not-a-number')
    await addLine(SKU_A, 5)

    const cart = await getCartJson()
    expect(cart.wholesale.applied).toBe(false)
    expect(cart.totalInr).toBe(1245)
  })

  it('returns the applied wholesale cart from the PUT itself, not just a later GET', async () => {
    await setWholesale(true, 1000, 10)
    const res = await addLine(SKU_A, 5)

    expect(res.statusCode).toBe(200)
    expect(res.json().wholesale.applied).toBe(true)
    expect(res.json().totalInr).toBe(5 * 224)
  })
})

/**
 * `?coupon=CODE` is resolved by the ROUTE (via `services/coupons.ts`) into a
 * plain `CouponLookup` the cart service folds in — these prove the HTTP
 * query-param → route → service wiring end to end (test/services/cart.test.ts
 * covers the pricing math itself by calling `getCart` with an already-resolved
 * lookup, which can't catch a route-layer wiring bug).
 */
describe('coupon wiring (route -> service)', () => {
  async function addLine(sku: string, qty: number) {
    return ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${sku}`,
      headers: auth(USER_A.token),
      payload: { qty },
    })
  }

  async function getCartWithCoupon(code: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/cart?coupon=${encodeURIComponent(code)}`,
      headers: auth(USER_A.token),
    })
    return res
  }

  beforeEach(async () => {
    await ctx.db.insert(coupons).values({
      code: 'DIRECT15',
      label: 'Early Bird offer',
      description: '15% off',
      discountType: 'percent',
      discountValue: 15,
      minCartInr: 0,
      maxDiscountInr: null,
      active: true,
      sortOrder: 0,
    })
  })

  it('folds a valid `?coupon=` code into the priced cart over HTTP', async () => {
    await addLine(SKU_A, 1) // 249

    const res = await getCartWithCoupon('DIRECT15')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.coupon).toMatchObject({
      applied: true,
      code: 'DIRECT15',
      discountInr: 37, // round(249 * 0.15) = 37.35 -> 37
      reason: null,
    })
    expect(body.totalInr).toBe(249 - 37)
  })

  it('normalizes a lowercase `?coupon=` code to the uppercase row', async () => {
    await addLine(SKU_A, 1)
    const res = await getCartWithCoupon('direct15')
    expect(res.json().coupon).toMatchObject({ applied: true, code: 'DIRECT15' })
  })

  it('an unknown `?coupon=` code folds in as reason invalid, no discount', async () => {
    await addLine(SKU_A, 1)
    const res = await getCartWithCoupon('GHOST')
    expect(res.statusCode).toBe(200)
    expect(res.json().coupon).toMatchObject({ applied: false, code: 'GHOST', reason: 'invalid' })
    expect(res.json().totalInr).toBe(249)
  })
})
