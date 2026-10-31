/**
 * Authentication plugin. Verifies `Authorization: Bearer <Firebase ID token>`
 * on any route that opts in via the `app.authenticate` onRequest hook, upserts
 * the caller's `users` row (holding `consentAccepted = true` — this is where
 * Terms/Privacy consent is captured, not at checkout; see
 * contracts/payment.ts), and decorates
 * `request.user = { id, uid, phone, role, consentAccepted }`. Any failure —
 * missing header, bad token, token without a phone claim — becomes a 401 with
 * the standard error envelope.
 *
 * Resolving the caller is layered, cheapest first: the in-process identity
 * cache (lib/authCache.ts, off when `AUTH_CACHE_TTL_MS=0`), then a single
 * indexed SELECT, and only then the upsert transaction. Each layer is used
 * only when the stored identity already matches the token's claims, so any
 * drift — first sighting of a uid, changed phone, consent not yet true —
 * always reaches the transaction.
 *
 * `app.requireAdmin` is a second onRequest hook for admin-only routes: it
 * must run AFTER `app.authenticate` (it reads `request.user`) and throws
 * `forbidden()` (403) unless `role === 'admin'`. Role promotion is manual SQL
 * — there is no self-serve route (see SPEC-V2.md §1). Because that SQL happens
 * outside this process, a promotion OR demotion takes effect only once the
 * caller's cache entry expires; that window is `AUTH_CACHE_TTL_MS`.
 *
 * The verifier is injected (`TokenVerifier`), so tests exercise the plugin's
 * real header parsing/upsert logic with a fake verifier instead of mocking
 * firebase-admin internals. Production uses `createFirebaseVerifier`, which
 * lazy-loads firebase-admin on first use — pure token verification needs only
 * the project id (no key file; ADC covers Cloud Run).
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { eq, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { users } from '../db/schema.js'
import { createAuthCache, type AuthCache } from '../lib/authCache.js'
import { conflict, forbidden, unauthorized } from '../lib/errors.js'

/** Postgres `unique_violation` — the raw pg error carries the code; drizzle wraps it in a
 *  `DrizzleQueryError` and moves it to `.cause`, so check both. */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && 'code' in v && (v as { code: unknown }).code === '23505'
  return hasCode(err) || (err instanceof Error && hasCode(err.cause))
}

/** The claims we consume from a verified Firebase ID token. */
export interface VerifiedToken {
  uid: string
  /** E.164 phone from the token's `phone_number` claim, absent for non-phone providers. */
  phoneNumber?: string | undefined
  /** The token's `iat`, in seconds. Absent means the verifier doesn't report it. */
  issuedAt?: number | undefined
}

/** Verifies a raw Bearer token, throwing on any invalid/expired token. */
export type TokenVerifier = (token: string) => Promise<VerifiedToken>

/** 'customer' | 'admin' — mirrors `users.role`. Promotion is manual (SQL). */
export type UserRole = 'customer' | 'admin'

/** The authenticated caller, as seen by route handlers via `request.user`. */
export interface AuthedUser {
  /** Our `users.id` (uuid) — the FK the rest of the schema hangs off. */
  id: string
  /** Firebase uid, for audit/logging correlation. */
  uid: string
  /** E.164 phone as stored (`+91…`). */
  phone: string
  role: UserRole
  /** Terms + Privacy acceptance; forced true by the upsert below whenever it isn't already. */
  consentAccepted: boolean
}

declare module 'fastify' {
  interface FastifyInstance {
    /** onRequest hook: verify the Bearer token and populate `request.user`. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** onRequest hook: run after `authenticate`; 403s unless `request.user.role === 'admin'`. */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** Drop a uid from this instance's identity cache (see lib/authCache.ts). */
    invalidateAuthUser: (uid: string) => void
  }
  interface FastifyRequest {
    /** Set by `authenticate`; only defined on routes that register the hook. */
    user: AuthedUser
  }
}

/** Production TokenVerifier: firebase-admin `verifyIdToken`, initialized lazily. */
export function createFirebaseVerifier(projectId: string): TokenVerifier {
  let verify:
    | ((token: string) => Promise<{ uid: string; phone_number?: string; iat?: number }>)
    | undefined
  return async (token) => {
    if (!verify) {
      const { getApps, initializeApp } = await import('firebase-admin/app')
      const { getAuth } = await import('firebase-admin/auth')
      const auth = getAuth(getApps()[0] ?? initializeApp({ projectId }))
      verify = (t) => auth.verifyIdToken(t)
    }
    const decoded = await verify(token)
    return { uid: decoded.uid, phoneNumber: decoded.phone_number, issuedAt: decoded.iat }
  }
}

/** Revokes a Firebase account by uid — used by account deletion (`DELETE /v1/me`). */
export type FirebaseUserDeleter = (uid: string) => Promise<void>

/**
 * Production {@link FirebaseUserDeleter}: firebase-admin `deleteUser`,
 * lazy-loaded and sharing the same admin app instance as
 * {@link createFirebaseVerifier}. A uid that's already gone (e.g. a retried
 * delete request) is treated as success — the end state (no live Firebase
 * account for this uid) is what account deletion wants either way, so it must
 * be idempotent rather than erroring on replay.
 */
export function createFirebaseUserDeleter(projectId: string): FirebaseUserDeleter {
  let deleteUser: ((uid: string) => Promise<void>) | undefined
  return async (uid) => {
    if (!deleteUser) {
      const { getApps, initializeApp } = await import('firebase-admin/app')
      const { getAuth } = await import('firebase-admin/auth')
      const auth = getAuth(getApps()[0] ?? initializeApp({ projectId }))
      deleteUser = (u) => auth.deleteUser(u)
    }
    try {
      await deleteUser(uid)
    } catch (err) {
      const code = err instanceof Error ? (err as { code?: string }).code : undefined
      if (code !== 'auth/user-not-found') throw err
    }
  }
}

/** Ends a uid's Firebase refresh tokens — used by `POST /v1/me/logout`. */
export type FirebaseTokenRevoker = (uid: string) => Promise<void>

/** Production {@link FirebaseTokenRevoker}, sharing the same lazy admin app as the others. */
export function createFirebaseTokenRevoker(projectId: string): FirebaseTokenRevoker {
  let revoke: ((uid: string) => Promise<void>) | undefined
  return async (uid) => {
    if (!revoke) {
      const { getApps, initializeApp } = await import('firebase-admin/app')
      const { getAuth } = await import('firebase-admin/auth')
      const auth = getAuth(getApps()[0] ?? initializeApp({ projectId }))
      revoke = (u) => auth.revokeRefreshTokens(u)
    }
    await revoke(uid)
  }
}

export interface AuthPluginOptions {
  db: Db
  verifyToken: TokenVerifier
  /**
   * Identity cache (see lib/authCache.ts). Omit to run uncached — every
   * request then resolves the caller against the database, which is the
   * behaviour this plugin had before the cache existed.
   */
  userCache?: AuthCache
}

export const authPlugin = fp<AuthPluginOptions>(
  (app, { db, verifyToken, userCache }, done) => {
    const cache = userCache ?? createAuthCache({ ttlMs: 0 })
    app.decorateRequest('user')

    // Exposed so the routes that knowingly invalidate an identity can say so
    // (today: `DELETE /v1/me`). Per-instance only — see lib/authCache.ts.
    app.decorate('invalidateAuthUser', (uid: string) => cache.delete(uid))

    app.decorate('authenticate', async (request: FastifyRequest) => {
      const header = request.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        throw unauthorized('Missing bearer token')
      }
      const token = header.slice('Bearer '.length).trim()
      if (token.length === 0) throw unauthorized('Missing bearer token')

      let verified: VerifiedToken
      try {
        verified = await verifyToken(token)
      } catch {
        // Deliberately swallowed: verifier failures must not leak detail (or the token) anywhere.
        throw unauthorized('Invalid or expired token')
      }
      if (!verified.uid || !verified.phoneNumber) {
        throw unauthorized('Token is missing required claims')
      }

      const phoneNumber = verified.phoneNumber
      const uid = verified.uid
      const cols = {
        id: users.id,
        phone: users.phone,
        role: users.role,
        consentAccepted: users.consentAccepted,
        tokensValidAfter: users.tokensValidAfter,
      }
      // Runs on every path below, the cached one included. A cached entry on
      // another instance can miss a logout for at most the cache TTL.
      const assertNotRevoked = (validAfter: Date | null | undefined) => {
        if (validAfter && verified.issuedAt !== undefined && verified.issuedAt * 1000 < validAfter.getTime()) {
          throw unauthorized('Invalid or expired token')
        }
      }

      // `firebase_uid` and `phone` are BOTH unique, so a plain
      // `ON CONFLICT (firebase_uid)` upsert only covers uid reuse — it 500s
      // the moment a phone number's Firebase account gets deleted and
      // recreated (same phone claim, brand-new uid), because the INSERT then
      // hits the `phone` unique constraint instead. Try each identity in
      // turn inside one transaction: known uid → known phone (re-link a
      // stale uid) → fresh row.
      //
      // Re-linking by phone hands the caller an existing row — including its
      // `role`. That's only safe because Firebase itself enforces one
      // verified account per phone number; demote to `customer` on relink
      // (promotion is manual SQL, see module docs) and log it, so a stale
      // `admin` role can never silently carry over to whoever proves the
      // number next.
      let relinkedFrom: string | undefined
      const attemptUpsert = () =>
        db.transaction(async (tx) => {
          const [byUid] = await tx
            .update(users)
            .set({ phone: phoneNumber, consentAccepted: true, updatedAt: sql`now()` })
            .where(eq(users.firebaseUid, uid))
            .returning(cols)
          if (byUid) return byUid

          const [existingByPhone] = await tx
            .select({ firebaseUid: users.firebaseUid })
            .from(users)
            .where(eq(users.phone, phoneNumber))
            .limit(1)

          const [byPhone] = await tx
            .update(users)
            .set({
              firebaseUid: uid,
              role: 'customer',
              consentAccepted: true,
              updatedAt: sql`now()`,
            })
            .where(eq(users.phone, phoneNumber))
            .returning(cols)
          if (byPhone) {
            // Recorded for cache invalidation below: the old uid may still
            // hold a cached entry carrying the `role` this relink just
            // demoted, which is exactly what the demotion exists to prevent.
            relinkedFrom = existingByPhone?.firebaseUid
            request.log.warn(
              { userId: byPhone.id, oldUid: existingByPhone?.firebaseUid, newUid: uid },
              'users row re-linked to a new firebase uid via phone match; role reset to customer'
            )
            return byPhone
          }

          const [inserted] = await tx
            .insert(users)
            .values({ firebaseUid: uid, phone: phoneNumber })
            .returning(cols)
          return inserted
        })

      // Hot path: the overwhelming majority of authed requests are a returning
      // caller whose row already says exactly what the upsert would write. Read
      // first and skip the transaction entirely when nothing would change —
      // `firebase_uid` is unique, so this is one index lookup. Without it every
      // authed request ran `BEGIN; UPDATE … SET updated_at = now(); COMMIT`,
      // which took a row lock on the caller's own row (serialising that user's
      // concurrent requests) and wrote a WAL record + dead tuple per request.
      //
      // The only thing the fast path drops is the `updated_at` bump. That
      // column is written here and read nowhere — it is not a last-seen field.
      // Anything the upsert would actually change (phone re-link, consent
      // re-affirmation, first sighting of a uid) still falls through to it.
      //
      // Ahead of even that read sits the in-process cache, which removes the
      // query outright for a caller seen in the last TTL window — the app
      // fires several authed calls per screen on one token. Both layers guard
      // on the same condition, so a token whose claims have drifted from the
      // stored row always reaches the transaction.
      const cached = cache.get(uid)
      if (cached && cached.phone === phoneNumber && cached.consentAccepted) {
        assertNotRevoked(cached.tokensValidAfter)
        request.user = { ...cached, uid }
        return
      }

      const [fresh] = await db.select(cols).from(users).where(eq(users.firebaseUid, uid)).limit(1)
      if (fresh && fresh.phone === phoneNumber && fresh.consentAccepted) {
        assertNotRevoked(fresh.tokensValidAfter)
        const resolved = {
          id: fresh.id,
          phone: fresh.phone,
          role: fresh.role as UserRole,
          consentAccepted: fresh.consentAccepted,
          tokensValidAfter: fresh.tokensValidAfter,
        }
        cache.set(uid, resolved)
        request.user = { ...resolved, uid }
        return
      }

      // Two concurrent first-authed-requests for the same brand-new uid+phone
      // can both miss the update branches and race the final INSERT — the
      // loser hits the same `phone` unique_violation. One retry resolves
      // that (the winner's row now matches on the update branches). If the
      // retry ALSO unique_violations, it's not a race but a stable conflict
      // (the phone is already claimed by a different, unrelated uid) — no
      // amount of retrying fixes that, so surface it as 409 instead of 500.
      let row
      try {
        row = await attemptUpsert()
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        try {
          row = await attemptUpsert()
        } catch (retryErr) {
          if (isUniqueViolation(retryErr)) {
            throw conflict('This phone number is already linked to another account')
          }
          throw retryErr
        }
      }
      if (!row) throw unauthorized()
      assertNotRevoked(row.tokensValidAfter)

      if (relinkedFrom !== undefined) cache.delete(relinkedFrom)
      const resolved = {
        id: row.id,
        phone: row.phone,
        role: row.role as UserRole,
        consentAccepted: row.consentAccepted,
        tokensValidAfter: row.tokensValidAfter,
      }
      cache.set(uid, resolved)
      request.user = { ...resolved, uid }
    })

    app.decorate('requireAdmin', async (request: FastifyRequest) => {
      if (request.user.role !== 'admin') throw forbidden()
    })

    done()
  },
  { name: 'auth', fastify: '5.x' }
)
