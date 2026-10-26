/**
 * Service-rule tests against PGlite for the cart module (SPEC-V2.md §4/§7
 * bullet 3-scope): idempotent PUT, unknown/inactive sku handling, the 50-line
 * cap, inactive-line exclusion from count/totalInr, and merge semantics
 * (max-rule, skip reporting, transactional single-shot, idempotent re-merge).
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { SHIPPING_NONE } from '../../src/contracts/cart.js'
import type { Db } from '../../src/db/client.js'
import { cartItems, catalogItems, users } from '../../src/db/schema.js'
import type { CouponLookup, CouponRule } from '../../src/lib/coupons.js'
import { WHOLESALE_OFF, type WholesaleRule } from '../../src/lib/pricing.js'
import {
  clearCart,
  deleteCartLine,
  getCart,
  mergeCart,
  putCartLine,
} from '../../src/services/cart.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let userId: string

const SKU_A = 'AH-82U3-T29Q'
const SKU_B = '04-JPDR-6Z6N'
const SKU_INACTIVE = 'ZZ-INACTIVE'

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db

  const [row] = await db
    .insert(users)
    .values({ firebaseUid: 'shopper-uid', phone: '+919876543210' })
    .returning({ id: users.id })
  if (!row) throw new Error('user insert failed')
  userId = row.id

  await db.insert(catalogItems).values([
    {
      sku: SKU_A,
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: 'https://example.com/a.jpg',
      active: true,
    },
    {
      sku: SKU_B,
      productId: 'dan-face-wash',
      name: 'Daniya Face Wash',
      size: '100ml',
      priceInr: 199,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: 'https://example.com/b.jpg',
      active: true,
    },
    {
      sku: SKU_INACTIVE,
      productId: 'dan-discontinued',
      name: 'Discontinued Item',
      size: '50ml',
      priceInr: 99,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: 'https://example.com/c.jpg',
      active: false,
    },
  ])
})

describe('getCart', () => {
  it('returns an empty cart with the epoch updatedAt', async () => {
    const cart = await getCart(db, userId)
    expect(cart).toEqual({
      items: [],
      count: 0,
      totalInr: 0,
      // No rule passed → wholesale reports itself off, never applied.
      wholesale: {
        applied: false,
        enabled: false,
        thresholdInr: 0,
        discountPct: 0,
        retailTotalInr: 0,
        remainingInr: 0,
        savedInr: 0,
      },
      // No coupon passed → the always-present block reports no code requested.
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
        waivesShipping: false,
        reason: null,
      },
      // No shipping resolver passed → the block is present but inert, and
      // `totalInr` is exactly what it was before delivery fees existed.
      shipping: SHIPPING_NONE,
      updatedAt: new Date(0).toISOString(),
    })
  })

  it('sorts items newest-first by createdAt', async () => {
    await putCartLine(db, userId, SKU_A, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await putCartLine(db, userId, SKU_B, 1)

    const cart = await getCart(db, userId)
    expect(cart.items.map((i) => i.sku)).toEqual([SKU_B, SKU_A])
  })
})

describe('putCartLine', () => {
  it('creates a new line and joins live catalog fields', async () => {
    const cart = await putCartLine(db, userId, SKU_A, 3)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]).toMatchObject({
      sku: SKU_A,
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      qty: 3,
      priceInr: 249,
      active: true,
    })
    expect(cart.count).toBe(3)
    expect(cart.totalInr).toBe(747)
  })

  it('is an idempotent SET, not an increment', async () => {
    await putCartLine(db, userId, SKU_A, 5)
    const cart = await putCartLine(db, userId, SKU_A, 2)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]?.qty).toBe(2)
    expect(cart.count).toBe(2)
  })

  it('404s for an unknown sku', async () => {
    await expect(putCartLine(db, userId, 'no-such-sku', 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })

  it('422s validation_failed for an inactive sku', async () => {
    await expect(putCartLine(db, userId, SKU_INACTIVE, 1)).rejects.toMatchObject({
      statusCode: 422,
      code: 'validation_failed',
    })
  })

  it('refreshes price_inr_snapshot from the current catalog price on every write', async () => {
    await putCartLine(db, userId, SKU_A, 1)
    // Catalog price changes after the line was created.
    await db.update(catalogItems).set({ priceInr: 299 }).where(eq(catalogItems.sku, SKU_A))

    await putCartLine(db, userId, SKU_A, 2)
    const rows = await db.select().from(cartItems)
    expect(rows[0]?.priceInrSnapshot).toBe(299)
    // Display price also reflects the live catalog value.
    const cart = await getCart(db, userId)
    expect(cart.items[0]?.priceInr).toBe(299)
  })

  it('rejects a new line past the 50-line cap with limit_exceeded', async () => {
    const skus: string[] = []
    for (let i = 0; i < 50; i++) {
      const sku = `bulk-sku-${i}`
      skus.push(sku)
      await db.insert(catalogItems).values({
        sku,
        productId: 'bulk',
        name: 'Bulk Item',
        size: '1',
        priceInr: 10,
        lengthCm: 5,
        widthCm: 5,
        heightCm: 5,
        imageUrl: '',
        active: true,
      })
      await putCartLine(db, userId, sku, 1)
    }

    await db.insert(catalogItems).values({
      sku: 'one-more',
      productId: 'bulk',
      name: 'One More',
      size: '1',
      priceInr: 10,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '',
      active: true,
    })

    await expect(putCartLine(db, userId, 'one-more', 1)).rejects.toMatchObject({
      statusCode: 422,
      code: 'limit_exceeded',
    })

    // Updating an EXISTING line at the cap must still succeed (not a new line).
    const cart = await putCartLine(db, userId, skus[0]!, 5)
    expect(cart.items.find((i) => i.sku === skus[0])?.qty).toBe(5)
  })

  it('excludes inactive lines from count/totalInr but still returns them with active:false', async () => {
    await putCartLine(db, userId, SKU_A, 2)
    // A line that existed while active, then went inactive later (simulate via direct row insert
    // since PUT itself rejects inactive skus).
    await db.insert(cartItems).values({
      userId,
      sku: SKU_INACTIVE,
      qty: 4,
      priceInrSnapshot: 99,
    })

    const cart = await getCart(db, userId)
    const inactiveLine = cart.items.find((i) => i.sku === SKU_INACTIVE)
    expect(inactiveLine?.active).toBe(false)
    expect(cart.count).toBe(2)
    expect(cart.totalInr).toBe(498)
  })

  it('updatedAt is the max line updated_at across all lines', async () => {
    await putCartLine(db, userId, SKU_A, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await putCartLine(db, userId, SKU_B, 1)

    const rows = await db.select().from(cartItems)
    const maxUpdatedAt = Math.max(...rows.map((r) => r.updatedAt.getTime()))
    const cart = await getCart(db, userId)
    expect(Date.parse(cart.updatedAt)).toBe(maxUpdatedAt)
  })
})

describe('deleteCartLine', () => {
  it('removes the line and returns the updated cart', async () => {
    await putCartLine(db, userId, SKU_A, 1)
    await putCartLine(db, userId, SKU_B, 1)

    const cart = await deleteCartLine(db, userId, SKU_A)
    expect(cart.items.map((i) => i.sku)).toEqual([SKU_B])
  })

  it('404s for a missing line', async () => {
    await expect(deleteCartLine(db, userId, SKU_A)).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })
})

describe('clearCart', () => {
  it('removes every line for the user', async () => {
    await putCartLine(db, userId, SKU_A, 1)
    await putCartLine(db, userId, SKU_B, 1)
    await clearCart(db, userId)
    const cart = await getCart(db, userId)
    expect(cart.items).toEqual([])
  })
})

describe('mergeCart', () => {
  it('creates lines for unknown-to-cart skus at the incoming qty', async () => {
    const { cart, skipped } = await mergeCart(db, userId, [
      { sku: SKU_A, qty: 3 },
      { sku: SKU_B, qty: 1 },
    ])
    expect(skipped).toEqual([])
    expect(cart.items).toHaveLength(2)
    expect(cart.items.find((i) => i.sku === SKU_A)?.qty).toBe(3)
  })

  it('applies qty = max(existing, incoming) clamped to 99', async () => {
    await putCartLine(db, userId, SKU_A, 10)
    const { cart } = await mergeCart(db, userId, [{ sku: SKU_A, qty: 5 }])
    expect(cart.items.find((i) => i.sku === SKU_A)?.qty).toBe(10)

    const { cart: cart2 } = await mergeCart(db, userId, [{ sku: SKU_A, qty: 50 }])
    expect(cart2.items.find((i) => i.sku === SKU_A)?.qty).toBe(50)
  })

  it('clamps the merged qty to 99 even if max(existing, incoming) would exceed it', async () => {
    await db.insert(cartItems).values({
      userId,
      sku: SKU_A,
      qty: 99,
      priceInrSnapshot: 249,
    })
    const { cart } = await mergeCart(db, userId, [{ sku: SKU_A, qty: 99 }])
    expect(cart.items.find((i) => i.sku === SKU_A)?.qty).toBe(99)
  })

  it('skips unknown skus and reports them', async () => {
    const { cart, skipped } = await mergeCart(db, userId, [
      { sku: SKU_A, qty: 1 },
      { sku: 'no-such-sku', qty: 1 },
    ])
    expect(skipped).toEqual(['no-such-sku'])
    expect(cart.items.map((i) => i.sku)).toEqual([SKU_A])
  })

  it('skips inactive skus and reports them', async () => {
    const { cart, skipped } = await mergeCart(db, userId, [
      { sku: SKU_A, qty: 1 },
      { sku: SKU_INACTIVE, qty: 1 },
    ])
    expect(skipped).toEqual([SKU_INACTIVE])
    expect(cart.items.map((i) => i.sku)).toEqual([SKU_A])
  })

  it('dedupes skipped skus and reports them in payload order', async () => {
    // Two different unknown skus (payload validation itself forbids literal duplicates,
    // but two DIFFERENT reasons can still land the same sku in skipped only once here
    // since a merge payload can't repeat a sku — this proves the dedupe logic doesn't
    // accidentally duplicate a single skip either).
    const { skipped } = await mergeCart(db, userId, [
      { sku: 'unknown-1', qty: 1 },
      { sku: SKU_A, qty: 1 },
      { sku: 'unknown-2', qty: 1 },
    ])
    expect(skipped).toEqual(['unknown-1', 'unknown-2'])
  })

  it('skips lines that would push the cart past the 50-line cap, keeping existing lines', async () => {
    const existingSkus: string[] = []
    for (let i = 0; i < 50; i++) {
      const sku = `bulk-sku-${i}`
      existingSkus.push(sku)
      await db.insert(catalogItems).values({
        sku,
        productId: 'bulk',
        name: 'Bulk Item',
        size: '1',
        priceInr: 10,
        lengthCm: 5,
        widthCm: 5,
        heightCm: 5,
        imageUrl: '',
        active: true,
      })
      await putCartLine(db, userId, sku, 1)
    }

    await db.insert(catalogItems).values({
      sku: 'new-merge-sku',
      productId: 'bulk',
      name: 'New Merge Item',
      size: '1',
      priceInr: 10,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '',
      active: true,
    })

    const { cart, skipped } = await mergeCart(db, userId, [{ sku: 'new-merge-sku', qty: 1 }])
    expect(skipped).toEqual(['new-merge-sku'])
    expect(cart.items).toHaveLength(50)
    // Existing lines are all still present.
    for (const sku of existingSkus) {
      expect(cart.items.some((i) => i.sku === sku)).toBe(true)
    }
  })

  it('is a single transaction: an unrelated later item does not roll back earlier valid ones', async () => {
    const { cart } = await mergeCart(db, userId, [
      { sku: SKU_A, qty: 2 },
      { sku: 'unknown-sku', qty: 1 },
      { sku: SKU_B, qty: 3 },
    ])
    expect(cart.items.map((i) => i.sku).sort()).toEqual([SKU_A, SKU_B].sort())
  })

  it('re-merging the same payload twice is a no-op (idempotent)', async () => {
    const payload = [
      { sku: SKU_A, qty: 4 },
      { sku: SKU_B, qty: 2 },
    ]
    const first = await mergeCart(db, userId, payload)
    const second = await mergeCart(db, userId, payload)

    expect(second.cart.items).toEqual(first.cart.items)
    expect(second.skipped).toEqual(first.skipped)
  })
})

// Wholesale is a CART-level rule: a cart whose retail subtotal reaches the
// threshold is billed at wholesale rates, and reverts the moment it drops back
// below. SKU_A is ₹249, SKU_B ₹199, SKU_INACTIVE ₹99 (inactive).
describe('wholesale pricing', () => {
  /** Threshold ₹1000, 10% off — small enough to cross with a couple of lines. */
  const RULE: WholesaleRule = { enabled: true, thresholdInr: 1000, discountPct: 10 }

  it('does not apply below the threshold, and reports what is still needed', async () => {
    await putCartLine(db, userId, SKU_A, 2, RULE) // 2 × 249 = 498

    const cart = await getCart(db, userId, RULE)
    expect(cart.wholesale).toMatchObject({
      applied: false,
      enabled: true,
      thresholdInr: 1000,
      retailTotalInr: 498,
      remainingInr: 502,
      savedInr: 0,
    })
    expect(cart.totalInr).toBe(498) // charged at retail
    expect(cart.items[0]?.priceInr).toBe(249)
  })

  it('applies at exactly the threshold', async () => {
    // Price a sku at the threshold precisely: 1 × 1000 = 1000.
    await db.update(catalogItems).set({ priceInr: 1000 }).where(eq(catalogItems.sku, SKU_A))
    await putCartLine(db, userId, SKU_A, 1, RULE)

    const cart = await getCart(db, userId, RULE)
    expect(cart.wholesale.applied).toBe(true)
    expect(cart.wholesale.retailTotalInr).toBe(1000)
    expect(cart.totalInr).toBe(900) // 10% off
    expect(cart.wholesale.savedInr).toBe(100)
    expect(cart.wholesale.remainingInr).toBe(0)
  })

  it('re-prices every active line and keeps totalInr === Σ(qty × priceInr)', async () => {
    await putCartLine(db, userId, SKU_A, 4, RULE) // 4 × 249 = 996
    await putCartLine(db, userId, SKU_B, 1, RULE) // 1 × 199 = 199 → retail 1195

    const cart = await getCart(db, userId, RULE)
    expect(cart.wholesale.applied).toBe(true)
    expect(cart.wholesale.retailTotalInr).toBe(1195)

    // Per-line rounding: 249 → 224 (224.1), 199 → 179 (179.1).
    const bySku = new Map(cart.items.map((i) => [i.sku, i]))
    expect(bySku.get(SKU_A)?.priceInr).toBe(224)
    expect(bySku.get(SKU_B)?.priceInr).toBe(179)

    // The client must be able to re-derive the total from the lines exactly.
    const summed = cart.items
      .filter((i) => i.active)
      .reduce((sum, i) => sum + i.qty * i.priceInr, 0)
    expect(cart.totalInr).toBe(summed)
    expect(cart.totalInr).toBe(4 * 224 + 179) // 1075
    expect(cart.wholesale.savedInr).toBe(1195 - 1075)
  })

  it('reverts to retail when the cart drops back below the threshold', async () => {
    await putCartLine(db, userId, SKU_A, 5, RULE) // 1245 → qualifies
    expect((await getCart(db, userId, RULE)).wholesale.applied).toBe(true)

    const after = await putCartLine(db, userId, SKU_A, 2, RULE) // 498 → no longer
    expect(after.wholesale.applied).toBe(false)
    expect(after.totalInr).toBe(498)
    expect(after.items[0]?.priceInr).toBe(249)
  })

  it('ignores inactive lines when qualifying and never re-prices them', async () => {
    await putCartLine(db, userId, SKU_A, 4, RULE) // 996 active
    // Add an inactive line directly (putCartLine rejects inactive skus).
    await db.insert(cartItems).values({ userId, sku: SKU_INACTIVE, qty: 10, priceInrSnapshot: 99 })

    // Active retail is 996 (< 1000); the inactive 10 × 99 must NOT push it over.
    const cart = await getCart(db, userId, RULE)
    expect(cart.wholesale.retailTotalInr).toBe(996)
    expect(cart.wholesale.applied).toBe(false)
    expect(cart.items.find((i) => i.sku === SKU_INACTIVE)?.priceInr).toBe(99)
  })

  it('leaves inactive lines at retail price even when the cart qualifies', async () => {
    await putCartLine(db, userId, SKU_A, 5, RULE) // 1245 → qualifies
    await db.insert(cartItems).values({ userId, sku: SKU_INACTIVE, qty: 1, priceInrSnapshot: 99 })

    const cart = await getCart(db, userId, RULE)
    expect(cart.wholesale.applied).toBe(true)
    // The unavailable line is not purchasable, so it is not discounted...
    expect(cart.items.find((i) => i.sku === SKU_INACTIVE)?.priceInr).toBe(99)
    // ...and contributes to neither the total nor the saving.
    expect(cart.totalInr).toBe(5 * 224)
  })

  it('charges retail when the rule is disabled, however large the cart', async () => {
    const off: WholesaleRule = { ...RULE, enabled: false }
    await putCartLine(db, userId, SKU_A, 20, off) // 4980

    const cart = await getCart(db, userId, off)
    expect(cart.wholesale).toMatchObject({ applied: false, enabled: false, remainingInr: 0 })
    expect(cart.totalInr).toBe(4980)
  })

  it('applies on merge too (a merged guest cart can cross the threshold)', async () => {
    const { cart } = await mergeCart(
      db,
      userId,
      [
        { sku: SKU_A, qty: 4 },
        { sku: SKU_B, qty: 1 },
      ],
      RULE
    )
    expect(cart.wholesale.applied).toBe(true)
    expect(cart.totalInr).toBe(4 * 224 + 179)
  })

  it('applies on delete too (removing a line can drop the cart below)', async () => {
    await putCartLine(db, userId, SKU_A, 4, RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, RULE) // → 1195 qualifies

    const after = await deleteCartLine(db, userId, SKU_B, RULE) // → 996
    expect(after.wholesale.applied).toBe(false)
    expect(after.totalInr).toBe(996)
  })
})

// Coupon is an ORDER-LEVEL discount stacked ON TOP of wholesale (stacking
// order per designDecisions.stackingRule: seasonal -> wholesale -> coupon).
// SKU_A ₹249, SKU_B ₹199, SKU_INACTIVE ₹99 (inactive).
describe('coupon pricing (stacking with wholesale)', () => {
  const WHOLESALE_RULE: WholesaleRule = { enabled: true, thresholdInr: 1000, discountPct: 10 }

  function couponLookup(overrides: Partial<CouponRule> = {}): CouponLookup {
    const rule: CouponRule = {
      code: 'DIRECT15',
      label: 'Early Bird offer',
      description: '',
      discountType: 'percent',
      discountValue: 15,
      minCartInr: 0,
      maxDiscountInr: null,
      active: true,
      validFrom: null,
      validTo: null,
      usageLimit: null,
      perUserLimit: null,
      waivesShipping: false,
      ...overrides,
    }
    return { code: rule.code, rule }
  }

  it('no coupon requested -> reason null, discountInr 0, totalInr unchanged from pre-coupon behavior', async () => {
    await putCartLine(db, userId, SKU_A, 4, WHOLESALE_RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, WHOLESALE_RULE) // → 1195 retail, qualifies

    const cart = await getCart(db, userId, WHOLESALE_RULE)
    expect(cart.wholesale.applied).toBe(true)
    expect(cart.coupon).toMatchObject({ applied: false, code: null, discountInr: 0, reason: null })
    expect(cart.coupon.subtotalInr).toBe(cart.totalInr)
    expect(cart.totalInr).toBe(4 * 224 + 179) // 1075, unchanged from pre-coupon behavior
  })

  it('applies the coupon on the POST-wholesale subtotal, not the retail one', async () => {
    await putCartLine(db, userId, SKU_A, 4, WHOLESALE_RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, WHOLESALE_RULE) // → 1195 retail, qualifies

    const cart = await getCart(db, userId, WHOLESALE_RULE, undefined, couponLookup())
    expect(cart.wholesale.applied).toBe(true)
    expect(cart.coupon.subtotalInr).toBe(1075) // post-wholesale — NOT 1195 retail
    expect(cart.coupon.discountInr).toBe(161) // round(1075 * 0.15) = 161.25 -> 161
    expect(cart.coupon.applied).toBe(true)
    expect(cart.coupon.reason).toBeNull()
    expect(cart.totalInr).toBe(1075 - 161) // 914 — new invariant: subtotalInr - discountInr

    // Line prices are UNCHANGED by the coupon — still the wholesale prices —
    // so the per-line invariant holds against coupon.subtotalInr.
    const bySku = new Map(cart.items.map((i) => [i.sku, i]))
    expect(bySku.get(SKU_A)?.priceInr).toBe(224)
    expect(bySku.get(SKU_B)?.priceInr).toBe(179)
    const summed = cart.items
      .filter((i) => i.active)
      .reduce((sum, i) => sum + i.qty * i.priceInr, 0)
    expect(summed).toBe(cart.coupon.subtotalInr)
  })

  it('a flat coupon min-cart check runs against the post-wholesale subtotal', async () => {
    await putCartLine(db, userId, SKU_A, 4, WHOLESALE_RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, WHOLESALE_RULE) // → 1195 retail, 1075 post-wholesale

    const flat = couponLookup({ discountType: 'flat', discountValue: 100, minCartInr: 1000 })
    const cart = await getCart(db, userId, WHOLESALE_RULE, undefined, flat)
    expect(cart.coupon.applied).toBe(true) // 1075 >= 1000
    expect(cart.coupon.discountInr).toBe(100)
    expect(cart.totalInr).toBe(975)
  })

  it('wholesale dropping the subtotal can push a coupon below its min-cart — flagged, not silently dropped', async () => {
    await putCartLine(db, userId, SKU_A, 4, WHOLESALE_RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, WHOLESALE_RULE) // → 1195 retail, 1075 post-wholesale

    const highMin = couponLookup({ discountType: 'flat', discountValue: 50, minCartInr: 1200 })
    const cart = await getCart(db, userId, WHOLESALE_RULE, undefined, highMin)
    expect(cart.coupon.applied).toBe(false)
    expect(cart.coupon.reason).toBe('below_min')
    expect(cart.coupon.discountInr).toBe(0)
    // Total reverts to the (post-wholesale) subtotal — no phantom discount.
    expect(cart.totalInr).toBe(1075)
  })

  it('below the wholesale threshold, the coupon still applies — against the plain retail subtotal', async () => {
    await putCartLine(db, userId, SKU_A, 2, WHOLESALE_RULE) // 498, below threshold

    const cart = await getCart(db, userId, WHOLESALE_RULE, undefined, couponLookup())
    expect(cart.wholesale.applied).toBe(false)
    expect(cart.coupon.subtotalInr).toBe(498)
    expect(cart.coupon.discountInr).toBe(75) // round(498 * 0.15) = 74.7 -> 75
    expect(cart.coupon.applied).toBe(true)
    expect(cart.totalInr).toBe(498 - 75)
  })

  it('a percent coupon is capped by maxDiscountInr even after wholesale re-pricing', async () => {
    await putCartLine(db, userId, SKU_A, 4, WHOLESALE_RULE) // 996
    await putCartLine(db, userId, SKU_B, 1, WHOLESALE_RULE) // → 1075 post-wholesale

    const capped = couponLookup({ discountType: 'percent', discountValue: 50, maxDiscountInr: 100 })
    const cart = await getCart(db, userId, WHOLESALE_RULE, undefined, capped)
    // 50% of 1075 = 537.5 -> 538, capped to 100.
    expect(cart.coupon.discountInr).toBe(100)
    expect(cart.totalInr).toBe(975)
  })

  it('an unresolved (unknown) code folds into the cart as reason invalid, with no discount', async () => {
    await putCartLine(db, userId, SKU_A, 1) // 249

    const unknown: CouponLookup = { code: 'GHOST', rule: null }
    const cart = await getCart(db, userId, WHOLESALE_OFF, undefined, unknown)
    expect(cart.coupon).toMatchObject({
      applied: false,
      code: 'GHOST',
      reason: 'invalid',
      discountInr: 0,
    })
    expect(cart.totalInr).toBe(249)
  })

  it('an inactive coupon folds into the cart as reason inactive, with no discount', async () => {
    await putCartLine(db, userId, SKU_A, 1) // 249

    const inactive = couponLookup({ active: false })
    const cart = await getCart(db, userId, WHOLESALE_OFF, undefined, inactive)
    expect(cart.coupon).toMatchObject({ applied: false, reason: 'inactive', discountInr: 0 })
    expect(cart.totalInr).toBe(249)
  })
})
