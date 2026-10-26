/**
 * Service-rule tests against PGlite for the coupons module: public
 * list/validate, code resolution for cart folding (uppercase normalization,
 * unknown/expired/not-yet-valid/inactive/min-cart), and admin CRUD
 * (duplicate-code rejection, percent/flat pricing validation, partial patch).
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { coupons, users } from '../../src/db/schema.js'
import {
  createCoupon,
  deleteCoupon,
  getAdminCoupon,
  getCouponRuleByCode,
  listAdminCoupons,
  listPublicCoupons,
  updateCoupon,
  validateCoupon,
} from '../../src/services/coupons.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let adminId: string

const NOW = new Date('2026-07-22T00:00:00.000Z')

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db

  const [row] = await db
    .insert(users)
    .values({ firebaseUid: 'admin-uid', phone: '+919000000001', role: 'admin' })
    .returning({ id: users.id })
  if (!row) throw new Error('user insert failed')
  adminId = row.id
})

async function seedCoupon(overrides: Partial<typeof coupons.$inferInsert> = {}) {
  await db.insert(coupons).values({
    code: 'DIRECT15',
    label: 'Early Bird offer',
    description: '15% off your order',
    discountType: 'percent',
    discountValue: 15,
    minCartInr: 0,
    maxDiscountInr: null,
    active: true,
    sortOrder: 0,
    ...overrides,
  })
}

describe('getCouponRuleByCode', () => {
  it('resolves COUPON_NONE for a blank/absent code', async () => {
    expect(await getCouponRuleByCode(db, undefined)).toEqual({ code: null, rule: null })
    expect(await getCouponRuleByCode(db, '')).toEqual({ code: null, rule: null })
    expect(await getCouponRuleByCode(db, '   ')).toEqual({ code: null, rule: null })
  })

  it('resolves a valid apply: an active, in-window, matching code', async () => {
    await seedCoupon()
    const lookup = await getCouponRuleByCode(db, 'DIRECT15')
    expect(lookup.code).toBe('DIRECT15')
    expect(lookup.rule).toMatchObject({
      code: 'DIRECT15',
      discountType: 'percent',
      discountValue: 15,
    })
  })

  it('normalizes lower/mixed case and surrounding whitespace to the uppercase code', async () => {
    await seedCoupon()
    expect((await getCouponRuleByCode(db, 'direct15')).rule?.code).toBe('DIRECT15')
    expect((await getCouponRuleByCode(db, ' DiReCt15 ')).rule?.code).toBe('DIRECT15')
  })

  it('an unknown code resolves with rule: null (never throws)', async () => {
    const lookup = await getCouponRuleByCode(db, 'NOPE')
    expect(lookup).toEqual({ code: 'NOPE', rule: null })
  })
})

describe('validateCoupon (public, stateless)', () => {
  it('valid apply: applied true, discount computed against the given cartTotalInr', async () => {
    await seedCoupon()
    const result = await validateCoupon(db, 'DIRECT15', 1000, NOW)
    expect(result.applied).toBe(true)
    expect(result.discountInr).toBe(150) // 15% of 1000
    expect(result.subtotalInr).toBe(1000)
    expect(result.reason).toBeNull()
  })

  it('unknown code -> applied false, reason invalid', async () => {
    const result = await validateCoupon(db, 'GHOST', 1000, NOW)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('invalid')
    expect(result.code).toBe('GHOST')
  })

  it('expired coupon (past validTo) -> applied false, reason expired', async () => {
    await seedCoupon({ validTo: new Date('2026-01-01T00:00:00.000Z') })
    const result = await validateCoupon(db, 'DIRECT15', 1000, NOW)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('not-yet-valid coupon (before validFrom) -> applied false, reason expired', async () => {
    await seedCoupon({ validFrom: new Date('2026-08-01T00:00:00.000Z') })
    const result = await validateCoupon(db, 'DIRECT15', 1000, NOW)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('inactive coupon -> applied false, reason inactive', async () => {
    await seedCoupon({ active: false })
    const result = await validateCoupon(db, 'DIRECT15', 1000, NOW)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('inactive')
  })

  it('min-cart not met -> applied false, reason below_min', async () => {
    await seedCoupon({ discountType: 'flat', discountValue: 100, minCartInr: 1000 })
    const result = await validateCoupon(db, 'DIRECT15', 999, NOW)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('below_min')
    expect(result.discountInr).toBe(0)
  })

  it('min-cart met exactly -> applied true', async () => {
    await seedCoupon({ discountType: 'flat', discountValue: 100, minCartInr: 1000 })
    const result = await validateCoupon(db, 'DIRECT15', 1000, NOW)
    expect(result.applied).toBe(true)
    expect(result.discountInr).toBe(100)
  })
})

describe('listPublicCoupons', () => {
  it('returns only active AND currently time-valid coupons, sorted by sortOrder', async () => {
    await seedCoupon({ code: 'B', sortOrder: 1 })
    await seedCoupon({ code: 'A', sortOrder: 0 })
    await seedCoupon({ code: 'INACTIVE', active: false, sortOrder: 2 })
    await seedCoupon({
      code: 'EXPIRED',
      sortOrder: 3,
      validTo: new Date('2026-01-01T00:00:00.000Z'),
    })

    const list = await listPublicCoupons(db, 10, NOW)
    expect(list.map((c) => c.code)).toEqual(['A', 'B'])
  })

  it('caps the result to the given limit', async () => {
    await seedCoupon({ code: 'A', sortOrder: 0 })
    await seedCoupon({ code: 'B', sortOrder: 1 })
    const list = await listPublicCoupons(db, 1, NOW)
    expect(list).toHaveLength(1)
    expect(list[0]?.code).toBe('A')
  })
})

describe('admin CRUD', () => {
  it('creates a coupon, uppercasing the code', async () => {
    const created = await createCoupon(
      db,
      {
        code: 'direct15',
        label: 'Early Bird offer',
        discountType: 'percent',
        discountValue: 15,
      },
      adminId
    )
    expect(created.code).toBe('DIRECT15')
    expect(created.active).toBe(true)
    expect(created.minCartInr).toBe(0)
  })

  it('rejects a duplicate code (case-insensitive)', async () => {
    await createCoupon(
      db,
      { code: 'DIRECT15', label: 'x', discountType: 'flat', discountValue: 10 },
      adminId
    )
    await expect(
      createCoupon(
        db,
        { code: 'direct15', label: 'y', discountType: 'flat', discountValue: 20 },
        adminId
      )
    ).rejects.toMatchObject({ statusCode: 422, code: 'validation_failed' })
  })

  it('rejects an out-of-range percent value (service-level backstop)', async () => {
    await expect(
      createCoupon(
        db,
        { code: 'BAD', label: 'x', discountType: 'percent', discountValue: 95 },
        adminId
      )
    ).rejects.toMatchObject({ statusCode: 422, code: 'validation_failed' })
  })

  it('rejects a non-positive flat value (service-level backstop)', async () => {
    await expect(
      createCoupon(db, { code: 'BAD', label: 'x', discountType: 'flat', discountValue: 0 }, adminId)
    ).rejects.toMatchObject({ statusCode: 422, code: 'validation_failed' })
  })

  it('lists every coupon, including inactive', async () => {
    await createCoupon(
      db,
      { code: 'A', label: 'a', discountType: 'flat', discountValue: 10 },
      adminId
    )
    await createCoupon(
      db,
      { code: 'B', label: 'b', discountType: 'flat', discountValue: 10, active: false },
      adminId
    )
    const list = await listAdminCoupons(db)
    expect(list.map((c) => c.code).sort()).toEqual(['A', 'B'])
  })

  it('reads one coupon by code (normalized), 404s when absent', async () => {
    await createCoupon(
      db,
      { code: 'A', label: 'a', discountType: 'flat', discountValue: 10 },
      adminId
    )
    expect((await getAdminCoupon(db, 'a')).code).toBe('A')
    await expect(getAdminCoupon(db, 'GHOST')).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })

  it('patches a single field, leaving the rest untouched', async () => {
    await createCoupon(
      db,
      { code: 'A', label: 'a', discountType: 'percent', discountValue: 15 },
      adminId
    )
    const updated = await updateCoupon(db, 'A', { label: 'Renamed' }, adminId)
    expect(updated.label).toBe('Renamed')
    expect(updated.discountValue).toBe(15)
  })

  it('validates the EFFECTIVE discountValue against the EXISTING discountType on a partial patch', async () => {
    await createCoupon(
      db,
      { code: 'A', label: 'a', discountType: 'percent', discountValue: 15 },
      adminId
    )
    // Existing type is 'percent'; patching discountValue alone to 200 must fail against percent's 1..90.
    await expect(updateCoupon(db, 'A', { discountValue: 200 }, adminId)).rejects.toMatchObject({
      statusCode: 422,
      code: 'validation_failed',
    })
  })

  it('404s updating a missing coupon', async () => {
    await expect(updateCoupon(db, 'GHOST', { label: 'x' }, adminId)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('deletes a coupon (204-equivalent no-throw), 404s when absent', async () => {
    await createCoupon(
      db,
      { code: 'A', label: 'a', discountType: 'flat', discountValue: 10 },
      adminId
    )
    await deleteCoupon(db, 'a')
    const [row] = await db.select().from(coupons).where(eq(coupons.code, 'A'))
    expect(row).toBeUndefined()
    await expect(deleteCoupon(db, 'A')).rejects.toMatchObject({ statusCode: 404 })
  })
})
