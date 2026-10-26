/**
 * Route tests: public GET /v1/config (snapshot + ETag/304), admin
 * /v1/admin/config (401 no token / 403 customer role / PUT upsert + audit /
 * DELETE + 404) — SPEC-V2.md §7 bullet 3.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appConfigAudit } from '../../src/db/schema.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

/**
 * Makes USER_ADMIN's `users` row exist with role='admin' (simulates the
 * manual SQL promotion described in SPEC-V2.md §1). The first authed request
 * (rejected with 403 while still a customer) is what upserts the row; only
 * after that can we flip its role.
 */
async function makeAdmin(): Promise<void> {
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/config',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
}

describe('GET /v1/config (public)', () => {
  it('200s with an empty snapshot before any config exists', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.values).toEqual({})
    expect(body.updatedAt).toBe(new Date(0).toISOString())
    expect(typeof body.version).toBe('string')
    expect(res.headers.etag).toBe(`"${body.version}"`)
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })

  it('requires no auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    expect(res.statusCode).not.toBe(401)
  })

  it('reflects an admin-written value', async () => {
    await makeAdmin()
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/orders.cancelReasons',
      headers: auth(USER_ADMIN.token),
      payload: { value: ['Duplicate order'] },
    })

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    expect(res.json().values).toEqual({ 'orders.cancelReasons': ['Duplicate order'] })
  })

  it('serves ONLY the allowlisted keys — a non-public key is never exposed', async () => {
    await makeAdmin()
    for (const [key, value] of [
      ['legal.company', { name: 'ADIX AI' }],
      ['orders.cancelReasons', ['Duplicate order']],
      // Not allowlisted. `ops.notifyNumbers` is the on-call phone list and
      // `fulfilment.pickupLocationName` the registered warehouse — the exact
      // reason this endpoint is an allowlist.
      ['ops.notifyNumbers', ['919876543210']],
      ['fulfilment.pickupLocationName', 'AHM-01'],
      ['shipping.marginBps', 1000],
      ['checkout.mode', 'whatsapp'],
    ] as const) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/v1/admin/config/${key}`,
        headers: auth(USER_ADMIN.token),
        payload: { value },
      })
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    expect(Object.keys(res.json().values).sort()).toEqual(['legal.company', 'orders.cancelReasons'])

    // The admin view is the unfiltered one — the rows do exist.
    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/config',
      headers: auth(USER_ADMIN.token),
    })
    expect(admin.json().map((e: { key: string }) => e.key)).toContain('ops.notifyNumbers')
  })

  it('a private-key write does not change the public ETag', async () => {
    await makeAdmin()
    const before = await ctx.app.inject({ method: 'GET', url: '/v1/config' })

    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/ops.notifyNumbers',
      headers: auth(USER_ADMIN.token),
      payload: { value: ['919876543210'] },
    })

    const after = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    expect(after.headers.etag).toBe(before.headers.etag)
    expect(after.json().updatedAt).toBe(before.json().updatedAt)
  })

  it('304s with an empty body when If-None-Match matches the current version (quoted or bare)', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    const version = first.json().version as string

    const quoted = await ctx.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'if-none-match': `"${version}"` },
    })
    expect(quoted.statusCode).toBe(304)
    expect(quoted.body).toBe('')

    const bare = await ctx.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'if-none-match': version },
    })
    expect(bare.statusCode).toBe(304)
    expect(bare.body).toBe('')

    // The form clients ACTUALLY send: Cloudflare weakens the validator
    // whenever it compresses the response. See lib/etag.ts.
    const weak = await ctx.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'if-none-match': `W/"${version}"` },
    })
    expect(weak.statusCode).toBe(304)
    expect(weak.body).toBe('')
  })

  it('200s (not 304) when If-None-Match is stale', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'if-none-match': '"deadbeefdeadbeef"' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('/v1/admin/config auth', () => {
  it('401s without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/admin/config' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('403s for an authenticated customer (non-admin) role', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/config',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
  })

  it('200s for an admin role', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/config',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('PUT /v1/admin/config/:key', () => {
  it('200s, upserts, and writes exactly one audit row', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/checkout.mode',
      headers: auth(USER_ADMIN.token),
      payload: { value: 'whatsapp', description: 'checkout flow' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      key: 'checkout.mode',
      value: 'whatsapp',
      description: 'checkout flow',
    })

    const auditRows = await ctx.db
      .select()
      .from(appConfigAudit)
      .where(eq(appConfigAudit.key, 'checkout.mode'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.oldValue).toBeNull()
  })

  it('403s for a customer role', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/checkout.mode',
      headers: auth(USER_A.token),
      payload: { value: 'whatsapp' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('422s for a malformed key', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/Bad.Key',
      headers: auth(USER_ADMIN.token),
      payload: { value: 'x' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('422s for an oversized value', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/big.value',
      headers: auth(USER_ADMIN.token),
      payload: { value: 'x'.repeat(20_000) },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /v1/admin/config/:key', () => {
  it('204s and removes the key', async () => {
    await makeAdmin()
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/config/checkout.mode',
      headers: auth(USER_ADMIN.token),
      payload: { value: 'whatsapp' },
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/config/checkout.mode',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/config',
      headers: auth(USER_ADMIN.token),
    })
    expect(list.json()).toEqual([])
  })

  it('404s for a missing key', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/config/nope',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('403s for a customer role', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/config/checkout.mode',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })
})
