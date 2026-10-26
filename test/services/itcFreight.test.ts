/**
 * ITC-on-freight report (`services/itcFreight.ts`).
 *
 * Seeds shipments and their orders directly. The point of this module is what
 * it does with a FROZEN cost snapshot, including the three shapes of snapshot
 * it cannot use — an order predating the cost split, a manually-carried parcel,
 * and a parcel re-manifested onto a different courier. None of those is
 * reachable by driving a happy-path checkout, and each is the case where a
 * quiet omission would show up months later as an unexplained gap against the
 * courier's invoice.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { payments, shipments, users } from '../../src/db/schema.js'
import type { FreightCost } from '../../src/lib/shipping.js'
import { exportItcFreightCsv, resolvePeriod } from '../../src/services/itcFreight.js'
import type { ShippingSnapshot } from '../../src/services/shipping.js'
import { createTestDb } from '../helpers/app.js'

/** ₹46 taxable + ₹8 GST = ₹54 — the worked example from `freightCost`'s own tests. */
const COST: FreightCost = {
  baseInr: 37,
  fuelInr: 4,
  docketInr: 5,
  riskInr: 0,
  codInr: 0,
  preTaxInr: 46,
  gstBps: 1800,
  gstInr: 8,
  totalInr: 54,
}

function snapshot(over: Partial<ShippingSnapshot> = {}): ShippingSnapshot {
  return {
    nodeId: '00000000-0000-0000-0000-000000000001',
    nodeCode: 'AHM-01',
    courierCode: 'delhivery',
    zone: 'A',
    chargeableWeightG: 500,
    customerFeeInr: 49,
    trueCostInr: COST.totalInr,
    etaDays: 3,
    destPincode: '380001',
    cost: COST,
    ...over,
  }
}

/** A snapshot as it was stored before the cost split existed: no `cost` key at all. */
function withoutCost(full: ShippingSnapshot): ShippingSnapshot {
  const rest: ShippingSnapshot = { ...full }
  delete rest.cost
  return rest
}

function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rest] = csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')))
  return { header: header!, rows: rest }
}

describe('ITC-on-freight export', () => {
  let db: Db
  let userId: string

  beforeEach(async () => {
    const ctx = await createTestDb()
    db = ctx.db
    const [user] = await db
      .insert(users)
      .values({ firebaseUid: 'firebase-uid-itc', phone: '+919876543210' })
      .returning()
    userId = user!.id
  })

  async function seedShipment(opts: {
    orderId: string
    manifestedAt: string | null
    shippingSnapshot?: ShippingSnapshot | null
    courierCode?: string
    manualCourierName?: string
    status?: string
  }): Promise<void> {
    await db.insert(payments).values({
      orderId: opts.orderId,
      userId,
      amountPaise: 129_900,
      status: 'paid',
      cartSnapshot: {},
      addressSnapshot: {},
      shippingSnapshot: opts.shippingSnapshot === undefined ? snapshot() : opts.shippingSnapshot,
    })
    await db.insert(shipments).values({
      orderId: opts.orderId,
      userId,
      courierCode: opts.courierCode ?? 'delhivery',
      awb: `AWB${opts.orderId}`,
      status: opts.status ?? 'delivered',
      manifestedAt: opts.manifestedAt ? new Date(opts.manifestedAt) : null,
      manualCourierName: opts.manualCourierName ?? null,
    })
  }

  it('anchors the period on manifest, not on payment — an unmanifested order cost nothing to carry', async () => {
    await seedShipment({ orderId: 'order_1', manifestedAt: '2026-08-05T06:00:00.000Z' })
    await seedShipment({ orderId: 'order_2', manifestedAt: null })

    const august = await exportItcFreightCsv(db, { month: '2026-08' })
    expect(august.shipments).toBe(1)
  })

  it('excludes a parcel manifested outside the window', async () => {
    // 23:45 IST on 31 July — the last instant of the PREVIOUS month.
    await seedShipment({ orderId: 'order_1', manifestedAt: '2026-07-31T18:15:00.000Z' })

    expect((await exportItcFreightCsv(db, { month: '2026-07' })).shipments).toBe(1)
    expect((await exportItcFreightCsv(db, { month: '2026-08' })).shipments).toBe(0)
  })

  describe('summary', () => {
    it('totals taxable freight and its tax per courier and frozen rate', async () => {
      await seedShipment({ orderId: 'order_1', manifestedAt: '2026-08-05T06:00:00.000Z' })
      await seedShipment({ orderId: 'order_2', manifestedAt: '2026-08-06T06:00:00.000Z' })

      const { csv } = await exportItcFreightCsv(db, { month: '2026-08' })
      const { header, rows } = parseCsv(csv)

      expect(header).toEqual([
        'Courier',
        'GST Rate',
        'Shipments',
        'Freight (Taxable Value)',
        'Freight GST (modelled ITC)',
        'Freight Total',
        'Note',
      ])
      expect(rows[0]!.slice(0, 6)).toEqual(['delhivery', '18%', '2', '92', '16', '108'])
    })

    it('splits couriers, and splits one courier across a rate change', async () => {
      await seedShipment({ orderId: 'order_1', manifestedAt: '2026-08-05T06:00:00.000Z' })
      await seedShipment({
        orderId: 'order_2',
        manifestedAt: '2026-08-06T06:00:00.000Z',
        courierCode: 'xpressbees',
        shippingSnapshot: snapshot({ courierCode: 'xpressbees' }),
      })
      // Same courier, a different rate frozen at the time — two rows, because
      // a return is filed per rate.
      await seedShipment({
        orderId: 'order_3',
        manifestedAt: '2026-08-07T06:00:00.000Z',
        shippingSnapshot: snapshot({ cost: { ...COST, gstBps: 500, gstInr: 2, totalInr: 48 } }),
      })

      const { rows } = parseCsv((await exportItcFreightCsv(db, { month: '2026-08' })).csv)
      expect(rows.slice(0, 3).map((r) => [r[0], r[1]])).toEqual([
        ['delhivery', '5%'],
        ['delhivery', '18%'],
        ['xpressbees', '18%'],
      ])
    })

    it('closes with the reconcile-before-claiming banner', async () => {
      await seedShipment({ orderId: 'order_1', manifestedAt: '2026-08-05T06:00:00.000Z' })

      const { rows } = parseCsv((await exportItcFreightCsv(db, { month: '2026-08' })).csv)
      const last = rows[rows.length - 1]!
      expect(last[6]).toContain('GSTR-2B')
      expect(last[6]).toContain('Not a GSTR-3B figure')
    })
  })

  describe('exclusions', () => {
    it('counts an order frozen before the cost split existed, rather than dropping it', async () => {
      await seedShipment({
        orderId: 'order_1',
        manifestedAt: '2026-08-05T06:00:00.000Z',
        // A snapshot from before `cost` was added to it — the key is ABSENT,
        // not present-and-undefined, which is what an old jsonb row looks like.
        shippingSnapshot: withoutCost(snapshot()),
      })

      const result = await exportItcFreightCsv(db, { month: '2026-08' })
      expect(result.shipments).toBe(1)
      expect(result.excluded.no_frozen_cost).toBe(1)
      // Nothing to add to the summary — but the parcel is not invisible.
      expect(parseCsv(result.csv).rows[0]![2]).toBe('')
    })

    it('excludes a manually-carried parcel — no rate card, so no modelled tax', async () => {
      await seedShipment({
        orderId: 'order_1',
        manifestedAt: '2026-08-05T06:00:00.000Z',
        manualCourierName: 'Ravi (walked it to the counter)',
      })

      const result = await exportItcFreightCsv(db, { month: '2026-08' })
      expect(result.excluded.manual).toBe(1)
    })

    it('excludes a parcel re-manifested onto a different courier than the quote priced', async () => {
      await seedShipment({
        orderId: 'order_1',
        manifestedAt: '2026-08-05T06:00:00.000Z',
        courierCode: 'shadowfax',
        // The snapshot still holds delhivery's rate card.
        shippingSnapshot: snapshot({ courierCode: 'delhivery' }),
      })

      const result = await exportItcFreightCsv(db, { month: '2026-08' })
      expect(result.excluded.courier_changed).toBe(1)
      expect(parseCsv(result.csv).rows[0]![2]).toBe('')
    })

    it('has no orders with a null shipping snapshot contribute tax', async () => {
      await seedShipment({
        orderId: 'order_1',
        manifestedAt: '2026-08-05T06:00:00.000Z',
        shippingSnapshot: null,
      })

      const result = await exportItcFreightCsv(db, { month: '2026-08' })
      expect(result.excluded.no_frozen_cost).toBe(1)
    })
  })

  describe('detail', () => {
    it('lists every manifested parcel, naming the reason each excluded one contributes nothing', async () => {
      await seedShipment({ orderId: 'order_1', manifestedAt: '2026-08-05T06:00:00.000Z' })
      await seedShipment({
        orderId: 'order_2',
        manifestedAt: '2026-08-06T06:00:00.000Z',
        manualCourierName: 'Ravi',
      })

      const { header, rows } = parseCsv(
        (await exportItcFreightCsv(db, { month: '2026-08', report: 'detail' })).csv
      )
      expect(header[0]).toBe('Manifest Date')
      expect(rows).toHaveLength(2)

      const priced = rows.find((r) => r[1] === 'order_1')!
      expect(priced[5]).toBe('18%')
      expect(priced[6]).toBe('46')
      expect(priced[7]).toBe('8')
      expect(priced[9]).toBe('')

      const manual = rows.find((r) => r[1] === 'order_2')!
      expect(manual[6]).toBe('')
      expect(manual[9]).toBe('manual')
    })
  })

  describe('resolvePeriod', () => {
    it('matches the GSTR-1 feed\'s IST conventions', () => {
      const { start, end } = resolvePeriod({ month: '2026-08' })
      expect(start?.toISOString()).toBe('2026-07-31T18:30:00.000Z')
      expect(end?.toISOString()).toBe('2026-08-31T18:30:00.000Z')
      expect(resolvePeriod({ to: '2026-08-31' }).end?.toISOString()).toBe(
        '2026-08-31T18:30:00.000Z'
      )
    })
  })
})
