/**
 * Route tests: /v1/payments (SPEC-PAYMENTS.md "Definition of done" #3/#4).
 *
 * The Razorpay SDK is never hit: a fake {@link PaymentsGateway} is injected via
 * `buildApp({ paymentsGateway })` — its `client()` returns an in-memory stub
 * that records `orders.create` calls and serves `orders.fetchPayments`. HMAC
 * signatures are computed FOR REAL with node:crypto against obviously-fake test
 * secrets, so the timing-safe verification path is exercised end-to-end.
 *
 * Covers, per the DoD: order-create happy path (server pricing incl. a
 * wholesale cart) → 201; empty cart 422; foreign addressId 404; unauthed 401;
 * verify happy path (→ paid + cart cleared); verify bad signature 400 + row
 * untouched; verify replay no-op; verify cross-user 404; webhook valid capture
 * → paid (raw-body signature); webhook replay no-op; webhook bad signature 400;
 * webhook amount mismatch → NO transition; payment.failed + refund.processed
 * transitions; keys-missing → 503 payments_disabled; GET status own/foreign,
 * plus its live gateway reconciliation (capture → paid as `observed_by = 'poll'`,
 * mismatch never transitions, the age window at both ends, the per-order
 * throttle, and a gateway failure degrading to the stored status);
 * the mobile UPI-intent endpoint (link + per-app deep links, server-side amount,
 * no transition, cross-user 404, non-pending 409, gateway refusal 422, kill
 * switch 503); and the scoped-raw-body regression (other routes still parse
 * JSON).
 */

import { createHmac } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../../src/app.js'
import {
  appConfig,
  catalogItems,
  coupons,
  courierRateSlabs,
  courierServiceAreas,
  couriers,
  creditNotes,
  invoices,
  paymentAttempts,
  payments,
  pickupNodes,
  pincodes,
  shipments,
  users,
} from '../../src/db/schema.js'
import type { CreditNoteDocument } from '../../src/contracts/creditNotes.js'
import type { InvoiceDocument } from '../../src/contracts/invoices.js'
import type { PaymentsGateway, RazorpayApi } from '../../src/lib/razorpay.js'
import type { VerifiedToken } from '../../src/plugins/auth.js'
import { countCodOrdersThisMonth } from '../../src/services/cod.js'
import {
  auth,
  createTestDb,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  USER_B,
  type TestContext,
} from '../helpers/app.js'

// Obviously-fake test secrets (never real key material — DoD #6).
const KEY_ID = 'rzp_test_fake123'
const KEY_SECRET = 'test_key_secret_fake'
const WEBHOOK_SECRET = 'test_webhook_secret_fake'

/**
 * A Razorpay-shaped UPI intent link — same field set the real `create/upi`
 * returns (payee VPA, name, transaction ref, amount, currency, MCC).
 */
const UPI_LINK = 'upi://pay?pa=laanya%40razopay&pn=Laanya&tr=TESTREF01&am=498&cu=INR&mc=5411'
const UPI_QUERY = UPI_LINK.slice(UPI_LINK.indexOf('?'))

const SKU_A = 'AH-82U3-T29Q'
const SKU_B = '04-JPDR-6Z6N'

/** A recording stub for the Razorpay SDK client. Tests tweak `createResult`/`payments`. */
class FakeRazorpay {
  createCalls: Array<{ amount: number; currency: string }> = []
  refundCalls: Array<{ paymentId: string; amount: number }> = []
  captureCalls: Array<{ paymentId: string; amount: number; currency: string }> = []
  nextOrderId = 'order_TEST0001'
  /** Cancel tests default to an already-captured payment; override per-test to exercise capture-before-refund. */
  paymentStatus = 'captured'
  /** What `payments.refund` returns — overridden to exercise a bank-pending (non-instant) refund. */
  refundResult: { id: string; status: string; speed_processed?: string } = {
    id: 'rfnd_TEST0001',
    status: 'processed',
    speed_processed: 'instant',
  }
  /** The instrument on the fetched payment — the refund destination the order screen shows. */
  paymentInstrument: {
    method?: string
    upi?: { vpa?: string }
    card?: { last4?: string; network?: string }
  } = { method: 'upi', upi: { vpa: 'shopper@okhdfcbank' } }
  paymentsByOrder = new Map<
    string,
    Array<{ id: string; status: string; amount: number; currency?: string }>
  >()
  /**
   * Order ids `orders.fetchPayments` was asked about. The status poll is
   * supposed to spend a round trip only inside a narrow window, and "did NOT
   * call the gateway" is the whole assertion for the cases outside it.
   */
  fetchPaymentsCalls: string[] = []
  /** Every S2S UPI create this fake saw — the intent tests assert on the params. */
  upiCalls: Array<Record<string, unknown>> = []
  /** What `payments.createUpi` returns; overridden to exercise a link-less response. */
  upiResult: { razorpay_payment_id: string; link?: string } = {
    razorpay_payment_id: 'pay_UPI00001',
    link: UPI_LINK,
  }
  /** When set, `payments.createUpi` rejects with this instead of returning. */
  upiError: unknown = undefined

  api: RazorpayApi = {
    orders: {
      create: async (params) => {
        this.createCalls.push({ amount: params.amount, currency: params.currency })
        return {
          id: this.nextOrderId,
          amount: params.amount,
          currency: params.currency,
          status: 'created',
        }
      },
      fetchPayments: async (orderId) => {
        this.fetchPaymentsCalls.push(orderId)
        return { items: this.paymentsByOrder.get(orderId) ?? [] }
      },
    },
    payments: {
      refund: async (paymentId, params) => {
        this.refundCalls.push({ paymentId, amount: params.amount })
        return this.refundResult
      },
      fetch: async (paymentId) => ({
        id: paymentId,
        status: this.paymentStatus,
        amount: 0,
        ...this.paymentInstrument,
      }),
      capture: async (paymentId, amount, currency) => {
        this.captureCalls.push({ paymentId, amount, currency })
        this.paymentStatus = 'captured'
        return { id: paymentId, status: 'captured' }
      },
      createUpi: async (params) => {
        this.upiCalls.push(params as unknown as Record<string, unknown>)
        if (this.upiError !== undefined) throw this.upiError
        return this.upiResult
      },
    },
  }
}

/** Build a PaymentsGateway around the fake SDK with the fake test secrets. */
function fakeGateway(sdk: FakeRazorpay): PaymentsGateway {
  return {
    config: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, mode: 'test' },
    client: () => Promise.resolve(sdk.api),
  }
}

/** The verify-body signature Razorpay Checkout returns: HMAC(orderId|paymentId, KEY_SECRET). */
function verifySignature(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
}

/** The webhook header signature: HMAC over the RAW body under WEBHOOK_SECRET. */
function webhookSignature(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
}

import { taskNameFor, type TaskEnqueueInput } from '../../src/lib/tasks.js'
import { resetGatewayPollThrottle } from '../../src/services/payments.js'

let ctx: TestContext
let sdk: FakeRazorpay
const completedOrder = vi.fn()

/** Build a fresh app whose payments module uses the fake gateway, sharing one DB. */
async function appWithGateway(gateway?: PaymentsGateway) {
  const { db, pglite } = await createTestDb()
  const tokens = new Map<string, VerifiedToken>([
    [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
    [USER_B.token, { uid: USER_B.uid, phoneNumber: USER_B.phoneNumber }],
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
    analytics: {
      enabled: true,
      userProfileUpdated: () => {},
      orderCompleted: completedOrder,
      flush: async () => {},
    },
    ...(gateway ? { paymentsGateway: gateway } : {}),
  })
  await app.ready()
  return { app, db, pglite }
}

beforeEach(async () => {
  sdk = new FakeRazorpay()
  // Module-level state, so it outlives the per-test app. Every case here reuses
  // `order_TEST0001`, and a leftover entry would suppress the very gateway call
  // the next case asserts on.
  resetGatewayPollThrottle()
  const built = await appWithGateway(fakeGateway(sdk))
  ctx = { app: built.app, db: built.db, pglite: built.pglite, tokens: new Map() }
  await ctx.db.insert(catalogItems).values([
    {
      sku: SKU_A,
      productId: 'aloe-gel',
      name: 'Aloe Vera Gel',
      size: '100g',
      priceInr: 249,
      imageUrl: '/products/aloe.jpg',
      active: true,
    },
    {
      sku: SKU_B,
      productId: 'rose-water',
      name: 'Rose Water',
      size: '200ml',
      priceInr: 199,
      imageUrl: '/products/rose.jpg',
      active: true,
    },
  ])
  // The legal Gujarat-only fence (services/shipping.ts checkOrderDestination)
  // now runs on EVERY order-create, independent of `shipping.enabled` — so the
  // shared default test address (below) has to resolve to an in-fence state,
  // or every order-creation test in this file 422s regardless of what it's
  // actually testing.
  await ctx.db.insert(pincodes).values({
    pincode: '380015',
    officeName: 'Satellite',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
  })
  await ctx.db.insert(appConfig).values({
    key: 'shipping.serviceableStates',
    value: ['Gujarat'],
    description: '',
  })
})

afterEach(async () => {
  await ctx.app.close()
  vi.restoreAllMocks()
})

/** Create a default address for a user and return its id. */
async function createAddress(token: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/addresses',
    headers: auth(token),
    payload: {
      name: 'Asha Rao',
      phone: '9876543210',
      pincode: '380015',
      city: 'Ahmedabad',
      state: 'Gujarat',
      houseNumber: '12B',
      roadArea: 'Satellite Road',
      isDefault: true,
    },
  })
  return res.json().id as string
}

/** Add a cart line for USER_A. */
async function addLine(sku: string, qty: number, token: string = USER_A.token) {
  return ctx.app.inject({
    method: 'PUT',
    url: `/v1/cart/items/${sku}`,
    headers: auth(token),
    payload: { qty },
  })
}

/** Create an order for USER_A with a stocked cart; returns the response. */
async function createOrder(token = USER_A.token, qty = 2) {
  const addressId = await createAddress(token)
  await addLine(SKU_A, qty, token)
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/orders',
    headers: auth(token),
    payload: { addressId },
  })
}

describe('auth gate', () => {
  it.each([
    ['POST', '/v1/payments/orders'],
    ['POST', '/v1/payments/verify'],
    ['GET', '/v1/payments/orders/order_x'],
    ['POST', '/v1/payments/recover'],
  ] as const)('401s %s %s without a token', async (method, url) => {
    const res = await ctx.app.inject({ method, url })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })
})

describe('POST /v1/payments/orders', () => {
  it('201s with a server-priced order and inserts a pending row', async () => {
    const res = await createOrder(USER_A.token, 2) // 2 × 249 = 498 INR

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({
      orderId: 'order_TEST0001',
      keyId: KEY_ID,
      amountInr: 498,
      amountPaise: 49800,
      currency: 'INR',
      status: 'pending',
      mode: 'test',
    })
    // The amount handed to Razorpay is server-computed paise, never client-sent.
    expect(sdk.createCalls).toEqual([{ amount: 49800, currency: 'INR' }])

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
    expect(row?.amountPaise).toBe(49800)
  })

  // The checkout tick-box is where nearly all marketing consent will come
  // from, so this covers BOTH halves of the split: the frozen evidence in
  // `consent_snapshot` and the live state a send actually reads.
  it('records a checkout marketing opt-in as both evidence and live state', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, marketingWhatsappOptIn: true },
    })
    expect(res.statusCode).toBe(201)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.consentSnapshot).toMatchObject({
      accepted: true,
      marketingWhatsapp: { accepted: true },
    })

    const [user] = await ctx.db.select().from(users).where(eq(users.id, row!.userId))
    expect(user?.marketingWhatsappOptIn).toBe(true)
    expect(user?.marketingWhatsappOptInAt).toBeInstanceOf(Date)
  })

  // Ticking nothing is not consent, and it is not a refusal either. The
  // snapshot must be able to tell "declined" from "never asked" later, so an
  // absent field writes NEITHER key — the user row stays null.
  it('leaves consent untouched when the checkout box was never ticked', async () => {
    const res = await createOrder(USER_A.token, 1)
    expect(res.statusCode).toBe(201)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.consentSnapshot).not.toHaveProperty('marketingWhatsapp')

    const [user] = await ctx.db.select().from(users).where(eq(users.id, row!.userId))
    expect(user?.marketingWhatsappOptIn).toBeNull()
  })

  // An explicit "no" is a real answer and must be recorded as one — it is what
  // separates a shopper who declined from one who was never asked.
  it('records an explicit decline as false, not as never-asked', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, marketingWhatsappOptIn: false },
    })
    expect(res.statusCode).toBe(201)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.consentSnapshot).toMatchObject({ marketingWhatsapp: { accepted: false } })

    const [user] = await ctx.db.select().from(users).where(eq(users.id, row!.userId))
    expect(user?.marketingWhatsappOptIn).toBe(false)
  })

  // Ad-audience consent is a separate purpose: ticking it must not touch the
  // WhatsApp flag, and it must land in its own snapshot key.
  it('records ad-audience consent independently of WhatsApp consent', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, adAudienceOptIn: true },
    })
    expect(res.statusCode).toBe(201)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.consentSnapshot).toMatchObject({ adAudience: { accepted: true } })
    expect(row?.consentSnapshot).not.toHaveProperty('marketingWhatsapp')

    const [user] = await ctx.db.select().from(users).where(eq(users.id, row!.userId))
    expect(user?.adAudienceOptIn).toBe(true)
    expect(user?.adAudienceOptInAt).toBeInstanceOf(Date)
    expect(user?.marketingWhatsappOptIn).toBeNull()
  })

  it('prices a WHOLESALE cart at the discounted total (same rule as cart)', async () => {
    await ctx.db.insert(await import('../../src/db/schema.js').then((m) => m.appConfig)).values([
      { key: 'wholesale.enabled', value: true, description: 'test' },
      { key: 'wholesale.thresholdInr', value: 1000, description: 'test' },
      { key: 'wholesale.discountPct', value: 10, description: 'test' },
    ])
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 5) // 5 × 249 = 1245 ≥ 1000 → wholesale 224/line → 1120

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBe(5 * 224)
    expect(res.json().amountPaise).toBe(5 * 224 * 100)
    expect(sdk.createCalls[0]?.amount).toBe(5 * 224 * 100)
  })

  it('prices a coupon into the charged amount (re-resolved server-side from `couponCode`)', async () => {
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
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 2) // 2 × 249 = 498

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, couponCode: 'direct15' },
    })
    expect(res.statusCode).toBe(201)
    // round(498 * 0.15) = 74.7 -> 75
    expect(res.json().amountInr).toBe(498 - 75)
    expect(res.json().amountPaise).toBe((498 - 75) * 100)
    expect(sdk.createCalls[0]?.amount).toBe((498 - 75) * 100)
  })

  it('ignores an unknown `couponCode` and charges the plain subtotal (never throws)', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 2) // 498

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, couponCode: 'GHOST' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBe(498)
  })

  it('prices only the selected `skus`, leaving the rest of the cart untouched by the order', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 2) // 2 × 249 = 498
    await addLine(SKU_B, 1) // 199, deselected — not part of this order

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, skus: [SKU_A] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBe(498)
    expect(sdk.createCalls[0]?.amount).toBe(49800)

    // Both lines are still in the cart — the order only priced SKU_A.
    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(
      cart
        .json()
        .items.map((i: { sku: string }) => i.sku)
        .sort()
    ).toEqual([SKU_A, SKU_B].sort())
  })

  it('422s validation_failed when `skus` selects nothing present in the cart', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, skus: [SKU_B] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s validation_failed for an empty cart', async () => {
    const addressId = await createAddress(USER_A.token)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it("404s for another user's addressId", async () => {
    const foreignAddressId = await createAddress(USER_B.token)
    await addLine(SKU_A, 1)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId: foreignAddressId },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('422s for unknown body fields (strict)', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, amount: 1 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('freezes a true consent snapshot onto the order row (consent is captured at login, not checkout)', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })
    expect(res.statusCode).toBe(201)

    const [row] = await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, res.json().orderId))
    const consentSnapshot = row?.consentSnapshot as { accepted: boolean; acceptedAt: string }
    expect(consentSnapshot.accepted).toBe(true)
    expect(new Date(consentSnapshot.acceptedAt).getTime()).not.toBeNaN()
  })
})

describe('POST /v1/payments/verify', () => {
  it('emits frozen campaign and identity only once after a paid transition, including replay', async () => {
    completedOrder.mockClear()
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: {
        addressId,
        anonymousId: 'anonymous-checkout-fixture',
        attribution: {
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'commerce-fixture',
          utmContent: 'texture-fixture',
        },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(completedOrder).not.toHaveBeenCalled()
    const orderId = created.json().orderId as string
    const payload = {
      razorpayOrderId: orderId,
      razorpayPaymentId: 'pay_TEST0001',
      razorpaySignature: verifySignature(orderId, 'pay_TEST0001'),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const verified = await ctx.app.inject({
        method: 'POST',
        url: '/v1/payments/verify',
        headers: auth(USER_A.token),
        payload,
      })
      expect(verified.statusCode).toBe(200)
    }
    expect(completedOrder).toHaveBeenCalledOnce()
    expect(completedOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        anonymousId: 'anonymous-checkout-fixture',
        userId: expect.any(String),
        campaign: {
          source: 'google',
          medium: 'cpc',
          name: 'commerce-fixture',
          content: 'texture-fixture',
        },
      })
    )
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, orderId))
    expect(row?.status).toBe('paid')
    expect(completedOrder.mock.calls[0]![0].userId).toBe(row?.userId)
  })

  it('transitions to paid and clears the cart on a valid signature', async () => {
    await createOrder()
    const paymentId = 'pay_TEST0001'
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: paymentId,
        razorpaySignature: verifySignature('order_TEST0001', paymentId),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orderId: 'order_TEST0001', status: 'paid' })

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('paid')
    expect(row?.razorpayPaymentId).toBe(paymentId)
    expect(row?.paidAt).not.toBeNull()

    // Cart cleared in the same transaction.
    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(cart.json().items).toEqual([])
  })

  it('clears only the ordered skus, leaving a deselected line in the cart', async () => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 2)
    await addLine(SKU_B, 1) // deselected at checkout — must survive payment
    const orderRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, skus: [SKU_A] },
    })
    expect(orderRes.statusCode).toBe(201)
    const orderId = orderRes.json().orderId as string
    const paymentId = 'pay_PARTIAL1'

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: verifySignature(orderId, paymentId),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('paid')

    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(cart.json().items).toHaveLength(1)
    expect(cart.json().items[0].sku).toBe(SKU_B)
  })

  it('400s signature_invalid and leaves the row untouched on a bad signature', async () => {
    await createOrder()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: 'deadbeef',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('signature_invalid')

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')

    // Cart is NOT cleared.
    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(cart.json().items).toHaveLength(1)
  })

  it('400s on an equal-length wrong signature (timingSafeEqual false branch)', async () => {
    await createOrder()
    const real = verifySignature('order_TEST0001', 'pay_TEST0001')
    // Same 64-hex-char length as the real digest, but wrong bytes: passes the
    // length pre-check, fails crypto.timingSafeEqual.
    const wrongSameLength = 'f'.repeat(64)
    expect(wrongSameLength).toHaveLength(real.length)
    expect(wrongSameLength).not.toBe(real)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: wrongSameLength,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('signature_invalid')
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('is a no-op on replay (already paid → still paid)', async () => {
    await createOrder()
    const payload = {
      razorpayOrderId: 'order_TEST0001',
      razorpayPaymentId: 'pay_TEST0001',
      razorpaySignature: verifySignature('order_TEST0001', 'pay_TEST0001'),
    }
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload,
    })
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload,
    })
    expect(first.json().status).toBe('paid')
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('paid')
  })

  it("404s for another user's order (no cross-user access)", async () => {
    await createOrder(USER_A.token)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_B.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: verifySignature('order_TEST0001', 'pay_TEST0001'),
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('POST /v1/payments/webhook', () => {
  /** Inject a webhook with a correctly-signed raw body. */
  async function postWebhook(event: unknown, signature?: string) {
    const raw = JSON.stringify(event)
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature ?? webhookSignature(raw),
      },
      payload: raw,
    })
  }

  /** `currency: null` omits the field entirely (absent-currency events must be mismatches). */
  function capturedEvent(
    orderId: string,
    amountPaise: number,
    paymentId = 'pay_WH1',
    currency: string | null = 'INR'
  ) {
    return {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: amountPaise,
            ...(currency === null ? {} : { currency }),
          },
        },
      },
    }
  }

  it('transitions to paid on a valid payment.captured (raw-body signature)', async () => {
    await createOrder()
    const res = await postWebhook(capturedEvent('order_TEST0001', 49800))
    expect(res.statusCode).toBe(200)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('paid')
    expect(row?.razorpayPaymentId).toBe('pay_WH1')

    // Cart cleared for the user.
    const cart = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(cart.json().items).toEqual([])
  })

  it('is a no-op on webhook replay (paid stays paid, cart stays empty)', async () => {
    await createOrder()
    await postWebhook(capturedEvent('order_TEST0001', 49800))
    const second = await postWebhook(capturedEvent('order_TEST0001', 49800))
    expect(second.statusCode).toBe(200)
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('paid')
  })

  it('400s on a bad signature and does NOT transition', async () => {
    await createOrder()
    const res = await postWebhook(capturedEvent('order_TEST0001', 49800), 'not-a-real-signature')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('signature_invalid')
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('400s on a missing signature', async () => {
    await createOrder()
    const raw = JSON.stringify(capturedEvent('order_TEST0001', 49800))
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('signature_invalid')
  })

  it('does NOT transition on an amount mismatch (still 200, row stays pending)', async () => {
    await createOrder()
    // Wrong amount: stored is 49800.
    const res = await postWebhook(capturedEvent('order_TEST0001', 100))
    expect(res.statusCode).toBe(200) // valid signature → always 200
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('does NOT transition on a currency mismatch (correct amount, wrong currency)', async () => {
    await createOrder()
    const res = await postWebhook(capturedEvent('order_TEST0001', 49800, 'pay_WH1', 'USD'))
    expect(res.statusCode).toBe(200) // valid signature → always 200
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('treats an ABSENT currency field as a mismatch (no transition)', async () => {
    await createOrder()
    const res = await postWebhook(capturedEvent('order_TEST0001', 49800, 'pay_WH1', null))
    expect(res.statusCode).toBe(200)
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('400s on an equal-length wrong signature (timingSafeEqual false branch)', async () => {
    await createOrder()
    const raw = JSON.stringify(capturedEvent('order_TEST0001', 49800))
    // Same 64-hex-char length as a real HMAC-SHA256 hex digest, but wrong bytes:
    // passes the length pre-check, fails crypto.timingSafeEqual.
    const wrongSameLength = '0'.repeat(64)
    expect(wrongSameLength).toHaveLength(webhookSignature(raw).length)
    expect(wrongSameLength).not.toBe(webhookSignature(raw))
    const res = await postWebhook(capturedEvent('order_TEST0001', 49800), wrongSameLength)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('signature_invalid')
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
  })

  it('transitions pending → failed on payment.failed', async () => {
    await createOrder()
    const res = await postWebhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_F1', order_id: 'order_TEST0001', amount: 49800 } } },
    })
    expect(res.statusCode).toBe(200)
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('failed')
  })

  it('transitions paid → refunded on refund.processed (order_id on the refund entity)', async () => {
    await createOrder()
    await postWebhook(capturedEvent('order_TEST0001', 49800)) // → paid
    // Realistic shape: refund.processed carries its data under payload.refund.entity
    // (order_id lives there), with NO payload.payment.entity.
    const res = await postWebhook({
      event: 'refund.processed',
      payload: {
        refund: {
          entity: { id: 'rfnd_1', order_id: 'order_TEST0001', payment_id: 'pay_WH1' },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('refunded')
  })

  it('refund.processed falls back to razorpay_payment_id when no order_id is present', async () => {
    await createOrder()
    await postWebhook(capturedEvent('order_TEST0001', 49800)) // → paid, stores razorpayPaymentId 'pay_WH1'
    // Payload identifies only the payment (no order_id anywhere) — the row is
    // still found via the stored razorpay_payment_id.
    const res = await postWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_WH1' } } },
    })
    expect(res.statusCode).toBe(200)
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('refunded')
  })
})

describe('GET /v1/payments/orders/:orderId', () => {
  it('200s with the own order status', async () => {
    await createOrder()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      orderId: 'order_TEST0001',
      status: 'pending',
      amountInr: 498,
    })
  })

  it("404s for another user's order", async () => {
    await createOrder(USER_A.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('404s for an unknown order id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_NOPE',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  /**
   * The live reconciliation the UPI intent flow depends on. That flow returns
   * no signature, so there is no `verify` call: without this, a late or lost
   * `payment.captured` webhook leaves a shopper who HAS paid staring at a
   * spinner until it times out.
   */
  describe('live gateway reconciliation', () => {
    /** Move the row into the window where the poll is allowed to ask Razorpay. */
    const ageRowMs = (ms: number) =>
      ctx.db
        .update(payments)
        .set({ createdAt: new Date(Date.now() - ms) })
        .where(eq(payments.orderId, 'order_TEST0001'))

    const poll = () =>
      ctx.app.inject({
        method: 'GET',
        url: '/v1/payments/orders/order_TEST0001',
        headers: auth(USER_A.token),
      })

    it('reports paid — and transitions the row — when the gateway has the capture', async () => {
      await createOrder()
      await ageRowMs(30_000)
      sdk.paymentsByOrder.set('order_TEST0001', [
        { id: 'pay_POLL1', status: 'captured', amount: 49800, currency: 'INR' },
      ])

      const res = await poll()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ orderId: 'order_TEST0001', status: 'paid' })

      const [row] = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.orderId, 'order_TEST0001'))
      expect(row?.status).toBe('paid')
      expect(row?.razorpayPaymentId).toBe('pay_POLL1')
    })

    it("logs the attempt as observed by 'poll', not by the sweep", async () => {
      await createOrder()
      await ageRowMs(30_000)
      sdk.paymentsByOrder.set('order_TEST0001', [
        { id: 'pay_POLL2', status: 'captured', amount: 49800, currency: 'INR' },
      ])
      await poll()

      const attempts = await ctx.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, 'order_TEST0001'))
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ observedBy: 'poll', status: 'captured' })
    })

    it('stays pending when the gateway has no captured payment', async () => {
      await createOrder()
      await ageRowMs(30_000)

      const res = await poll()
      expect(res.json().status).toBe('pending')
      expect(sdk.fetchPaymentsCalls).toEqual(['order_TEST0001'])
    })

    it('NEVER transitions on an amount mismatch — money exists, but not ours', async () => {
      await createOrder() // stored 49800
      await ageRowMs(30_000)
      sdk.paymentsByOrder.set('order_TEST0001', [
        { id: 'pay_POLL3', status: 'captured', amount: 100, currency: 'INR' },
      ])

      const res = await poll()
      expect(res.json().status).toBe('pending')
      const [row] = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.orderId, 'order_TEST0001'))
      expect(row?.status).toBe('pending')
    })

    it('does not call the gateway for an order created moments ago', async () => {
      await createOrder()
      const res = await poll()
      expect(res.json().status).toBe('pending')
      expect(sdk.fetchPaymentsCalls).toEqual([])
    })

    it('does not call the gateway once the row is old enough for the sweep', async () => {
      await createOrder()
      await ageRowMs(20 * 60 * 1000)
      sdk.paymentsByOrder.set('order_TEST0001', [
        { id: 'pay_POLL4', status: 'captured', amount: 49800, currency: 'INR' },
      ])

      const res = await poll()
      // The capture IS there — the sweep will find it. This endpoint must not
      // duplicate a scheduled job on every poll of a long-abandoned order.
      expect(res.json().status).toBe('pending')
      expect(sdk.fetchPaymentsCalls).toEqual([])
    })

    it('asks at most once per throttle interval, however fast the client polls', async () => {
      await createOrder()
      await ageRowMs(30_000)

      await poll()
      await poll()
      await poll()
      expect(sdk.fetchPaymentsCalls).toEqual(['order_TEST0001'])
    })

    it('still answers with the stored status when the gateway throws', async () => {
      await createOrder()
      await ageRowMs(30_000)
      sdk.api.orders.fetchPayments = () => Promise.reject(new Error('razorpay down'))

      const res = await poll()
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toBe('pending')
    })
  })
})

describe('POST /v1/payments/orders/:orderId/upi/intent', () => {
  const url = '/v1/payments/orders/order_TEST0001/upi/intent'

  it('201s with the intent link, per-app deep links, and the order amount', async () => {
    await createOrder() // 2 × 249 = 498 INR
    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({
      orderId: 'order_TEST0001',
      paymentId: 'pay_UPI00001',
      intentUrl: UPI_LINK,
      amountInr: 498,
      amountPaise: 49800,
      currency: 'INR',
      expiresInMinutes: 5,
    })
    // Every app link is the SAME payment — the query string is carried across
    // untouched, only the scheme+path change.
    expect(body.apps).toEqual([
      {
        app: 'gpay',
        url: `tez://upi/pay${UPI_QUERY}`,
        androidPackage: 'com.google.android.apps.nbu.paisa.user',
      },
      { app: 'phonepe', url: `phonepe://pay${UPI_QUERY}`, androidPackage: 'com.phonepe.app' },
      { app: 'paytm', url: `paytmmp://pay${UPI_QUERY}`, androidPackage: 'net.one97.paytm' },
      { app: 'bhim', url: `bhim://pay${UPI_QUERY}`, androidPackage: 'in.org.npci.upiapp' },
    ])
  })

  it("sends Razorpay the stored amount and the caller's own phone, never client input", async () => {
    await createOrder()
    await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })

    expect(sdk.upiCalls).toHaveLength(1)
    expect(sdk.upiCalls[0]).toMatchObject({
      amount: 49800,
      currency: 'INR',
      order_id: 'order_TEST0001',
      method: 'upi',
      contact: USER_A.phoneNumber,
      // Nullable `users.email` → Razorpay's documented placeholder, not a blank.
      email: 'void@razorpay.com',
      upi: { flow: 'intent', expiry_time: 5 },
    })
  })

  it('leaves the order pending — an intent transitions nothing', async () => {
    await createOrder()
    await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending')
    expect(row?.razorpayPaymentId).toBeNull()
  })

  it('opens a second attempt when called again (an expired link is replaced)', async () => {
    await createOrder()
    await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })
    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })

    expect(res.statusCode).toBe(201)
    expect(sdk.upiCalls).toHaveLength(2)
  })

  it("404s for another user's order", async () => {
    await createOrder(USER_A.token)
    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_B.token) })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
    expect(sdk.upiCalls).toHaveLength(0)
  })

  it('409s once the order is no longer pending (never double-charge)', async () => {
    await createOrder()
    await ctx.db
      .update(payments)
      .set({ status: 'paid' })
      .where(eq(payments.orderId, 'order_TEST0001'))

    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })
    expect(res.statusCode).toBe(409)
    expect(sdk.upiCalls).toHaveLength(0)
  })

  it('422s when Razorpay refuses to open the payment (e.g. S2S not enabled)', async () => {
    await createOrder()
    sdk.upiError = {
      statusCode: 400,
      error: { code: 'BAD_REQUEST_ERROR', description: 'The feature is not enabled' },
    }
    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })

    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('The feature is not enabled')
  })

  it('503s when the intent kill switch is off, so the client falls back to Checkout', async () => {
    await createOrder()
    await ctx.db
      .insert(appConfig)
      .values({ key: 'payments.upiIntent.enabled', value: false, description: '' })

    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('payments_disabled')
    expect(sdk.upiCalls).toHaveLength(0)
  })

  it('honours a configured link expiry', async () => {
    await createOrder()
    await ctx.db
      .insert(appConfig)
      .values({ key: 'payments.upiIntent.expiryMinutes', value: 9, description: '' })

    const res = await ctx.app.inject({ method: 'POST', url, headers: auth(USER_A.token) })
    expect(res.json().expiresInMinutes).toBe(9)
    expect(sdk.upiCalls[0]).toMatchObject({ upi: { expiry_time: 9 } })
  })

  it('401s without a token', async () => {
    const res = await ctx.app.inject({ method: 'POST', url })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /v1/payments/orders (history)', () => {
  it('lists only terminal orders, newest first, with joined item details', async () => {
    // order 1: paid
    await createOrder(USER_A.token, 2) // 2 × 249 = 498
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: verifySignature('order_TEST0001', 'pay_TEST0001'),
      },
    })

    // order 2: still pending — must be excluded from history
    sdk.nextOrderId = 'order_TEST0002'
    await createOrder(USER_A.token, 1)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const { orders } = res.json()
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      orderId: 'order_TEST0001',
      status: 'paid',
      totalInr: 498,
      currency: 'INR',
      items: [
        {
          sku: SKU_A,
          name: 'Aloe Vera Gel',
          size: '100g',
          imageUrl: '/products/aloe.jpg',
          qty: 2,
          priceInr: 249,
        },
      ],
    })
    expect(orders[0].paidAt).not.toBeNull()
  })

  it("never returns another user's orders", async () => {
    await createOrder(USER_A.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orders).toEqual([])
  })

  it('401s without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/payments/orders' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /v1/payments/orders/:orderId/details', () => {
  it("200s with items and the order's shipping address", async () => {
    await createOrder(USER_A.token, 2)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: verifySignature('order_TEST0001', 'pay_TEST0001'),
      },
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/details',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      orderId: 'order_TEST0001',
      status: 'paid',
      totalInr: 498,
      items: [{ sku: SKU_A, name: 'Aloe Vera Gel', qty: 2 }],
      address: { name: 'Asha Rao', phone: '9876543210', pincode: '380015' },
    })
  })

  it('404s while the order is still pending', async () => {
    await createOrder()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/details',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it("404s for another user's order", async () => {
    await createOrder(USER_A.token)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: auth(USER_A.token),
      payload: {
        razorpayOrderId: 'order_TEST0001',
        razorpayPaymentId: 'pay_TEST0001',
        razorpaySignature: verifySignature('order_TEST0001', 'pay_TEST0001'),
      },
    })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/details',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('404s for an unknown order id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_NOPE/details',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /v1/payments/orders/:orderId/invoice', () => {
  async function seedSeller() {
    await ctx.db.insert(appConfig).values({
      key: 'legal.company',
      value: { legalName: 'Adix AI', address: 'Ahmedabad, Gujarat 380051' },
      description: '',
    })
  }

  it('200s with itemised lines, seller, and buyer address for a paid order — no GST/GSTIN fields', async () => {
    await seedSeller()
    await createOrder(USER_A.token, 2)
    await payOrder()

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      orderId: 'order_TEST0001',
      status: 'paid',
      seller: { legalName: 'Adix AI', address: 'Ahmedabad, Gujarat 380051' },
      buyerAddress: { name: 'Asha Rao', phone: '9876543210', pincode: '380015' },
      items: [{ sku: SKU_A, name: 'Aloe Vera Gel', qty: 2, priceInr: 249, lineTotalInr: 498 }],
      totalInr: 498,
    })
    const serialized = JSON.stringify(body).toLowerCase()
    expect(serialized).not.toContain('gst')
    expect(serialized).not.toContain('tax invoice')
  })

  it('200s for a refunded order', async () => {
    await seedSeller()
    await createOrder(USER_A.token, 2)
    await payOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'refunded' })
  })

  it('404s while the order is still pending', async () => {
    await seedSeller()
    await createOrder()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('404s for a failed order (nothing was charged)', async () => {
    await seedSeller()
    await createOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      payload: JSON.stringify({
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_TEST0001', order_id: 'order_TEST0001' } } },
      }),
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature(
          JSON.stringify({
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_TEST0001', order_id: 'order_TEST0001' } } },
          })
        ),
      },
    })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("404s for another user's order", async () => {
    await seedSeller()
    await createOrder(USER_A.token)
    await payOrder()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('404s for an unknown order id', async () => {
    await seedSeller()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_NOPE/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('503s invoice_unavailable when `legal.company` is not configured', async () => {
    await createOrder(USER_A.token)
    await payOrder()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('invoice_unavailable')
  })

  it('401s without a token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders/order_TEST0001/invoice',
    })
    expect(res.statusCode).toBe(401)
  })
})

/** Pay for USER_A's default `createOrder()` order via the verify path. */
async function payOrder(orderId = 'order_TEST0001', paymentId = 'pay_TEST0001') {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/verify',
    headers: auth(USER_A.token),
    payload: {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: verifySignature(orderId, paymentId),
    },
  })
}

describe('POST /v1/payments/orders/:orderId/cancel', () => {
  it('cancels a paid order — refunds the full amount and transitions to refunded', async () => {
    await createOrder(USER_A.token, 2) // 2 × 249 = 498 → 49800 paise
    await payOrder()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orderId: 'order_TEST0001', status: 'refunded' })
    expect(sdk.refundCalls).toEqual([{ paymentId: 'pay_TEST0001', amount: 49800 }])

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('refunded')
  })

  it('persists the shopper-picked cancel reason on the row', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
      payload: { reason: 'Wrong size/colour' },
    })
    expect(res.statusCode).toBe(200)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.cancelReason).toBe('Wrong size/colour')
  })

  it('captures an authorized (not yet captured) payment before refunding it', async () => {
    await createOrder(USER_A.token, 2) // 2 × 249 = 498 → 49800 paise
    await payOrder()
    sdk.paymentStatus = 'authorized'

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(sdk.captureCalls).toEqual([
      { paymentId: 'pay_TEST0001', amount: 49800, currency: 'INR' },
    ])
    expect(sdk.refundCalls).toEqual([{ paymentId: 'pay_TEST0001', amount: 49800 }])
  })

  it('is idempotent — cancelling an already-refunded order does not refund twice', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orderId: 'order_TEST0001', status: 'refunded' })
    expect(sdk.refundCalls).toHaveLength(1)
  })

  it('409s cancelling a failed order (nothing to refund)', async () => {
    await createOrder()
    const raw = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { order_id: 'order_TEST0001' } } },
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature(raw),
      },
      payload: raw,
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')
    expect(sdk.refundCalls).toHaveLength(0)
  })

  it('404s while the order is still pending', async () => {
    await createOrder()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("404s for another user's order", async () => {
    await createOrder(USER_A.token)
    await payOrder()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
    expect(sdk.refundCalls).toHaveLength(0)
  })

  it('404s for an unknown order id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_NOPE/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('401s without a token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
    })
    expect(res.statusCode).toBe(401)
  })

  // --- The shipment guard (SPEC-LOGISTICS.md §8.2) --------------------------
  //
  // Paying an order now inserts a `pending_manifest` shipment via the paid
  // hook, so these move that row rather than creating one: the state under test
  // is the one production actually produces.

  async function setShipmentStatus(status: string): Promise<void> {
    await ctx.db
      .update(shipments)
      .set({ status, awb: status === 'pending_manifest' ? null : 'TESTAWB0001' })
      .where(eq(shipments.orderId, 'order_TEST0001'))
  }

  it('still cancels while the shipment is only an unmanifested intent', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(sdk.refundCalls).toHaveLength(1)
  })

  it('voids the unmanifested shipment so the manifest sweep drops the refunded order', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })

    const [row] = await ctx.db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelledAt).not.toBeNull()
  })

  /**
   * `manifested` is packed and labelled but still on our shelf, so it stays
   * self-cancellable (`SELF_CANCELLABLE` in `services/fulfilment.ts`); the
   * refund path recalls the label rather than blocking the shopper.
   */
  it('still cancels while the shipment is manifested but not yet collected', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await setShipmentStatus('manifested')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(sdk.refundCalls).toHaveLength(1)
  })

  it.each(['picked_up', 'in_transit', 'out_for_delivery', 'ndr'])(
    '409s and refunds NOTHING once the parcel is %s',
    async (status) => {
      await createOrder(USER_A.token, 2)
      await payOrder()
      await setShipmentStatus(status)

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/payments/orders/order_TEST0001/cancel',
        headers: auth(USER_A.token),
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.message).toMatch(/courier/i)
      // The whole point: no money moved and the row is untouched.
      expect(sdk.refundCalls).toHaveLength(0)
      const [row] = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.orderId, 'order_TEST0001'))
      expect(row?.status).toBe('paid')
    }
  )

  it('409s with delivery-specific copy once the parcel is delivered', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await setShipmentStatus('delivered')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toMatch(/delivered/i)
    expect(sdk.refundCalls).toHaveLength(0)
  })

  it('allows cancelling again once ops has cancelled the shipment with the carrier', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await setShipmentStatus('cancelled')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(sdk.refundCalls).toHaveLength(1)
  })

  it('stays idempotent for an already-refunded order even after it shipped', async () => {
    // A retried request must not start 409ing just because the parcel moved on
    // between the first cancel and the retry — the refund already happened.
    await createOrder(USER_A.token, 2)
    await payOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    await setShipmentStatus('in_transit')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orderId: 'order_TEST0001', status: 'refunded' })
    expect(sdk.refundCalls).toHaveLength(1)
  })

  it("issues no credit note — no legal.company config, so no invoice exists to reverse (today's real state)", async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })

    const rows = await ctx.db.select().from(creditNotes)
    expect(rows).toHaveLength(0)
  })
})

/**
 * Credit-note issuance on the refund transition (Phase 2.6). Own describe
 * block: needs `legal.company` registered + `registeredStateName` + a
 * catalog item carrying a real `hsnCode`/`gstRatePct`, none of which the
 * file's default `beforeEach` seeds — the rest of this file deliberately
 * exercises the dormant (`legal.company` unconfigured) state.
 */
describe('credit notes on the refund transition (Phase 2.6)', () => {
  beforeEach(async () => {
    await ctx.db
      .update(catalogItems)
      .set({ hsnCode: '3305.90', gstRatePct: 18 })
      .where(eq(catalogItems.sku, SKU_A))
    await ctx.db.insert(appConfig).values([
      {
        key: 'legal.company',
        value: {
          legalName: 'Adix AI',
          brand: 'Laanya',
          address:
            '3, Qamar Makhdumi Road, near Noori Masjid, Bhuli Road, Wasseypur, Dhanbad, Jharkhand 826001',
          jurisdictionCity: 'Dhanbad',
          jurisdictionState: 'Jharkhand',
          gstRegistered: true,
          gstin: '20AAAAA0000A1Z5',
          registeredStateName: 'Jharkhand',
          supportEmail: 'hello@adix.ai',
        },
        description: '',
      },
      {
        key: 'legal.manufacturer',
        value: {
          legalName: 'Saman Products Company',
          address: '4/B Al-Farooq Com Housing Society, Sarkhej, Ahmedabad, Gujarat 380051',
          licence: 'GC1299',
        },
        description: '',
      },
    ])
  })

  it('cancel issues a docVersion 2 invoice, then a matching credit note on refund', async () => {
    await createOrder(USER_A.token, 2) // 2 × 249 = 498 → 49800 paise
    await payOrder()

    const [invoiceRow] = await ctx.db
      .select()
      .from(invoices)
      .where(eq(invoices.orderId, 'order_TEST0001'))
    expect(invoiceRow).toBeDefined()
    expect((invoiceRow!.document as InvoiceDocument).docVersion).toBe(2)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
      payload: { reason: 'Wrong size/colour' },
    })
    expect(res.statusCode).toBe(200)

    const rows = await ctx.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.orderId, 'order_TEST0001'))
    expect(rows).toHaveLength(1)
    const note = rows[0]!
    expect(note.invoiceNumber).toBe(invoiceRow!.invoiceNumber)
    expect(note.totalPaise).toBe(invoiceRow!.totalPaise)
    const doc = note.document as CreditNoteDocument
    expect(doc.docVersion).toBe(2)
    expect(doc.title).toBe('CREDIT NOTE')
    expect(doc.originalInvoiceNumber).toBe(invoiceRow!.invoiceNumber)
    expect(doc.reason).toBe('Wrong size/colour')
    expect(doc.lines).toHaveLength((invoiceRow!.document as InvoiceDocument).lines.length)
  })

  it('a Razorpay dashboard refund (refund.processed webhook) issues the same credit note, no self-service cancel involved', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()

    const raw = JSON.stringify({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_1', order_id: 'order_TEST0001' } } },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature(raw),
      },
      payload: raw,
    })
    expect(res.statusCode).toBe(200)

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('refunded')

    const rows = await ctx.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.orderId, 'order_TEST0001'))
    expect(rows).toHaveLength(1)
    expect((rows[0]!.document as CreditNoteDocument).reason).toBe('Refund issued')
  })

  it('is idempotent — cancelling twice issues exactly one credit note', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(second.statusCode).toBe(200)

    const rows = await ctx.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.orderId, 'order_TEST0001'))
    expect(rows).toHaveLength(1)
  })

  it('is idempotent — a self-service cancel followed by a replayed refund.processed webhook does not double-issue', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })

    const raw = JSON.stringify({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_1', order_id: 'order_TEST0001' } } },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature(raw),
      },
      payload: raw,
    })
    expect(res.statusCode).toBe(200)

    const rows = await ctx.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.orderId, 'order_TEST0001'))
    expect(rows).toHaveLength(1)
  })
})

describe('POST /v1/payments/recover (admin)', () => {
  it('403s for a non-admin caller', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/recover',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
  })

  it('reconciles a stale pending order with a captured payment → paid', async () => {
    await createOrder()
    // Age the row past the 15-min stale window.
    const staleCreatedAt = new Date(Date.now() - 20 * 60 * 1000)
    await ctx.db
      .update(payments)
      .set({ createdAt: staleCreatedAt })
      .where(eq(payments.orderId, 'order_TEST0001'))
    sdk.paymentsByOrder.set('order_TEST0001', [
      { id: 'pay_REC1', status: 'captured', amount: 49800, currency: 'INR' },
    ])

    // Promote USER_ADMIN.
    await ctx.app.inject({ method: 'GET', url: '/v1/cart', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/recover',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ scanned: 1, paid: 1, mismatched: 0 })
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('paid')
  })

  it('leaves a >24h-old row PENDING (not failed) when the captured amount mismatches', async () => {
    await createOrder()
    // Age the row past the 24-hour expiry window — the mismatch branch must
    // still win over the expiry branch (money exists; never mark it failed).
    const expiredCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await ctx.db
      .update(payments)
      .set({ createdAt: expiredCreatedAt })
      .where(eq(payments.orderId, 'order_TEST0001'))
    // Captured, but the wrong amount (stored is 49800).
    sdk.paymentsByOrder.set('order_TEST0001', [
      { id: 'pay_REC2', status: 'captured', amount: 100, currency: 'INR' },
    ])

    await ctx.app.inject({ method: 'GET', url: '/v1/cart', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/recover',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ scanned: 1, paid: 0, failed: 0, mismatched: 1, stillPending: 0 })
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.status).toBe('pending') // left for manual review, NOT failed
  })
})

describe('graceful degrade — 503 payments_disabled', () => {
  it('503s on POST /orders when Razorpay is not configured', async () => {
    // Build an app with NO gateway.
    const { app } = await appWithGateway(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('payments_disabled')
    await app.close()
  })

  it('503s on the webhook when the secret is not configured', async () => {
    const { app } = await appWithGateway(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'x' },
      payload: JSON.stringify({ event: 'payment.captured' }),
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('payments_disabled')
    await app.close()
  })

  it('503s when the payments.enabled config kill switch is off', async () => {
    const { appConfig } = await import('../../src/db/schema.js')
    await ctx.db
      .insert(appConfig)
      .values({ key: 'payments.enabled', value: false, description: 'kill' })
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, 1)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('payments_disabled')
  })
})

/**
 * SPEC-PAYMENTS.md DoD #4 — the webhook's scoped raw-body parser must NOT leak
 * into the rest of the app: a normal JSON route must still parse JSON.
 */
describe('scoped raw-body parser regression', () => {
  it('other routes still parse JSON normally (cart PUT works)', async () => {
    const res = await addLine(SKU_A, 3)
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0].qty).toBe(3)
  })

  it('the authed payments JSON routes still parse JSON (verify reads the body)', async () => {
    await createOrder()
    // A malformed-but-present JSON body still reaches Zod (proves JSON parsing,
    // not buffer parsing, is active on this scope).
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { ...auth(USER_A.token), 'content-type': 'application/json' },
      payload: { razorpayOrderId: 'order_TEST0001' }, // missing required fields
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })
})

/**
 * Delivery fees at checkout (docs/SPEC-SHIPPING.md §6.4). Three properties, and
 * each of them is the difference between a working shop and a quiet leak:
 *
 * - The amount charged includes the fee resolved from the ORDER'S OWN address.
 * - A destination we cannot serve is refused (422) and creates NO payment row —
 *   rather than being sold, charged, and discovered at the packing bench.
 * - A stale quote token is a 409, so a fee that moved between the cart screen
 *   and checkout is re-confirmed instead of silently charged.
 */
describe('delivery fees at checkout', () => {
  const GUJARAT_PIN = '395003'

  /** Turn shipping on with a one-courier, one-node, Zone-B-only world. */
  async function enableShipping(): Promise<void> {
    await ctx.db.update(catalogItems).set({ weightG: 220, lengthCm: 6, widthCm: 6, heightCm: 12 })

    await ctx.db.insert(pincodes).values([
      {
        pincode: '380001',
        officeName: 'Ahmedabad GPO',
        taluk: 'Ahmadabad City',
        district: 'Ahmadabad',
        state: 'Gujarat',
      },
      {
        pincode: GUJARAT_PIN,
        officeName: 'Nanpura',
        taluk: 'Surat City',
        district: 'Surat',
        state: 'Gujarat',
      },
    ])
    await ctx.db.insert(pickupNodes).values({
      code: 'AHM-01',
      name: 'Ahmedabad',
      pincode: '380001',
      state: 'Gujarat',
      isActive: true,
    })
    await ctx.db.insert(couriers).values({
      code: 'delhivery',
      name: 'Delhivery Surface',
      fuelBps: 1100,
      gstBps: 1800,
      docketFeeInr: 5,
    })
    await ctx.db.insert(courierRateSlabs).values({
      courierCode: 'delhivery',
      zone: 'B',
      uptoG: 2000,
      rateInr: 140,
      addlPerG: 1000,
      addlRateInr: 60,
    })
    await ctx.db.insert(courierServiceAreas).values({
      courierCode: 'delhivery',
      fromPincode: '360001',
      toPincode: '396999',
      isActive: true,
    })
    await ctx.db.insert(appConfig).values([
      { key: 'shipping.enabled', value: true, description: '' },
      // A threshold nothing in this test can reach, so the fee is always live.
      {
        key: 'shipping.freeAboveTiers',
        value: [{ uptoG: 2000, freeAboveInr: 100000 }],
        description: '',
      },
      { key: 'shipping.marginBps', value: 1000, description: '' },
      // `shipping.serviceableStates` is seeded once, globally, in the file's
      // top-level `beforeEach` — the legal fence reads it unconditionally now,
      // so every test needs it present, not just this describe block.
      { key: 'shipping.packagingTareG', value: 60, description: '' },
    ])
  }

  /** An address for USER_A at `pincode`; returns its id. */
  async function addressAt(pincode: string, state: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: {
        name: 'Asha Rao',
        phone: '9876543210',
        pincode,
        city: 'Surat',
        state,
        houseNumber: '12B',
        roadArea: 'Ring Road',
        isDefault: true,
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }

  it('charges the fee resolved from the order address and freezes the snapshot', async () => {
    await enableShipping()
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1) // ₹249 goods

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })

    expect(res.statusCode).toBe(201)
    // Zone B, 2000 g slab: (140 base × 1.11 fuel + 5 docket) × 1.18 GST = ₹189
    // true cost, +10% margin = ₹208.
    expect(res.json()).toMatchObject({ amountInr: 457, amountPaise: 45700 }) // 249 + 208
    expect(sdk.createCalls).toEqual([{ amount: 45700, currency: 'INR' }])

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.shippingSnapshot).toMatchObject({
      nodeCode: 'AHM-01',
      courierCode: 'delhivery',
      zone: 'B',
      customerFeeInr: 208,
      trueCostInr: 189,
      destPincode: GUJARAT_PIN,
    })

    // The frozen cart snapshot has to add up on the order-history screen.
    expect(row?.cartSnapshot).toMatchObject({
      goodsInr: 249,
      couponDiscountInr: 0,
      shippingFeeInr: 208,
      totalInr: 457,
    })
  })

  it('stamps the COD-inclusive cost on the snapshot without moving the fee', async () => {
    // docs/SPEC-COD.md D8. The courier's COD collection charge is real and the
    // margin report must see it — but it must not reach `customerFeeInr`,
    // which is derived from the courier bill. Letting it through would put a
    // delivery surcharge on top of the ₹49 token AND move the fee after the
    // shopper was quoted it, failing the quote-token check on their own order.
    await enableShipping()
    await ctx.db
      .update(couriers)
      .set({ codFlatInr: 40, codBps: 200 })
      .where(eq(couriers.code, 'delhivery'))
    await ctx.db
      .insert(appConfig)
      .values({ key: 'payments.cod.enabled', value: true, description: 'test' })
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1) // ₹249 goods

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, paymentMode: 'cod' },
    })
    expect(res.statusCode).toBe(201)

    // Identical total to the prepaid case above — ₹249 goods + the SAME ₹208
    // fee — and the gateway sees only the ₹49 token.
    expect(res.json()).toMatchObject({ orderTotalInr: 457, amountPaise: 4900, codAmountInr: 408 })

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.shippingSnapshot).toMatchObject({
      customerFeeInr: 208, // unchanged — priced prepaid, as the shopper was shown
      // (140 base × 1.11 fuel + 5 docket + 40 COD) × 1.18 GST = ₹236, vs ₹189
      // on the prepaid order above.
      trueCostInr: 236,
    })
    expect((row?.shippingSnapshot as { cost: { codInr: number } }).cost.codInr).toBe(40)
    expect(row?.cartSnapshot).toMatchObject({ shippingFeeInr: 208, totalInr: 457 })
  })

  it('charges the quoted estimate for an out-of-state pincode absent from the reference table', async () => {
    await enableShipping()
    const addressId = await addressAt('560001', 'Karnataka')
    await addLine(SKU_A, 1)

    const cart = await ctx.app.inject({
      method: 'GET',
      url: `/v1/cart?addressId=${addressId}`,
      headers: auth(USER_A.token),
    })
    const shipping = cart.json().shipping
    expect(shipping).toMatchObject({ estimated: true, reason: null })
    expect(shipping.feeInr).toBeGreaterThan(0)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, quoteToken: shipping.quoteToken },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBe(249 + shipping.feeInr)
    expect(sdk.createCalls).toHaveLength(1)
    const rows = await ctx.db.select().from(payments)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.shippingSnapshot).toMatchObject({
      estimated: true,
      customerFeeInr: shipping.feeInr,
      destPincode: '560001',
    })
  })

  it('estimates a missing zone slab for an otherwise valid destination', async () => {
    await enableShipping()
    // Same pincode as the pickup node → Zone A, but only a Zone-B rate slab was
    // seeded: an in-fence destination no courier has a published rate for.
    const addressId = await addressAt('380001', 'Gujarat')
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBeGreaterThan(249)
    expect(sdk.createCalls).toHaveLength(1)
  })

  it('accepts an out-of-state order when delivery pricing is disabled', async () => {
    // Deliberately does NOT call enableShipping() — this is the always-on
    // state the app actually ships with (`shipping.enabled` seeds `false`).
    // `shipping.serviceableStates` is already seeded globally in `beforeEach`.
    await ctx.db.insert(pincodes).values({
      pincode: '560001',
      officeName: 'Bengaluru GPO',
      taluk: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
    })
    const addressId = await addressAt('560001', 'Karnataka')
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBe(249)
    expect(sdk.createCalls).toHaveLength(1)
    const rows = await ctx.db.select().from(payments)
    expect(rows).toHaveLength(1)
  })

  it('an in-Gujarat order still succeeds with shipping.enabled false (no regression)', async () => {
    // `shipping.serviceableStates` is already seeded globally in `beforeEach`.
    await ctx.db.insert(pincodes).values({
      pincode: GUJARAT_PIN,
      officeName: 'Nanpura',
      taluk: 'Surat City',
      district: 'Surat',
      state: 'Gujarat',
    })
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })

    expect(res.statusCode).toBe(201)
    // shipping.enabled is false, so no delivery fee — goods price only.
    expect(res.json().amountInr).toBe(249)
  })

  it('uses a distance estimate for an out-of-state address even when flat fallback is configured', async () => {
    await enableShipping()
    await ctx.db.insert(appConfig).values([
      { key: 'shipping.unserviceableBehavior', value: 'flat', description: '' },
      { key: 'shipping.fallbackFeeInr', value: 99, description: '' },
    ])
    const addressId = await addressAt('560001', 'Karnataka')
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().amountInr).toBeGreaterThan(249)
    const [row] = await ctx.db.select().from(payments)
    expect(row?.shippingSnapshot).toMatchObject({ estimated: true })
  })

  it('409s a quote token that no longer matches, without charging', async () => {
    await enableShipping()
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, quoteToken: 'v1.99999999999999.deadbeef' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('shipping_quote_stale')
    expect(sdk.createCalls).toEqual([])
  })

  it('accepts the token the cart actually issued for this address', async () => {
    await enableShipping()
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1)

    const cart = await ctx.app.inject({
      method: 'GET',
      url: `/v1/cart?addressId=${addressId}`,
      headers: auth(USER_A.token),
    })
    const quoteToken = cart.json().shipping.quoteToken as string
    expect(quoteToken).not.toBe('')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, quoteToken },
    })
    expect(res.statusCode).toBe(201)
  })

  it('a `?pincode=` preview cannot change what the order charges', async () => {
    await enableShipping()
    const addressId = await addressAt(GUJARAT_PIN, 'Gujarat')
    await addLine(SKU_A, 1)

    // Preview another pincode, which receives its own distance estimate.
    const preview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart?pincode=560001',
      headers: auth(USER_A.token),
    })
    expect(preview.json().shipping.estimated).toBe(true)
    expect(preview.json().shipping.feeInr).toBeGreaterThan(0)

    // The order still charges the fee for its own Gujarat address.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId },
    })
    expect(res.json().amountInr).toBe(457)
  })
})

/**
 * The manifest trigger on the paid transition (docs/WIP-EVENT-DRIVEN-SWEEPS.md
 * §4). Asserted from this file because the trigger is wired to
 * `onOrderPaidCommitted` — it must fire once the shipment intent is DURABLE,
 * and only the real payment flow proves that ordering.
 *
 * The gate is the interesting half. Manifest and reconcile were left on cron
 * while fulfilment was off precisely because a task enqueued then would buy a
 * Neon compute window to be told `ran: false, reason: fulfilment_disabled`.
 */
describe('manifest sweep trigger', () => {
  const LIVE_RULE: Record<string, unknown> = {
    'fulfilment.enabled': true,
    'fulfilment.carrier': 'delhivery',
    'fulfilment.autoManifest': false,
    'fulfilment.pickupLocationName': 'AHM-01 SAMAN PRODUCTS',
    'fulfilment.manifestMaxAttempts': 5,
    'fulfilment.reconcileStaleMinutes': 180,
    'fulfilment.reconcileBatchSize': 100,
    'fulfilment.ndrAutoReattempt': false,
    'fulfilment.trackingUrlTemplate': '',
    'fulfilment.mode': 'carrier',
  }

  /** `parseFulfilmentRule` is all-or-nothing — a partial seed silently reads as OFF. */
  async function seedRule(over: Record<string, unknown> = {}): Promise<void> {
    const values = { ...LIVE_RULE, ...over }
    await ctx.db
      .insert(appConfig)
      .values(Object.entries(values).map(([key, value]) => ({ key, value, description: '' })))
  }

  /**
   * Swap in an app that has a carrier adapter and a task recorder, over the
   * SAME database the fixtures were seeded into. `afterEach` closes whatever
   * `ctx.app` ends up being.
   */
  async function withCarrier(): Promise<TaskEnqueueInput[]> {
    const calls: TaskEnqueueInput[] = []
    await ctx.app.close()
    const tokens = new Map<string, VerifiedToken>([
      [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
      [USER_B.token, { uid: USER_B.uid, phoneNumber: USER_B.phoneNumber }],
      [USER_ADMIN.token, { uid: USER_ADMIN.uid, phoneNumber: USER_ADMIN.phoneNumber }],
    ])
    const app = buildApp({
      db: ctx.db,
      verifyToken: (t) => {
        const c = tokens.get(t)
        return c ? Promise.resolve(c) : Promise.reject(new Error('invalid test token'))
      },
      logger: false,
      authCacheTtlMs: 0,
      paymentsGateway: fakeGateway(sdk),
      carrierAdapter: {
        code: 'delhivery',
        config: {
          baseUrl: 'https://staging-express.delhivery.com',
          apiToken: 't',
          clientName: 'C',
          mode: 'staging',
        },
        manifest: vi.fn(async () => ({ ok: true, awb: '18000000042', raw: {} })),
        track: vi.fn(async () => ({ scans: [], expectedDeliveryDate: null })),
        createPickup: vi.fn(async () => ({ ok: true, pickupId: 'PU-1', raw: {} })),
        label: vi.fn(async () => ({ ok: true, raw: {} })),
        cancel: vi.fn(async () => ({ ok: true, raw: {} })),
        ndrAction: vi.fn(async () => ({ ok: true, uplId: 'UPL-1', raw: {} })),
        serviceability: vi.fn(async () => []),
        invoiceCharges: vi.fn(async () => ({ chargeInr: null, raw: {} })),
      },
      taskEnqueuer: {
        enqueue: async (input) => {
          calls.push(input)
        },
      },
    })
    await app.ready()
    ctx.app = app
    return calls
  }

  /** The trigger is a post-commit fire-and-forget; give it a tick. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  it('asks for a manifest drain once the paid order books its shipment', async () => {
    const calls = await withCarrier()
    await seedRule()
    await createOrder(USER_A.token, 2)
    await payOrder()
    await settle()

    const manifest = calls.filter((c) => c.kind === 'manifest')
    expect(manifest).toHaveLength(1)
    expect(manifest[0]!.name).toBe(taskNameFor('manifest', manifest[0]!.scheduleTime))
  })

  it('asks for nothing while fulfilment is disabled', async () => {
    const calls = await withCarrier()
    await seedRule({ 'fulfilment.enabled': false })
    await createOrder(USER_A.token, 2)
    await payOrder()
    await settle()

    expect(calls.filter((c) => c.kind === 'manifest')).toEqual([])
  })

  it('asks for nothing in manual mode, where no carrier call may fire', async () => {
    // The second, independent gate (SPEC-MANUAL-FULFILMENT §4B). `enabled` on
    // its own is not permission to talk to Delhivery.
    const calls = await withCarrier()
    await seedRule({ 'fulfilment.mode': 'manual' })
    await createOrder(USER_A.token, 2)
    await payOrder()
    await settle()

    expect(calls.filter((c) => c.kind === 'manifest')).toEqual([])
  })

  it('asks for nothing when the pickup location is unset', async () => {
    // Live-looking config that would have the carrier reject every manifest.
    const calls = await withCarrier()
    await seedRule({ 'fulfilment.pickupLocationName': '' })
    await createOrder(USER_A.token, 2)
    await payOrder()
    await settle()

    expect(calls.filter((c) => c.kind === 'manifest')).toEqual([])
  })
})

/**
 * The refund block on a refunded order — what the app's "Refund details" sheet
 * reads. The point of every assertion here is that the shopper is told what is
 * TRUE: a refund the bank has not released yet must not read as done, and an
 * order refunded before this data existed must not gain an invented destination.
 */
describe('refund details on a refunded order', () => {
  /** Same signed-raw-body injection as the webhook suite's own helper. */
  async function postWebhook(event: unknown) {
    const raw = JSON.stringify(event)
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature(raw),
      },
      payload: raw,
    })
  }

  async function cancel(orderId = 'order_TEST0001'): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payments/orders/${orderId}/cancel`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
  }

  async function details(orderId = 'order_TEST0001') {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/payments/orders/${orderId}/details`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('reports the amount, the source instrument and instant settlement', async () => {
    await createOrder(USER_A.token, 2) // 2 × 249 = 498
    await payOrder()
    await cancel()

    const { refund } = await details()
    expect(refund).toMatchObject({
      amountInr: 498,
      status: 'processed',
      instant: true,
      // Instant money is already there — promising a future date would be worse
      // than promising nothing.
      creditByDate: null,
      destination: { label: 'UPI Account', reference: 'shopper@okhdfcbank' },
    })
    expect(refund.initiatedAt).not.toBeNull()
  })

  it('a bank-pending refund reads as pending, with a working-day credit-by date', async () => {
    sdk.refundResult = { id: 'rfnd_SLOW', status: 'pending', speed_processed: 'normal' }
    await createOrder(USER_A.token, 2)
    await payOrder()
    await cancel()

    const { refund } = await details()
    expect(refund.status).toBe('pending')
    expect(refund.instant).toBe(false)
    expect(refund.processedAt).toBeNull()
    expect(refund.creditByDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Five WORKING days is never fewer than five calendar days away, and never
    // more than seven (one weekend can fall inside the window).
    const days =
      (Date.parse(`${refund.creditByDate}T00:00:00Z`) - Date.parse(refund.initiatedAt)) / 86_400_000
    expect(days).toBeGreaterThanOrEqual(4.5)
    expect(days).toBeLessThanOrEqual(7.5)
    // Never a weekend: banks do not settle on one.
    expect(new Date(`${refund.creditByDate}T00:00:00Z`).getUTCDay()).not.toBe(0)
    expect(new Date(`${refund.creditByDate}T00:00:00Z`).getUTCDay()).not.toBe(6)
  })

  it('refund.processed closes out a pending refund without losing its instrument', async () => {
    sdk.refundResult = { id: 'rfnd_SLOW', status: 'pending', speed_processed: 'normal' }
    await createOrder(USER_A.token, 2)
    await payOrder()
    await cancel()
    expect((await details()).refund.status).toBe('pending')

    // The bank releases it days later. The order is already `refunded`, so the
    // status transition is a no-op — this is purely the refund's own outcome.
    const res = await postWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_SLOW', order_id: 'order_TEST0001' } } },
    })
    expect(res.statusCode).toBe(200)

    const { refund } = await details()
    expect(refund.status).toBe('processed')
    expect(refund.processedAt).not.toBeNull()
    expect(refund.destination).toEqual({ label: 'UPI Account', reference: 'shopper@okhdfcbank' })
  })

  it('refund.failed says so, and never claims a credit date', async () => {
    sdk.refundResult = { id: 'rfnd_BAD', status: 'pending', speed_processed: 'normal' }
    await createOrder(USER_A.token, 2)
    await payOrder()
    await cancel()

    const res = await postWebhook({
      event: 'refund.failed',
      payload: { refund: { entity: { id: 'rfnd_BAD', order_id: 'order_TEST0001' } } },
    })
    expect(res.statusCode).toBe(200)

    const { refund, status } = await details()
    expect(refund.status).toBe('failed')
    expect(refund.creditByDate).toBeNull()
    // The money left our side; a failed remittance is a support case, not a
    // reversal of the cancellation.
    expect(status).toBe('refunded')
  })

  it('degrades for an order refunded before refund data was recorded', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    await cancel()
    // Exactly the shape migration 0034 leaves behind on historic rows.
    await ctx.db
      .update(payments)
      .set({
        razorpayRefundId: null,
        refundStatus: null,
        refundAmountPaise: null,
        refundSpeed: null,
        refundInitiatedAt: null,
        refundProcessedAt: null,
        refundDestination: null,
      })
      .where(eq(payments.orderId, 'order_TEST0001'))

    const { refund } = await details()
    expect(refund).toEqual({
      amountInr: 498,
      status: 'processed',
      destination: null,
      initiatedAt: null,
      processedAt: null,
      creditByDate: null,
      instant: false,
    })
  })

  it('is absent on an order that was never refunded', async () => {
    await createOrder(USER_A.token, 2)
    await payOrder()
    expect((await details()).refund).toBeNull()
  })
})

/**
 * Cash on delivery, partial-prepaid — docs/SPEC-COD.md.
 *
 * The invariant every test here defends is D1: `payments.amount_paise` stays
 * THE ORDER TOTAL on both modes. Only the GATEWAY sees the token. Getting that
 * backwards understates revenue on the invoice, in `Order Completed` and in
 * realised CAC simultaneously, with nothing to catch it.
 */
describe('cash on delivery', () => {
  const enableCod = async (over: Record<string, unknown> = {}) => {
    const rows = { 'payments.cod.enabled': true, ...over }
    await ctx.db
      .insert(appConfig)
      .values(Object.entries(rows).map(([key, value]) => ({ key, value, description: 'test' })))
  }

  const createCodOrder = async (qty = 2) => {
    const addressId = await createAddress(USER_A.token)
    await addLine(SKU_A, qty)
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
      payload: { addressId, paymentMode: 'cod' },
    })
  }

  it('refuses a COD order while the switch is off', async () => {
    const res = await createCodOrder()
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('cod_unavailable')
    // Nothing reached the gateway — a refused policy must not leave an order behind.
    expect(sdk.createCalls).toEqual([])
  })

  it('charges the gateway the TOKEN and keeps the total on the row', async () => {
    await enableCod()
    const res = await createCodOrder(2) // 2 × 249 = 498 INR

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      // What Checkout is handed — the token alone.
      amountInr: 49,
      amountPaise: 4900,
      paymentMode: 'cod',
      // What the shopper actually owes.
      orderTotalInr: 498,
      codAmountInr: 449,
    })
    expect(sdk.createCalls).toEqual([{ amount: 4900, currency: 'INR' }])

    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.amountPaise).toBe(49800)
    expect(row?.paymentMode).toBe('cod')
    expect(row?.codAmountPaise).toBe(44900)
    // Generated, never written — it cannot drift from the balance.
    expect(row?.prepaidAmountPaise).toBe(4900)
  })

  it('leaves a prepaid order charging the full amount, mode prepaid', async () => {
    await enableCod()
    const res = await createOrder(USER_A.token, 2)

    expect(res.json()).toMatchObject({
      amountPaise: 49800,
      paymentMode: 'prepaid',
      orderTotalInr: 498,
      codAmountInr: 0,
    })
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, 'order_TEST0001'))
    expect(row?.codAmountPaise).toBe(0)
    expect(row?.prepaidAmountPaise).toBe(49800)
  })

  it('re-validates against THIS order rather than trusting the client', async () => {
    // The cart screen may have been told COD was on; the ceiling is what binds
    // at create time.
    await enableCod({ 'payments.cod.maxCartInr': 100 })
    const res = await createCodOrder(2)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('cod_unavailable')
  })

  it('counts only CONFIRMED orders against the monthly cap', async () => {
    await enableCod({ 'payments.cod.monthlyOrderCap': 1 })
    expect((await createCodOrder(2)).statusCode).toBe(201)

    // Still pending — an abandoned Razorpay sheet must not consume the cap, or
    // a handful of bounced checkouts would close COD for everyone until the 1st.
    const [pendingRow] = await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, 'order_TEST0001'))
    expect(pendingRow?.status).toBe('pending')
    expect(await countCodOrdersThisMonth(ctx.db)).toBe(0)

    // The token clears: now it counts, and the next shopper is refused.
    await payOrder()
    expect(await countCodOrdersThisMonth(ctx.db)).toBe(1)

    const addressId = await createAddress(USER_B.token)
    await addLine(SKU_A, 2, USER_B.token)
    const next = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: auth(USER_B.token),
      payload: { addressId, paymentMode: 'cod' },
    })
    expect(next.statusCode).toBe(422)
    expect(next.json().error.code).toBe('cod_unavailable')
  })

  it('refunds the TOKEN on cancel, never the total', async () => {
    await enableCod()
    await createCodOrder(2)
    await payOrder()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments/orders/order_TEST0001/cancel',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    // ₹49, not ₹498. The other ₹449 was never paid and must not be handed back.
    expect(sdk.refundCalls).toEqual([{ paymentId: 'pay_TEST0001', amount: 4900 }])
  })

  it('reports the split on the order history', async () => {
    await enableCod()
    await createCodOrder(2)
    await payOrder()

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments/orders',
      headers: auth(USER_A.token),
    })
    expect(res.json().orders[0]).toMatchObject({
      totalInr: 498,
      paymentMode: 'cod',
      codAmountInr: 449,
      prepaidAmountInr: 49,
      codCollectedAt: null,
    })
  })

  it('tells the cart whether cash is on offer, without publishing the policy', async () => {
    await enableCod({ 'payments.cod.pincodes': { mode: 'allow', list: ['380015'] } })
    await createAddress(USER_A.token)
    await addLine(SKU_A, 2)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: auth(USER_A.token),
    })
    expect(res.json().cod).toEqual({
      available: true,
      tokenInr: 49,
      dueOnDeliveryInr: 449,
      reason: null,
    })
    // The allowlist itself never leaves the server.
    expect(JSON.stringify(res.json())).not.toContain('380015')
  })
})
