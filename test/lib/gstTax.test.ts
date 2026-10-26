/**
 * Unit tests for the GST decomposition. Pure arithmetic (no DB) — the fast
 * guard on the invariant that makes a tax invoice lawful:
 * Σ(taxableValuePaise + taxPaise) === totalInr × 100.
 */

import { describe, expect, it } from 'vitest'

import { apportionByWeight, decomposeCartGst, type GstLineInput } from '../../src/lib/gstTax.js'

function sumTaxableAndTax(lines: ReturnType<typeof decomposeCartGst>['lines']): number {
  return lines.reduce((sum, l) => sum + l.taxableValuePaise + l.taxPaise, 0)
}

describe('apportionByWeight', () => {
  it('splits proportionally and sums exactly to the input amount', () => {
    const shares = apportionByWeight(10_000, [30, 20, 50])
    expect(shares).toEqual([3000, 2000, 5000])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000)
  })

  it('distributes the remainder by largest fractional share first', () => {
    // 100 split 3 ways by equal weight: 33.33 each — one gets the extra paisa.
    const shares = apportionByWeight(100, [1, 1, 1])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100)
    expect(shares.sort((a, b) => b - a)).toEqual([34, 33, 33])
  })

  it('returns all zeros for a zero amount', () => {
    expect(apportionByWeight(0, [10, 20, 30])).toEqual([0, 0, 0])
  })

  it('returns all zeros when every weight is zero (no division by zero)', () => {
    expect(apportionByWeight(500, [0, 0])).toEqual([0, 0])
  })
})

describe('decomposeCartGst', () => {
  const singleLine: GstLineInput[] = [{ sku: 'SKU-A', qty: 1, priceInr: 500, gstRatePct: 18 }]

  it('single line, no coupon/shipping, inter-state (IGST)', () => {
    const result = decomposeCartGst({
      lines: singleLine,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 500,
      interState: true,
    })
    const line = result.lines[0]!
    expect(line.taxableValuePaise).toBe(42_373) // 500/1.18 ≈ 423.73
    expect(line.igstPaise).toBe(7627)
    expect(line.cgstPaise).toBe(0)
    expect(line.sgstPaise).toBe(0)
    expect(sumTaxableAndTax(result.lines)).toBe(50_000)
  })

  it('single line, intra-state splits tax evenly into CGST+SGST', () => {
    const result = decomposeCartGst({
      lines: singleLine,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 500,
      interState: false,
    })
    const line = result.lines[0]!
    expect(line.igstPaise).toBe(0)
    expect(line.cgstPaise + line.sgstPaise).toBe(line.taxPaise)
    expect(Math.abs(line.cgstPaise - line.sgstPaise)).toBeLessThanOrEqual(1)
  })

  it('zero-rated line: taxable equals the full inclusive amount, no tax', () => {
    const result = decomposeCartGst({
      lines: [{ sku: 'SKU-Z', qty: 1, priceInr: 200, gstRatePct: 0 }],
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 200,
      interState: true,
    })
    const line = result.lines[0]!
    expect(line.taxableValuePaise).toBe(20_000)
    expect(line.taxPaise).toBe(0)
    expect(line.igstPaise).toBe(0)
  })

  it('coupon-only: discount reduces the taxable value before tax', () => {
    const result = decomposeCartGst({
      lines: singleLine,
      couponDiscountInr: 100,
      shippingFeeInr: 0,
      totalInr: 400,
      interState: true,
    })
    const line = result.lines[0]!
    expect(line.couponSharePaise).toBe(10_000)
    expect(line.lineInclusivePaise).toBe(40_000)
    expect(sumTaxableAndTax(result.lines)).toBe(40_000)
  })

  it('shipping-only: delivery fee is taxed at the goods rate, not separately', () => {
    const result = decomposeCartGst({
      lines: singleLine,
      couponDiscountInr: 0,
      shippingFeeInr: 50,
      totalInr: 550,
      interState: true,
    })
    const line = result.lines[0]!
    expect(line.shippingSharePaise).toBe(5000)
    expect(line.lineInclusivePaise).toBe(55_000)
    expect(sumTaxableAndTax(result.lines)).toBe(55_000)
  })

  it('coupon + shipping together', () => {
    const result = decomposeCartGst({
      lines: singleLine,
      couponDiscountInr: 50,
      shippingFeeInr: 40,
      totalInr: 490,
      interState: true,
    })
    expect(sumTaxableAndTax(result.lines)).toBe(49_000)
  })

  it('mixed-rate cart apportions coupon/shipping pro-rata by line value, each line taxed at its own rate', () => {
    const lines: GstLineInput[] = [
      { sku: 'SKU-18', qty: 1, priceInr: 800, gstRatePct: 18 },
      { sku: 'SKU-5', qty: 1, priceInr: 200, gstRatePct: 5 },
    ]
    const result = decomposeCartGst({
      lines,
      couponDiscountInr: 100,
      shippingFeeInr: 0,
      totalInr: 900,
      interState: true,
    })
    expect(result.lines[0]!.gstRatePct).toBe(18)
    expect(result.lines[1]!.gstRatePct).toBe(5)
    // Coupon apportioned 800:200 = 80:20 of ₹100.
    expect(result.lines[0]!.couponSharePaise).toBe(8000)
    expect(result.lines[1]!.couponSharePaise).toBe(2000)
    expect(sumTaxableAndTax(result.lines)).toBe(90_000)
    expect(result.rateWise).toHaveLength(2)
  })

  it('an awkward ₹1,000 / 3-line / 18% cart still reconciles exactly (remainder distribution)', () => {
    const lines: GstLineInput[] = [
      { sku: 'SKU-1', qty: 1, priceInr: 333, gstRatePct: 18 },
      { sku: 'SKU-2', qty: 1, priceInr: 333, gstRatePct: 18 },
      { sku: 'SKU-3', qty: 1, priceInr: 334, gstRatePct: 18 },
    ]
    const result = decomposeCartGst({
      lines,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 1000,
      interState: true,
    })
    expect(sumTaxableAndTax(result.lines)).toBe(100_000)
    expect(result.totals.taxableValuePaise + result.totals.totalTaxPaise).toBe(100_000)
  })

  it('rate-wise summary groups and sums by gstRatePct', () => {
    const lines: GstLineInput[] = [
      { sku: 'SKU-A', qty: 2, priceInr: 100, gstRatePct: 18 },
      { sku: 'SKU-B', qty: 1, priceInr: 100, gstRatePct: 18 },
      { sku: 'SKU-C', qty: 1, priceInr: 100, gstRatePct: 5 },
    ]
    const result = decomposeCartGst({
      lines,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 400,
      interState: true,
    })
    expect(result.rateWise.map((r) => r.gstRatePct)).toEqual([5, 18])
    const row18 = result.rateWise.find((r) => r.gstRatePct === 18)!
    expect(row18.igstPaise).toBe(result.lines[0]!.igstPaise + result.lines[1]!.igstPaise)
  })

  it('throws when totalInr is inconsistent with the lines (invariant guard)', () => {
    expect(() =>
      decomposeCartGst({
        lines: singleLine,
        couponDiscountInr: 0,
        shippingFeeInr: 0,
        totalInr: 999, // wrong on purpose
        interState: true,
      })
    ).toThrow(/invariant violated/)
  })
})
