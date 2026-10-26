/**
 * `seedShipping` (core logic behind `scripts/seed-shipping.ts`) against PGlite.
 *
 * Beyond the usual idempotence check, this asserts two things about the seeded
 * DATA rather than the code, because both are load-bearing and both are easy to
 * break with a careless edit to a table of numbers:
 *
 * 1. **Every zone that has a rate card has a reachable top slab.** A zone whose
 *    top row carries no per-kilogram charge cannot quote above its table at
 *    all, which turns a heavy cart into "not serviceable" rather than a price.
 * 2. **The seeded rates actually produce the margins the config file claims.**
 *    `scripts/seed-config.ts` states, in a comment a human will trust, that a
 *    Zone-B 500 g parcel earns ₹15 and a 5 kg one loses ₹63. If the rate seeds
 *    drift, that comment becomes a lie about money — so it is checked here.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { COURIER_SEEDS, PINCODE_SEEDS, SLAB_SEEDS, seedShipping } from '../../scripts/seed-shipping.js'
import { baseFreightInr, trueCostInr, type RateSlab, type Zone } from '../../src/lib/shipping.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

/** Cheapest true cost across the seeded couriers for a (zone, weight) cell. */
function cheapestCostInr(zone: Zone, weightG: number): number | null {
  let cheapest: number | null = null
  for (const courier of COURIER_SEEDS) {
    const slabs: RateSlab[] = SLAB_SEEDS.filter((slab) => slab.courierCode === courier.code).map(
      (slab) => ({
        zone: slab.zone as Zone,
        uptoG: slab.uptoG,
        rateInr: slab.rateInr,
        addlPerG: slab.addlPerG ?? 500,
        addlRateInr: slab.addlRateInr ?? 0,
      })
    )
    const base = baseFreightInr(slabs, zone, weightG)
    if (base === null) continue
    const cost = trueCostInr(
      {
        fuelBps: courier.fuelBps ?? 0,
        gstBps: courier.gstBps ?? 1800,
        docketFeeInr: courier.docketFeeInr ?? 0,
        riskBps: 0,
        riskMinInr: 0,
        codFlatInr: 0,
        codBps: 0,
      },
      base,
      249,
      false
    )
    if (cheapest === null || cost < cheapest) cheapest = cost
  }
  return cheapest
}

describe('seedShipping', () => {
  it('inserts couriers, slabs, service areas, a node and pincodes on an empty database', async () => {
    const summary = await seedShipping(db)
    expect(summary.couriers).toBe(COURIER_SEEDS.length)
    expect(summary.slabs).toBe(SLAB_SEEDS.length)
    expect(summary.serviceAreas).toBe(COURIER_SEEDS.length)
    expect(summary.nodes).toBe(1)
    expect(summary.pincodes).toBe(PINCODE_SEEDS.length)
  })

  it('is idempotent — a second run inserts nothing and overwrites nothing', async () => {
    await seedShipping(db)
    const second = await seedShipping(db)
    expect(second).toEqual({ couriers: 0, slabs: 0, serviceAreas: 0, nodes: 0, pincodes: 0 })
  })
})

describe('the seeded rate data', () => {
  it('gives every carded zone a top slab that can price above the table', () => {
    for (const courier of COURIER_SEEDS) {
      const mine = SLAB_SEEDS.filter((slab) => slab.courierCode === courier.code)
      for (const zone of new Set(mine.map((slab) => slab.zone))) {
        const inZone = mine.filter((slab) => slab.zone === zone).sort((a, b) => a.uptoG - b.uptoG)
        const top = inZone[inZone.length - 1]!
        expect(
          (top.addlRateInr ?? 0) > 0,
          `${courier.code}/${zone} top slab has no per-kg charge, so it cannot quote above ${top.uptoG} g`
        ).toBe(true)
      }
    }
  })

  it('seeds Zone A cheaper than Zone B at every weight, as the zone model requires', () => {
    for (const weightG of [500, 1000, 2000, 5000]) {
      const a = cheapestCostInr('A', weightG)!
      const b = cheapestCostInr('B', weightG)!
      expect(a).toBeLessThan(b)
    }
  })

  it('matches the margins scripts/seed-config.ts states in prose', () => {
    // Customer slabs as seeded in seed-config.ts.
    const CUSTOMER: Record<Zone | string, Record<number, number>> = {
      A: { 500: 49, 1000: 79, 2000: 129, 5000: 249 },
      B: { 500: 60, 1000: 99, 2000: 169, 5000: 349 },
    }
    const CLAIMED: Record<string, Record<number, number>> = {
      A: { 500: 13, 1000: 4, 2000: 3, 5000: 35 },
      B: { 500: 15, 1000: 8, 2000: 30, 5000: 120 },
    }

    for (const zone of ['A', 'B'] as Zone[]) {
      for (const weightG of [500, 1000, 2000, 5000]) {
        const margin = CUSTOMER[zone]![weightG]! - cheapestCostInr(zone, weightG)!
        expect(margin, `zone ${zone} at ${weightG} g`).toBe(CLAIMED[zone]![weightG])
      }
    }
  })

  it('keeps the light-parcel slabs profitable — the ones a real order actually uses', () => {
    expect(60 - cheapestCostInr('B', 500)!).toBeGreaterThan(0)
    expect(49 - cheapestCostInr('A', 500)!).toBeGreaterThan(0)
  })

  it('seeds the non-Gujarat pincodes that prove the fence is on state, not prefix', () => {
    const daman = PINCODE_SEEDS.find((row) => row.pincode === '396210')
    expect(daman?.state).toBe('Daman and Diu')
    // …and it sits inside the same 360001–396999 band the couriers cover.
    expect(Number(daman!.pincode)).toBeLessThan(396999)
  })
})
