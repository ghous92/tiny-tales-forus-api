/**
 * Unit tests for the effective-price helper. Pure arithmetic (no DB), so these
 * are the fast guard on the one formula that must stay identical between the
 * public catalog (display) and the projection into catalog_items (charge).
 */

import { describe, expect, it } from 'vitest'

import {
  effectivePriceInr,
  qualifiesForWholesale,
  wholesalePriceInr,
  WHOLESALE_OFF,
  type WholesaleRule,
} from '../../src/lib/pricing.js'

describe('effectivePriceInr', () => {
  it('returns the price unchanged when the discount is 0', () => {
    expect(effectivePriceInr(499, 0)).toBe(499)
    expect(effectivePriceInr(1, 0)).toBe(1)
    expect(effectivePriceInr(0, 0)).toBe(0)
  })

  it('applies a whole-percent discount, rounded to whole rupees', () => {
    expect(effectivePriceInr(500, 20)).toBe(400) // 500 * 0.80
    expect(effectivePriceInr(449, 25)).toBe(337) // 449 * 0.75 = 336.75 → 337
    expect(effectivePriceInr(999, 10)).toBe(899) // 999 * 0.90 = 899.1 → 899
  })

  it('handles the max 90% discount', () => {
    expect(effectivePriceInr(1000, 90)).toBe(100)
  })

  it('clamps an out-of-range percent into 0..90', () => {
    expect(effectivePriceInr(500, -5)).toBe(500) // < 0 → 0 → unchanged
    expect(effectivePriceInr(1000, 150)).toBe(100) // > 90 → 90
  })

  it('truncates a fractional percent before applying (DB stores integers)', () => {
    // 20.9% is coerced to 20% — the schema only ever stores integer pct, but
    // the helper must not trust its input.
    expect(effectivePriceInr(500, 20.9)).toBe(400)
  })

  it('never returns a negative price', () => {
    expect(effectivePriceInr(0, 90)).toBe(0)
  })

  it('treats a non-finite percent as no discount', () => {
    expect(effectivePriceInr(500, Number.NaN)).toBe(500)
  })
})

const RULE: WholesaleRule = { enabled: true, thresholdInr: 5000, discountPct: 10 }

describe('qualifiesForWholesale', () => {
  it('qualifies at exactly the threshold', () => {
    // "Spend ₹5000 to unlock" must fire AT ₹5000, not a rupee later.
    expect(qualifiesForWholesale(5000, RULE)).toBe(true)
  })

  it('qualifies above the threshold and not below', () => {
    expect(qualifiesForWholesale(5001, RULE)).toBe(true)
    expect(qualifiesForWholesale(4999, RULE)).toBe(false)
    expect(qualifiesForWholesale(0, RULE)).toBe(false)
  })

  it('never qualifies when the rule is disabled, however large the cart', () => {
    expect(qualifiesForWholesale(1_000_000, { ...RULE, enabled: false })).toBe(false)
    expect(qualifiesForWholesale(1_000_000, WHOLESALE_OFF)).toBe(false)
  })

  it('never qualifies when the discount is zero or negative (nothing to apply)', () => {
    expect(qualifiesForWholesale(9999, { ...RULE, discountPct: 0 })).toBe(false)
    expect(qualifiesForWholesale(9999, { ...RULE, discountPct: -5 })).toBe(false)
  })

  it('rejects a malformed threshold rather than qualifying everything', () => {
    expect(qualifiesForWholesale(9999, { ...RULE, thresholdInr: Number.NaN })).toBe(false)
    expect(qualifiesForWholesale(9999, { ...RULE, thresholdInr: -1 })).toBe(false)
  })

  it('a zero threshold qualifies any cart (an intentional "wholesale for all")', () => {
    expect(qualifiesForWholesale(0, { ...RULE, thresholdInr: 0 })).toBe(true)
  })
})

describe('wholesalePriceInr', () => {
  it('applies the rule percent to a line price', () => {
    expect(wholesalePriceInr(500, RULE)).toBe(450)
  })

  it('stacks on top of the seasonal discount (multiplicative, not additive)', () => {
    // ₹1000 list, 20% seasonal → ₹800, then 10% wholesale → ₹720.
    // NOT a flat 30% off (which would be ₹700).
    const seasonal = effectivePriceInr(1000, 20)
    expect(seasonal).toBe(800)
    expect(wholesalePriceInr(seasonal, RULE)).toBe(720)
  })

  it('rounds per line to whole rupees', () => {
    expect(wholesalePriceInr(337, RULE)).toBe(303) // 337 * 0.9 = 303.3 → 303
  })
})
