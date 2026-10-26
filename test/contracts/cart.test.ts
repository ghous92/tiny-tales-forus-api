/**
 * Contract unit tests: cart qty bounds and the merge payload's duplicate-sku
 * rejection (SPEC-V2.md §7 bullet 4).
 */

import { describe, expect, it } from 'vitest'

import {
  CartMergeBodySchema,
  CartPutBodySchema,
  CartSkuParamsSchema,
  MAX_LINES,
  MAX_MERGE_ITEMS,
  MAX_QTY_PER_LINE,
} from '../../src/contracts/cart.js'

describe('CartPutBodySchema (qty bounds)', () => {
  it.each([1, 2, 50, MAX_QTY_PER_LINE])('accepts qty %d', (qty) =>
    expect(CartPutBodySchema.safeParse({ qty }).success).toBe(true)
  )

  it.each([0, -1, MAX_QTY_PER_LINE + 1, 100, 1.5])('rejects qty %d', (qty) =>
    expect(CartPutBodySchema.safeParse({ qty }).success).toBe(false)
  )

  it('rejects a missing qty', () => {
    expect(CartPutBodySchema.safeParse({}).success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(CartPutBodySchema.safeParse({ qty: 1, extra: true }).success).toBe(false)
  })
})

describe('CartSkuParamsSchema', () => {
  it('accepts a normal sku', () => {
    expect(CartSkuParamsSchema.safeParse({ sku: 'AH-82U3-T29Q' }).success).toBe(true)
  })

  it('rejects an empty sku', () => {
    expect(CartSkuParamsSchema.safeParse({ sku: '' }).success).toBe(false)
  })

  it('rejects a sku over 100 characters', () => {
    expect(CartSkuParamsSchema.safeParse({ sku: 'a'.repeat(101) }).success).toBe(false)
  })
})

describe('CartMergeBodySchema', () => {
  it('accepts a valid payload', () => {
    const parsed = CartMergeBodySchema.parse({
      items: [
        { sku: 'AH-82U3-T29Q', qty: 2 },
        { sku: '04-JPDR-6Z6N', qty: 1 },
      ],
    })
    expect(parsed.items).toHaveLength(2)
  })

  it('accepts an empty items array', () => {
    expect(CartMergeBodySchema.safeParse({ items: [] }).success).toBe(true)
  })

  it('rejects duplicate skus within the same payload', () => {
    const result = CartMergeBodySchema.safeParse({
      items: [
        { sku: 'AH-82U3-T29Q', qty: 2 },
        { sku: 'AH-82U3-T29Q', qty: 5 },
      ],
    })
    expect(result.success).toBe(false)
  })

  it(`rejects more than ${MAX_MERGE_ITEMS} items`, () => {
    const items = Array.from({ length: MAX_MERGE_ITEMS + 1 }, (_, i) => ({
      sku: `sku-${i}`,
      qty: 1,
    }))
    expect(CartMergeBodySchema.safeParse({ items }).success).toBe(false)
  })

  it(`accepts exactly ${MAX_MERGE_ITEMS} items`, () => {
    const items = Array.from({ length: MAX_MERGE_ITEMS }, (_, i) => ({ sku: `sku-${i}`, qty: 1 }))
    expect(CartMergeBodySchema.safeParse({ items }).success).toBe(true)
  })

  it('rejects an out-of-bounds qty within a merge item', () => {
    const result = CartMergeBodySchema.safeParse({ items: [{ sku: 'x', qty: 0 }] })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields on the merge item (strict)', () => {
    const result = CartMergeBodySchema.safeParse({ items: [{ sku: 'x', qty: 1, extra: true }] })
    expect(result.success).toBe(false)
  })
})

describe('cart limits', () => {
  it('MAX_LINES is 50', () => {
    expect(MAX_LINES).toBe(50)
  })

  it('MAX_QTY_PER_LINE is 99', () => {
    expect(MAX_QTY_PER_LINE).toBe(99)
  })
})
