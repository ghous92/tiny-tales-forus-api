/**
 * Route tests: the full HTTP surface via `app.inject()` against the real app
 * with a fake token verifier (auth stubbed at the plugin seam) and an
 * in-memory Postgres. Covers every done-criterion case: happy paths, 401s,
 * cross-user 404s, the 422 variants, default promotion on delete, and
 * default-swap transactionality.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Address } from '../../src/contracts/address.js'
import { addresses, users } from '../../src/db/schema.js'
import { MAX_ADDRESSES_PER_USER } from '../../src/services/addresses.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_B,
  USER_NO_PHONE,
  validAddress,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

/** POST a valid address as `token`, return the created resource. */
async function create(token: string, overrides: Record<string, unknown> = {}): Promise<Address> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/addresses',
    headers: auth(token),
    payload: validAddress(overrides),
  })
  expect(res.statusCode).toBe(201)
  return res.json() as Address
}

describe('authentication (all /v1 routes)', () => {
  it('401s without an Authorization header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/addresses' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('401s for a non-Bearer scheme', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: { authorization: 'Basic abc123' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('401s for a token the verifier rejects', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth('forged-token'),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      error: { code: 'unauthorized', message: 'Invalid or expired token' },
    })
  })

  it('401s for a valid token missing the phone_number claim', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_NO_PHONE.token),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('upserts the users row on first authed request (E.164 phone), without duplicating later', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })

    const rows = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.phone).toBe(USER_A.phoneNumber)
  })

  it('updates the stored phone when the token claim changes for the same uid', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    ctx.tokens.set(USER_A.token, { uid: USER_A.uid, phoneNumber: '+919000000000' })
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })

    const rows = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.phone).toBe('+919000000000')
  })

  it('re-links an existing row when the token phone matches a different uid, resetting role to customer', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    await promoteToAdmin(ctx.db, USER_A.uid)
    const created = await create(USER_A.token)

    const [before] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(before?.role).toBe('admin')

    // Same phone, brand-new uid — simulates the Firebase account for this
    // number being deleted and the number re-verified from scratch.
    const newUid = 'firebase-uid-a-recreated'
    ctx.tokens.set('test-token-user-a-relinked', { uid: newUid, phoneNumber: USER_A.phoneNumber })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth('test-token-user-a-relinked'),
    })
    expect(res.statusCode).toBe(200)

    const rows = await ctx.db.select().from(users).where(eq(users.phone, USER_A.phoneNumber))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(before?.id)
    expect(rows[0]?.firebaseUid).toBe(newUid)
    expect(rows[0]?.role).toBe('customer')

    // Relink must not orphan existing data.
    const preserved = await ctx.db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(preserved).toHaveLength(1)
    expect(preserved[0]?.userId).toBe(before?.id)
  })

  it('handles two concurrent first-authed-requests for the same new uid+phone without erroring', async () => {
    ctx.tokens.set('test-token-user-concurrent', {
      uid: 'firebase-uid-concurrent',
      phoneNumber: '+919999999999',
    })
    const [res1, res2] = await Promise.all([
      ctx.app.inject({
        method: 'GET',
        url: '/v1/addresses',
        headers: auth('test-token-user-concurrent'),
      }),
      ctx.app.inject({
        method: 'GET',
        url: '/v1/addresses',
        headers: auth('test-token-user-concurrent'),
      }),
    ])
    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)

    const rows = await ctx.db
      .select()
      .from(users)
      .where(eq(users.firebaseUid, 'firebase-uid-concurrent'))
    expect(rows).toHaveLength(1)
  })

  it('409s when a token claims a phone already owned by a different, unrelated uid', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_B.token) })

    ctx.tokens.set(USER_A.token, { uid: USER_A.uid, phoneNumber: USER_B.phoneNumber })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')

    // Failed attempt must not leave the row half-updated.
    const rows = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(rows[0]?.phone).toBe(USER_A.phoneNumber)
  })
})

describe('POST /v1/addresses', () => {
  it('201s with the serialized resource', async () => {
    const created = await create(USER_A.token)
    expect(created).toMatchObject({
      name: 'Asha Rao',
      phone: '9876543210',
      pincode: '560001',
      city: 'Bengaluru',
      state: 'Karnataka',
      houseNumber: '12B, Sunrise Apartments',
      roadArea: 'MG Road, Shanthala Nagar',
      isDefault: true, // first address is forced default
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
    expect(new Date(created.updatedAt).toISOString()).toBe(created.updatedAt)
  })

  it('stores the phone as E.164 while serving 10 digits', async () => {
    const created = await create(USER_A.token)
    const [row] = await ctx.db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(row?.phone).toBe('+919876543210')
    expect(created.phone).toBe('9876543210')
  })

  it('forces the first address to default even when the body says isDefault=false', async () => {
    const created = await create(USER_A.token, { isDefault: false })
    expect(created.isDefault).toBe(true)
  })

  it('creating with isDefault=true unsets the previous default atomically', async () => {
    const first = await create(USER_A.token)
    const second = await create(USER_A.token, { isDefault: true })

    const rows = await ctx.db.select().from(addresses)
    const defaults = rows.filter((row) => row.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(second.id)
    expect(defaults[0]?.id).not.toBe(first.id)
  })

  it.each([
    ['bad phone', { phone: '5876543210' }],
    ['short phone', { phone: '987654321' }],
    ['bad pincode', { pincode: '060001' }],
    ['short pincode', { pincode: '56001' }],
    ['empty name', { name: '' }],
    ['empty houseNumber', { houseNumber: '' }],
    ['empty roadArea', { roadArea: '' }],
  ])('422 validation_failed for %s', async (_label, override) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: validAddress(override),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422 validation_failed for unknown JSON fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: validAddress({ useAsDefault: true }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422 validation_failed for a malformed JSON body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: { ...auth(USER_A.token), 'content-type': 'application/json' },
      payload: '{"name": "Asha"',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it(`422 limit_exceeded on the ${MAX_ADDRESSES_PER_USER + 1}th address, leaving the default untouched`, async () => {
    const first = await create(USER_A.token)
    for (let i = 1; i < MAX_ADDRESSES_PER_USER; i++) await create(USER_A.token)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: validAddress({ isDefault: true }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('limit_exceeded')

    const rows = await ctx.db.select().from(addresses)
    expect(rows).toHaveLength(MAX_ADDRESSES_PER_USER)
    const defaults = rows.filter((row) => row.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(first.id)
  })

  it('per-user limit: another user can still create when one user is full', async () => {
    for (let i = 0; i < 10; i++) await create(USER_A.token)
    const created = await create(USER_B.token, { phone: '9123456780' })
    expect(created.isDefault).toBe(true)
  })
})

describe('GET /v1/addresses', () => {
  it('returns [] before any addresses exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('lists default first, then newest to oldest', async () => {
    const first = await create(USER_A.token) // default
    const middle = await create(USER_A.token)
    const newest = await create(USER_A.token)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const ids = res.json().map((a: { id: string }) => a.id)
    expect(ids).toEqual([first.id, newest.id, middle.id])
  })

  it('reorders after the default moves', async () => {
    const first = await create(USER_A.token) // default
    const middle = await create(USER_A.token)
    const newest = await create(USER_A.token)

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${middle.id}`,
      headers: auth(USER_A.token),
      payload: { isDefault: true },
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })
    const ids = res.json().map((a: { id: string }) => a.id)
    expect(ids).toEqual([middle.id, newest.id, first.id])
  })

  it("never includes another user's addresses", async () => {
    await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_B.token),
    })
    expect(res.json()).toEqual([])
  })
})

describe('GET /v1/addresses/:id', () => {
  it('200s with the resource for the owner', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(created)
  })

  it("404s (never 403) for another user's id", async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('404s for a nonexistent id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses/4f9c2f6a-1c8e-4b8e-9f3a-2b1d5c7e8a90',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('422s for a malformed id (params are validated)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses/not-a-uuid',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })
})

describe('PATCH /v1/addresses/:id', () => {
  it('applies a partial update and bumps updatedAt', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
      payload: { city: 'Mysuru', phone: '9123456780' },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json()
    expect(updated.city).toBe('Mysuru')
    expect(updated.phone).toBe('9123456780')
    expect(updated.name).toBe(created.name)
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))

    const [row] = await ctx.db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(row?.phone).toBe('+919123456780')
  })

  it('validates patched fields with the create rules', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
      payload: { pincode: '00001' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s for unknown fields', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
      payload: { useAsDefault: true },
    })
    expect(res.statusCode).toBe(422)
  })

  it('isDefault=true swaps the default; exactly one default remains', async () => {
    const first = await create(USER_A.token)
    const second = await create(USER_A.token)

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${second.id}`,
      headers: auth(USER_A.token),
      payload: { isDefault: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().isDefault).toBe(true)

    const rows = await ctx.db.select().from(addresses)
    const defaults = rows.filter((row) => row.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(second.id)

    const firstNow = rows.find((row) => row.id === first.id)
    expect(firstNow?.isDefault).toBe(false)
  })

  it('422 default_required when un-defaulting the current default', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
      payload: { isDefault: false },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('default_required')
  })

  it("404s (never 403) for another user's id, changing nothing", async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_B.token),
      payload: { city: 'Hacked' },
    })
    expect(res.statusCode).toBe(404)

    const [row] = await ctx.db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(row?.city).toBe('Bengaluru')
  })
})

describe('DELETE /v1/addresses/:id', () => {
  it('204s with an empty body and removes the row', async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_A.token),
    })
    expect(after.statusCode).toBe(404)
  })

  it('deleting the default promotes the newest remaining address', async () => {
    const first = await create(USER_A.token) // default
    const middle = await create(USER_A.token)
    const newest = await create(USER_A.token)

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/addresses/${first.id}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(204)

    const rows = await ctx.db.select().from(addresses)
    const defaults = rows.filter((row) => row.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(newest.id)

    const middleNow = rows.find((row) => row.id === middle.id)
    expect(middleNow?.isDefault).toBe(false)
  })

  it('deleting a non-default address leaves the default alone', async () => {
    const first = await create(USER_A.token) // default
    const second = await create(USER_A.token)

    await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/addresses/${second.id}`,
      headers: auth(USER_A.token),
    })

    const rows = await ctx.db.select().from(addresses)
    expect(rows.filter((row) => row.isDefault)[0]?.id).toBe(first.id)
  })

  it("404s (never 403) for another user's id without deleting it", async () => {
    const created = await create(USER_A.token)
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/addresses/${created.id}`,
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)

    const rows = await ctx.db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(rows).toHaveLength(1)
  })
})
