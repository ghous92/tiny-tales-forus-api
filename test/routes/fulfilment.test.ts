/**
 * Fulfilment HTTP surface — docs/SPEC-LOGISTICS.md DoD 6, 9, and the
 * unconfigured-carrier posture.
 *
 * The webhook cases carry the most weight. Delhivery signs nothing, so the
 * shared-secret header IS the authentication rather than one layer of it, and
 * the "always answer 200 once stored" rule is what keeps their push pipeline
 * from switching us off.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appConfig,
  opsNotifications,
  payments,
  shipmentEvents,
  shipments,
  users,
} from '../../src/db/schema.js'
import type { CarrierAdapter } from '../../src/lib/delhivery.js'
import { reactToShipmentMilestone } from '../../src/routes/customerNotifications.js'
import { manifestSourceFor } from '../../src/routes/fulfilmentAdmin.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

const SECRET = 'carrier-webhook-secret'
const AWB = '18000000001'
const ORDER_ID = 'order_ROUTE1'

/** A scan in Delhivery's documented push shape. */
function pushBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Shipment: {
      Status: {
        Status: 'Dispatched',
        StatusType: 'UD',
        StatusDateTime: '2026-08-03T17:10:42.767',
        StatusLocation: 'Surat_Hub (Surat)',
        Instructions: 'Out for delivery',
      },
      NSLCode: 'X-UCI',
      ReferenceNo: ORDER_ID,
      AWB,
      ...over,
    },
  }
}

function fakeAdapter(over: Partial<CarrierAdapter> = {}): CarrierAdapter {
  return {
    code: 'delhivery',
    config: {
      baseUrl: 'https://staging-express.delhivery.com',
      apiToken: 't',
      clientName: 'C',
      mode: 'staging',
    },
    manifest: vi.fn(async () => ({ ok: true, awb: AWB, raw: {} })),
    track: vi.fn(async () => ({ scans: [], expectedDeliveryDate: null })),
    createPickup: vi.fn(async () => ({ ok: true, pickupId: 'PU-1', raw: {} })),
    label: vi.fn(async () => ({ ok: true, raw: {} })),
    cancel: vi.fn(async () => ({ ok: true, raw: {} })),
    ndrAction: vi.fn(async () => ({ ok: true, uplId: 'UPL-1', raw: {} })),
    serviceability: vi.fn(async () => []),
    invoiceCharges: vi.fn(async () => ({ chargeInr: null, raw: {} })),
    ...over,
  }
}

describe('customer delivery milestones', () => {
  it('enqueues distinct, deduplicated WhatsApp messages for out for delivery and delivered', async () => {
    const ctx = await createTestApp()
    await seedShipment(ctx)
    await ctx.db
      .update(payments)
      .set({
        addressSnapshot: { fullName: 'Priya Sharma', phone: '+919876543210', pincode: '395003' },
      })
      .where(eq(payments.orderId, ORDER_ID))

    const react = (status: string) =>
      reactToShipmentMilestone(ctx.db, {
        orderId: ORDER_ID,
        status,
        awb: AWB,
        courierCode: 'delhivery',
        log: ctx.app.log,
      })
    await react('in_transit')
    await react('out_for_delivery')
    expect(await ctx.db.select().from(opsNotifications)).toHaveLength(0)
    await ctx.db.insert(appConfig).values([
      { key: 'notify.orderOutForDeliveryCustomerTemplate', value: 'tinytales_order_out_for_delivery' },
      { key: 'notify.orderOutForDeliveryCustomerLocale', value: 'en' },
    ])
    await react('out_for_delivery')
    await react('out_for_delivery')
    await react('delivered')

    const rows = await ctx.db.select().from(opsNotifications)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'order_delivered_customer',
      'order_out_for_delivery_customer',
    ])
    const outForDelivery = rows.find((row) => row.kind === 'order_out_for_delivery_customer')
    expect(outForDelivery?.target).toBe('919876543210')
    expect(outForDelivery?.payload).toEqual({ params: ['Priya', ORDER_ID] })
  })

  it('sends the out-for-delivery message as the scan lands when channels are wired', async () => {
    const ctx = await createTestApp()
    await seedShipment(ctx)
    await ctx.db
      .update(payments)
      .set({
        addressSnapshot: { fullName: 'Priya Sharma', phone: '+919876543210', pincode: '395003' },
      })
      .where(eq(payments.orderId, ORDER_ID))
    await ctx.db.insert(appConfig).values([
      { key: 'notify.orderOutForDeliveryCustomerTemplate', value: 'tinytales_order_out_for_delivery' },
      { key: 'notify.orderOutForDeliveryCustomerLocale', value: 'en' },
    ])
    const send = vi.fn(async () => ({ ok: true, providerMessageId: 'wamid.1' }))

    await reactToShipmentMilestone(ctx.db, {
      orderId: ORDER_ID,
      status: 'out_for_delivery',
      awb: AWB,
      courierCode: 'delhivery',
      log: ctx.app.log,
      channels: { whatsapp_cloud: { send } },
    })

    // The send is fire-and-forget; wait for it rather than for the daily sweep.
    await vi.waitFor(async () => {
      const [row] = await ctx.db.select().from(opsNotifications)
      expect(row?.status).toBe('sent')
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      '919876543210',
      expect.objectContaining({
        params: ['Priya', ORDER_ID],
        template: { name: 'tinytales_order_out_for_delivery', locale: 'en' },
      })
    )
  })
})

async function seedShipment(ctx: TestContext, awb: string | null = AWB): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({ firebaseUid: 'uid-route', phone: '+919000000009' })
    .returning({ id: users.id })
  await ctx.db.insert(payments).values({
    orderId: ORDER_ID,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 119 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
  })
  const [row] = await ctx.db
    .insert(shipments)
    .values({
      orderId: ORDER_ID,
      userId: user!.id,
      courierCode: 'delhivery',
      awb,
      status: awb === null ? 'pending_manifest' : 'manifested',
    })
    .returning({ id: shipments.id })
  return row!.id
}

describe('POST /v1/fulfilment/webhook/delhivery — auth (DoD 9)', () => {
  it('answers 503 when no webhook secret is configured', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      payload: pushBody(),
    })
    expect(res.statusCode).toBe(503)
    // The code, not just the status: this and the admin routes describe the
    // same deploy state, and asserting only 503 is what let them drift apart.
    expect(res.json().error.code).toBe('fulfilment_disabled')
  })

  it('answers 401 for a wrong token', async () => {
    const ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers: { 'x-delhivery-token': 'wrong' },
      payload: pushBody(),
    })
    expect(res.statusCode).toBe(401)
  })

  it('answers 401 for a missing token', async () => {
    const ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      payload: pushBody(),
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a correct token', async () => {
    const ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
    await seedShipment(ctx)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers: { 'x-delhivery-token': SECRET },
      payload: pushBody(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true, matched: true })
  })
})

describe('POST /v1/fulfilment/webhook/delhivery — ingestion', () => {
  let ctx: TestContext
  beforeEach(async () => {
    ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
  })

  const headers = { 'x-delhivery-token': SECRET }

  it('moves the shipment to out_for_delivery on a Dispatched scan', async () => {
    const id = await seedShipment(ctx)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers,
      payload: pushBody(),
    })
    const row = (await ctx.db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('out_for_delivery')
    expect(row?.nslCode).toBe('X-UCI')
  })

  it('answers 200 for an unknown AWB and keeps the scan (DoD 6)', async () => {
    // A 4xx to a carrier push pipeline buys retries and eventually gets us
    // switched off — and the orphan row is the only copy of the event.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers,
      payload: pushBody({ AWB: 'NOT-OURS' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true, matched: false })

    const rows = await ctx.db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.awb, 'NOT-OURS'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.shipmentId).toBeNull()
  })

  it('is idempotent under replay over HTTP', async () => {
    await seedShipment(ctx)
    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/fulfilment/webhook/delhivery',
        headers,
        payload: pushBody(),
      })
      expect(res.statusCode).toBe(200)
    }
    expect(
      await ctx.db.select().from(shipmentEvents).where(eq(shipmentEvents.awb, AWB))
    ).toHaveLength(1)
  })

  it('stores an unknown status as exception rather than dropping the scan', async () => {
    const id = await seedShipment(ctx)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers,
      payload: {
        Shipment: {
          Status: {
            Status: 'Teleported',
            StatusType: 'ZZ',
            StatusDateTime: '2026-08-04T10:00:00.000',
          },
          AWB,
        },
      },
    })
    const row = (await ctx.db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('exception')
    expect(row?.statusDetail).toBe('Teleported')
  })

  it('tolerates unknown keys instead of rejecting a scan', async () => {
    // Their docs say the payload is negotiable per client and to consume all
    // scans; a strict schema would drop real events.
    await seedShipment(ctx)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers,
      payload: pushBody({ SomeNewFieldTheyAdded: 'x', Sortcode: 'AMD/SUR' }),
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a body with no AWB', async () => {
    // 422 `validation_failed`, the repo-wide code for a well-formed request
    // whose contents cannot be used — there is nothing to store, and a retry
    // might carry something better.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/fulfilment/webhook/delhivery',
      headers,
      payload: {
        Shipment: { Status: { Status: 'Manifested', StatusDateTime: '2026-08-04T10:00:00' } },
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })
})

describe('webhook scope does not leak its auth exemption (DoD 9)', () => {
  it('leaves the shopper tracking route authenticated', async () => {
    const ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/fulfilment/orders/${ORDER_ID}/tracking`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('leaves other modules’ authed routes untouched', async () => {
    const ctx = await createTestApp({ delhiveryWebhookSecret: SECRET })
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/cart' })).statusCode).toBe(401)
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/addresses' })).statusCode).toBe(401)
  })
})

describe('GET /v1/fulfilment/orders/:orderId/tracking', () => {
  it('404s for an order with no shipment', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/fulfilment/orders/order_NOPE/tracking',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('renders a pending_manifest shipment as a real state, not an error', async () => {
    const ctx = await createTestApp()
    // Bind the shipment to USER_A by making the authed request create the row first.
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    const [user] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.firebaseUid, USER_A.uid))
    await ctx.db.insert(payments).values({
      orderId: ORDER_ID,
      userId: user!.id,
      amountPaise: 17_900,
      status: 'paid',
      cartSnapshot: { items: [], totalInr: 179 },
      addressSnapshot: {},
    })
    await ctx.db.insert(shipments).values({
      orderId: ORDER_ID,
      userId: user!.id,
      courierCode: 'delhivery',
      status: 'pending_manifest',
      promisedEtaDays: 4,
      promisedDeliveryDate: '2026-07-26',
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/fulfilment/orders/${ORDER_ID}/tracking`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('pending_manifest')
    expect(body.label).toBe('Preparing your order')
    expect(body.awb).toBeNull()
    expect(body.trackingUrl).toBe('')
    expect(body.promisedEtaDays).toBe(4)
    expect(body.promisedDeliveryDate).toBe('2026-07-26')
  })
})

describe('/v1/admin/fulfilment — unconfigured carrier', () => {
  it('answers 503 rather than 500 when no adapter is wired', async () => {
    const ctx = await createTestApp()
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/fulfilment/manifest',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('fulfilment_disabled')
  })

  it('still requires admin, even unconfigured', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/fulfilment/manifest',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to sweep while fulfilment.enabled is false', async () => {
    const ctx = await createTestApp({ carrierAdapter: fakeAdapter() })
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/fulfilment/manifest',
      headers: auth(USER_ADMIN.token),
    })
    // No config seeded in tests ⇒ the rule collapses to OFF ⇒ nothing ships.
    expect(res.statusCode).toBe(503)
  })

  it('lists shipments for an admin without touching the carrier', async () => {
    const ctx = await createTestApp()
    await seedShipment(ctx)
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/fulfilment/shipments',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().shipments).toHaveLength(1)
    expect(res.json().shipments[0].awb).toBe(AWB)
  })
})

describe('manifestSourceFor — package count vs unit count', () => {
  const address = {
    name: 'Asha',
    phone: '+919876543210',
    houseNumber: '12',
    roadArea: 'MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  }

  it('always manifests one package regardless of unit count', () => {
    const source = manifestSourceFor(
      address,
      { items: [{ sku: 'SKU1', name: 'Face Wash', qty: 3 }], goodsInr: 144 },
      { chargeableWeightG: 500 },
      {}
    )
    expect(source?.quantity).toBe(1)
    expect(source?.productDescription).toBe('Face Wash x3')
  })

  it('manifests every order as prepaid, with nothing to collect at the door', () => {
    const source = manifestSourceFor(
      address,
      { items: [{ sku: 'SKU1', name: 'Face Wash', qty: 1 }], goodsInr: 144 },
      { chargeableWeightG: 500 },
      {}
    )
    expect(source?.codAmountInr).toBe(0)
    expect(source?.declaredValueInr).toBe(144)
  })


  it('rejects an order with no units', () => {
    expect(
      manifestSourceFor(
        address,
        { items: [{ sku: 'SKU1', name: 'Face Wash', qty: 0 }], goodsInr: 144 },
        { chargeableWeightG: 500 },
        {}
      )
    ).toBeNull()
  })
})
