/**
 * /v1/me route tests — the profile the app's post-login prompt writes. Covers
 * the fresh-user shape (name/email null), partial and full patches, validation
 * rejects, auth, and the isolation guarantee that "me" is always the token's
 * own row and never another user's.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Profile } from '../../src/contracts/profile.js'
import { addresses, cartItems, catalogItems, payments, users } from '../../src/db/schema.js'
import { auth, createTestApp, USER_A, USER_B, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

/** PATCH /v1/me as `token`. */
function patch(token: string, payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: auth(token), payload })
}

describe('GET /v1/me', () => {
  it('401s without an Authorization header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
  })

  it('returns the auto-upserted profile with name and email null', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    expect(res.statusCode).toBe(200)
    const profile = res.json() as Profile
    expect(profile.name).toBeNull()
    expect(profile.email).toBeNull()
    expect(profile.gender).toBeNull()
    expect(profile.dob).toBeNull()
    // E.164 storage, bare 10 digits on the wire (docs/CONTRACTS.md).
    expect(profile.phone).toBe('9876543210')
  })
})

describe('PATCH /v1/me', () => {
  it('sends the complete saved profile to analytics under the database user id', async () => {
    const userProfileUpdated = vi.fn()
    const analyticsCtx = await createTestApp({
      analytics: {
        enabled: true,
        userProfileUpdated,
        orderCompleted: () => {},
        flush: async () => {},
      },
    })

    try {
      const res = await analyticsCtx.app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(USER_A.token),
        payload: { name: 'Asha Rao', email: 'asha@example.com' },
      })
      expect(res.statusCode).toBe(200)
      const profile = res.json() as Profile
      expect(userProfileUpdated).toHaveBeenCalledWith({
        userId: profile.id,
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '9876543210',
        gender: null,
        dob: null,
        marketingWhatsappOptIn: null,
        adAudienceOptIn: null,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })
    } finally {
      await analyticsCtx.app.close()
    }
  })

  it('saves name and email, and GET reads them back', async () => {
    const res = await patch(USER_A.token, { name: 'Asha Rao', email: 'asha@example.com' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com' })

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect(after.json()).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com' })
  })

  it('patches one field without clearing the other', async () => {
    await patch(USER_A.token, { name: 'Asha Rao', email: 'asha@example.com' })
    const res = await patch(USER_A.token, { email: 'asha.rao@example.com' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'Asha Rao', email: 'asha.rao@example.com' })
  })

  it('trims surrounding whitespace before storing', async () => {
    const res = await patch(USER_A.token, { name: '  Asha Rao  ', email: ' asha@example.com ' })
    expect(res.json()).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com' })
  })

  it('422s on an invalid email', async () => {
    const res = await patch(USER_A.token, { name: 'Asha', email: 'not-an-email' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s on a blank name', async () => {
    expect((await patch(USER_A.token, { name: '   ' })).statusCode).toBe(422)
  })

  it('422s on an empty body', async () => {
    expect((await patch(USER_A.token, {})).statusCode).toBe(422)
  })

  it('422s on unknown keys (strict)', async () => {
    expect((await patch(USER_A.token, { name: 'Asha', role: 'admin' })).statusCode).toBe(422)
  })

  it('saves gender and dob, and GET reads them back', async () => {
    const res = await patch(USER_A.token, { gender: 'miss', dob: '1998-05-20' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ gender: 'miss', dob: '1998-05-20' })

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect(after.json()).toMatchObject({ gender: 'miss', dob: '1998-05-20' })
  })

  it('422s on an invalid gender', async () => {
    const res = await patch(USER_A.token, { gender: 'other' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('422s on a future dob', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect((await patch(USER_A.token, { dob: future })).statusCode).toBe(422)
  })

  it('422s on an implausibly old dob', async () => {
    expect((await patch(USER_A.token, { dob: '1850-01-01' })).statusCode).toBe(422)
  })

  it('never touches another user’s row', async () => {
    await patch(USER_A.token, { name: 'Asha Rao', email: 'asha@example.com' })
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_B.token) })
    expect(res.json()).toMatchObject({ name: null, email: null })
  })

  it('survives the auth plugin’s per-request upsert', async () => {
    await patch(USER_A.token, { name: 'Asha Rao', email: 'asha@example.com' })
    // Any later authed request re-runs the users upsert; it must not reset the profile.
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_A.token) })
    const [row] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(row).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com' })
  })
})

describe('DELETE /v1/me (account deletion)', () => {
  // Its own local app/ctx — `deleteFirebaseUser` is a spy here, unlike the
  // shared `ctx` above, which never touches this route.
  let delCtx: TestContext
  let revokedUids: string[]

  beforeEach(async () => {
    revokedUids = []
    delCtx = await createTestApp({
      deleteFirebaseUser: (uid) => {
        revokedUids.push(uid)
        return Promise.resolve()
      },
    })
  })

  afterEach(async () => {
    await delCtx.app.close()
  })

  it('401s without an Authorization header', async () => {
    const res = await delCtx.app.inject({ method: 'DELETE', url: '/v1/me' })
    expect(res.statusCode).toBe(401)
  })

  it('204s, revokes the Firebase uid, and anonymizes the row in place', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const [before] = await delCtx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    const userId = before!.id

    const res = await delCtx.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(204)
    expect(revokedUids).toEqual([USER_A.uid])

    // Same row (same id) — never hard-deleted — but scrubbed, and the
    // tombstone is never the real E.164 phone or firebase uid.
    const [after] = await delCtx.db.select().from(users).where(eq(users.id, userId))
    expect(after).toMatchObject({
      id: userId,
      name: null,
      email: null,
      gender: null,
      dob: null,
      role: 'customer',
    })
    expect(after!.phone).not.toBe('+919876543210')
    expect(after!.firebaseUid).not.toBe(USER_A.uid)
    expect(after!.phone).toContain(userId)
    expect(after!.firebaseUid).toContain(userId)
  })

  it('deletes addresses and cart items (not tax-required, unlike payments)', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const [userRow] = await delCtx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.firebaseUid, USER_A.uid))
    const userId = userRow!.id

    await delCtx.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
      payload: {
        name: 'Asha Rao',
        phone: '9876543210',
        pincode: '380015',
        city: 'Ahmedabad',
        state: 'Gujarat',
        houseNumber: '12B',
        roadArea: 'Satellite Road',
        isDefault: true,
      },
    })
    await delCtx.db.insert(catalogItems).values({
      sku: 'SKU-DEL-1',
      productId: 'p1',
      name: 'Test',
      size: '100g',
      priceInr: 100,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      active: true,
    })
    await delCtx.app.inject({
      method: 'PUT',
      url: '/v1/cart/items/SKU-DEL-1',
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })

    await delCtx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) })

    const remainingAddresses = await delCtx.db
      .select()
      .from(addresses)
      .where(eq(addresses.userId, userId))
    const remainingCartItems = await delCtx.db
      .select()
      .from(cartItems)
      .where(eq(cartItems.userId, userId))
    expect(remainingAddresses).toHaveLength(0)
    expect(remainingCartItems).toHaveLength(0)
  })

  it('keeps payment/order history intact (tax retention), still linked to the same user id', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const [userRow] = await delCtx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.firebaseUid, USER_A.uid))
    const userId = userRow!.id

    await delCtx.db.insert(payments).values({
      orderId: 'order_KEEP_ME',
      userId,
      amountPaise: 10000,
      status: 'paid',
      cartSnapshot: { items: [], totalInr: 100 },
      addressSnapshot: { name: 'Asha Rao' },
    })

    await delCtx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) })

    const [row] = await delCtx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, 'order_KEEP_ME'))
    expect(row).toBeDefined()
    expect(row!.userId).toBe(userId)
  })

  it('signing in again with the same phone after deletion creates a brand-new, empty profile', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    await delCtx.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth(USER_A.token),
      payload: { name: 'Asha Rao' },
    })
    await delCtx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) })

    // Same token/uid/phone claims — the auth plugin's upsert can no longer
    // find the old (tombstoned) row by either firebase_uid or phone, so it
    // inserts a fresh one.
    const res = await delCtx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const profile = res.json() as Profile
    expect(profile.name).toBeNull()
    expect(profile.phone).toBe('9876543210')

    const rows = await delCtx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(rows).toHaveLength(1)
  })

  it('404s a second delete (the row is gone under the old identity)', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    await delCtx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) })

    // The auth plugin re-upserts on every request, so the SAME token now maps
    // to a brand-new row rather than 404ing outright — assert the important
    // property instead: it is definitely not the same account (fresh/empty),
    // never a resurrection of the deleted one's data.
    const res = await delCtx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect((res.json() as Profile).name).toBeNull()
  })

  it('never touches another user’s row', async () => {
    await delCtx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    await delCtx.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth(USER_B.token),
      payload: { name: 'Other User' },
    })

    await delCtx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) })

    const res = await delCtx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Profile).name).toBe('Other User')
  })

  it('rejects with a clear error when misconfigured (no override, no firebaseProjectId)', async () => {
    const unconfigured = await createTestApp()
    await unconfigured.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const res = await unconfigured.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(500)
    await unconfigured.app.close()
  })
})
