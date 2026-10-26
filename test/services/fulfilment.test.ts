/**
 * Fulfilment service behaviour against a real Postgres (PGlite + the committed
 * migrations) — docs/SPEC-LOGISTICS.md DoD 4, 5, 6, 10.
 *
 * The out-of-order and idempotency tests are the ones that matter: they encode
 * Delhivery's own warning that the flow is not linear and that every scan
 * should be consumed, and they are the difference between a delivered parcel
 * staying delivered and a late scan un-delivering it.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { payments, shipmentEvents, shipments, users } from '../../src/db/schema.js'
import type { CarrierAdapter } from '../../src/lib/delhivery.js'
import type { CarrierScan } from '../../src/lib/fulfilmentStatus.js'
import {
  adoptOrphanEvents,
  cancelShipmentsForOrder,
  createShipmentIntent,
  dedupeHashFor,
  FULFILMENT_OFF,
  getShipmentForUser,
  ingestScan,
  parseFulfilmentRule,
  shipmentCancelBlock,
  trackingUrlFor,
} from '../../src/services/fulfilment.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let userId: string

const ORDER_ID = 'order_TEST123'
const AWB = '18000000001'

function scan(over: Partial<CarrierScan> = {}): CarrierScan {
  return {
    statusType: 'UD',
    status: 'Manifested',
    scannedAt: new Date('2026-08-01T10:00:00.000Z'),
    ...over,
  }
}

async function seedOrder(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ firebaseUid: 'uid-fulfilment', phone: '+919876543210' })
    .returning({ id: users.id })
  userId = user!.id

  await db.insert(payments).values({
    orderId: ORDER_ID,
    userId,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 119 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
  })

  const id = await createShipmentIntent(db, {
    orderId: ORDER_ID,
    userId,
    courierCode: 'delhivery',
    promisedEtaDays: 4,
    promisedDeliveryDate: '2026-07-26',
  })
  return id!
}

async function withAwb(shipmentId: string): Promise<void> {
  await db
    .update(shipments)
    .set({ awb: AWB, status: 'manifested' })
    .where(eq(shipments.id, shipmentId))
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe('createShipmentIntent', () => {
  it('records exactly one shipment per order, even when called twice', async () => {
    // The paid transition can be driven by webhook, verify and recover; the
    // guard upstream is the single UPDATE, but a double-call must still be safe.
    const first = await seedOrder()
    const second = await createShipmentIntent(db, {
      orderId: ORDER_ID,
      userId,
      courierCode: 'delhivery',
      promisedEtaDays: 4,
      promisedDeliveryDate: '2026-07-26',
    })
    expect(first).toBeTruthy()
    expect(second).toBeNull()

    const rows = await db.select().from(shipments).where(eq(shipments.orderId, ORDER_ID))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending_manifest')
    expect(rows[0]?.awb).toBeNull()
    expect(rows[0]?.promisedEtaDays).toBe(4)
  })
})

describe('ingestScan — idempotency (DoD 5)', () => {
  it('stores the same scan once however many times it arrives', async () => {
    const id = await seedOrder()
    await withAwb(id)

    const s = scan({ statusType: 'UD', status: 'Dispatched' })
    const a = await ingestScan(db, AWB, s, 'webhook', {})
    const b = await ingestScan(db, AWB, s, 'webhook', {})

    expect(a.stored).toBe(true)
    expect(b.stored).toBe(false)
    const events = await db.select().from(shipmentEvents).where(eq(shipmentEvents.awb, AWB))
    expect(events).toHaveLength(1)
  })

  it('collapses the same physical scan arriving from BOTH channels', async () => {
    // This is what makes running the webhook and the reconcile poll together
    // safe rather than duplicative.
    const id = await seedOrder()
    await withAwb(id)
    const s = scan({ statusType: 'UD', status: 'Dispatched' })

    await ingestScan(db, AWB, s, 'webhook', {})
    const viaPoll = await ingestScan(db, AWB, s, 'poll', {})

    expect(viaPoll.stored).toBe(false)
    expect(await db.select().from(shipmentEvents).where(eq(shipmentEvents.awb, AWB))).toHaveLength(
      1
    )
  })

  it('produces the same dedupe hash for the same scan and different for different', () => {
    const a = scan()
    expect(dedupeHashFor(AWB, a)).toBe(dedupeHashFor(AWB, { ...a }))
    expect(dedupeHashFor(AWB, a)).not.toBe(dedupeHashFor(AWB, { ...a, status: 'Delivered' }))
    expect(dedupeHashFor(AWB, a)).not.toBe(dedupeHashFor('other', a))
  })
})

describe('ingestScan — out-of-order scans (DoD 4)', () => {
  it('advances status on a newer scan', async () => {
    const id = await seedOrder()
    await withAwb(id)

    await ingestScan(
      db,
      AWB,
      scan({ status: 'In Transit', scannedAt: new Date('2026-08-02T10:00:00Z') }),
      'webhook',
      {}
    )
    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('in_transit')
    expect(row?.pickedUpAt).not.toBeNull()
  })

  it('a LATE In Transit scan cannot un-deliver a delivered parcel', async () => {
    const id = await seedOrder()
    await withAwb(id)

    await ingestScan(
      db,
      AWB,
      scan({ statusType: 'DL', status: 'Delivered', scannedAt: new Date('2026-08-05T10:00:00Z') }),
      'webhook',
      {}
    )
    const late = await ingestScan(
      db,
      AWB,
      scan({ status: 'In Transit', scannedAt: new Date('2026-08-03T10:00:00Z') }),
      'webhook',
      {}
    )

    expect(late.stored).toBe(true) // still recorded…
    expect(late.advanced).toBe(false) // …but it did not move the status
    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('delivered')
    expect(row?.deliveredAt).not.toBeNull()
    // The late scan still filled in the milestone nobody had recorded.
    expect(row?.pickedUpAt).not.toBeNull()
  })

  it('a NEWER Not Picked scan cannot un-cancel a cancelled parcel', async () => {
    // The prod sequence this exists for: Delhivery acknowledges a cancellation
    // with its own `Not Picked` (X-PNP) scan, which maps to `manifested` and
    // arrives a second or two AFTER `cancelShipment` has written `cancelled`.
    // Its carrier timestamp is genuinely the newest one, so strict clock
    // ordering used to let it overwrite the cancellation — leaving a row with
    // `cancelledAt` set but `status` reading "awaiting pickup", which also kept
    // the tracking sweep polling an AWB for an already-refunded order.
    const id = await seedOrder()
    await withAwb(id)
    await db
      .update(shipments)
      .set({
        status: 'cancelled',
        cancelledAt: new Date('2026-08-03T10:00:00.000Z'),
        lastScanAt: new Date('2026-08-02T10:00:00.000Z'),
      })
      .where(eq(shipments.id, id))

    const ack = await ingestScan(
      db,
      AWB,
      scan({
        status: 'Not Picked',
        nslCode: 'X-PNP',
        instructions: 'Shipment not received from client',
        scannedAt: new Date('2026-08-03T10:00:05.000Z'),
      }),
      'webhook',
      {}
    )

    expect(ack.stored).toBe(true) // still recorded…
    expect(ack.advanced).toBe(false) // …but it did not move the status
    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelledAt).not.toBeNull()
  })

  it('never rewrites a milestone once set', async () => {
    const id = await seedOrder()
    await withAwb(id)

    await ingestScan(
      db,
      AWB,
      scan({ status: 'In Transit', scannedAt: new Date('2026-08-02T10:00:00Z') }),
      'webhook',
      {}
    )
    const first = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]?.pickedUpAt

    await ingestScan(
      db,
      AWB,
      scan({ status: 'In Transit', scannedAt: new Date('2026-08-04T10:00:00Z') }),
      'webhook',
      {}
    )
    const second = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]?.pickedUpAt
    expect(second?.toISOString()).toBe(first?.toISOString())
  })
})

describe('ingestScan — NDR', () => {
  it('counts a delivery attempt and records the reason', async () => {
    const id = await seedOrder()
    await withAwb(id)

    await ingestScan(
      db,
      AWB,
      scan({
        status: 'Pending',
        statusCode: 'EOD-74',
        instructions: 'Consignee not available',
        scannedAt: new Date('2026-08-03T10:00:00Z'),
      }),
      'webhook',
      {}
    )

    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('ndr')
    expect(row?.deliveryAttempts).toBe(1)
    expect(row?.ndrReason).toBe('Consignee not available')
    expect(row?.ndrRaisedAt).not.toBeNull()
  })

  it('clears the NDR reason once the parcel moves on', async () => {
    const id = await seedOrder()
    await withAwb(id)
    await ingestScan(
      db,
      AWB,
      scan({
        status: 'Pending',
        statusCode: 'EOD-74',
        scannedAt: new Date('2026-08-03T10:00:00Z'),
      }),
      'webhook',
      {}
    )
    await ingestScan(
      db,
      AWB,
      scan({ statusType: 'DL', status: 'Delivered', scannedAt: new Date('2026-08-04T10:00:00Z') }),
      'webhook',
      {}
    )
    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('delivered')
    expect(row?.ndrReason).toBeNull()
  })
})

describe('ingestScan — orphans (DoD 6)', () => {
  it('stores a scan for an unknown AWB rather than dropping it', async () => {
    const result = await ingestScan(db, 'UNKNOWN-AWB', scan(), 'webhook', { some: 'body' })
    expect(result.stored).toBe(true)
    expect(result.matched).toBe(false)

    const rows = await db.select().from(shipmentEvents).where(eq(shipmentEvents.awb, 'UNKNOWN-AWB'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.shipmentId).toBeNull()
  })

  it('adopts orphans when the AWB is later manifested, and replays them', async () => {
    // The race this guards: a carrier that scans faster than our sweep commits.
    await ingestScan(
      db,
      AWB,
      scan({ status: 'In Transit', scannedAt: new Date('2026-08-02T10:00:00Z') }),
      'webhook',
      {}
    )

    const id = await seedOrder()
    await withAwb(id)
    const adopted = await adoptOrphanEvents(db, id, AWB)

    expect(adopted).toBe(1)
    const row = (await db.select().from(shipments).where(eq(shipments.id, id)))[0]
    expect(row?.status).toBe('in_transit')
    const events = await db.select().from(shipmentEvents).where(eq(shipmentEvents.awb, AWB))
    expect(events[0]?.shipmentId).toBe(id)
  })
})

describe('fulfilment never writes payments (DoD 10)', () => {
  it('leaves the order row byte-identical across a full scan lifecycle', async () => {
    const id = await seedOrder()
    await withAwb(id)
    const before = (await db.select().from(payments).where(eq(payments.orderId, ORDER_ID)))[0]

    for (const [status, when] of [
      ['In Transit', '2026-08-02T10:00:00Z'],
      ['Dispatched', '2026-08-03T10:00:00Z'],
    ] as const) {
      await ingestScan(db, AWB, scan({ status, scannedAt: new Date(when) }), 'webhook', {})
    }
    await ingestScan(
      db,
      AWB,
      scan({ statusType: 'DL', status: 'RTO', scannedAt: new Date('2026-08-06T10:00:00Z') }),
      'webhook',
      {}
    )

    const after = (await db.select().from(payments).where(eq(payments.orderId, ORDER_ID)))[0]
    // An RTO is exactly the case where a careless implementation would refund.
    expect(after).toEqual(before)
    expect(after?.status).toBe('paid')
  })
})

describe('getShipmentForUser', () => {
  it('collapses consecutive same-status scans in the timeline', async () => {
    // A parcel crossing four hubs emits four in_transit rows; repeating "In
    // transit" four times to a shopper reads as a bug.
    const id = await seedOrder()
    await withAwb(id)
    for (const [i, loc] of ['Ahmedabad', 'Vadodara', 'Bharuch', 'Surat'].entries()) {
      await ingestScan(
        db,
        AWB,
        scan({
          status: 'In Transit',
          scanLocation: loc,
          scannedAt: new Date(`2026-08-0${i + 2}T10:00:00Z`),
        }),
        'webhook',
        {}
      )
    }

    const found = await getShipmentForUser(db, userId, ORDER_ID)
    expect(found?.events.filter((e) => e.status === 'in_transit')).toHaveLength(1)
  })

  it('reports another user’s order as absent', async () => {
    await seedOrder()
    const [other] = await db
      .insert(users)
      .values({ firebaseUid: 'uid-other', phone: '+919123456780' })
      .returning({ id: users.id })
    expect(await getShipmentForUser(db, other!.id, ORDER_ID)).toBeNull()
  })
})

describe('parseFulfilmentRule — a rule never switches itself on', () => {
  const valid = new Map<string, unknown>([
    ['fulfilment.enabled', true],
    ['fulfilment.carrier', 'delhivery'],
    ['fulfilment.autoManifest', false],
    ['fulfilment.pickupLocationName', 'TT-AHM'],
    ['fulfilment.manifestMaxAttempts', 5],
    ['fulfilment.reconcileStaleMinutes', 180],
    ['fulfilment.reconcileBatchSize', 100],
    ['fulfilment.trackingUrlTemplate', 'https://x/{awb}'],
  ])

  it('parses a complete, valid config', () => {
    const rule = parseFulfilmentRule(valid)
    expect(rule.enabled).toBe(true)
    expect(rule.pickupLocationName).toBe('TT-AHM')
  })

  it('collapses to OFF when a key is missing', () => {
    const partial = new Map(valid)
    partial.delete('fulfilment.pickupLocationName')
    expect(parseFulfilmentRule(partial)).toEqual(FULFILMENT_OFF)
  })

  it('collapses to OFF when a key is malformed', () => {
    const bad = new Map(valid)
    bad.set('fulfilment.reconcileBatchSize', 'lots')
    expect(parseFulfilmentRule(bad).enabled).toBe(false)
  })

  it('rejects a batch size above the carrier throttle', () => {
    const bad = new Map(valid)
    bad.set('fulfilment.reconcileBatchSize', 5000)
    expect(parseFulfilmentRule(bad).enabled).toBe(false)
  })

  it('collapses an entirely empty config to OFF', () => {
    expect(parseFulfilmentRule(new Map())).toEqual(FULFILMENT_OFF)
  })
})

describe('trackingUrlFor', () => {
  it('substitutes the AWB', () => {
    expect(trackingUrlFor('https://x/track/{awb}', '123')).toBe('https://x/track/123')
  })

  it('is empty when there is nothing to track yet', () => {
    expect(trackingUrlFor('https://x/{awb}', null)).toBe('')
    expect(trackingUrlFor('', '123')).toBe('')
  })
})

describe('shipmentCancelBlock (DoD 11, §8.1)', () => {
  it('allows an order with no shipment at all', async () => {
    // Every order placed before this module, and every order while
    // `fulfilment.enabled` is false. The guard has to switch itself on.
    expect(await shipmentCancelBlock(db, 'order_NEVER_SHIPPED')).toBeNull()
  })

  it('allows an unmanifested intent — nothing has been sent to the carrier', async () => {
    await seedOrder()
    expect(await shipmentCancelBlock(db, ORDER_ID)).toBeNull()
  })

  it('allows a manifested (packed, awaiting pickup) parcel — still on our shelf', async () => {
    const id = await seedOrder()
    await db.update(shipments).set({ status: 'manifested', awb: AWB }).where(eq(shipments.id, id))
    expect(await shipmentCancelBlock(db, ORDER_ID)).toBeNull()
  })

  it.each(['picked_up', 'in_transit', 'out_for_delivery', 'ndr', 'rto_in_transit'])(
    'refuses once the parcel is %s',
    async (status) => {
      const id = await seedOrder()
      await db.update(shipments).set({ status, awb: AWB }).where(eq(shipments.id, id))
      expect(await shipmentCancelBlock(db, ORDER_ID)).toMatch(/courier/i)
    }
  )

  it.each(['delivered', 'rto_delivered'])('refuses with delivery copy once %s', async (status) => {
    const id = await seedOrder()
    await db.update(shipments).set({ status, awb: AWB }).where(eq(shipments.id, id))
    expect(await shipmentCancelBlock(db, ORDER_ID)).toMatch(/delivered/i)
  })

  it('allows again once ops has cancelled the shipment with the carrier', async () => {
    const id = await seedOrder()
    await db.update(shipments).set({ status: 'cancelled', awb: AWB }).where(eq(shipments.id, id))
    expect(await shipmentCancelBlock(db, ORDER_ID)).toBeNull()
  })

  it('refuses when ANY shipment for the order is live', async () => {
    // `orderId` is deliberately non-unique so a cancelled parcel can be
    // re-manifested — so a live second row must not be masked by a dead first.
    const id = await seedOrder()
    await db.update(shipments).set({ status: 'cancelled' }).where(eq(shipments.id, id))
    await db.insert(shipments).values({
      orderId: ORDER_ID,
      userId,
      courierCode: 'delhivery',
      status: 'in_transit',
      awb: '18000000002',
    })
    expect(await shipmentCancelBlock(db, ORDER_ID)).toMatch(/courier/i)
  })
})

describe('cancelShipmentsForOrder (§8.1)', () => {
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

  it('cancels an unmanifested intent so the manifest sweep stops considering it', async () => {
    await seedOrder()
    expect(await cancelShipmentsForOrder(db, ORDER_ID)).toEqual({ cancelled: 1, unresolved: [] })

    const [row] = await db.select().from(shipments).where(eq(shipments.orderId, ORDER_ID))
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelledAt).not.toBeNull()
  })

  it('recalls a manifested label with the carrier', async () => {
    const id = await seedOrder()
    await withAwb(id)
    const adapter = fakeAdapter()

    expect(await cancelShipmentsForOrder(db, ORDER_ID, adapter)).toEqual({
      cancelled: 1,
      unresolved: [],
    })
    expect(adapter.cancel).toHaveBeenCalledWith(AWB)

    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.status).toBe('cancelled')
  })

  it('reports a manifested parcel it cannot recall instead of faking the status', async () => {
    const id = await seedOrder()
    await withAwb(id)

    const sweep = await cancelShipmentsForOrder(db, ORDER_ID)
    expect(sweep.cancelled).toBe(0)
    expect(sweep.unresolved).toHaveLength(1)

    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.status).toBe('manifested')
  })

  it('does not touch payments (the §1.1 quarantine holds here too)', async () => {
    await seedOrder()
    await cancelShipmentsForOrder(db, ORDER_ID)
    const [row] = await db.select().from(payments).where(eq(payments.orderId, ORDER_ID))
    expect(row?.status).toBe('paid')
  })
})
