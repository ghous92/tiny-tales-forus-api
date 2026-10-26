/**
 * Route + issuance tests for invoices, driven through the real payment flow —
 * an invoice is a consequence of money moving, and testing it any other way
 * would prove the wrong thing.
 *
 * The claims that matter here:
 * - exactly ONE invoice per order, however many of verify/webhook/recover race;
 * - numbers are gapless and consecutive within the financial year, and a replay
 *   consumes none;
 * - the customer's copy is mailed once, and its failure never touches the payment;
 * - a shopper can read only their OWN invoice; a non-admin cannot reach the register.
 *
 * The Razorpay SDK is faked exactly as in `payments.test.ts` (real HMAC math,
 * obviously-fake secrets); Brevo is a recording `fetch`.
 */

import { createHmac } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../../src/app.js'
import type { InvoiceDocument } from '../../src/contracts/invoices.js'
import {
  appConfig,
  catalogItems,
  categories,
  invoiceCounters,
  invoices,
  pincodes,
  products,
} from '../../src/db/schema.js'
import type { Db } from '../../src/db/client.js'
import { financialYearOf } from '../../src/lib/invoiceFormat.js'
import {
  claimInvoiceEmail,
  EMAIL_CLAIM_STALE_MS,
  reapStuckInvoiceEmails,
} from '../../src/services/invoices.js'
import type { PaymentsGateway, RazorpayApi } from '../../src/lib/razorpay.js'
import type { VerifiedToken } from '../../src/plugins/auth.js'
import { backfillInvoices } from '../../scripts/backfill-invoices.js'
import {
  DRAIN_BUCKET_MS,
  RECOVER_BUCKET_MS,
  taskNameFor,
  type TaskEnqueueInput,
} from '../../src/lib/tasks.js'
import { auth, createTestDb, promoteToAdmin, USER_A, USER_ADMIN, USER_B } from '../helpers/app.js'
import type { FastifyInstance } from 'fastify'

const KEY_ID = 'rzp_test_fake123'
const KEY_SECRET = 'test_key_secret_fake'
const WEBHOOK_SECRET = 'test_webhook_secret_fake'
const BREVO_API_KEY = 'brevo_test_fake'
const EMAIL_FROM = 'no-reply@laanya.test'

const SKU_A = 'AH-82U3-T29Q'
const SKU_B = '04-JPDR-6Z6N'

/** The FY the test run falls in — the numbers below are relative to it, never hardcoded. */
const FY = financialYearOf(new Date())

class FakeRazorpay {
  nextOrderId = 'order_TEST0001'
  paymentStatus = 'captured'
  paymentsByOrder = new Map<
    string,
    Array<{ id: string; status: string; amount: number; currency?: string }>
  >()

  api: RazorpayApi = {
    orders: {
      create: async (params) => ({
        id: this.nextOrderId,
        amount: params.amount,
        currency: params.currency,
        status: 'created',
      }),
      fetchPayments: async (orderId) => ({ items: this.paymentsByOrder.get(orderId) ?? [] }),
    },
    payments: {
      refund: async () => ({ id: 'rfnd_TEST0001', status: 'processed' }),
      fetch: async (paymentId) => ({ id: paymentId, status: this.paymentStatus, amount: 0 }),
      capture: async (paymentId) => ({ id: paymentId, status: 'captured' }),
      // Never exercised from the invoice tests — present so the fake still
      // satisfies `RazorpayApi`.
      createUpi: async () => ({ razorpay_payment_id: 'pay_TEST0001', link: 'upi://pay?am=1' }),
    },
  }
}

function fakeGateway(sdk: FakeRazorpay): PaymentsGateway {
  return {
    config: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, mode: 'test' },
    client: () => Promise.resolve(sdk.api),
  }
}

function verifySignature(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
}

function webhookSignature(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
}

interface EmailCall {
  to: Array<{ email: string; name?: string }>
  subject: string
  htmlContent: string
}

let app: FastifyInstance
let db: Db
let sdk: FakeRazorpay
let emailCalls: EmailCall[]
/** Flip to make the next Brevo call fail, for the "email failure never breaks the payment" case. */
let brevoFails: boolean
/** What the app WOULD have put on the Cloud Tasks queue (docs/WIP-EVENT-DRIVEN-SWEEPS.md). */
let enqueuedTasks: TaskEnqueueInput[]

beforeEach(async () => {
  const built = await createTestDb()
  db = built.db
  sdk = new FakeRazorpay()
  emailCalls = []
  brevoFails = false
  enqueuedTasks = []

  const tokens = new Map<string, VerifiedToken>([
    [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
    [USER_B.token, { uid: USER_B.uid, phoneNumber: USER_B.phoneNumber }],
    [USER_ADMIN.token, { uid: USER_ADMIN.uid, phoneNumber: USER_ADMIN.phoneNumber }],
  ])

  const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (brevoFails) return new Response('boom', { status: 500 })
    emailCalls.push(JSON.parse(String(init?.body)) as EmailCall)
    return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
  }) as unknown as typeof fetch

  app = buildApp({
    db,
    verifyToken: (t) => {
      const claims = tokens.get(t)
      return claims ? Promise.resolve(claims) : Promise.reject(new Error('invalid test token'))
    },
    logger: false,
    paymentsGateway: fakeGateway(sdk),
    alerts: { brevoApiKey: BREVO_API_KEY, emailFrom: EMAIL_FROM },
    invoiceEmailFetchImpl: fakeFetch,
    authCacheTtlMs: 0,
    taskEnqueuer: {
      enqueue: async (input) => {
        enqueuedTasks.push(input)
      },
    },
  })
  await app.ready()

  await db.insert(catalogItems).values([
    {
      sku: SKU_A,
      productId: 'aloe-gel',
      name: 'Aloe Vera Gel',
      size: '100g',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/a.jpg',
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
      imageUrl: '/r.jpg',
      active: true,
    },
  ])
  await db.insert(pincodes).values({
    pincode: '380015',
    officeName: 'Satellite',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
  })
  await db.insert(appConfig).values([
    { key: 'shipping.serviceableStates', value: ['Gujarat'], description: '' },
    {
      key: 'legal.company',
      value: {
        legalName: 'Adix AI',
        brand: 'Laanya',
        address: '4/B Al-Farooq CHS, Sarkhej, Ahmedabad, Gujarat 380051',
        jurisdictionCity: 'Ahmedabad',
        jurisdictionState: 'Gujarat',
        gstRegistered: false,
        gstin: '',
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

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

/** The fire-and-forget invoice email races the response; give it a tick. */
async function settleEmail(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

async function createAddress(token: string): Promise<string> {
  const res = await app.inject({
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

/** Place an order for `token` and return its Razorpay order id. */
async function placeOrder(
  orderId: string,
  token: string = USER_A.token,
  sku: string = SKU_A,
  qty = 2
): Promise<string> {
  sdk.nextOrderId = orderId
  const addressId = await createAddress(token)
  await app.inject({
    method: 'PUT',
    url: `/v1/cart/items/${sku}`,
    headers: auth(token),
    payload: { qty },
  })
  const res = await app.inject({
    method: 'POST',
    url: '/v1/payments/orders',
    headers: auth(token),
    payload: { addressId },
  })
  expect(res.statusCode).toBe(201)
  return res.json().orderId as string
}

/** Drive the client-verify path to `paid`. */
async function verify(orderId: string, paymentId = 'pay_TEST0001', token: string = USER_A.token) {
  return app.inject({
    method: 'POST',
    url: '/v1/payments/verify',
    headers: auth(token),
    payload: {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: verifySignature(orderId, paymentId),
    },
  })
}

/** Place + pay one order, settling the email side-effect. Returns the order id. */
async function payOrder(
  orderId: string,
  token: string = USER_A.token,
  sku: string = SKU_A
): Promise<string> {
  const id = await placeOrder(orderId, token, sku)
  const res = await verify(id, `pay_${orderId}`, token)
  expect(res.json().status).toBe('paid')
  await settleEmail()
  return id
}

/** Give USER_A an email address, so the customer copy has somewhere to go. */
async function setEmail(email: string, token = USER_A.token): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/me',
    headers: auth(token),
    payload: { email },
  })
  expect(res.statusCode).toBe(200)
}

describe('issuance', () => {
  it('omits Adix jurisdiction from an invoice issued in Saman’s name', async () => {
    await db.insert(appConfig).values({
      key: 'invoice.sellerOfRecord',
      value: 'manufacturer',
      description: '',
    })
    await payOrder('order_SAMAN001')

    const [row] = await db.select().from(invoices)
    const doc = row!.document as InvoiceDocument
    expect(doc.seller.legalName).toBe('Saman Products Company')
    expect(doc.notes.jurisdiction).toBe('')

    const res = await app.inject({
      method: 'GET',
      url: '/v1/invoices/orders/order_SAMAN001/html',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Saman Products Company')
    expect(res.body).not.toContain('Subject to Ahmedabad, Gujarat jurisdiction.')
  })

  it('omits the Dhanbad jurisdiction footer from an Adix resale invoice', async () => {
    await payOrder('order_ADIX001')

    const [row] = await db.select().from(invoices)
    const doc = row!.document as InvoiceDocument
    expect(doc.seller.legalName).toBe('Adix AI')
    expect(doc.notes.jurisdiction).toBe('')
  })

  it('issues exactly one invoice, numbered from the financial-year series', async () => {
    await payOrder('order_INV0001')

    const rows = await db.select().from(invoices)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.invoiceNumber).toBe(`LAA/${FY}/000001`)
    expect(rows[0]!.orderId).toBe('order_INV0001')
    expect(rows[0]!.fy).toBe(FY)
    expect(rows[0]!.seq).toBe(1)

    const doc = rows[0]!.document as InvoiceDocument
    expect(doc.title).toBe('INVOICE')
    expect(doc.seller.legalName).toBe('Adix AI')
    expect(doc.manufacturers[0]?.legalName).toBe('Saman Products Company')
    expect(doc.totals.totalInr).toBe(498)
    expect(doc.lines).toHaveLength(1)
  })

  it('numbers consecutive orders without a gap', async () => {
    await payOrder('order_INV0001')
    await payOrder('order_INV0002', USER_B.token, SKU_B)

    const rows = await db.select().from(invoices).orderBy(invoices.seq)
    expect(rows.map((r) => r.invoiceNumber)).toEqual([`LAA/${FY}/000001`, `LAA/${FY}/000002`])

    const [counter] = await db.select().from(invoiceCounters).where(eq(invoiceCounters.fy, FY))
    expect(counter?.nextSeq).toBe(3)
  })

  it('does not issue a second invoice — or burn a number — on a verify replay', async () => {
    const orderId = await payOrder('order_INV0001')

    const replay = await verify(orderId, 'pay_order_INV0001')
    expect(replay.json().status).toBe('paid')
    await settleEmail()

    expect(await db.select().from(invoices)).toHaveLength(1)
    const [counter] = await db.select().from(invoiceCounters).where(eq(invoiceCounters.fy, FY))
    // Still 2, not 3: the replay consumed nothing, so the next sale gets 000002.
    expect(counter?.nextSeq).toBe(2)
  })

  it('issues exactly one invoice when the webhook and the client verify race', async () => {
    const orderId = await placeOrder('order_INV0001')

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_hook', order_id: orderId, amount: 49800, currency: 'INR' } },
      },
    })
    const hookRes = await app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: {
        'x-razorpay-signature': webhookSignature(body),
        'content-type': 'application/json',
      },
      payload: body,
    })
    expect(hookRes.statusCode).toBe(200)

    // The client's verify arrives second and finds the row already paid.
    await verify(orderId, 'pay_client')
    await settleEmail()

    const rows = await db.select().from(invoices)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.seq).toBe(1)
  })

  it('issues nothing for an order that never got paid', async () => {
    await placeOrder('order_INV0001')
    expect(await db.select().from(invoices)).toHaveLength(0)
  })

  it("attributes a product's own manufacturer over the configured default", async () => {
    // `products.category` is an FK to `categories.slug`, so the category comes first.
    await db.insert(categories).values({ slug: 'skin', label: 'Skin' })
    await db.insert(products).values({
      id: 'aloe-gel',
      slug: 'aloe-gel',
      name: 'Aloe Vera Gel',
      category: 'skin',
      manufacturerName: 'Other Cosmetics Pvt Ltd',
      manufacturerAddress: 'Plot 9, Vatva, Ahmedabad',
      countryOfOrigin: 'India',
      consumerCareContact: 'care@other.test',
    })

    await payOrder('order_INV0001')

    const [row] = await db.select().from(invoices)
    const doc = row!.document as InvoiceDocument
    expect(doc.manufacturers).toHaveLength(1)
    expect(doc.manufacturers[0]).toMatchObject({
      legalName: 'Other Cosmetics Pvt Ltd',
      consumerCareContact: 'care@other.test',
      // The configured licence belongs to Saman, so it must not be printed
      // against a different maker's name.
      licence: '',
    })
  })
})

/**
 * Materialise the admin user and give them the role. Module-scoped because the
 * claim/reaper tests below reach the admin retry sweep from the customer-copy
 * block — that sweep is the only caller that exercises them end to end.
 */
async function asAdmin(): Promise<void> {
  await app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
  await promoteToAdmin(db, USER_ADMIN.uid)
}

describe('customer copy by email', () => {
  it('mails the invoice when we hold an address for the shopper', async () => {
    await setEmail('asha@example.com')
    await payOrder('order_INV0001')

    const invoiceMail = emailCalls.find((c) => c.to.some((r) => r.email === 'asha@example.com'))
    expect(invoiceMail).toBeDefined()
    expect(invoiceMail!.subject).toContain(`LAA/${FY}/000001`)
    expect(invoiceMail!.htmlContent).toContain('Aloe Vera Gel')
    // A mail client would strip a stylesheet, so there must not be one.
    expect(invoiceMail!.htmlContent).not.toContain('<style')

    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('sent')
    expect(row!.emailTo).toBe('asha@example.com')
    expect(row!.emailedAt).not.toBeNull()
  })

  it('records skipped_no_email, without an attempt, when we hold no address', async () => {
    await payOrder('order_INV0001')
    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('skipped_no_email')
    // A shopper who never gave us an email must not eat the retry budget.
    expect(row!.emailAttempts).toBe(0)
  })

  it('still completes the payment and stores the invoice when Brevo fails', async () => {
    await setEmail('asha@example.com')
    brevoFails = true
    const orderId = await payOrder('order_INV0001')

    const status = await app.inject({
      method: 'GET',
      url: `/v1/payments/orders/${orderId}`,
      headers: auth(USER_A.token),
    })
    expect(status.json().status).toBe('paid')

    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('failed')
    expect(row!.emailAttempts).toBe(1)
    expect(row!.lastEmailError).toBeTruthy()
  })

  it('holds the email back when invoice.emailEnabled is off, but still issues', async () => {
    await setEmail('asha@example.com')
    await db
      .insert(appConfig)
      .values({ key: 'invoice.emailEnabled', value: false, description: '' })
    await payOrder('order_INV0001')

    expect(emailCalls.find((c) => c.to.some((r) => r.email === 'asha@example.com'))).toBeUndefined()
    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('pending')
  })

  /**
   * The duplicate this claim exists to prevent. Both senders are real and can
   * hold the same invoice at once: `sendCapturedInvoiceEmails` fires the moment
   * a payment commits, and the retry sweep drains the same backlog — as can a
   * second sweep run, because Cloud Scheduler retries past its attempt deadline
   * while Cloud Run leaves the first handler running.
   */
  it('will not mail an invoice a concurrent sender already claimed', async () => {
    await setEmail('asha@example.com')
    brevoFails = true
    await payOrder('order_INV0001')
    const [owed] = await db.select().from(invoices)
    emailCalls.length = 0
    brevoFails = false
    await asAdmin()

    // Stand in for the other sender: take the claim and never come back.
    const claimed = await claimInvoiceEmail(db, owed!.invoiceNumber)
    expect(claimed?.emailStatus).toBe('sending')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/invoices/retry-emails',
      headers: auth(USER_ADMIN.token),
    })
    // Invisible to the sweep for as long as the claim holds, so nothing is sent
    // and the shopper is not mailed the same invoice twice.
    expect(res.json()).toMatchObject({ scanned: 0, sent: 0, failed: 0 })
    expect(emailCalls).toHaveLength(0)
    const [afterSweep] = await db.select().from(invoices)
    expect(afterSweep!.emailStatus).toBe('sending')
  })

  it('reclaims an invoice abandoned mid-send, and the sweep then mails it', async () => {
    await setEmail('asha@example.com')
    brevoFails = true
    await payOrder('order_INV0001')
    const [owed] = await db.select().from(invoices)
    await claimInvoiceEmail(db, owed!.invoiceNumber)
    emailCalls.length = 0
    brevoFails = false
    await asAdmin()

    // Fresh claim: a slow Brevo call must not be mistaken for a dead sender.
    expect(await reapStuckInvoiceEmails(db)).toBe(0)

    const later = new Date(Date.now() + EMAIL_CLAIM_STALE_MS + 60_000)
    expect(await reapStuckInvoiceEmails(db, later)).toBe(1)
    const [reaped] = await db.select().from(invoices)
    expect(reaped!.emailStatus).toBe('failed')
    expect(reaped!.lastEmailError).toContain('abandoned')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/invoices/retry-emails',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.json()).toMatchObject({ scanned: 1, sent: 1 })
    expect(emailCalls).toHaveLength(1)
  })
})

describe('GET /v1/invoices/orders/:orderId', () => {
  it('returns the caller’s own invoice', async () => {
    const orderId = await payOrder('order_INV0001')
    const res = await app.inject({
      method: 'GET',
      url: `/v1/invoices/orders/${orderId}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().invoiceNumber).toBe(`LAA/${FY}/000001`)
    expect(res.json().document.title).toBe('INVOICE')
  })

  it('404s another shopper’s invoice — never leaks that it exists', async () => {
    const orderId = await payOrder('order_INV0001')
    const res = await app.inject({
      method: 'GET',
      url: `/v1/invoices/orders/${orderId}`,
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('404s an order that has no invoice', async () => {
    const orderId = await placeOrder('order_INV0001')
    const res = await app.inject({
      method: 'GET',
      url: `/v1/invoices/orders/${orderId}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('401s without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/invoices/orders/order_INV0001' })
    expect(res.statusCode).toBe(401)
  })

  it('serves a printable HTML page for the app’s invoice screen', async () => {
    const orderId = await payOrder('order_INV0001')
    const res = await app.inject({
      method: 'GET',
      url: `/v1/invoices/orders/${orderId}/html`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('<!doctype html>')
    expect(res.body).toContain(`LAA/${FY}/000001`)
    // The customer never gets the packing copy.
    expect(res.body).not.toContain('Delivery copy')
  })
})

describe('/v1/admin/invoices', () => {
  it('403s a non-admin', async () => {
    await payOrder('order_INV0001')
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lists the register newest-first with a total', async () => {
    await payOrder('order_INV0001')
    await payOrder('order_INV0002', USER_B.token, SKU_B)
    await asAdmin()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.invoices).toHaveLength(2)
    expect(body.invoices[0].buyerName).toBe('Asha Rao')
    expect(body.invoices[0].buyerCity).toBe('Ahmedabad')
  })

  it('filters by invoice number, order id and buyer', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const byOrder = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices?q=INV0001',
      headers: auth(USER_ADMIN.token),
    })
    expect(byOrder.json().total).toBe(1)

    const byBuyer = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices?q=Asha',
      headers: auth(USER_ADMIN.token),
    })
    expect(byBuyer.json().total).toBe(1)

    const noMatch = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices?q=nobody',
      headers: auth(USER_ADMIN.token),
    })
    expect(noMatch.json().total).toBe(0)
  })

  it('returns the frozen document on the detail route', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/invoices/${encodeURIComponent(`LAA/${FY}/000001`)}`,
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().document.invoiceNumber).toBe(`LAA/${FY}/000001`)
    expect(res.json().emailAttempts).toBe(0)
  })

  it('renders both print copies', async () => {
    await payOrder('order_INV0001')
    await asAdmin()
    const url = `/v1/admin/invoices/${encodeURIComponent(`LAA/${FY}/000001`)}/html`

    const customer = await app.inject({ method: 'GET', url, headers: auth(USER_ADMIN.token) })
    expect(customer.headers['content-type']).toContain('text/html')
    expect(customer.body).not.toContain('Delivery copy')

    const delivery = await app.inject({
      method: 'GET',
      url: `${url}?copy=delivery`,
      headers: auth(USER_ADMIN.token),
    })
    expect(delivery.body).toContain('Delivery copy')
    expect(delivery.body).toContain('Deliver to')
  })

  it('resends the customer copy, optionally to an override address', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/invoices/${encodeURIComponent(`LAA/${FY}/000001`)}/email`,
      headers: auth(USER_ADMIN.token),
      payload: { to: 'ops@laanya.test' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().emailStatus).toBe('sent')
    expect(res.json().emailTo).toBe('ops@laanya.test')
    expect(emailCalls.some((c) => c.to.some((r) => r.email === 'ops@laanya.test'))).toBe(true)

    // The document itself is immutable — only the delivery record moved.
    const [row] = await db.select().from(invoices)
    expect((row!.document as InvoiceDocument).invoiceNumber).toBe(`LAA/${FY}/000001`)
  })

  it('exports a CSV register the accountant can open', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/export.csv',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('Invoice No')
    expect(res.body).toContain(`LAA/${FY}/000001`)
    expect(res.body).toContain('Asha Rao')
  })

  /**
   * Wiring only — the aggregation itself is `test/services/gstr1.test.ts`,
   * which can seed the frozen documents this flow cannot produce (the seller is
   * unregistered here, so every invoice these tests issue is `docVersion: 1`).
   * What matters at this layer is that the route is admin-gated, replies as a
   * downloadable CSV, and refuses a self-contradictory period.
   */
  it('serves the GSTR-1 feed as a named CSV download, admin only', async () => {
    await payOrder('order_INV0001')

    const anon = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/gstr1.csv',
      headers: auth(USER_A.token),
    })
    expect(anon.statusCode).toBe(403)

    await asAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/gstr1.csv?month=2026-08',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    // Report and period both in the name: these files are mailed to a CA and
    // four identically-named exports are indistinguishable in a downloads folder.
    expect(res.headers['content-disposition']).toContain('laanya-gstr1-b2cs-2026-08.csv')
    // b2cs is the default section.
    expect(res.body).toContain('Place Of Supply')
  })

  it('rejects a period given as both a month and a from/to range', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/gstr1.csv?month=2026-08&from=2026-08-01',
      headers: auth(USER_ADMIN.token),
    })
    // 422, not 400: the app's error handler maps a schema rejection to
    // Unprocessable Entity, and the contract's `.refine` is one.
    expect(res.statusCode).toBe(422)
  })

  it('surfaces the docVersion 1 invoices this unregistered seller issues in the detail report', async () => {
    await payOrder('order_INV0001')
    await asAdmin()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/gstr1.csv?report=invoices',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`LAA/${FY}/000001`)
    // No tax to report, but the document is listed rather than dropped.
    expect(res.body).toContain('Doc Version')
  })

  /**
   * Wiring only, same as the GSTR-1 route above — the aggregation lives in
   * `test/services/itcFreight.test.ts`, which can seed the manifested shipments
   * and frozen cost snapshots this flow does not produce.
   */
  it('serves the ITC-on-freight report as a named CSV download, admin only', async () => {
    await payOrder('order_INV0001')

    const anon = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/itc-freight.csv',
      headers: auth(USER_A.token),
    })
    expect(anon.statusCode).toBe(403)

    await asAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/invoices/itc-freight.csv?month=2026-08',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('laanya-itc-freight-summary-2026-08.csv')
    expect(res.body).toContain('Freight GST (modelled ITC)')
    // The banner rides in the data so it cannot be lost between here and the CA.
    expect(res.body).toContain('Not a GSTR-3B figure')
  })

  it('retries the copies that are still owed one', async () => {
    await setEmail('asha@example.com')
    brevoFails = true
    await payOrder('order_INV0001')
    await asAdmin()

    brevoFails = false
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/invoices/retry-emails',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ scanned: 1, sent: 1, failed: 0 })

    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('sent')
    expect(row!.emailAttempts).toBe(2)
  })
})

describe('backfill', () => {
  it('issues invoices for already-paid orders, chronologically and without mailing them', async () => {
    // Two paid orders whose invoices are then deleted, standing in for orders
    // placed before the invoice system existed.
    await payOrder('order_INV0001')
    await payOrder('order_INV0002', USER_B.token, SKU_B)
    await db.delete(invoices)
    await db.delete(invoiceCounters)
    emailCalls = []

    const first = await backfillInvoices(db)
    expect(first).toMatchObject({ scanned: 2, issued: 2, alreadyIssued: 0, failed: 0 })

    const rows = await db.select().from(invoices).orderBy(invoices.seq)
    expect(rows.map((r) => r.orderId)).toEqual(['order_INV0001', 'order_INV0002'])
    expect(rows.every((r) => r.emailStatus === 'skipped_backfill')).toBe(true)
    expect(emailCalls).toHaveLength(0)

    // Re-running is a no-op — the property that makes it safe to run in prod.
    const second = await backfillInvoices(db)
    expect(second).toMatchObject({ scanned: 2, issued: 0, alreadyIssued: 2, failed: 0 })
    expect(await db.select().from(invoices)).toHaveLength(2)
  })
})

/**
 * The event-driven sweep triggers (docs/WIP-EVENT-DRIVEN-SWEEPS.md), asserted
 * here because this file already drives the real payment flow — and a trigger
 * that only fires in a hand-built fixture is not evidence of anything.
 *
 * A task carries no row id and no payload: it means "there is work, go drain",
 * and POSTs the same sweep URL Cloud Scheduler does. So the only thing worth
 * asserting is WHETHER one was raised and for WHICH bucket. Enqueuing when
 * nothing is owed would buy a Neon compute window guaranteed to find nothing,
 * which is the whole cost this replaces.
 */
describe('sweep triggers', () => {
  it('asks for an invoice-email drain when the customer copy failed', async () => {
    await setEmail('asha@example.com')
    brevoFails = true
    await payOrder('order_INV0001')

    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('failed')

    const drain = enqueuedTasks.filter((t) => t.kind === 'invoice-emails')
    expect(drain).toHaveLength(1)
    expect(drain[0]!.name).toBe(taskNameFor('invoice-emails', drain[0]!.scheduleTime))
    expect(drain[0]!.scheduleTime.getTime() % DRAIN_BUCKET_MS).toBe(0)
  })

  it('asks for nothing once the copy is actually sent', async () => {
    await setEmail('asha@example.com')
    await payOrder('order_INV0001')

    const [row] = await db.select().from(invoices)
    expect(row!.emailStatus).toBe('sent')
    // The common path, and the one that decides the bill: no owed row, no
    // task, no wake.
    expect(enqueuedTasks.filter((t) => t.kind === 'invoice-emails')).toEqual([])
  })

  it('schedules a payments-recover drain for after the order can go stale', async () => {
    // Placed, not paid. The recovery sweep only looks at orders older than
    // RECOVER_STALE_AFTER_MS (15 min), so the task must not fire before then —
    // an earlier one would wake Neon to look at a row it would skip anyway.
    await placeOrder('order_INV0001')

    const recover = enqueuedTasks.filter((t) => t.kind === 'payments-recover')
    expect(recover).toHaveLength(1)
    expect(recover[0]!.name).toBe(taskNameFor('payments-recover', recover[0]!.scheduleTime))
    expect(recover[0]!.scheduleTime.getTime() % RECOVER_BUCKET_MS).toBe(0)
    expect(recover[0]!.scheduleTime.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000)
  })
})
