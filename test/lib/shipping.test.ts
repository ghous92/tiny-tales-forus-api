/**
 * Unit tests for the shipping math. Pure arithmetic (no DB), so this is the
 * fast guard on the numbers that decide what a shopper is charged and what the
 * courier bills us.
 *
 * Two themes get disproportionate coverage on purpose:
 *
 * 1. **Nothing missing is ever free.** Unknown pincode, out-of-fence state, no
 *    coverage, no slab row, no tier, unweighed sku — each has a test asserting
 *    a `null`/reason, because a ₹0 fee is the expensive failure in this domain.
 * 2. **Unit slips.** Grams vs kilograms, rupees vs percent vs basis points.
 *    The volumetric formula in particular is tested at sub-kilo cartons, where
 *    a divide-then-scale implementation silently returns 0.
 */

import { describe, expect, it } from 'vitest'

import {
  baseFreightInr,
  estimatedBaseFreightInr,
  cartVolumetricG,
  chargeableG,
  customerFeeInr,
  discountedFeeInr,
  shopperFeeInr,
  deadWeightG,
  freeTierFor,
  estimatedPincodeInfo,
  haversineKm,
  qualifiesForFreeShipping,
  resolveFee,
  freightCost,
  resolveLineWeights,
  selectShipment,
  serviceable,
  SHIPPING_OFF,
  trueCostInr,
  volumetricG,
  zoneFor,
  type PincodeInfo,
  type RateSlab,
  type ShippingCourier,
  type ShippingLine,
  type ShippingNode,
  type ShippingRule,
} from '../../src/lib/shipping.js'

// --- Fixtures ----------------------------------------------------------------

const line = (over: Partial<ShippingLine> = {}): ShippingLine => ({
  sku: 'DAN-CREAM-100',
  qty: 1,
  weightG: 220,
  lengthCm: 6,
  widthCm: 6,
  heightCm: 12,
  ...over,
})

const pin = (over: Partial<PincodeInfo> & { pincode: string }): PincodeInfo => ({
  taluk: '',
  district: '',
  state: 'Gujarat',
  lat: null,
  lng: null,
  ...over,
})

/** Ahmedabad (origin + same taluk), Surat (same state), Kochi (out of fence). */
const INDEX = new Map<string, PincodeInfo>([
  [
    '380001',
    pin({
      pincode: '380001',
      taluk: 'Ahmadabad City',
      district: 'Ahmadabad',
      lat: 23.02,
      lng: 72.57,
    }),
  ],
  [
    '380015',
    pin({
      pincode: '380015',
      taluk: 'Ahmadabad City',
      district: 'Ahmadabad',
      lat: 23.0,
      lng: 72.53,
    }),
  ],
  [
    '395003',
    pin({ pincode: '395003', taluk: 'Surat City', district: 'Surat', lat: 21.19, lng: 72.83 }),
  ],
  ['682001', pin({ pincode: '682001', taluk: 'Kochi', district: 'Ernakulam', state: 'Kerala' })],
  ['781001', pin({ pincode: '781001', taluk: 'Guwahati', district: 'Kamrup', state: 'Assam' })],
])

const SLABS: RateSlab[] = [
  { zone: 'A', uptoG: 500, rateInr: 30, addlPerG: 500, addlRateInr: 0 },
  { zone: 'A', uptoG: 1000, rateInr: 58, addlPerG: 500, addlRateInr: 0 },
  { zone: 'A', uptoG: 2000, rateInr: 102, addlPerG: 1000, addlRateInr: 38 },
  { zone: 'B', uptoG: 500, rateInr: 37, addlPerG: 500, addlRateInr: 0 },
  { zone: 'B', uptoG: 1000, rateInr: 75, addlPerG: 1000, addlRateInr: 48 },
]

const RULE: ShippingRule = {
  enabled: true,
  freeAboveTiers: [
    { uptoG: 2000, freeAboveInr: 249 },
    { uptoG: 5000, freeAboveInr: 999 },
  ],
  thresholdBasis: 'preCoupon',
  marginBps: 1000,
  feeDiscountBps: 0,
  tareG: 60,
  volumetricPackFactor: 1,
  serviceableStates: ['Gujarat'],
  unknownWeightBehavior: 'block',
  assumedWeightG: 300,
  unserviceableBehavior: 'block',
  fallbackFeeInr: 99,
  rankBy: 'cost',
}

const courier = (over: Partial<ShippingCourier> = {}): ShippingCourier => ({
  code: 'delhivery',
  name: 'Delhivery Surface',
  rateModel: 'weight',
  volumetricDivisor: 5000,
  minChargeableG: 500,
  fuelBps: 1100,
  gstBps: 1800,
  docketFeeInr: 5,
  riskBps: 0,
  riskMinInr: 0,
  codFlatInr: 0,
  codBps: 0,
  slaDaysZoneA: 2,
  slaDaysZoneB: 4,
  reliabilityScore: 70,
  priority: 0,
  slabs: SLABS,
  serviceAreas: [{ fromPincode: '360001', toPincode: '396999', isActive: true }],
  serviceExceptions: [],
  ...over,
})

const NODE: ShippingNode = {
  id: 'node-ahm',
  code: 'AHM-01',
  pincode: '380001',
  lat: 23.02,
  lng: 72.57,
  priority: 0,
  skus: [],
  cutoffIst: '15:00',
}

// --- Weight ------------------------------------------------------------------

describe('deadWeightG', () => {
  it('sums qty × weight and adds the tare exactly once', () => {
    // 2 × 220 + 300 + 60 tare
    expect(
      deadWeightG([line({ weightG: 220, qty: 2 }), line({ sku: 'x', weightG: 300 })], 60)
    ).toBe(800)
  })

  it('adds the tare even to a single-line cart', () => {
    expect(deadWeightG([line({ weightG: 220 })], 60)).toBe(280)
  })
})

describe('volumetricG', () => {
  it('converts cm³ to grams without rounding through whole kilograms', () => {
    // 20×15×10 = 3000 cm³ → 3000×1000/5000 = 600 g. A divide-then-scale
    // implementation returns 1000 g here.
    expect(volumetricG(20, 15, 10, 5000)).toBe(600)
  })

  it('does not collapse a sub-kilo carton to zero', () => {
    // 15×10×8 = 1200 cm³ → 240 g. Divide-then-scale returns 0 g — the whole
    // volumetric guard rail silently disappears for every small parcel.
    expect(volumetricG(15, 10, 8, 5000)).toBe(240)
  })

  it('scales with the divisor', () => {
    expect(volumetricG(20, 15, 10, 4000)).toBe(750)
  })

  it('treats any unmeasured dimension as no volume at all', () => {
    expect(volumetricG(0, 15, 10, 5000)).toBe(0)
    expect(volumetricG(20, 15, 0, 5000)).toBe(0)
  })
})

describe('chargeableG', () => {
  it('bills the carrier minimum for a light parcel', () => {
    expect(chargeableG(280, 100, 500)).toBe(500)
  })

  it('bills volumetric weight when the parcel is bulky', () => {
    expect(chargeableG(280, 900, 500)).toBe(900)
  })

  it('bills dead weight when it dominates', () => {
    expect(chargeableG(1800, 900, 500)).toBe(1800)
  })
})

describe('cartVolumetricG', () => {
  it('uses the largest single carton, scaled by the pack factor', () => {
    const lines = [
      line({ lengthCm: 6, widthCm: 6, heightCm: 12 }),
      line({ sku: 'b', lengthCm: 20, widthCm: 15, heightCm: 10 }),
    ]
    expect(cartVolumetricG(lines, 5000, 1)).toBe(600)
    expect(cartVolumetricG(lines, 5000, 1.2)).toBe(720)
  })

  it('differs between two couriers with different divisors', () => {
    const lines = [line({ lengthCm: 20, widthCm: 15, heightCm: 10 })]
    expect(cartVolumetricG(lines, 5000, 1)).toBe(600)
    expect(cartVolumetricG(lines, 4000, 1)).toBe(750)
  })
})

describe('resolveLineWeights', () => {
  it('passes fully-weighed carts straight through', () => {
    const lines = [line()]
    expect(resolveLineWeights(lines, RULE)).toBe(lines)
  })

  it('returns null when a sku has no measured weight and the rule blocks', () => {
    expect(resolveLineWeights([line(), line({ sku: 'unweighed', weightG: 0 })], RULE)).toBeNull()
  })

  it('substitutes the assumed weight only for the unweighed lines', () => {
    const resolved = resolveLineWeights([line(), line({ sku: 'unweighed', weightG: 0 })], {
      unknownWeightBehavior: 'assume',
      assumedWeightG: 300,
    })
    expect(resolved?.map((l) => l.weightG)).toEqual([220, 300])
  })

  it('still blocks under "assume" when no assumed weight is configured', () => {
    expect(
      resolveLineWeights([line({ weightG: 0 })], {
        unknownWeightBehavior: 'assume',
        assumedWeightG: 0,
      })
    ).toBeNull()
  })
})

// --- Zone --------------------------------------------------------------------

describe('zoneFor', () => {
  it('is Zone A within the same pincode', () => {
    expect(zoneFor('380001', '380001', INDEX, ['Gujarat'])).toBe('A')
  })

  it('is Zone A within the same taluk', () => {
    expect(zoneFor('380001', '380015', INDEX, ['Gujarat'])).toBe('A')
  })

  it('is Zone B elsewhere in the same state', () => {
    expect(zoneFor('380001', '395003', INDEX, ['Gujarat'])).toBe('B')
  })

  it('prices other states regardless of the legacy state allowlist', () => {
    expect(zoneFor('380001', '682001', INDEX, ['Gujarat'])).toBe('D')
  })

  it('uses a coarse distance zone for a pincode absent from reference data', () => {
    expect(zoneFor('380001', '110001', INDEX, ['Gujarat'])).toBe('D')
  })

  it('rejects a malformed pincode even when estimating', () => {
    expect(zoneFor('380001', '011111', INDEX, ['Gujarat'])).toBeNull()
  })

  it('accepts nationwide coverage with an empty legacy allowlist', () => {
    expect(zoneFor('380001', '380015', INDEX, [])).toBe('A')
  })

  it('does not collapse two blank taluks into Zone A', () => {
    const index = new Map<string, PincodeInfo>([
      ['380001', pin({ pincode: '380001', taluk: '' })],
      ['361001', pin({ pincode: '361001', taluk: '' })],
    ])
    expect(zoneFor('380001', '361001', index, ['Gujarat'])).toBe('B')
  })

  it('matches the fence case-insensitively', () => {
    expect(zoneFor('380001', '380015', INDEX, ['gujarat'])).toBe('A')
  })

  it('is Zone E for a remote-state destination, not the flat cross-state D rate', () => {
    expect(zoneFor('380001', '781001', INDEX, ['Gujarat', 'Assam'])).toBe('E')
  })

  it('accepts remote-state destinations without adding them to an allowlist', () => {
    expect(zoneFor('380001', '781001', INDEX, ['Gujarat'])).toBe('E')
  })
})

describe('estimatedPincodeInfo', () => {
  const kmFromAhmedabad = (pincode: string) => {
    const info = estimatedPincodeInfo(pincode)
    if (info?.lat == null || info.lng == null) throw new Error(`no centroid for ${pincode}`)
    return haversineKm(23.0121, 72.5136, info.lat, info.lng)
  }

  it('separates Rajasthan from Gujarat inside postal region 3', () => {
    // Jaipur is ~550 km away; the region-wide centroid put it at ~67 km.
    expect(kmFromAhmedabad('302001')).toBeGreaterThan(450)
    expect(kmFromAhmedabad('380051')).toBeLessThan(50)
  })

  it('separates Lucknow from Dehradun inside postal region 2', () => {
    const lucknow = kmFromAhmedabad('226001')
    const dehradun = kmFromAhmedabad('248001')
    expect(Math.abs(lucknow - dehradun)).toBeGreaterThan(50)
  })

  it('places Andaman pincodes on the islands, not in Bengal', () => {
    expect(kmFromAhmedabad('744101')).toBeGreaterThan(2300)
  })

  it('falls back to the region centroid for an unmapped sub-region', () => {
    expect(estimatedPincodeInfo('990001')).toMatchObject({ estimated: true, lat: 23.0, lng: 77.0 })
  })

  it('rejects malformed pincodes', () => {
    expect(estimatedPincodeInfo('012345')).toBeNull()
  })
})

describe('haversineKm', () => {
  it('measures Ahmedabad → Surat at roughly 230 km', () => {
    const km = haversineKm(23.02, 72.57, 21.19, 72.83)
    expect(km).toBeGreaterThan(190)
    expect(km).toBeLessThan(230)
  })

  it('is zero for the same point', () => {
    expect(haversineKm(23.02, 72.57, 23.02, 72.57)).toBe(0)
  })
})

// --- Serviceability ----------------------------------------------------------

describe('serviceable', () => {
  const areas = [{ fromPincode: '360001', toPincode: '396999', isActive: true }]

  it('covers a pincode inside an active range', () => {
    expect(serviceable('380015', areas, [])).toBe(true)
  })

  it('does not cover a pincode outside every range', () => {
    expect(serviceable('682001', areas, [])).toBe(false)
  })

  it('ignores inactive ranges', () => {
    expect(serviceable('380015', [{ ...areas[0]!, isActive: false }], [])).toBe(false)
  })

  it('lets an exception carve a hole inside a covered range', () => {
    expect(serviceable('380015', areas, [{ pincode: '380015', serviceable: false }])).toBe(false)
  })

  it('lets an exception add a pincode outside every range', () => {
    expect(serviceable('682001', areas, [{ pincode: '682001', serviceable: true }])).toBe(true)
  })

  it('rejects a malformed pincode outright', () => {
    expect(serviceable('38001', areas, [])).toBe(false)
    expect(serviceable('038001', areas, [])).toBe(false)
  })
})

// --- Slabs -------------------------------------------------------------------

describe('baseFreightInr', () => {
  it('picks the smallest slab that covers the weight', () => {
    expect(baseFreightInr(SLABS, 'A', 500)).toBe(30)
    expect(baseFreightInr(SLABS, 'A', 501)).toBe(58)
    expect(baseFreightInr(SLABS, 'A', 1000)).toBe(58)
  })

  it('extrapolates above the top slab using the TOP row step', () => {
    // Zone A top: 2000 g @ ₹102, then ₹38 per started 1000 g.
    expect(baseFreightInr(SLABS, 'A', 2001)).toBe(140)
    expect(baseFreightInr(SLABS, 'A', 3000)).toBe(140)
    expect(baseFreightInr(SLABS, 'A', 3001)).toBe(178)
  })

  it('returns null for a zone with no rows — never a zero rate', () => {
    expect(baseFreightInr(SLABS, 'D', 500)).toBeNull()
  })

  it('returns null above the table when no per-step charge is configured', () => {
    const stopsAt1kg: RateSlab[] = [
      { zone: 'A', uptoG: 1000, rateInr: 58, addlPerG: 500, addlRateInr: 0 },
    ]
    expect(baseFreightInr(stopsAt1kg, 'A', 1001)).toBeNull()
  })
})

describe('customerFeeInr', () => {
  it('is true cost plus the configured margin', () => {
    expect(customerFeeInr(100, 1000)).toBe(110) // +10%
    expect(customerFeeInr(45, 1000)).toBe(50) // 49.5 rounds to 50
  })

  it('is exactly true cost at zero margin', () => {
    expect(customerFeeInr(83, 0)).toBe(83)
  })

  it('never charges less than a non-negative cost, even with a negative-ish input', () => {
    expect(customerFeeInr(-10, 1000)).toBe(0)
  })
})

describe('discountedFeeInr', () => {
  it('takes the configured share off the fee', () => {
    expect(discountedFeeInr(100, 5000)).toBe(50) // half price
    expect(discountedFeeInr(91, 5000)).toBe(46) // 45.5 rounds to 46
    expect(discountedFeeInr(100, 0)).toBe(100)
    expect(discountedFeeInr(100, 10_000)).toBe(0)
  })

  it('clamps to 0–100% so a typo can neither raise the fee nor go negative', () => {
    expect(discountedFeeInr(100, -500)).toBe(100)
    expect(discountedFeeInr(100, 25_000)).toBe(0)
  })
})

describe('shopperFeeInr', () => {
  it('applies the margin first, then the discount', () => {
    expect(shopperFeeInr(100, { marginBps: 1000, feeDiscountBps: 5000 })).toBe(55)
    expect(shopperFeeInr(100, { marginBps: 1000, feeDiscountBps: 0 })).toBe(110)
  })
})

// --- True cost ---------------------------------------------------------------

describe('trueCostInr', () => {
  it('applies fuel to the base only, then GST to everything', () => {
    // base 37 + fuel 4.07 (11%) + docket 5 = 46.07; +18% GST = 54.36 → 54
    expect(trueCostInr(courier(), 37, 249, false)).toBe(54)
  })

  it('counts the docket fee — omitting it understates every shipment', () => {
    const withoutDocket = trueCostInr(courier({ docketFeeInr: 0 }), 37, 249, false)
    expect(trueCostInr(courier(), 37, 249, false) - withoutDocket).toBe(6) // ₹5 + its GST
  })

  it('charges risk as max(minimum, percent of declared value)', () => {
    const c = courier({ riskBps: 200, riskMinInr: 20, fuelBps: 0, docketFeeInr: 0 })
    // 249 × 2% = 4.98 → the ₹20 floor wins: (37 + 20) × 1.18 = 67.26 → 67
    expect(trueCostInr(c, 37, 249, false)).toBe(67)
    // 5000 × 2% = 100 beats the floor: (37 + 100) × 1.18 = 161.66 → 162
    expect(trueCostInr(c, 37, 5000, false)).toBe(162)
  })

  it('adds no COD component on a prepaid order', () => {
    const c = courier({ codFlatInr: 40, codBps: 200 })
    expect(trueCostInr(c, 37, 249, false)).toBe(trueCostInr(courier(), 37, 249, false))
  })

  it('charges COD as max(flat, percent) when the order is COD', () => {
    const c = courier({ codFlatInr: 40, codBps: 200, fuelBps: 0, docketFeeInr: 0 })
    // max(40, 249×2% = 4.98) = 40 → (37 + 40) × 1.18 = 90.86 → 91
    expect(trueCostInr(c, 37, 249, true)).toBe(91)
  })

  it('reads percentages as basis points, not percent', () => {
    // 1800 bps must be 18%, not 1800%.
    expect(trueCostInr(courier({ fuelBps: 0, docketFeeInr: 0 }), 100, 0, false)).toBe(118)
  })
})

// --- Freight cost split (the ITC-on-freight input) ---------------------------

describe('freightCost', () => {
  it('splits the bill without changing what it totals', () => {
    // The split exists for reporting; if it moved the total by a rupee it
    // would move every margin figure with it.
    for (const [base, value, cod] of [
      [37, 249, false],
      [37, 5000, true],
      [100, 0, false],
      [0, 0, false],
    ] as const) {
      const c = courier({ codFlatInr: 40, codBps: 200 })
      expect(freightCost(c, base, value, cod).totalInr).toBe(trueCostInr(c, base, value, cod))
    }
  })

  it('makes taxable value plus tax equal the total exactly', () => {
    // The invariant the whole report leans on. `gstInr` is the REMAINDER
    // against a rounded pre-tax, not an independently rounded figure — round
    // both and they drift apart by a rupee on cases like this one.
    for (const base of [0, 1, 7, 37, 99, 100, 137, 1013]) {
      const cost = freightCost(courier(), base, 249, false)
      expect(cost.preTaxInr + cost.gstInr).toBe(cost.totalInr)
    }
  })

  it('freezes the rate it used, so a later rate-card edit cannot restate a filed period', () => {
    expect(freightCost(courier(), 37, 249, false).gstBps).toBe(1800)
    expect(freightCost(courier({ gstBps: 500 }), 37, 249, false).gstBps).toBe(500)
  })

  it('itemises the components the carrier bills pre-tax', () => {
    // base 37 + fuel 4.07 (11% of base) + docket 5 = 46.07 → 46; GST 18% of
    // the unrounded 46.07 = 8.29, total 54.36 → 54, so tax is 54 − 46 = 8.
    const cost = freightCost(courier(), 37, 249, false)
    expect(cost.baseInr).toBe(37)
    expect(cost.fuelInr).toBe(4)
    expect(cost.docketInr).toBe(5)
    expect(cost.codInr).toBe(0)
    expect(cost.preTaxInr).toBe(46)
    expect(cost.gstInr).toBe(8)
    expect(cost.totalInr).toBe(54)
  })

  it('reports no tax at all when the courier charges none', () => {
    const cost = freightCost(courier({ gstBps: 0, fuelBps: 0, docketFeeInr: 0 }), 100, 0, false)
    expect(cost.gstInr).toBe(0)
    expect(cost.preTaxInr).toBe(100)
    expect(cost.totalInr).toBe(100)
  })
})

// --- Free shipping -----------------------------------------------------------

describe('freeTierFor', () => {
  it('picks the first tier whose ceiling covers the weight', () => {
    expect(freeTierFor(RULE.freeAboveTiers, 500)?.freeAboveInr).toBe(249)
    expect(freeTierFor(RULE.freeAboveTiers, 2000)?.freeAboveInr).toBe(249)
    expect(freeTierFor(RULE.freeAboveTiers, 2001)?.freeAboveInr).toBe(999)
  })

  it('returns null above every tier — a heavy cart is NEVER free', () => {
    expect(freeTierFor(RULE.freeAboveTiers, 5001)).toBeNull()
  })
})

describe('qualifiesForFreeShipping', () => {
  const tier = { uptoG: 2000, freeAboveInr: 249 }

  it('qualifies at exactly the threshold', () => {
    expect(qualifiesForFreeShipping(249, tier)).toBe(true)
    expect(qualifiesForFreeShipping(248, tier)).toBe(false)
  })

  it('never qualifies without a tier', () => {
    expect(qualifiesForFreeShipping(100000, null)).toBe(false)
  })
})

describe('resolveFee', () => {
  it('charges the gross fee below the threshold and reports the gap', () => {
    const out = resolveFee(60, 500, 119, 119, RULE)
    expect(out).toEqual({
      feeInr: 60,
      freeApplied: false,
      freeAboveInr: 249,
      remainingInr: 130,
      waivedByCoupon: false,
    })
  })

  it('waives the fee at exactly the threshold', () => {
    const out = resolveFee(60, 500, 249, 249, RULE)
    expect(out).toEqual({
      feeInr: 0,
      freeApplied: true,
      freeAboveInr: 249,
      remainingInr: 0,
      waivedByCoupon: false,
    })
  })

  it('never frees a cart heavier than every tier, however valuable', () => {
    const out = resolveFee(349, 6000, 5000, 5000, RULE)
    expect(out.freeApplied).toBe(false)
    expect(out.feeInr).toBe(349)
    expect(out.freeAboveInr).toBe(0)
  })

  it('measures against the pre-coupon subtotal by default', () => {
    expect(resolveFee(60, 500, 260, 240, RULE).freeApplied).toBe(true)
  })

  it('CLAMP: applying a coupon can never re-acquire the fee under a postCoupon basis', () => {
    // The rev-1 bug: ₹260 cart ships free; a ₹20 coupon drops the basis to
    // ₹240, the fee comes back, and the "discount" costs the shopper ₹40.
    const postCoupon: ShippingRule = { ...RULE, thresholdBasis: 'postCoupon' }
    expect(resolveFee(60, 500, 260, 240, postCoupon).feeInr).toBe(0)
  })

  it('CLAMP: a postCoupon basis still helps when it is the one that qualifies', () => {
    // Fee is charged either way here — the clamp must not invent a discount.
    const postCoupon: ShippingRule = { ...RULE, thresholdBasis: 'postCoupon' }
    expect(resolveFee(60, 500, 200, 180, postCoupon).feeInr).toBe(60)
  })

  // `coupons.waives_shipping` — a retention code whose message promised free
  // delivery. It has to beat the threshold, because the shopper it was sent to
  // was never shown one.
  it('a shipping-waiving coupon frees a cart far below the threshold', () => {
    const out = resolveFee(79, 135, 119, 107, RULE, true)
    expect(out).toEqual({
      feeInr: 0,
      freeApplied: true,
      // The tier is still reported, so the cart screen can show the ordinary
      // threshold; nothing remains to unlock.
      freeAboveInr: 249,
      remainingInr: 0,
      waivedByCoupon: true,
    })
  })

  it('a shipping-waiving coupon frees a cart heavier than EVERY tier', () => {
    // Without the short-circuit this is the `freeTierFor -> null` case that is
    // hard-coded never to be free.
    const out = resolveFee(349, 6000, 5000, 4500, RULE, true)
    expect(out.feeInr).toBe(0)
    expect(out.freeApplied).toBe(true)
    expect(out.waivedByCoupon).toBe(true)
  })

  it('leaves the fee alone when the flag is false', () => {
    expect(resolveFee(60, 500, 119, 119, RULE, false).feeInr).toBe(60)
  })
})

// --- Selection ---------------------------------------------------------------

describe('selectShipment', () => {
  const base = {
    lines: [line()],
    destPincode: '395003',
    nodes: [NODE],
    couriers: [courier()],
    pincodeIndex: INDEX,
    rule: RULE,
    declaredValueInr: 119,
    isCod: false,
  }

  it('prices a Gujarat Zone-B shipment from the Ahmedabad node', () => {
    const { winner, reason } = selectShipment(base)
    expect(reason).toBeNull()
    expect(winner).toMatchObject({
      nodeCode: 'AHM-01',
      courierCode: 'delhivery',
      zone: 'B',
      chargeableWeightG: 500, // 280 g dead, 432 g volumetric → the 500 g minimum
      slaDays: 4,
    })
  })

  // docs/SPEC-COD.md D8. Selection and the shopper's fee are priced PREPAID on
  // every order; `codCost` is what the order snapshot stamps instead. Pricing
  // the ranking on COD would let a payment choice reorder carriers, and the
  // fee is derived from the courier bill, so it would also put a delivery
  // surcharge on top of the ₹49 token.
  describe('codCost', () => {
    const withCod = { ...base, couriers: [courier({ codFlatInr: 40, codBps: 200 })] }

    it('prices the same parcel both ways when the input is prepaid', () => {
      const { winner } = selectShipment(withCod)
      expect(winner?.cost.codInr).toBe(0)
      // max(₹40 flat, 2% of ₹119) = ₹40, plus GST on it.
      expect(winner?.codCost.codInr).toBe(40)
      expect(winner!.codCost.totalInr).toBeGreaterThan(winner!.trueCostInr)
    })

    it('is the same object of numbers when the input already said COD', () => {
      const { winner } = selectShipment({ ...withCod, isCod: true })
      expect(winner?.codCost).toEqual(winner?.cost)
      expect(winner?.trueCostInr).toBe(winner?.codCost.totalInr)
    })

    it('leaves `trueCostInr` — and therefore the ranking — prepaid', () => {
      const prepaidOnly = selectShipment(base).winner!.trueCostInr
      expect(selectShipment(withCod).winner?.trueCostInr).toBe(prepaidOnly)
    })
  })

  it('picks the cheaper courier, not the first one listed', () => {
    const dear = courier({
      code: 'dear',
      name: 'Dear',
      slabs: SLABS.map((s) => ({ ...s, rateInr: s.rateInr * 3 })),
    })
    const { winner } = selectShipment({ ...base, couriers: [dear, courier()] })
    expect(winner?.courierCode).toBe('delhivery')
  })

  it('lets a per-courier volumetric divisor change the chargeable weight', () => {
    const bulky = [line({ lengthCm: 30, widthCm: 25, heightCm: 20 })] // 15000 cm³
    const five = selectShipment({ ...base, lines: bulky, couriers: [courier()] })
    const four = selectShipment({
      ...base,
      lines: bulky,
      couriers: [courier({ code: 'four', volumetricDivisor: 4000 })],
    })
    expect(five.winner?.chargeableWeightG).toBe(3000)
    expect(four.winner?.chargeableWeightG).toBe(3750)
  })

  it('estimates an out-of-state lane with a missing zone slab instead of shipping it free', () => {
    const out = selectShipment({
      ...base,
      destPincode: '682001',
      couriers: [
        courier({ serviceAreas: [{ fromPincode: '100001', toPincode: '999999', isActive: true }] }),
      ],
    })
    expect(out.winner).toMatchObject({ estimated: true, zone: 'D' })
    expect(out.winner!.trueCostInr).toBeGreaterThan(0)
    expect(out.reason).toBeNull()
  })

  it('estimates missing pincode coverage and charges more for a farther destination', () => {
    const nearby = selectShipment({ ...base, destPincode: '300001' })
    const far = selectShipment({ ...base, destPincode: '600001' })
    expect(nearby.winner?.estimated).toBe(true)
    expect(far.winner?.estimated).toBe(true)
    expect(far.winner!.distanceKm!).toBeGreaterThan(nearby.winner!.distanceKm!)
    expect(far.winner!.trueCostInr).toBeGreaterThan(nearby.winner!.trueCostInr)
  })

  it('prefers a covered carrier rate over a cheaper estimated carrier', () => {
    const covered = courier({
      code: 'covered',
      slabs: SLABS.map((s) => ({ ...s, rateInr: s.rateInr * 3 })),
    })
    const estimate = courier({
      serviceExceptions: [{ pincode: base.destPincode, serviceable: false }],
    })
    expect(selectShipment({ ...base, couriers: [estimate, covered] }).winner?.courierCode).toBe(
      'covered'
    )
  })

  it('uses distance bands without ever falling back to a zero-priced rate', () => {
    expect(estimatedBaseFreightInr(SLABS, 500, 200)).toBe(37)
    expect(estimatedBaseFreightInr(SLABS, 500, 900)).toBe(47)
    expect(estimatedBaseFreightInr(SLABS, 500, 1500)).toBe(56)
    expect(estimatedBaseFreightInr(SLABS, 500, 2500)).toBe(65)
    expect(estimatedBaseFreightInr([], 500, 2500)).toBeNull()
  })

  it('refuses an unweighed cart', () => {
    const out = selectShipment({ ...base, lines: [line({ weightG: 0 })] })
    expect(out.reason).toBe('weight_unknown')
    expect(out.winner).toBeNull()
  })

  it('refuses a cart with no measured carton dims, with no assume bypass', () => {
    const out = selectShipment({ ...base, lines: [line({ lengthCm: 0 })] })
    expect(out.reason).toBe('dims_unknown')
    expect(out.winner).toBeNull()
  })

  it('reports no_single_node when no node stocks every line', () => {
    const partial: ShippingNode = { ...NODE, skus: ['DAN-CREAM-100'] }
    const out = selectShipment({
      ...base,
      lines: [line(), line({ sku: 'DAN-OIL-200' })],
      nodes: [partial],
    })
    expect(out.reason).toBe('no_single_node')
  })

  it('treats a node with an empty allowlist as stocking everything', () => {
    const out = selectShipment({ ...base, lines: [line(), line({ sku: 'DAN-OIL-200' })] })
    expect(out.reason).toBeNull()
  })

  it('reports no_destination without a pincode', () => {
    expect(selectShipment({ ...base, destPincode: '' }).reason).toBe('no_destination')
  })

  it('skips a courier whose rate card cannot reach the weight', () => {
    const shortCard = courier({
      code: 'short',
      slabs: [{ zone: 'B', uptoG: 500, rateInr: 37, addlPerG: 500, addlRateInr: 0 }],
    })
    const out = selectShipment({
      ...base,
      lines: [line({ weightG: 2500 })],
      couriers: [shortCard],
    })
    expect(out.reason).toBe('not_serviceable')
  })

  it('ignores a distance-model courier at v1 rather than mispricing it', () => {
    const out = selectShipment({ ...base, couriers: [courier({ rateModel: 'distance' })] })
    expect(out.reason).toBe('not_serviceable')
  })

  it('ranks by SLA when the rule says so', () => {
    const fast = courier({
      code: 'fast',
      slaDaysZoneB: 2,
      slabs: SLABS.map((s) => ({ ...s, rateInr: s.rateInr * 2 })),
    })
    const bySla = selectShipment({
      ...base,
      couriers: [courier(), fast],
      rule: { ...RULE, rankBy: 'sla' },
    })
    const byCost = selectShipment({ ...base, couriers: [courier(), fast] })
    expect(bySla.winner?.courierCode).toBe('fast')
    expect(byCost.winner?.courierCode).toBe('delhivery')
  })

  it('is deterministic when two candidates tie on every ranking key', () => {
    const twin = courier({ code: 'aaa', name: 'Twin' })
    const first = selectShipment({ ...base, couriers: [courier(), twin] })
    const second = selectShipment({ ...base, couriers: [twin, courier()] })
    expect(first.winner?.courierCode).toBe(second.winner?.courierCode)
    expect(first.winner?.courierCode).toBe('aaa')
  })

  it('returns every viable candidate for the admin simulator, best first', () => {
    const dear = courier({
      code: 'dear',
      slabs: SLABS.map((s) => ({ ...s, rateInr: s.rateInr * 3 })),
    })
    const { candidates } = selectShipment({ ...base, couriers: [dear, courier()] })
    expect(candidates.map((c) => c.courierCode)).toEqual(['delhivery', 'dear'])
  })

  it('quotes nothing for an empty cart, with no reason', () => {
    expect(selectShipment({ ...base, lines: [] })).toEqual({
      winner: null,
      candidates: [],
      reason: null,
    })
  })
})

describe('SHIPPING_OFF', () => {
  it('is inert: no tiers, no fence', () => {
    expect(SHIPPING_OFF.enabled).toBe(false)
    expect(SHIPPING_OFF.marginBps).toBe(0)
    expect(SHIPPING_OFF.freeAboveTiers).toEqual([])
    expect(SHIPPING_OFF.serviceableStates).toEqual([])
  })
})
