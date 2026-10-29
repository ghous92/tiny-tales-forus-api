/**
 * Test harness. Builds the real app (`buildApp`) against an in-memory PGlite
 * Postgres with the committed `drizzle/` migrations applied — so route tests
 * exercise the genuine transaction/index behavior — and stubs auth at the
 * designed seam: a fake TokenVerifier keyed by literal test tokens. Nothing
 * here mocks firebase-admin or touches the network.
 */

import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../../src/app.js'
import type { ErrorAlerter } from '../../src/lib/alerts.js'
import type { AlertEmailTaskEnqueuer } from '../../src/lib/alertEmailTask.js'
import type { CarrierAdapter } from '../../src/lib/delhivery.js'
import type { Analytics } from '../../src/lib/analytics.js'
import type { TaskEnqueuer } from '../../src/lib/tasks.js'
import type { AdminPushSender } from '../../src/lib/notify/adminPush.js'
import type { NotificationChannelRegistry } from '../../src/lib/notify/registry.js'
import type { Db } from '../../src/db/client.js'
import * as schema from '../../src/db/schema.js'
import { users } from '../../src/db/schema.js'
import type { FirebaseUserDeleter, TokenVerifier, VerifiedToken } from '../../src/plugins/auth.js'

/** Fixed test identities. `token` is what goes in the Authorization header. */
export const USER_A = {
  token: 'test-token-user-a',
  uid: 'firebase-uid-a',
  phoneNumber: '+919876543210',
} as const

export const USER_B = {
  token: 'test-token-user-b',
  uid: 'firebase-uid-b',
  phoneNumber: '+919123456780',
} as const

/** A syntactically fine token whose claims lack `phone_number`. */
export const USER_NO_PHONE = {
  token: 'test-token-no-phone',
  uid: 'firebase-uid-no-phone',
} as const

/** A third identity, promoted to `role = 'admin'` via {@link promoteToAdmin} in tests that need it. */
export const USER_ADMIN = {
  token: 'test-token-user-admin',
  uid: 'firebase-uid-admin',
  phoneNumber: '+919000000001',
} as const

/**
 * Simulates the manual-SQL role promotion (SPEC-V2.md §1 — there is no
 * self-serve route). Call AFTER the user has made at least one authed
 * request (so the `users` row exists) or pass a fresh uid to pre-seed one.
 */
export async function promoteToAdmin(db: Db, uid: string): Promise<void> {
  await db.update(users).set({ role: 'admin' }).where(eq(users.firebaseUid, uid))
}

export interface TestContext {
  app: FastifyInstance
  db: Db
  pglite: PGlite
  /** Mutable claim map — tests can add/replace tokens to simulate claim changes. */
  tokens: Map<string, VerifiedToken>
}

/** Fresh in-memory Postgres with the real committed migrations applied. */
export async function createTestDb(): Promise<{ db: Db; pglite: PGlite }> {
  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: 'drizzle' })
  // PGlite's drizzle instance exposes the same query/transaction surface Db needs.
  return { db: db as unknown as Db, pglite }
}

export interface CreateTestAppOptions {
  claimsNow?: () => Date
  /** Test seam for profile identify calls and authoritative commerce events. */
  analytics?: Analytics
  /**
   * Google Maps server key for `/v1/geocode/reverse`. Left unset by default so
   * the route degrades to 503 `geocoding_disabled` exactly as an unconfigured
   * deploy does; geocode tests pass a dummy and stub `fetch`.
   */
  googleMapsServerKey?: string
  /**
   * Proxy-gate shared secret (see `src/app.ts`). Left unset by default so
   * every other test suite keeps hitting routes without the
   * `X-TinyTales-Proxy-Auth` header, exactly like today's ungated deploy;
   * proxy-gate tests pass one explicitly.
   */
  proxySharedSecret?: string
  /**
   * Test seam for inbound WhatsApp (`src/app.ts`'s `whatsappInbound`). Left
   * unset by default so `POST /v1/whatsapp/webhook` answers 503 exactly as an
   * unconfigured deploy does — the webhook tests pass these explicitly.
   */
  whatsappInbound?: { appSecret?: string; verifyToken?: string }
  /** Send credentials for a WhatsApp REPLY; without them a reply records as `failed`. */
  whatsapp?: { phoneNumberId?: string; accessToken?: string }
  /** Test seam for the fetch the WhatsApp reply sender uses. */
  whatsappFetch?: typeof fetch
  /**
   * Test seam for admin push (`src/app.ts`'s `adminPushSender`). Unset by
   * default, which is how an unconfigured deploy behaves: the inbound webhook
   * skips the alert entirely rather than reaching for Firebase.
   */
  adminPushSender?: AdminPushSender
  /**
   * Test seam for `ErrorAlerter` (see `src/app.ts`'s `alerter` option). Left
   * unset by default — `buildApp` then builds its own (unconfigured, so
   * inert) alerter, exactly like an unconfigured deploy; alerting tests pass
   * a fake here to assert on what the client-errors route hands it.
   */
  alerter?: ErrorAlerter
  /**
   * Test seam for `DELETE /v1/me` (see `src/app.ts`'s `deleteFirebaseUser`
   * option). Left unset by default — no test here calls that route, so it
   * never matters that the production deleter would reject without a
   * configured `firebaseProjectId`; account-deletion tests pass a fake.
   */
  deleteFirebaseUser?: FirebaseUserDeleter
  /**
   * Test seam for the carrier (see `src/app.ts`'s `carrierAdapter` option).
   * Left unset by default so every fulfilment route that would call out answers
   * 503 `fulfilment_disabled`, exactly like a deploy with no Delhivery token —
   * which is also the state the module ships in.
   */
  carrierAdapter?: CarrierAdapter
  /**
   * Test seam for the Cloud Tasks enqueuer (see `src/app.ts`'s `taskEnqueuer`).
   * Left unset by default so no route requests a sweep task and behaviour is
   * exactly the pre-queue one; trigger tests pass a recorder and assert on what
   * WOULD have been enqueued, without touching GCP.
   */
  taskEnqueuer?: TaskEnqueuer
  /**
   * Shared secret for the inbound carrier webhook. Unset by default so the
   * webhook answers 503; webhook tests pass one explicitly.
   */
  delhiveryWebhookSecret?: string
  /**
   * Test seam for the ops notification channel registry (see `src/app.ts`'s
   * `notificationChannels` option). Left unset by default so every enqueued
   * `ops_notifications` row resolves to `skipped_unconfigured`, exactly like a
   * deploy with no WhatsApp credentials; ops-notification tests pass a fake
   * channel here.
   */
  notificationChannels?: NotificationChannelRegistry
  /**
   * Cloud Scheduler OIDC gate (see `src/plugins/scheduler.ts`). Left unset by
   * default so `/v1/internal/sweeps/*` answers 503 `scheduler_disabled`,
   * exactly like a deploy with no `SCHEDULER_*` env — which is the state every
   * environment is in until the jobs are provisioned. Sweep tests pass one.
   *
   * The verifier is stubbed at the same designed seam as `verifyToken` above:
   * {@link SCHEDULER_SA}'s token verifies, everything else rejects, and nothing
   * here touches Google.
   */
  scheduler?: { audience: string; allowedServiceAccounts: readonly string[] }
  /**
   * Auth identity-cache lifetime (see `src/lib/authCache.ts`). **Defaults to
   * 0 — caching OFF — which is NOT the production default.**
   *
   * Production runs a short TTL; the harness disables it so every suite keeps
   * seeing manual-SQL role changes (`promoteToAdmin`) on the very next
   * request, which is what almost every admin test depends on. Suites that
   * exercise the cache itself pass a TTL explicitly, and the staleness that
   * TTL buys is pinned in `test/plugins/auth-cache.test.ts`.
   */
  authCacheTtlMs?: number
  /**
   * Brevo credentials (see `src/app.ts`'s `alerts` option). Left unset by
   * default so every email sender (`ErrorAlerter`, invoice/complaint/alert
   * emails) is inert, exactly like an unconfigured deploy.
   */
  alerts?: { brevoApiKey: string; emailFrom: string; emailTo?: string }
  /**
   * Shared secret for the inbound Grafana alert webhook
   * (`routes/grafanaAlertWebhook.ts`). Unset by default so it answers 503.
   */
  grafanaAlertWebhookSecret?: string
  /**
   * Test seam for the alert-email Cloud Task enqueuer. Left unset by default
   * so the webhook falls back to (or skips, if `alerts` is also unset) a
   * direct Brevo send.
   */
  alertEmailTaskEnqueuer?: AlertEmailTaskEnqueuer
  /** Test seam for the alert-email direct-send fallback's `fetch`. */
  alertEmailFetchImpl?: typeof fetch
  /** Image-intake credentials for the upload proxies. */
  imageIntake?: { baseUrl?: string; uploadToken?: string }
  /** Test seam for the upload proxies' `fetch`. */
  mediaUploadFetchImpl?: typeof fetch
  /** Caricature previews; unset -> those routes answer 503. */
  openai?: { apiKey?: string; previewDailyCap?: number }
  /** Test seam for OpenAI's `fetch`. */
  openaiFetchImpl?: typeof fetch
}

/** The allowlisted machine identity used by sweep tests. */
export const SCHEDULER_SA = {
  token: 'test-oidc-token-scheduler',
  email: 'tinytales-scheduler@tinytalesforus-prod.iam.gserviceaccount.com',
} as const

/** A correctly-signed token from an identity that is NOT on the allowlist. */
export const SCHEDULER_STRANGER = {
  token: 'test-oidc-token-stranger',
  email: 'someone-else@some-other-project.iam.gserviceaccount.com',
} as const

/** Audience sweep tests mint tokens for. Must match what the app is built with. */
export const SCHEDULER_AUDIENCE = 'tinytales-api-sweeps'

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestContext> {
  const { db, pglite } = await createTestDb()

  const tokens = new Map<string, VerifiedToken>([
    [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
    [USER_B.token, { uid: USER_B.uid, phoneNumber: USER_B.phoneNumber }],
    [USER_NO_PHONE.token, { uid: USER_NO_PHONE.uid }],
    [USER_ADMIN.token, { uid: USER_ADMIN.uid, phoneNumber: USER_ADMIN.phoneNumber }],
  ])
  const verifyToken: TokenVerifier = (token) => {
    const claims = tokens.get(token)
    if (!claims) return Promise.reject(new Error('invalid test token'))
    return Promise.resolve(claims)
  }

  const app = buildApp({
    db,
    verifyToken,
    logger: false,
    authCacheTtlMs: options.authCacheTtlMs ?? 0,
    ...(options.analytics ? { analytics: options.analytics } : {}),
    ...(options.googleMapsServerKey ? { googleMapsServerKey: options.googleMapsServerKey } : {}),
    ...(options.proxySharedSecret ? { proxySharedSecret: options.proxySharedSecret } : {}),
    ...(options.alerter ? { alerter: options.alerter } : {}),
    ...(options.deleteFirebaseUser ? { deleteFirebaseUser: options.deleteFirebaseUser } : {}),
    ...(options.carrierAdapter ? { carrierAdapter: options.carrierAdapter } : {}),
    ...(options.taskEnqueuer ? { taskEnqueuer: options.taskEnqueuer } : {}),
    ...(options.delhiveryWebhookSecret
      ? { delhivery: { webhookSecret: options.delhiveryWebhookSecret } }
      : {}),
    ...(options.notificationChannels ? { notificationChannels: options.notificationChannels } : {}),
    ...(options.alerts ? { alerts: options.alerts } : {}),
    ...(options.grafanaAlertWebhookSecret
      ? { grafanaAlertWebhookSecret: options.grafanaAlertWebhookSecret }
      : {}),
    ...(options.alertEmailTaskEnqueuer
      ? { alertEmailTaskEnqueuer: options.alertEmailTaskEnqueuer }
      : {}),
    ...(options.alertEmailFetchImpl ? { alertEmailFetchImpl: options.alertEmailFetchImpl } : {}),
    ...(options.whatsappInbound ? { whatsappInbound: options.whatsappInbound } : {}),
    ...(options.whatsapp ? { whatsapp: options.whatsapp } : {}),
    ...(options.claimsNow ? { claimsNow: options.claimsNow } : {}),
    ...(options.imageIntake ? { imageIntake: options.imageIntake } : {}),
    ...(options.mediaUploadFetchImpl ? { mediaUploadFetchImpl: options.mediaUploadFetchImpl } : {}),
    ...(options.openai ? { openai: options.openai } : {}),
    ...(options.openaiFetchImpl ? { openaiFetchImpl: options.openaiFetchImpl } : {}),
    ...(options.whatsappFetch ? { whatsappFetch: options.whatsappFetch } : {}),
    ...(options.adminPushSender ? { adminPushSender: options.adminPushSender } : {}),
    ...(options.scheduler
      ? {
          scheduler: options.scheduler,
          verifyOidc: (token: string, audience: string) => {
            // Audience is checked here, in the fake, because that is where
            // Google checks it in production — `verifyIdToken` throws on a
            // mismatch rather than returning a payload the plugin inspects.
            if (audience !== SCHEDULER_AUDIENCE) {
              return Promise.reject(new Error('audience mismatch'))
            }
            const identity = [SCHEDULER_SA, SCHEDULER_STRANGER].find((i) => i.token === token)
            if (!identity) return Promise.reject(new Error('invalid test oidc token'))
            return Promise.resolve({ email: identity.email, emailVerified: true })
          },
        }
      : {}),
  })
  await app.ready()
  return { app, db, pglite, tokens }
}

/** `headers` object for an authed request. */
export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

/** A body that passes AddressCreateSchema; override per test. */
export function validAddress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Asha Rao',
    phone: '9876543210',
    pincode: '560001',
    city: 'Bengaluru',
    state: 'Karnataka',
    houseNumber: '12B, Sunrise Apartments',
    roadArea: 'MG Road, Shanthala Nagar',
    isDefault: false,
    ...overrides,
  }
}
