/**
 * Unit tests for the coupon pricing helpers. Pure arithmetic (no DB) — the
 * fast guard on the formula that must stay identical between
 * `services/coupons.ts` (validate/getCouponRuleByCode) and
 * `services/cart.ts`'s coupon folding.
 */

import { describe, expect, it } from 'vitest'

import {
  COUPON_NONE,
  isCouponValidNow,
  resolveCouponDiscount,
  type CouponLookup,
  type CouponRule,
} from '../../src/lib/coupons.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')

function rule(overrides: Partial<CouponRule> = {}): CouponRule {
  return {
    code: 'DIRECT15',
    label: 'Early Bird offer',
    description: '15% off',
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
}

function lookup(r: CouponRule | null, code = r?.code ?? null): CouponLookup {
  return { code, rule: r }
}

describe('isCouponValidNow', () => {
  it('is valid when active with no window', () => {
    expect(isCouponValidNow(true, null, null, NOW)).toBe(true)
  })

  it('is invalid when inactive, regardless of window', () => {
    expect(isCouponValidNow(false, null, null, NOW)).toBe(false)
  })

  it('is invalid before validFrom (not yet started)', () => {
    const validFrom = new Date('2026-08-01T00:00:00.000Z')
    expect(isCouponValidNow(true, validFrom, null, NOW)).toBe(false)
  })

  it('is valid exactly at validFrom', () => {
    expect(isCouponValidNow(true, NOW, null, NOW)).toBe(true)
  })

  it('is invalid after validTo (expired)', () => {
    const validTo = new Date('2026-01-01T00:00:00.000Z')
    expect(isCouponValidNow(true, null, validTo, NOW)).toBe(false)
  })

  it('is valid exactly at validTo', () => {
    expect(isCouponValidNow(true, null, NOW, NOW)).toBe(true)
  })

  it('is valid strictly inside a window', () => {
    const validFrom = new Date('2026-01-01T00:00:00.000Z')
    const validTo = new Date('2026-12-31T00:00:00.000Z')
    expect(isCouponValidNow(true, validFrom, validTo, NOW)).toBe(true)
  })
})

describe('resolveCouponDiscount', () => {
  it('no coupon requested -> not applied, reason null, code null', () => {
    const result = resolveCouponDiscount(1000, COUPON_NONE, NOW)
    expect(result).toEqual({
      applied: false,
      code: null,
      label: '',
      discountType: null,
      discountValue: 0,
      minCartInr: 0,
      maxDiscountInr: null,
      discountInr: 0,
      reason: null,
      waivesShipping: false,
    })
  })

  it('unknown code -> not applied, reason invalid, echoes the requested code', () => {
    const result = resolveCouponDiscount(1000, lookup(null, 'GHOST'), NOW)
    expect(result.applied).toBe(false)
    expect(result.code).toBe('GHOST')
    expect(result.discountInr).toBe(0)
    expect(result.reason).toBe('invalid')
  })

  it('inactive coupon -> not applied, reason inactive', () => {
    const result = resolveCouponDiscount(1000, lookup(rule({ active: false })), NOW)
    expect(result.applied).toBe(false)
    expect(result.discountInr).toBe(0)
    expect(result.reason).toBe('inactive')
  })

  it('not-yet-valid coupon (before validFrom) -> not applied, reason expired', () => {
    const r = rule({ validFrom: new Date('2026-08-01T00:00:00.000Z') })
    const result = resolveCouponDiscount(1000, lookup(r), NOW)
    expect(result.applied).toBe(false)
    expect(result.discountInr).toBe(0)
    expect(result.reason).toBe('expired')
  })

  it('past-window coupon (after validTo) -> not applied, reason expired', () => {
    const r = rule({ validTo: new Date('2026-01-01T00:00:00.000Z') })
    const result = resolveCouponDiscount(1000, lookup(r), NOW)
    expect(result.applied).toBe(false)
    expect(result.discountInr).toBe(0)
    expect(result.reason).toBe('expired')
  })

  it('min cart not met -> not applied, reason below_min', () => {
    const r = rule({ minCartInr: 1000 })
    const result = resolveCouponDiscount(999, lookup(r), NOW)
    expect(result.applied).toBe(false)
    expect(result.discountInr).toBe(0)
    expect(result.reason).toBe('below_min')
  })

  it('min cart met exactly -> applied', () => {
    const r = rule({ minCartInr: 1000, discountType: 'flat', discountValue: 100 })
    const result = resolveCouponDiscount(1000, lookup(r), NOW)
    expect(result.applied).toBe(true)
    expect(result.discountInr).toBe(100)
    expect(result.reason).toBeNull()
  })

  it('percent coupon rounds to whole rupees', () => {
    const r = rule({ discountType: 'percent', discountValue: 15 })
    // 999 * 0.15 = 149.85 -> 150
    const result = resolveCouponDiscount(999, lookup(r), NOW)
    expect(result.discountInr).toBe(150)
    expect(result.applied).toBe(true)
  })

  it('percent coupon is capped by maxDiscountInr', () => {
    const r = rule({ discountType: 'percent', discountValue: 50, maxDiscountInr: 100 })
    // 50% of 1000 = 500, capped to 100
    const result = resolveCouponDiscount(1000, lookup(r), NOW)
    expect(result.discountInr).toBe(100)
  })

  it('a 90% coupon on a small cart clamps to the subtotal, never goes negative', () => {
    const r = rule({ discountType: 'percent', discountValue: 90, minCartInr: 0 })
    const result = resolveCouponDiscount(50, lookup(r), NOW)
    expect(result.discountInr).toBe(45)
    expect(50 - result.discountInr).toBe(5)
  })

  it('flat coupon never discounts more than the subtotal', () => {
    const r = rule({ discountType: 'flat', discountValue: 500 })
    const result = resolveCouponDiscount(300, lookup(r), NOW)
    expect(result.discountInr).toBe(300)
  })

  it('an eligible coupon on a zero subtotal computes to zero and is NOT applied', () => {
    const r = rule({ discountType: 'percent', discountValue: 15, minCartInr: 0 })
    const result = resolveCouponDiscount(0, lookup(r), NOW)
    expect(result.discountInr).toBe(0)
    expect(result.applied).toBe(false)
    expect(result.reason).toBeNull()
  })

  // `waivesShipping` rides with the DISCOUNT, never with mere eligibility.
  it('carries waivesShipping through when the coupon applies', () => {
    const result = resolveCouponDiscount(
      119,
      {
        code: 'REFILL10',
        rule: rule({ code: 'REFILL10', discountValue: 10, waivesShipping: true }),
      },
      NOW
    )
    expect(result.applied).toBe(true)
    expect(result.waivesShipping).toBe(true)
  })

  it('does NOT waive shipping when the coupon is below its minimum', () => {
    // Otherwise a shopper is told "add Rs X more to use this code" while
    // already banking the free delivery it was supposed to unlock.
    const result = resolveCouponDiscount(
      50,
      { code: 'REFILL10', rule: rule({ code: 'REFILL10', minCartInr: 99, waivesShipping: true }) },
      NOW
    )
    expect(result.reason).toBe('below_min')
    expect(result.waivesShipping).toBe(false)
  })

  it('does NOT waive shipping when the coupon is inactive or expired', () => {
    const inactive = resolveCouponDiscount(
      500,
      { code: 'REFILL10', rule: rule({ active: false, waivesShipping: true }) },
      NOW
    )
    expect(inactive.waivesShipping).toBe(false)
    const expired = resolveCouponDiscount(
      500,
      {
        code: 'REFILL10',
        rule: rule({ validTo: new Date('2026-01-01T00:00:00.000Z'), waivesShipping: true }),
      },
      NOW
    )
    expect(expired.reason).toBe('expired')
    expect(expired.waivesShipping).toBe(false)
  })

  it('does NOT waive shipping when an eligible coupon computes to a zero discount', () => {
    const result = resolveCouponDiscount(
      0,
      { code: 'REFILL10', rule: rule({ waivesShipping: true }) },
      NOW
    )
    expect(result.applied).toBe(false)
    expect(result.waivesShipping).toBe(false)
  })

  it('discount fields echo the resolved rule even when not applied (below_min)', () => {
    const r = rule({ label: 'Early Bird offer', minCartInr: 5000 })
    const result = resolveCouponDiscount(100, lookup(r), NOW)
    expect(result.label).toBe('Early Bird offer')
    expect(result.discountType).toBe('percent')
    expect(result.discountValue).toBe(15)
    expect(result.minCartInr).toBe(5000)
  })
})
