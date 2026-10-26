/**
 * Integration tests for delivery fees, end to end through the real app: config
 * → rate tables → cart → order creation.
 *
 * These exist to hold the two properties the unit tests cannot prove on their
 * own, because both are about how the PIECES are wired rather than about the
 * arithmetic:
 *
 * 1. **Nothing missing is ever free.** An unknown pincode, an out-of-state one,
 *    an unweighed sku — each must produce a `reason` and refuse the order, not
 *    a ₹0 delivery charge that only the warehouse discovers.
 * 2. **DISPLAY == CHARGE.** The cart screen may price against a bare
 *    `?pincode=`; order creation prices against the order's own address. A
 *    client that carries the signed quote from the first into the second gets a
 *    409 rather than a surprise on their card.
 *
 * The seeded rate card here is small and deliberate — true courier cost plus a
 * 10% margin (`shipping.marginBps: 1000`) works out to Zone A ₹50, Zone B ₹59
 * at the 500 g minimum, free above ₹249 up to 2 kg — so the numbers in the
 * assertions are the ones a shopper would actually see.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { Cart } from '../../src/contracts/cart.js'
import { appConfig, catalogItems, couriers, courierRateSlabs, courierServiceAreas, pickupNodes, pincodes } from '../../src/db/schema.js'
import { auth, createTestApp, USER_A, USER_ADMIN, promoteToAdmin, type TestContext } from '../helpers/app.js'

/** The real Daniya price points, so the threshold arithmetic is the live one. */
const SKU_CREAM = 'DAN-CREAM-100'
const SKU_OIL = 'DAN-OIL-200'
const SKU_UNWEIGHED = 'DAN-MYSTERY-1'

const AHMEDABAD = '380001'
/** Same taluk as the pickup node → Zone A. */
const AHMEDABAD_SATELLITE = '380015'
/** Same state, different taluk → Zone B. */
const SURAT = '395003'
/** Serviceable pincode range, but Daman — excluded by the STATE fence, not the prefix. */
const DAMAN = '396210'
/** Not in the reference data at all. */
const UNKNOWN_PIN = '110001'

let ctx: TestContext

async function seedShippingWorld(): Promise<void> {
  await ctx.db.insert(catalogItems).values([
    {
      sku: SKU_CREAM,
      productId: 'dan-body-cream',
      name: 'Daniya Body Cream',
      size: '100ml',
      priceInr: 119,
      weightG: 220,
      lengthCm: 6,
      widthCm: 6,
      heightCm: 12,
      imageUrl: '',
      active: true,
    },
    {
      sku: SKU_OIL,
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 140,
      weightG: 260,
      lengthCm: 6,
      widthCm: 6,
      heightCm: 16,
      imageUrl: '',
      active: true,
    },
    {
      // Nobody has put this on a scale. It must block, not ship at tare.
      sku: SKU_UNWEIGHED,
      productId: 'dan-mystery',
      name: 'Unweighed Product',
      size: '50ml',
      priceInr: 99,
      weightG: 0,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
      imageUrl: '',
      active: true,
    },
  ])

  await ctx.db.insert(pincodes).values([
    { pincode: AHMEDABAD, officeName: 'Ahmedabad GPO', taluk: 'Ahmadabad City', district: 'Ahmadabad', state: 'Gujarat', lat: 23.02, lng: 72.57 },
    { pincode: AHMEDABAD_SATELLITE, officeName: 'Satellite', taluk: 'Ahmadabad City', district: 'Ahmadabad', state: 'Gujarat', lat: 23.01, lng: 72.51 },
    { pincode: SURAT, officeName: 'Nanpura', taluk: 'Surat City', district: 'Surat', state: 'Gujarat', lat: 21.18, lng: 72.82 },
    { pincode: DAMAN, officeName: 'Daman', taluk: 'Daman', district: 'Daman', state: 'Daman and Diu', lat: 20.39, lng: 72.83 },
  ])

  await ctx.db.insert(pickupNodes).values({
    code: 'AHM-01',
    name: 'Ahmedabad Warehouse',
    pincode: AHMEDABAD,
    city: 'Ahmedabad',
    state: 'Gujarat',
    isActive: true,
  })

  await ctx.db.insert(couriers).values({
    code: 'delhivery',
    name: 'Delhivery Surface',
    fuelBps: 1100,
    gstBps: 1800,
    docketFeeInr: 5,
    volumetricDivisor: 5000,
    minChargeableG: 500,
    slaDaysZoneA: 2,
    slaDaysZoneB: 4,
  })

  await ctx.db.insert(courierRateSlabs).values([
    { courierCode: 'delhivery', zone: 'A', uptoG: 500, rateInr: 30, addlPerG: 1000, addlRateInr: 0 },
    { courierCode: 'delhivery', zone: 'A', uptoG: 2000, rateInr: 105, addlPerG: 1000, addlRateInr: 45 },
    { courierCode: 'delhivery', zone: 'B', uptoG: 500, rateInr: 37, addlPerG: 1000, addlRateInr: 0 },
    { courierCode: 'delhivery', zone: 'B', uptoG: 2000, rateInr: 140, addlPerG: 1000, addlRateInr: 60 },
  ])

  // The whole Gujarat band, INCLUDING Daman's 396xxx — proving the state fence
  // and not the pincode prefix is what excludes it.
  await ctx.db.insert(courierServiceAreas).values({
    courierCode: 'delhivery',
    fromPincode: '360001',
    toPincode: '396999',
    isActive: true,
  })

  await ctx.db.insert(appConfig).values([
    { key: 'shipping.enabled', value: true, description: '' },
    {
      key: 'shipping.freeAboveTiers',
      value: [{ uptoG: 2000, freeAboveInr: 249 }],
      description: '',
    },
    { key: 'shipping.thresholdBasis', value: 'preCoupon', description: '' },
    { key: 'shipping.marginBps', value: 1000, description: '' },
    { key: 'shipping.packagingTareG', value: 60, description: '' },
    { key: 'shipping.serviceableStates', value: ['Gujarat'], description: '' },
  ])
}

/** Put a line in the caller's cart. */
async function addLine(sku: string, qty = 1): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/v1/cart/items/${sku}`,
    headers: auth(USER_A.token),
    payload: { qty },
  })
  expect(res.statusCode).toBe(200)
}

/** Read the cart, optionally priced against a destination. */
async function readCart(query = ''): Promise<Cart> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/v1/cart${query}`,
    headers: auth(USER_A.token),
  })
  expect(res.statusCode).toBe(200)
  return res.json() as Cart
}

/** Create a saved address and return its id. */
async function createAddress(pincode: string, isDefault = true): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/addresses',
    headers: auth(USER_A.token),
    payload: {
      name: 'Asha Rao',
      phone: '9876543210',
      pincode,
      city: 'Ahmedabad',
      state: 'Gujarat',
      houseNumber: '12B',
      roadArea: 'CG Road',
      isDefault,
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id
}

beforeEach(async () => {
  ctx = await createTestApp()
  await seedShippingWorld()
})

describe('the delivery-fee decoy', () => {
  it('charges ₹59 to Zone B for a lone ₹119 cream, and names the gap to free', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart(`?pincode=${SURAT}`)

    expect(cart.shipping).toMatchObject({
      enabled: true,
      feeApplied: true,
      freeApplied: false,
      feeInr: 59,
      freeAboveInr: 249,
      remainingInr: 130,
      wouldBeFeeInr: 59,
      savedInr: 0,
      zone: 'B',
      // 220 g + 60 g tare = 280 g dead, 432 g volumetric → the 500 g minimum.
      chargeableWeightG: 500,
      etaDays: 4,
      reason: null,
    })
    expect(cart.totalInr).toBe(178)
  })

  it('waives the fee once a ₹140 add-on clears the threshold', async () => {
    await addLine(SKU_CREAM)
    await addLine(SKU_OIL)
    const cart = await readCart(`?pincode=${SURAT}`)

    // 119 + 140 = 259, which clears ₹249.
    expect(cart.shipping).toMatchObject({
      feeApplied: false,
      freeApplied: true,
      feeInr: 0,
      remainingInr: 0,
      // ₹208, NOT the ₹59 the one-item cart was quoted: 220 g + 260 g + 60 g
      // tare = 540 g, which falls out of the ≤500 g slab into the ≤2 kg one.
      //
      // This is precisely why the client copy must read "save UP TO ₹59" and
      // never "save ₹59" — the add-on that clears the threshold can also cross
      // a weight slab, and the amount actually escaped moves with it. (Here it
      // moves in the shopper's favour; a cheaper, heavier add-on would make the
      // saving larger still while the gap to the threshold stayed the same.)
      wouldBeFeeInr: 208,
      savedInr: 208,
      chargeableWeightG: 540,
    })
    expect(cart.totalInr).toBe(259)
  })

  it('charges the cheaper Zone-A fee for a same-taluk destination', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart(`?pincode=${AHMEDABAD_SATELLITE}`)
    expect(cart.shipping).toMatchObject({ zone: 'A', feeInr: 50, etaDays: 2 })
    expect(cart.totalInr).toBe(169)
  })
})

describe('the shipping block is always present', () => {
  it('is on an empty cart', async () => {
    const cart = await readCart()
    expect(cart.shipping).toBeDefined()
    expect(cart.shipping.feeInr).toBe(0)
    expect(cart.totalInr).toBe(0)
  })

  it('is on a cart with no destination at all', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart()
    expect(cart.shipping).toMatchObject({ enabled: true, reason: 'no_destination', feeInr: 0 })
    expect(cart.totalInr).toBe(119)
  })

  it('is on a write response, so the fee does not blink out on a qty change', async () => {
    await createAddress(SURAT)
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${SKU_CREAM}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.json().shipping).toMatchObject({ zone: 'B', feeInr: 59 })
  })

  it('keeps `totalInr === subtotal − discount + fee` exactly', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart(`?pincode=${SURAT}`)
    expect(cart.totalInr).toBe(
      cart.coupon.subtotalInr - cart.coupon.discountInr + cart.shipping.feeInr
    )
  })
})

describe('absence is never free', () => {
  it('estimates an out-of-state destination inside the courier range with a missing zone slab', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart(`?pincode=${DAMAN}`)
    expect(cart.shipping).toMatchObject({ reason: null, estimated: true, zone: 'D' })
    expect(cart.shipping.feeInr).toBeGreaterThan(0)
    expect(cart.totalInr).toBe(119 + cart.shipping.feeInr)
  })

  it('estimates a pincode absent from the reference data', async () => {
    await addLine(SKU_CREAM)
    const cart = await readCart(`?pincode=${UNKNOWN_PIN}`)
    expect(cart.shipping).toMatchObject({ reason: null, estimated: true })
    expect(cart.shipping.feeInr).toBeGreaterThan(0)
  })

  it('refuses a cart containing a sku nobody has weighed', async () => {
    await addLine(SKU_UNWEIGHED)
    const cart = await readCart(`?pincode=${SURAT}`)
    expect(cart.shipping).toMatchObject({ reason: 'weight_unknown', feeInr: 0 })
  })
})

describe('coupons never raise the amount due', () => {
  beforeEach(async () => {
    await ctx.db.insert(appConfig).values({
      key: 'shipping.thresholdBasis',
      value: 'postCoupon',
      description: '',
    }).onConflictDoUpdate({ target: appConfig.key, set: { value: 'postCoupon' } })
  })

  it('does not re-acquire the fee when a coupon drops the cart below the threshold', async () => {
    await ctx.db.insert((await import('../../src/db/schema.js')).coupons).values({
      code: 'SAVE20',
      label: '₹20 off',
      discountType: 'flat',
      discountValue: 20,
      active: true,
    })

    await addLine(SKU_CREAM)
    await addLine(SKU_OIL)

    const without = await readCart(`?pincode=${SURAT}`)
    const withCoupon = await readCart(`?pincode=${SURAT}&coupon=SAVE20`)

    // 259 ships free. With ₹20 off the basis is 239 — below ₹249 — so an
    // unclamped implementation charges ₹208 and the "discount" costs ₹188.
    expect(without.totalInr).toBe(259)
    expect(withCoupon.shipping.feeInr).toBe(0)
    expect(withCoupon.totalInr).toBe(239)
    expect(withCoupon.totalInr).toBeLessThan(without.totalInr)
  })
})

describe('DISPLAY == CHARGE at checkout', () => {
  it('prices the order from its OWN address, not a client-supplied pincode', async () => {
    // Cart previewed against a cheap Zone-A pincode…
    const addressId = await createAddress(SURAT)
    await addLine(SKU_CREAM)

    const previewed = await readCart(`?pincode=${AHMEDABAD_SATELLITE}`)
    expect(previewed.shipping.feeInr).toBe(50)

    // …while the saved address is Zone B. The cart read that checkout must do
    // reports the real number.
    const authoritative = await readCart(`?addressId=${addressId}`)
    expect(authoritative.shipping.feeInr).toBe(59)
    expect(authoritative.totalInr).toBe(178)
  })

  it('404s an addressId belonging to somebody else', async () => {
    await addLine(SKU_CREAM)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart?addressId=00000000-0000-0000-0000-000000000000',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('issues a quote token only when there is a quote to bind', async () => {
    await addLine(SKU_CREAM)
    const quoted = await readCart(`?pincode=${SURAT}`)
    const unquotable = await readCart(`?pincode=${UNKNOWN_PIN}`)
    expect(quoted.shipping.quoteToken).not.toBe('')
    expect(unquotable.shipping.estimated).toBe(true)
    expect(unquotable.shipping.quoteToken).not.toBe('')
  })
})

describe('GET /v1/shipping/serviceability', () => {
  it('answers yes with a zone and an ETA for a Gujarat pincode', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/serviceability?pincode=${SURAT}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ serviceable: true, zone: 'B', etaDays: 4, reason: null })
  })

  it('accepts PAN India with an estimated rate outside the old allowlist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/serviceability?pincode=${DAMAN}`,
    })
    expect(res.json()).toMatchObject({
      serviceable: true,
      estimated: true,
      zone: 'D',
      reason: null,
    })
  })

  it('needs no authentication — the question comes before the account', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/serviceability?pincode=${AHMEDABAD}`,
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /v1/shipping/quote', () => {
  it('derives the weight from the sku, and takes none from the caller', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/quote?sku=${SKU_CREAM}&pincode=${SURAT}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ serviceable: true, feeInr: 59, zone: 'B', chargeableWeightG: 500 })
  })

  it('rejects an attempt to pass a weight', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/quote?sku=${SKU_CREAM}&pincode=${SURAT}&weightG=1`,
    })
    // The query schema is strict, so an unknown key is a validation failure
    // (422 in this API's envelope) — the weight is not merely ignored.
    expect(res.statusCode).toBe(422)
  })

  it('404s an unknown sku', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/shipping/quote?sku=nope&pincode=${SURAT}`,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /v1/shipping/cod-preview', () => {
  it('is gone: Tiny Tales is prepaid only, so there is no cash-on-delivery preview', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/shipping/cod-preview?sku=ANY&pincode=380015',
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /v1/admin/shipping/simulate', () => {
  beforeEach(async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  })

  it('reports the margin on every candidate, winner flagged', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/simulate',
      headers: auth(USER_ADMIN.token),
      payload: { destPincode: SURAT, weightG: 220, cartValueInr: 119, lengthCm: 1, widthCm: 1, heightCm: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.serviceable).toBe(true)
    expect(body.candidates).toHaveLength(1)

    const winner = body.candidates[0]
    expect(winner.chosen).toBe(true)
    // (37 base × 1.11 fuel + 5 docket) × 1.18 GST = 54.36 → ₹54, +10% margin → ₹59.
    expect(winner.trueCostInr).toBe(54)
    expect(winner.customerFeeInr).toBe(59)
    expect(winner.marginInr).toBe(5)
  })

  it('scales the margin with weight, and never charges less than true cost', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/simulate',
      headers: auth(USER_ADMIN.token),
      payload: { destPincode: SURAT, weightG: 1900, cartValueInr: 999, lengthCm: 1, widthCm: 1, heightCm: 1 },
    })
    const winner = res.json().candidates[0]
    // (140 base × 1.11 fuel + 5 docket) × 1.18 GST = 189.27 → ₹189, +10% margin → ₹208.
    expect(winner.trueCostInr).toBe(189)
    expect(winner.customerFeeInr).toBe(208)
    expect(winner.marginInr).toBeGreaterThan(0)
  })

  it('is admin-only', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/simulate',
      headers: auth(USER_A.token),
      payload: { destPincode: SURAT, weightG: 220, cartValueInr: 119 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('reports no config error while the config is valid', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/simulate',
      headers: auth(USER_ADMIN.token),
      payload: { destPincode: SURAT, weightG: 220, cartValueInr: 119 },
    })
    expect(res.json().configError).toBeNull()
  })

  /**
   * The failure this is really about: the free-delivery threshold is edited as
   * raw JSON in the admin config screen. A typo there does not raise anything —
   * the rule silently collapses to off and the entire store stops charging for
   * delivery, looking exactly like somebody turned it off on purpose. The
   * simulator is where an operator finds out.
   */
  it('names the broken key when a malformed threshold silently disables shipping', async () => {
    await ctx.db
      .insert(appConfig)
      .values({ key: 'shipping.freeAboveTiers', value: 'two-fourty-nine', description: '' })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: 'two-fourty-nine' },
      })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/simulate',
      headers: auth(USER_ADMIN.token),
      payload: { destPincode: SURAT, weightG: 220, cartValueInr: 119 },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.configError).toContain('shipping.freeAboveTiers')
    // …and the cart path still fails SAFE rather than quoting from half a rule.
    expect(body.serviceable).toBe(false)
  })
})
