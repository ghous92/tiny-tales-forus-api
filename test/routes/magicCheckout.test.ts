/**
 * Route tests: /v1/payments/magic (Razorpay Magic Checkout for guests).
 *
 * Same harness shape as payments.test.ts: a fake SDK, real HMAC math, real
 * migrations. What matters here is the hand-over: a guest order holds no user
 * or address until a capture exists, and then has to become an ordinary
 * `payments` row on every path that can observe that capture.
 */

import { createHmac } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import {
  addresses,
  appConfig,
  catalogItems,
  coupons,
  magicCheckouts,
  payments,
  users,
} from '../../src/db/schema.js'
import type { MagicCustomerDetails, PaymentsGateway, RazorpayApi } from '../../src/lib/razorpay.js'
import type { VerifiedToken } from '../../src/plugins/auth.js'
import { clearMagicRateLimits } from '../../src/routes/payments.js'
import { addressFromCustomerDetails, canonicalState } from '../../src/services/magicCheckout.js'
import { auth, createTestDb, promoteToAdmin, USER_A, USER_ADMIN, type TestContext } from '../helpers/app.js'

const KEY_SECRET = 'test_key_secret_fake'
const WEBHOOK_SECRET = 'test_webhook_secret_fake'
const SKU = 'TT-TEST-1'
const ORDER_ID = 'order_MAGIC0001'
const PAYMENT_ID = 'pay_MAGIC0001'

const NEW_GUEST: MagicCustomerDetails = {
  contact: '+919123456780',
  email: 'guest@example.com',
  shipping_address: {
    name: 'Asha Rao',
    contact: '+919123456780',
    line1: '12B Shanti Nagar',
    line2: 'Satellite Road',
    city: 'Ahmedabad',
    state: 'Gujarat',
    zipcode: '380015',
    country: 'in',
  },
}

let ctx: TestContext
let createCalls: Array<Record<string, unknown>>
let customerDetails: MagicCustomerDetails | null
let capturedPayments: Array<{ id: string; status: string; amount: number; currency: string }>

function sign(orderId = ORDER_ID, paymentId = PAYMENT_ID): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
}

beforeEach(async () => {
  clearMagicRateLimits()
  createCalls = []
  customerDetails = NEW_GUEST
  capturedPayments = []
  const api = {
    orders: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params)
        return { id: ORDER_ID, amount: params.amount, currency: 'INR', status: 'created' }
      },
      fetch: async (id: string) => ({ id, customer_details: customerDetails }),
      fetchPayments: async () => ({ items: capturedPayments }),
    },
    payments: {},
  } as unknown as RazorpayApi
  const gateway: PaymentsGateway = {
    config: { keyId: 'rzp_test_fake', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, mode: 'test' },
    client: () => Promise.resolve(api),
  }
  const { db, pglite } = await createTestDb()
  const tokens = new Map<string, VerifiedToken>([
    [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
    [USER_ADMIN.token, { uid: USER_ADMIN.uid, phoneNumber: USER_ADMIN.phoneNumber }],
  ])
  const app = buildApp({
    db,
    verifyToken: (t) => {
      const c = tokens.get(t)
      return c ? Promise.resolve(c) : Promise.reject(new Error('invalid test token'))
    },
    logger: false,
    authCacheTtlMs: 0,
    paymentsGateway: gateway,
  })
  await app.ready()
  ctx = { app, db, pglite, tokens: new Map() }
  await db.insert(catalogItems).values({
    sku: SKU,
    productId: 'test-piece',
    name: 'The Test Piece',
    size: '8 cm',
    priceInr: 500,
    imageUrl: '/products/test.jpg',
    active: true,
  })
  await db
    .insert(appConfig)
    .values({ key: 'payments.magicCheckoutPercent', value: 100, description: '' })
})

afterEach(async () => {
  await ctx.app.close()
})

function createOrder(payload: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/magic/orders',
    payload: { lines: [{ sku: SKU, qty: 2 }], termsAccepted: true, ...payload },
  })
}

function verify(signature = sign()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/magic/verify',
    payload: {
      razorpayOrderId: ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: signature,
    },
  })
}

function webhookCaptured(amount = 100000) {
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: PAYMENT_ID, order_id: ORDER_ID, amount, currency: 'INR', notes: {} },
      },
    },
  })
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
    },
    payload,
  })
}

async function paymentRow() {
  const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, ORDER_ID))
  return row
}

describe('POST /magic/orders', () => {
  it('prices from the catalog, sends line items, and holds the order without a payments row', async () => {
    const res = await createOrder()
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ orderId: ORDER_ID, amountPaise: 100000, totalInr: 1000 })
    expect(createCalls[0]).toMatchObject({
      amount: 100000,
      line_items_total: 100000,
      line_items: [{ sku: SKU, variant_id: SKU, price: 50000, offer_price: 50000, quantity: 2 }],
      notes: { store: 'tinytales', checkout: 'magic' },
    })
    expect(await paymentRow()).toBeUndefined()
  })

  it('takes a coupon off amount and line_items_total but not the line prices', async () => {
    await ctx.db.insert(coupons).values({
      code: 'TENOFF',
      label: '10% off',
      discountType: 'percent',
      discountValue: 10,
      active: true,
    })
    const res = await createOrder({ couponCode: 'TENOFF' })
    expect(res.json()).toMatchObject({ amountPaise: 90000, discountInr: 100, couponCode: 'TENOFF' })
    expect(createCalls[0]).toMatchObject({
      amount: 90000,
      line_items_total: 90000,
      line_items: [{ offer_price: 50000 }],
    })
  })

  it.each([
    ['the percent is 0', async () => {
      await ctx.db.update(appConfig).set({ value: 0 }).where(eq(appConfig.key, 'payments.magicCheckoutPercent'))
    }, {}],
    ['delivery is not free', async () => {
      await ctx.db.insert(appConfig).values({ key: 'shipping.enabled', value: true, description: '' })
    }, {}],
    ['the coupon has a per-shopper limit', async () => {
      await ctx.db.insert(coupons).values({
        code: 'ONCE',
        label: 'Once',
        discountType: 'percent',
        discountValue: 10,
        active: true,
        perUserLimit: 1,
      })
    }, { couponCode: 'ONCE' }],
  ])('503s, so the storefront falls back to the form, when %s', async (_name, arrange, payload) => {
    await arrange()
    const res = await createOrder(payload)
    expect(res.statusCode).toBe(503)
    expect(createCalls).toHaveLength(0)
  })

  it('refuses a sku that is not on sale rather than dropping it from the total', async () => {
    const res = await createOrder({ lines: [{ sku: 'NOPE', qty: 1 }] })
    expect(res.statusCode).toBe(422)
    expect(createCalls).toHaveLength(0)
  })

  it('requires the terms line to have been shown', async () => {
    const res = await createOrder({ termsAccepted: false })
    expect(res.statusCode).toBe(422)
  })

  it('rate limits by IP', async () => {
    for (let i = 0; i < 10; i++) await createOrder({ lines: [{ sku: 'NOPE', qty: 1 }] })
    const res = await createOrder()
    expect(res.statusCode).toBe(429)
  })
})

describe('capture hand-over', () => {
  it('verify creates the user, freezes the address, marks paid, and saves the address', async () => {
    await createOrder()
    const res = await verify()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orderId: ORDER_ID, status: 'paid' })

    const row = await paymentRow()
    expect(row?.status).toBe('paid')
    expect(row?.addressSnapshot).toMatchObject({
      phone: '9123456780',
      pincode: '380015',
      state: 'Gujarat',
      houseNumber: '12B Shanti Nagar',
      roadArea: 'Satellite Road',
    })
    const [user] = await ctx.db.select().from(users).where(eq(users.phone, '+919123456780'))
    expect(user).toMatchObject({ firebaseUid: 'magic:+919123456780', email: 'guest@example.com' })
    const saved = await ctx.db.select().from(addresses).where(eq(addresses.userId, user!.id))
    expect(saved).toMatchObject([{ isDefault: true, pincode: '380015' }])
    const [held] = await ctx.db.select().from(magicCheckouts)
    expect(held?.status).toBe('converted')
  })

  it('a bad signature changes nothing and never asks Razorpay who the shopper is', async () => {
    await createOrder()
    const res = await verify('0'.repeat(64))
    expect(res.statusCode).toBe(400)
    expect(await paymentRow()).toBeUndefined()
  })

  it('does not answer for an order that is not a Magic order', async () => {
    const res = await verify()
    expect(res.statusCode).toBe(404)
  })

  it('the webhook alone can complete the order, and a later verify is a no-op', async () => {
    await createOrder()
    expect((await webhookCaptured()).statusCode).toBe(200)
    expect((await paymentRow())?.status).toBe('paid')
    const replay = await verify()
    expect(replay.json()).toEqual({ orderId: ORDER_ID, status: 'paid' })
  })

  it('a captured amount that differs is left for manual review', async () => {
    await createOrder()
    await webhookCaptured(100)
    expect((await paymentRow())?.status).toBe('pending')
  })

  it('never changes an existing account: its email and addresses stay as they were', async () => {
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    expect(me.statusCode).toBe(200)
    await ctx.db.update(users).set({ email: 'real@example.com' }).where(eq(users.phone, USER_A.phoneNumber))
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: {
        name: 'Real Owner',
        phone: '9876543210',
        pincode: '110001',
        city: 'Delhi',
        state: 'Delhi',
        houseNumber: '1',
        roadArea: 'Janpath',
        isDefault: true,
      },
    })
    customerDetails = {
      ...NEW_GUEST,
      contact: USER_A.phoneNumber,
      email: 'attacker@example.com',
      shipping_address: { ...NEW_GUEST.shipping_address, contact: USER_A.phoneNumber },
    }
    await createOrder()
    await verify()

    const [user] = await ctx.db.select().from(users).where(eq(users.phone, USER_A.phoneNumber))
    expect(user?.email).toBe('real@example.com')
    expect(user?.firebaseUid).toBe(USER_A.uid)
    const saved = await ctx.db.select().from(addresses).where(eq(addresses.userId, user!.id))
    expect(saved).toHaveLength(1)
    expect((await paymentRow())?.userId).toBe(user?.id)
  })

  it('a guest who later signs in with the same phone sees the order', async () => {
    customerDetails = {
      ...NEW_GUEST,
      contact: USER_A.phoneNumber,
      shipping_address: { ...NEW_GUEST.shipping_address, contact: USER_A.phoneNumber },
    }
    await createOrder()
    await verify()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orders.map((o: { orderId: string }) => o.orderId)).toEqual([ORDER_ID])
    const [user] = await ctx.db.select().from(users).where(eq(users.phone, USER_A.phoneNumber))
    expect(user?.firebaseUid).toBe(USER_A.uid)
  })

  it('an incomplete address answers pending, then the sweep finishes the order', async () => {
    customerDetails = { contact: '+919123456780' }
    await createOrder()
    const res = await verify()
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending')
    expect(await paymentRow()).toBeUndefined()

    customerDetails = NEW_GUEST
    capturedPayments = [{ id: PAYMENT_ID, status: 'captured', amount: 100000, currency: 'INR' }]
    await ctx.db
      .update(magicCheckouts)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(magicCheckouts.orderId, ORDER_ID))
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    const sweep = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/recover',
      headers: auth(USER_ADMIN.token),
    })
    expect(sweep.statusCode).toBe(200)
    expect((await paymentRow())?.status).toBe('paid')
  })

  it('the sweep expires an order nobody paid for, without creating a payments row', async () => {
    await createOrder()
    await ctx.db
      .update(magicCheckouts)
      .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(magicCheckouts.orderId, ORDER_ID))
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/recover',
      headers: auth(USER_ADMIN.token),
    })
    const [held] = await ctx.db.select().from(magicCheckouts)
    expect(held?.status).toBe('expired')
    expect(await paymentRow()).toBeUndefined()
  })
})

describe('GET /magic/orders/:orderId', () => {
  it('shows status and only the last four digits of the phone', async () => {
    await createOrder()
    await verify()
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/payments/magic/orders/${ORDER_ID}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      orderId: ORDER_ID,
      status: 'paid',
      totalInr: 1000,
      phoneLast4: '6780',
      items: [{ sku: SKU, name: 'The Test Piece', priceInr: 500, qty: 2 }],
    })
    expect(res.body).not.toContain('Shanti Nagar')
  })

  it('404s for an id that is not a Magic order', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/payments/magic/orders/order_OTHER' })
    expect(res.statusCode).toBe(404)
  })
})

describe('Razorpay callbacks', () => {
  it('shipping-info offers free delivery with no COD, and refuses a bad pincode or country', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/magic/shipping-info',
      payload: {
        order_id: 'r1',
        contact: '+919123456780',
        addresses: [
          { id: 'a', zipcode: '380015', country: 'IN' },
          { id: 'b', zipcode: '12', country: 'IN' },
          { id: 'c', zipcode: '380015', country: 'US' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const [good, badPin, abroad] = res.json().addresses
    expect(good.shipping_methods[0]).toMatchObject({
      serviceable: true,
      shipping_fee: 0,
      cod: false,
      cod_fee: 0,
    })
    expect(badPin.shipping_methods[0].serviceable).toBe(false)
    expect(abroad.shipping_methods[0].serviceable).toBe(false)
  })

  it('promotions offers nothing and apply refuses', async () => {
    const list = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/magic/promotions',
      payload: { order_id: 'r1' },
    })
    expect(list.json()).toEqual({ promotions: [] })
    const apply = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/magic/promotions/apply',
      payload: { order_id: 'r1', code: 'X' },
    })
    expect(apply.json().failure_code).toBe('INVALID_PROMOTION')
  })
})

describe('address parsing', () => {
  it('maps a state code to the name invoices need', () => {
    expect(canonicalState('KA')).toBe('Karnataka')
    expect(canonicalState(' Gujarat ')).toBe('Gujarat')
  })

  it('falls back to the city when line2 is empty', () => {
    const address = addressFromCustomerDetails({
      ...NEW_GUEST,
      shipping_address: { ...NEW_GUEST.shipping_address, line2: '' },
    })
    expect(address?.roadArea).toBe('Ahmedabad')
  })

  it.each([
    ['no address', { contact: '+919123456780' }],
    ['a foreign phone', { contact: '+14155550100', shipping_address: { ...NEW_GUEST.shipping_address, contact: '+14155550100' } }],
    ['no pincode', { ...NEW_GUEST, shipping_address: { ...NEW_GUEST.shipping_address, zipcode: '' } }],
  ])('rejects %s', (_name, details) => {
    expect(addressFromCustomerDetails(details)).toBeNull()
  })
})
