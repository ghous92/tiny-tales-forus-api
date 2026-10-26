/**
 * Route tests: `/v1/coupons` (public) and `/v1/admin/coupons` (admin CRUD) —
 * auth gates (401/403), the public list + validate wiring (incl. the
 * `coupons.autoSuggestCount` config knob), and CRUD HTTP plumbing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appConfig } from '../../src/db/schema.js'
import { auth, createTestApp, promoteToAdmin, USER_A, USER_ADMIN, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

async function makeAdmin(): Promise<void> {
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/coupons',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
}

const A = () => auth(USER_ADMIN.token)

async function createViaApi(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/coupons',
    headers: A(),
    payload: {
      code: 'DIRECT15',
      label: 'Early Bird offer',
      discountType: 'percent',
      discountValue: 15,
      ...payload,
    },
  })
}

// --- Public routes -----------------------------------------------------------

describe('GET /v1/coupons (public)', () => {
  it('200s with an empty list when no coupons exist', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/coupons' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ coupons: [] })
  })

  it('returns active, time-valid coupons ordered by sortOrder, no auth required', async () => {
    await makeAdmin()
    await createViaApi({ code: 'B', sortOrder: 1 })
    await createViaApi({ code: 'A', sortOrder: 0 })
    await createViaApi({ code: 'OFF', active: false, sortOrder: 2 })

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/coupons' })
    expect(res.statusCode).toBe(200)
    expect(res.json().coupons.map((c: { code: string }) => c.code)).toEqual(['A', 'B'])
  })

  it('caps the list to coupons.autoSuggestCount from config', async () => {
    await makeAdmin()
    await createViaApi({ code: 'A', sortOrder: 0 })
    await createViaApi({ code: 'B', sortOrder: 1 })
    await createViaApi({ code: 'C', sortOrder: 2 })
    await ctx.db.insert(appConfig).values({ key: 'coupons.autoSuggestCount', value: 2 })

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/coupons' })
    expect(res.json().coupons).toHaveLength(2)
  })

  it('falls back to the default count when config is malformed', async () => {
    await makeAdmin()
    for (let i = 0; i < 5; i++) await createViaApi({ code: `C${i}`, sortOrder: i })
    await ctx.db.insert(appConfig).values({ key: 'coupons.autoSuggestCount', value: 'not-a-number' })

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/coupons' })
    expect(res.json().coupons).toHaveLength(3) // DEFAULT_AUTO_SUGGEST_COUNT
  })
})

describe('POST /v1/coupons/validate (public)', () => {
  it('200s with the computed discount for a valid code, no auth required', async () => {
    await makeAdmin()
    await createViaApi({})

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/coupons/validate',
      payload: { code: 'direct15', cartTotalInr: 1000 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.applied).toBe(true)
    expect(body.code).toBe('DIRECT15')
    expect(body.discountInr).toBe(150)
    expect(body.subtotalInr).toBe(1000)
  })

  it('200s with applied:false and reason invalid for an unknown code', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/coupons/validate',
      payload: { code: 'GHOST', cartTotalInr: 1000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ applied: false, reason: 'invalid' })
  })

  it('422s for a missing cartTotalInr', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/coupons/validate',
      payload: { code: 'DIRECT15' },
    })
    expect(res.statusCode).toBe(422)
  })
})

// --- Admin auth gates ----------------------------------------------------------

describe('admin coupon auth', () => {
  it.each([
    ['GET', '/v1/admin/coupons'],
    ['POST', '/v1/admin/coupons'],
    ['GET', '/v1/admin/coupons/DIRECT15'],
    ['PUT', '/v1/admin/coupons/DIRECT15'],
    ['DELETE', '/v1/admin/coupons/DIRECT15'],
  ] as const)('401s %s %s without a token', async (method, url) => {
    const res = await ctx.app.inject({ method, url })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it.each([
    ['GET', '/v1/admin/coupons'],
    ['POST', '/v1/admin/coupons'],
    ['GET', '/v1/admin/coupons/DIRECT15'],
    ['PUT', '/v1/admin/coupons/DIRECT15'],
    ['DELETE', '/v1/admin/coupons/DIRECT15'],
  ] as const)('403s %s %s for a non-admin user', async (method, url) => {
    const res = await ctx.app.inject({ method, url, headers: auth(USER_A.token) })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
  })

  it('200s GET /v1/admin/coupons for an admin', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/admin/coupons', headers: A() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

// --- Admin CRUD ----------------------------------------------------------------

describe('admin coupon CRUD', () => {
  beforeEach(makeAdmin)

  it('creates (201), lists, reads, patches, and deletes (204) a coupon', async () => {
    const created = await createViaApi({})
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ code: 'DIRECT15', label: 'Early Bird offer', active: true })

    const list = await ctx.app.inject({ method: 'GET', url: '/v1/admin/coupons', headers: A() })
    expect(list.json()).toHaveLength(1)

    const got = await ctx.app.inject({ method: 'GET', url: '/v1/admin/coupons/direct15', headers: A() })
    expect(got.statusCode).toBe(200)
    expect(got.json().code).toBe('DIRECT15')

    const patched = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/coupons/direct15',
      headers: A(),
      payload: { label: 'Renamed', active: false },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({ label: 'Renamed', active: false })

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/coupons/direct15',
      headers: A(),
    })
    expect(deleted.statusCode).toBe(204)

    const after = await ctx.app.inject({ method: 'GET', url: '/v1/admin/coupons', headers: A() })
    expect(after.json()).toEqual([])
  })

  it('rejects a duplicate code with 422', async () => {
    await createViaApi({})
    const dup = await createViaApi({})
    expect(dup.statusCode).toBe(422)
  })

  it('rejects an out-of-range percent discountValue with 422 (contract-level)', async () => {
    const res = await createViaApi({ discountValue: 95 })
    expect(res.statusCode).toBe(422)
  })

  it('rejects a non-positive flat discountValue with 422 (contract-level)', async () => {
    const res = await createViaApi({ discountType: 'flat', discountValue: 0 })
    expect(res.statusCode).toBe(422)
  })

  it('rejects validFrom after validTo with 422', async () => {
    const res = await createViaApi({
      validFrom: '2026-08-01T00:00:00.000Z',
      validTo: '2026-01-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects unknown body fields (strict)', async () => {
    const res = await createViaApi({ notAField: true })
    expect(res.statusCode).toBe(422)
  })

  it('404s reading/updating/deleting a missing coupon', async () => {
    const get = await ctx.app.inject({ method: 'GET', url: '/v1/admin/coupons/GHOST', headers: A() })
    expect(get.statusCode).toBe(404)

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/coupons/GHOST',
      headers: A(),
      payload: { label: 'x' },
    })
    expect(put.statusCode).toBe(404)

    const del = await ctx.app.inject({ method: 'DELETE', url: '/v1/admin/coupons/GHOST', headers: A() })
    expect(del.statusCode).toBe(404)
  })
})
