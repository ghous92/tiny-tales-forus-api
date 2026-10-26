/**
 * authPlugin tests with the identity cache ENABLED — the one configuration the
 * rest of the suite deliberately does not run in (`createTestApp` defaults the
 * TTL to 0; see `test/helpers/app.ts`).
 *
 * Two jobs here. Prove the cache actually removes the query, and pin the
 * staleness it buys in exchange, so the trade-off is a decision in the test
 * suite rather than a surprise in production.
 *
 * The witness for "served from cache" throughout is deleting or mutating the
 * `users` row directly and showing the request still resolves to the old
 * identity: nothing but the cache could have answered it.
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
const revokedUids: string[] = []

beforeEach(async () => {
  revokedUids.length = 0
  ctx = await createTestApp({
    authCacheTtlMs: 60_000,
    deleteFirebaseUser: (uid) => {
      revokedUids.push(uid)
      return Promise.resolve()
    },
  })
})

afterEach(async () => {
  await ctx.app.close()
})

function authed(token: string) {
  return ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })
}

function adminList(token: string) {
  return ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/catalog/products',
    headers: auth(token),
  })
}

describe('authenticate — identity cache enabled', () => {
  it('serves a repeat request without re-reading the users row', async () => {
    // Seeded as admin so the FIRST authed request caches `role: 'admin'` —
    // promoting after that request would land behind the cache and prove
    // nothing.
    await ctx.db
      .insert(users)
      .values({ firebaseUid: USER_ADMIN.uid, phone: USER_ADMIN.phoneNumber, role: 'admin' })
    expect((await adminList(USER_ADMIN.token)).statusCode).toBe(200)

    await ctx.db
      .update(users)
      .set({ role: 'customer' })
      .where(eq(users.firebaseUid, USER_ADMIN.uid))

    // `requireAdmin` reads only `request.user.role`. Still 200 means the hook
    // never went back to the database — nothing else could have answered.
    expect((await adminList(USER_ADMIN.token)).statusCode).toBe(200)
  })

  it('bypasses the cache when the token phone claim no longer matches', async () => {
    await authed(USER_A.token)
    ctx.tokens.set(USER_A.token, { uid: USER_A.uid, phoneNumber: '+919000000000' })

    const res = await authed(USER_A.token)
    expect(res.statusCode).toBe(200)

    // Claim drift must reach the transaction even with a warm entry.
    const [row] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(row?.phone).toBe('+919000000000')
  })

  it('invalidates the cached identity on DELETE /v1/me', async () => {
    await authed(USER_A.token)
    const [before] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))

    expect(
      (await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(USER_A.token) }))
        .statusCode
    ).toBe(204)
    expect(revokedUids).toEqual([USER_A.uid])

    // The ID token is still unexpired. Without invalidation it would keep
    // resolving to the deleted account's row id for the rest of the TTL.
    await authed(USER_A.token)
    const [after] = await ctx.db.select().from(users).where(eq(users.firebaseUid, USER_A.uid))
    expect(after).toBeDefined()
    expect(after?.id).not.toBe(before?.id)
  })

  it('invalidates the OLD uid when a phone re-link demotes the row to customer', async () => {
    // Seeded as admin directly (like the first test above) so the ONE authed
    // request below is a cache miss that reads the row fresh and caches
    // `role: 'admin'`. Authing before promoting would cache `customer` first
    // — a second authed request then just replays that stale cache instead
    // of picking up the promotion, so it never warms the entry this test
    // needs.
    await ctx.db.insert(users).values({ firebaseUid: USER_A.uid, phone: USER_A.phoneNumber })
    await promoteToAdmin(ctx.db, USER_A.uid)
    // Warm the cache with role: 'admin' so the relink below has something
    // stale to clear — this is the exact carry-over the demotion prevents.
    await authed(USER_A.token)
    expect((await adminList(USER_A.token)).statusCode).toBe(200)

    ctx.tokens.set('test-token-user-a-relinked', {
      uid: 'firebase-uid-a-recreated',
      phoneNumber: USER_A.phoneNumber,
    })
    expect((await authed('test-token-user-a-relinked')).statusCode).toBe(200)

    // Old uid's entry must be gone, so its next request re-resolves against
    // the (now demoted, now re-linked) row instead of replaying admin.
    expect((await adminList(USER_A.token)).statusCode).toBe(403)
  })

  // --- The accepted trade-off ------------------------------------------------

  it('does NOT see a manual SQL role promotion until the entry expires', async () => {
    await authed(USER_ADMIN.token)
    expect((await adminList(USER_ADMIN.token)).statusCode).toBe(403)

    // Manual SQL (SPEC-V2.md §1) is invisible to this process — there is no
    // hook to invalidate on. The TTL is the only backstop, which is precisely
    // why it is short and why AUTH_CACHE_TTL_MS exists to turn it off.
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    expect((await adminList(USER_ADMIN.token)).statusCode).toBe(403)
  })

  it('has no such staleness when the cache is disabled (the harness default)', async () => {
    const plain = await createTestApp()
    try {
      await plain.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
      await promoteToAdmin(plain.db, USER_ADMIN.uid)

      const res = await plain.app.inject({
        method: 'GET',
        url: '/v1/admin/catalog/products',
        headers: auth(USER_ADMIN.token),
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await plain.app.close()
    }
  })
})
