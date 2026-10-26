/**
 * A hand-booked Shree Maruti parcel reaches its milestones through the same
 * reconcile poll Delhivery parcels do, against a real Postgres (PGlite).
 *
 * What is being held: dispatch routes the parcel to the right tracker, the
 * tracker is asked to confirm the order's pincode, and a Delhivery parcel in
 * the same batch is still tracked by Delhivery.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { payments, shipments, users } from '../../src/db/schema.js'
import type { CarrierAdapter, TrackingResult } from '../../src/lib/delhivery.js'
import { SHREE_MARUTI_COURIER_CODE, type CarrierTracker } from '../../src/lib/shreeMaruti.js'
import {
  createShipmentIntent,
  FULFILMENT_OFF,
  recordManualDispatch,
  reconcileStale,
  type FulfilmentRule,
} from '../../src/services/fulfilment.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

const RULE: FulfilmentRule = { ...FULFILMENT_OFF, enabled: true, mode: 'carrier' }

async function seed(orderId: string, phone: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ firebaseUid: `uid-${orderId}`, phone })
    .returning({ id: users.id })
  await db.insert(payments).values({
    orderId,
    userId: user!.id,
    amountPaise: 10_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 90 }], totalInr: 109 },
    addressSnapshot: { pincode: '370240' },
  })
  const id = await createShipmentIntent(db, {
    orderId,
    userId: user!.id,
    courierCode: 'delhivery',
    promisedEtaDays: 4,
    promisedDeliveryDate: '2026-10-23',
  })
  return id!
}

function delhiveryAdapter(track: CarrierAdapter['track']): CarrierAdapter {
  return { code: 'delhivery', track } as unknown as CarrierAdapter
}

const OFD: TrackingResult = {
  expectedDeliveryDate: null,
  scans: [
    {
      statusType: 'SM',
      status: 'IN_TRANSIT',
      nslCode: 'inscan_at_hub',
      scannedAt: new Date('2026-10-19T14:22:15.000Z'),
    },
    {
      statusType: 'SM',
      status: 'OUT_FOR_DELIVERY',
      nslCode: 'out_for_delivery',
      scannedAt: new Date('2026-10-20T05:55:33.000Z'),
    },
  ],
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe('recordManualDispatch — Shree Maruti', () => {
  it('routes the parcel to Shree Maruti and fills in their tracking page', async () => {
    const id = await seed('order_SM1', '+919000000001')
    await recordManualDispatch(db, id, {
      courierName: 'Shree Maruti',
      awb: '26086200759188',
      actorId: null,
    })
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.courierCode).toBe(SHREE_MARUTI_COURIER_CODE)
    expect(row?.manualTrackingUrl).toBe(
      'https://tracking.shreemaruti.com/?shipmentNo=26086200759188'
    )
  })

  it("keeps an operator's own tracking link", async () => {
    const id = await seed('order_SM2', '+919000000002')
    await recordManualDispatch(db, id, {
      courierName: 'SHREE MARUTI COURIER',
      awb: '26086200759189',
      trackingUrl: 'https://example.test/track',
      actorId: null,
    })
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.manualTrackingUrl).toBe('https://example.test/track')
  })

  it('leaves another courier on the configured carrier code', async () => {
    const id = await seed('order_SM3', '+919000000003')
    await recordManualDispatch(db, id, { courierName: 'DTDC', awb: 'D123', actorId: null })
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.courierCode).toBe('delhivery')
    expect(row?.manualTrackingUrl).toBeNull()
  })
})

describe('reconcileStale — per-carrier trackers', () => {
  it("tracks a Shree Maruti parcel with its tracker, checking the order's pincode", async () => {
    const id = await seed('order_SM4', '+919000000004')
    await recordManualDispatch(db, id, {
      courierName: 'Shree Maruti',
      awb: '26086200759188',
      actorId: null,
    })
    // Dispatch stamps a scan at "now"; age it so the poll picks the row up.
    await db
      .update(shipments)
      .set({ lastScanAt: new Date('2026-10-19T10:00:00.000Z') })
      .where(eq(shipments.id, id))

    const smTrack = vi.fn<CarrierTracker['track']>(async () => OFD)
    const delhiveryTrack = vi.fn<CarrierAdapter['track']>()
    const milestones: string[] = []

    const outcome = await reconcileStale(
      db,
      delhiveryAdapter(delhiveryTrack),
      RULE,
      new Date('2026-10-20T12:00:00.000Z'),
      async (result) => {
        milestones.push(result.status ?? '')
      },
      { [SHREE_MARUTI_COURIER_CODE]: { track: smTrack } }
    )

    expect(delhiveryTrack).not.toHaveBeenCalled()
    expect(smTrack).toHaveBeenCalledWith('26086200759188', { destinationPincode: '370240' })
    expect(outcome).toMatchObject({ scanned: 1, succeeded: 1, failed: 0 })
    expect(milestones).toContain('out_for_delivery')

    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.status).toBe('out_for_delivery')
    expect(row?.outForDeliveryAt?.toISOString()).toBe('2026-10-20T05:55:33.000Z')
  })

  it('counts a rejected (wrong-AWB) parcel as failed and leaves it untouched', async () => {
    const id = await seed('order_SM5', '+919000000005')
    await recordManualDispatch(db, id, {
      courierName: 'Shree Maruti',
      awb: '00000000000000',
      actorId: null,
    })
    await db
      .update(shipments)
      .set({ lastScanAt: new Date('2026-10-19T10:00:00.000Z') })
      .where(eq(shipments.id, id))

    const outcome = await reconcileStale(
      db,
      delhiveryAdapter(vi.fn()),
      RULE,
      new Date('2026-10-20T12:00:00.000Z'),
      undefined,
      {
        [SHREE_MARUTI_COURIER_CODE]: {
          track: async () => {
            throw new Error('wrong AWB?')
          },
        },
      }
    )

    expect(outcome).toMatchObject({ scanned: 1, succeeded: 0, failed: 1 })
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id))
    expect(row?.status).toBe('manifested')
  })

  it('still sends a Delhivery parcel to Delhivery', async () => {
    const id = await seed('order_DL1', '+919000000006')
    await db
      .update(shipments)
      .set({ awb: '61142810000999', status: 'manifested' })
      .where(eq(shipments.id, id))

    const delhiveryTrack = vi.fn<CarrierAdapter['track']>(async () => ({
      scans: [],
      expectedDeliveryDate: null,
    }))
    const smTrack = vi.fn<CarrierTracker['track']>()

    await reconcileStale(
      db,
      delhiveryAdapter(delhiveryTrack),
      RULE,
      new Date('2026-10-20T12:00:00.000Z'),
      undefined,
      { [SHREE_MARUTI_COURIER_CODE]: { track: smTrack } }
    )

    expect(delhiveryTrack).toHaveBeenCalledWith('61142810000999')
    expect(smTrack).not.toHaveBeenCalled()
  })
})
