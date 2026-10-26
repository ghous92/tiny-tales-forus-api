/**
 * `seedCouponDefaults` (core logic behind `scripts/seed-coupons.ts`) against
 * PGlite: inserts every default (DIRECT15, FLAT100, REFILL10) when absent,
 * overwrites nothing on re-run — mirrors `test/scripts/seed-config.test.ts`.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { coupons } from '../../src/db/schema.js'
import { COUPON_DEFAULTS, seedCouponDefaults } from '../../scripts/seed-coupons.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

describe('seedCouponDefaults', () => {
  it('inserts every default when the table is empty', async () => {
    const inserted = await seedCouponDefaults(db)
    expect(inserted).toEqual(['DIRECT15', 'FLAT100', 'REFILL10'])

    const rows = await db.select().from(coupons)
    expect(rows).toHaveLength(COUPON_DEFAULTS.length)

    const [direct15] = await db.select().from(coupons).where(eq(coupons.code, 'DIRECT15'))
    expect(direct15).toMatchObject({
      code: 'DIRECT15',
      discountType: 'percent',
      discountValue: 15,
      minCartInr: 0,
      active: true,
    })

    const [flat100] = await db.select().from(coupons).where(eq(coupons.code, 'FLAT100'))
    expect(flat100).toMatchObject({
      code: 'FLAT100',
      discountType: 'flat',
      discountValue: 100,
      minCartInr: 1000,
      active: true,
    })

    // REFILL10 is a production dependency of the approved
    // `tinytales_refill_reminder` template, whose body tells shoppers to use this
    // exact code. Pin the terms the message implies: 10% off, no cap.
    //
    // The floor and expiry are the owner's 2026-09-01 guardrails for seeding
    // the code to prod BEFORE the template that introduces it. `minCartInr`
    // must stay at or below the cheapest active SKU (₹99) — above it, the
    // reminder would tell a shopper to reorder the item they bought and then
    // reject the code on that exact cart. `validTo` must stay far enough out
    // that no ~60-day reminder chain can land after it lapses.
    const [refill10] = await db.select().from(coupons).where(eq(coupons.code, 'REFILL10'))
    expect(refill10).toMatchObject({
      code: 'REFILL10',
      discountType: 'percent',
      discountValue: 10,
      minCartInr: 99,
      maxDiscountInr: null,
      active: true,
    })
    expect(refill10?.minCartInr).toBeLessThanOrEqual(99)
    expect(refill10?.validTo?.getTime()).toBeGreaterThan(Date.parse('2026-12-31T00:00:00.000Z'))
  })

  it('overwrites nothing when re-run (existing row untouched)', async () => {
    await seedCouponDefaults(db)
    // Simulate an admin having edited the seeded coupon since the first seed.
    await db.update(coupons).set({ label: 'Renamed by admin' }).where(eq(coupons.code, 'DIRECT15'))

    const secondRun = await seedCouponDefaults(db)
    expect(secondRun).toEqual([])

    const [row] = await db.select().from(coupons).where(eq(coupons.code, 'DIRECT15'))
    expect(row?.label).toBe('Renamed by admin')
  })

  it('inserts only the codes that are absent (mixed state)', async () => {
    await db.insert(coupons).values({
      code: 'DIRECT15',
      label: 'pre-existing',
      discountType: 'percent',
      discountValue: 15,
    })

    const inserted = await seedCouponDefaults(db)
    expect(inserted).toEqual(['FLAT100', 'REFILL10'])

    const [row] = await db.select().from(coupons).where(eq(coupons.code, 'DIRECT15'))
    expect(row?.label).toBe('pre-existing')
  })
})
