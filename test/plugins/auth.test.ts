/**
 * authPlugin tests — specifically the read-first fast path in `authenticate`.
 *
 * The upsert's *semantics* (first-sighting insert, phone-claim change, uid
 * re-link with role demotion, concurrent-insert race, 409 on a stolen phone)
 * are covered end-to-end in `test/routes/addresses.test.ts`. What lives here is
 * the complementary half: proving the hook SKIPS the write transaction when
 * nothing would change, and — just as important — that skipping it introduces
 * no staleness. Every request still reads the row, so a manual SQL role change
 * and a false `consent_accepted` both take effect on the very next request.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { users } from '../../src/db/schema.js'
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

/** GET a cheap authed route purely to run the `authenticate` hook. */
function authed(token: string) {
  return ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })
}

/** The caller's stored row, or undefined before the first authed request. */
async function rowFor(uid: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
  return row
}

describe('authenticate — fast path', () => {
  it('does not write the users row when the token matches what is stored', async () => {
    const first = await authed(USER_A.token)
    expect(first.statusCode).toBe(200)

    const after1 = await rowFor(USER_A.uid)
    expect(after1).toBeDefined()

    // `updated_at` is written by the upsert and read by nothing else, which
    // makes it an exact witness for "did the transaction run". Two further
    // requests must leave it untouched.
    await authed(USER_A.token)
    await authed(USER_A.token)

    const after3 = await rowFor(USER_A.uid)
    expect(after3?.updatedAt).toEqual(after1?.updatedAt)
    expect(after3?.id).toBe(after1?.id)
  })

  it('still populates request.user correctly on the fast path', async () => {
    await authed(USER_A.token)

    // Second request is served by the fast path; the profile it returns must be
    // indistinguishable from the first.
    const res = await authed(USER_A.token)
    expect(res.statusCode).toBe(200)
    // E.164 in storage, bare 10 digits on the wire (docs/CONTRACTS.md).
    expect(res.json().phone).toBe('9876543210')
  })

  it('re-affirms consent when the stored row says false, instead of serving it stale', async () => {
    await authed(USER_A.token)
    await ctx.db
      .update(users)
      .set({ consentAccepted: false })
      .where(eq(users.firebaseUid, USER_A.uid))

    const res = await authed(USER_A.token)
    expect(res.statusCode).toBe(200)

    // A row that would have the transaction change something must NOT take the
    // fast path — `consent_accepted` is forced back to true.
    expect((await rowFor(USER_A.uid))?.consentAccepted).toBe(true)
  })

  it('picks up a manual SQL role promotion on the very next request', async () => {
    // Establish the row first, so the promotion lands on an already-"warm"
    // identity — the exact case a cache would get wrong.
    expect((await authed(USER_ADMIN.token)).statusCode).toBe(200)

    const before = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products',
      headers: auth(USER_ADMIN.token),
    })
    expect(before.statusCode).toBe(403)

    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products',
      headers: auth(USER_ADMIN.token),
    })
    expect(after.statusCode).toBe(200)
  })

  it('reflects a role demotion on the very next request', async () => {
    await authed(USER_ADMIN.token)
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/admin/catalog/products',
          headers: auth(USER_ADMIN.token),
        })
      ).statusCode
    ).toBe(200)

    await ctx.db
      .update(users)
      .set({ role: 'customer' })
      .where(eq(users.firebaseUid, USER_ADMIN.uid))

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/catalog/products',
      headers: auth(USER_ADMIN.token),
    })
    expect(after.statusCode).toBe(403)
  })
})
