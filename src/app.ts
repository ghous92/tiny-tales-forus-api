/**
 * `buildApp()` — assembles the Fastify instance: zod type provider, central
 * error handling, auth plugin, and routes. Exported separately from the
 * bootstrap so tests can build an app with an injected database and token
 * verifier and drive it through `app.inject()` without touching the network.
 *
 * Error contract (docs/CONTRACTS.md): every non-2xx response is
 * `{ "error": { "code": "...", "message": "..." } }` where code is one of
 * unauthorized | forbidden | not_found | validation_failed | limit_exceeded |
 * default_required | internal.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'

import cors from '@fastify/cors'
import fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'

import type { Db } from './db/client.js'
import {
  ErrorAlerter,
  type AppEnv,
  type BrevoConfig,
  type GithubConfig,
  type ServerErrorCtx,
} from './lib/alerts.js'
import type { Analytics } from './lib/analytics.js'
import type { OpenAiAdsConversions } from './lib/openaiAdsConversions.js'
import { createCloudTasksEnqueuer, type TaskEnqueuer } from './lib/tasks.js'
import { createAlertEmailTaskEnqueuer, type AlertEmailTaskEnqueuer } from './lib/alertEmailTask.js'
import {
  createReplenishmentTaskEnqueuer,
  type ReplenishmentTaskEnqueuer,
} from './lib/replenishmentTask.js'
import { createAuthCache } from './lib/authCache.js'
import type { EmailSenderConfig } from './lib/email.js'
import { ApiError } from './lib/errors.js'
import { buildLoggerOptions } from './lib/logger.js'
import {
  authPlugin,
  createFirebaseUserDeleter,
  createFirebaseVerifier,
  type FirebaseUserDeleter,
  type TokenVerifier,
} from './plugins/auth.js'
import { schedulerPlugin, type OidcVerifier } from './plugins/scheduler.js'
import type { PaymentsGateway } from './lib/razorpay.js'
import { createDelhiveryAdapter, modeFromBaseUrl, type CarrierAdapter } from './lib/delhivery.js'
import {
  createShreeMarutiTracker,
  SHREE_MARUTI_COURIER_CODE,
  type CarrierTracker,
} from './lib/shreeMaruti.js'
import { createFcmPushSender, type AdminPushSender } from './lib/notify/adminPush.js'
import { createWhatsAppCloudChannel } from './lib/notify/whatsappCloud.js'
import { whatsappAdminRoutes, whatsappRoutes } from './routes/whatsapp.js'
import type { NotificationChannelRegistry } from './lib/notify/registry.js'
import { manifestBlockedBy, resolveFulfilmentRule } from './services/fulfilment.js'
import { addressRoutes } from './routes/addresses.js'
import { cartRoutes } from './routes/cart.js'
import { catalogRoutes } from './routes/catalog.js'
import { catalogAdminRoutes } from './routes/catalogAdmin.js'
import { clientErrorsRoutes } from './routes/clientErrors.js'
import { adminConfigRoutes, configRoutes } from './routes/config.js'
import { adminComplaintRoutes, complaintRoutes } from './routes/complaints.js'
import { adminCouponsRoutes, couponRoutes } from './routes/coupons.js'
import { fulfilmentRoutes } from './routes/fulfilment.js'
import { internalReplenishmentRoutes } from './routes/internalReplenishment.js'
import { codAdminRoutes } from './routes/codAdmin.js'
import { fulfilmentAdminRoutes } from './routes/fulfilmentAdmin.js'
import { geocodeRoutes } from './routes/geocode.js'
import { grafanaAlertWebhookRoutes } from './routes/grafanaAlertWebhook.js'
import { healthRoutes } from './routes/health.js'
import { internalAlertEmailRoutes } from './routes/internalAlertEmail.js'
import { invoiceRoutes } from './routes/invoices.js'
import { adminInvoiceRoutes } from './routes/invoicesAdmin.js'
import {
  adminReadinessRoutes,
  internalSweepRoutes,
  type InternalSweepRoutesOptions,
} from './routes/internalSweeps.js'
import { mediaAdminRoutes } from './routes/mediaAdmin.js'
import { notificationsAdminRoutes } from './routes/notificationsAdmin.js'
import { paymentRoutes, type PaymentRoutesOptions } from './routes/payments.js'
import { profileRoutes } from './routes/profile.js'
import { authedReviewRoutes, reviewRoutes } from './routes/reviews.js'
import { shippingRoutes } from './routes/shipping.js'
import { shippingAdminRoutes } from './routes/shippingAdmin.js'
import { stockRoutes } from './routes/stock.js'
import { stockAdminRoutes } from './routes/stockAdmin.js'

/**
 * Build the `ErrorAlerter` context for a 500 from whatever the error handler
 * has on hand. Prefers the matched route's TEMPLATE
 * (`request.routeOptions.url`, e.g. `/v1/addresses/:id`) over the raw URL —
 * `fingerprintError` folds the route into the fingerprint, and a raw URL
 * would fingerprint every resource id as a different bug. Falls back to the
 * literal path for the rare case routing never matched at all (`is404`).
 * `userId` is read via optional chaining even though `request.user` is
 * declared non-optional (plugins/auth.ts): most routes that can 500 never run
 * the `authenticate` hook that populates it (e.g. `/v1/client-errors`,
 * `/v1/geocode/reverse`), so at runtime it may genuinely be unset.
 */
function serverErrorAlertCtx(request: FastifyRequest, statusCode: number): ServerErrorCtx {
  const userId = request.user?.id
  const path = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url
  return {
    method: request.method,
    path,
    requestId: request.id,
    ...(userId ? { userId } : {}),
    statusCode,
  }
}

export interface BuildAppOptions {
  db: Db
  /**
   * Token-verifier override — tests inject a fake here. When omitted, the
   * production firebase-admin verifier is used and `firebaseProjectId` is
   * required.
   */
  verifyToken?: TokenVerifier
  /** Firebase project for the default verifier (`env.FIREBASE_PROJECT_ID`). */
  firebaseProjectId?: string
  /**
   * `DELETE /v1/me` account-deletion override — tests inject a fake instead
   * of hitting real firebase-admin. When omitted, the production
   * `createFirebaseUserDeleter` is used and `firebaseProjectId` is required,
   * same rule as `verifyToken`.
   */
  deleteFirebaseUser?: FirebaseUserDeleter
  /**
   * Identity-cache lifetime for the auth hook, in ms (`AUTH_CACHE_TTL_MS`,
   * see lib/authCache.ts). Defaults to `DEFAULT_AUTH_CACHE_TTL_MS`; pass 0 to
   * resolve every request against the database. The test harness passes 0 by
   * default so route tests see manual-SQL role changes immediately.
   */
  authCacheTtlMs?: number
  /**
   * Browser origins allowed to call the API cross-origin (the admin SPA).
   * When omitted or empty, CORS is not registered — same-origin and
   * server-to-server callers are unaffected. Tests leave this unset.
   */
  allowedOrigins?: string[]
  /**
   * Which deployment this process is (`env.APP_ENV`). Echoed on every response
   * as `X-TinyTales-Env` so clients can display the environment the server says
   * they reached instead of the one they assume. Defaults to 'development'.
   */
  appEnv?: 'development' | 'staging' | 'production'
  /** Fastify logger config; defaults to pino with the auth header redacted. */
  logger?: FastifyServerOptions['logger']
  /**
   * Razorpay credentials for the payments module (from `env`). ALL OPTIONAL —
   * when any is missing, `POST /v1/payments/*` returns 503 `payments_disabled`
   * (graceful degrade). Never logged; only the public `keyId` is ever echoed.
   */
  razorpay?: {
    keyId?: string | undefined
    keySecret?: string | undefined
    webhookSecret?: string | undefined
  }
  /**
   * Test seam: inject a ready-made payments gateway (real HMAC math, mocked
   * SDK). Takes precedence over `razorpay`. Production leaves this unset.
   */
  paymentsGateway?: PaymentsGateway
  /**
   * Delhivery credentials (from `env`). ALL OPTIONAL — when the token or base
   * URL is missing, no carrier adapter is built and every fulfilment route that
   * would have called out answers 503 `fulfilment_disabled`. The inbound
   * webhook is gated separately on `webhookSecret`, because receiving scans and
   * sending manifests are independently configurable.
   */
  delhivery?: {
    apiToken?: string | undefined
    baseUrl?: string | undefined
    clientName?: string | undefined
    webhookSecret?: string | undefined
  }
  /** Test seam: inject a carrier adapter directly. Takes precedence over `delhivery`. */
  carrierAdapter?: CarrierAdapter
  /**
   * Test seam: track-only carriers keyed by `shipments.courier_code`, for
   * parcels booked outside the configured carrier. Defaults to Shree Maruti.
   */
  carrierTrackers?: Record<string, CarrierTracker>
  /**
   * WhatsApp Business Cloud API credentials for the ops notification channel
   * (from `env`, docs/SPEC-MANUAL-FULFILMENT.md §4A). ALL FOUR OPTIONAL — when
   * any is missing, no WhatsApp adapter is built and every `ops_notifications`
   * row resolves to `skipped_unconfigured` (graceful degrade, same shape as
   * Delhivery above).
   */
  whatsapp?: {
    phoneNumberId?: string | undefined
    accessToken?: string | undefined
    templateName?: string | undefined
    templateLocale?: string | undefined
  }
  /**
   * INBOUND WhatsApp credentials (TASK-04 phase 1). Separate from `whatsapp`
   * above because the posture is opposite: those degrade to "nothing is sent",
   * these gate a public endpoint that resolves a phone number to an account, so
   * absent means `POST /v1/whatsapp/webhook` answers 503 and accepts nothing.
   *
   * The SEND credentials for a reply still come from `whatsapp` — one WABA, one
   * token, two directions.
   */
  whatsappInbound?: {
    appSecret?: string | undefined
    verifyToken?: string | undefined
  }
  /** Test seam: the fetch the WhatsApp reply sender uses. */
  whatsappFetch?: typeof fetch | undefined
  /**
   * Test seam: the "a customer messaged you" push sender. Omitted in production
   * builds a real FCM sender when `firebaseProjectId` is set; omitted in tests
   * means no push is attempted at all.
   */
  adminPushSender?: AdminPushSender | undefined
  /**
   * Origin the push notification's tap-through link points at — the admin site,
   * NOT this API. Defaults to the production storefront.
   */
  adminBaseUrl?: string | undefined
  /**
   * Test seam: inject the notification channel registry directly (e.g. a fake
   * `NotificationChannel` whose `send` is a spy). Takes precedence over
   * `whatsapp`.
   */
  notificationChannels?: NotificationChannelRegistry
  /**
   * Google Maps SERVER key for `/v1/geocode/reverse` (from `env`). Optional —
   * without it that route returns 503 `geocoding_disabled` and clients fall
   * back to on-device geocoding. Never logged.
   */
  googleMapsServerKey?: string | undefined
  /**
   * `env.PROXY_SHARED_SECRET`. When set, registers an `onRequest` proxy gate
   * (see below) that rejects any request not carrying a matching
   * `X-TinyTales-Proxy-Auth` header — i.e. anything that didn't come through the
   * tiny-tales-forus Cloudflare edge Worker. Unset (default): the gate is not
   * registered at all and the app behaves exactly as it does today.
   */
  proxySharedSecret?: string | undefined
  /**
   * Server-side analytics, built in `index.ts` from `env` and passed down so
   * this module stays out of the environment. Absent → payments emits no
   * `Order Completed`, which is the supported unconfigured state rather than a
   * degraded one: no route changes behaviour and no response is affected.
   */
  analytics?: Analytics | undefined
  /**
   * ChatGPT Ads server-side conversions, built in `index.ts` alongside
   * `analytics` and passed down for the same reason. Absent → payments sends no
   * `order_created` and the browser pixel is the only conversion source.
   */
  openAiAds?: OpenAiAdsConversions | undefined
  /**
   * Alerting credentials (from `env`) for `ErrorAlerter` — a server 500 or a
   * `/v1/client-errors` batch becomes an alert email (and optionally a
   * GitHub issue) when this suffices. ALL OPTIONAL and independently so:
   * absent Brevo fields mean alerting logs-only (never sends); absent GitHub
   * fields mean alert emails omit the issue-creation step. Never logged.
   */
  alerts?: {
    brevoApiKey?: string | undefined
    emailFrom?: string | undefined
    emailTo?: string | undefined
    githubToken?: string | undefined
    githubRepo?: string | undefined
  }
  /**
   * Test seam: inject a ready-made `ErrorAlerter` (e.g. with a fake `fetch`
   * and clock) instead of building one from `alerts`. Takes precedence over
   * `alerts` — same precedence rule as `paymentsGateway` over `razorpay`.
   */
  alerter?: ErrorAlerter
  /**
   * Test seam: inject a fetch for the complaints module's Brevo sender
   * (grievance/nodal notification + shopper confirmation emails). Reuses
   * `alerts.brevoApiKey`/`alerts.emailFrom` as the sender identity — a
   * distinct `fromName`, not a distinct credential set.
   */
  complaintEmailFetchImpl?: typeof fetch
  /**
   * Test seam for the invoices module's Brevo sender (the customer's emailed
   * copy, and the admin resend). Same credentials as `alerts`, a different
   * `fromName` — an invoice comes from the shop, not from its support desk.
   */
  invoiceEmailFetchImpl?: typeof fetch
  /**
   * Cloud Scheduler → `/v1/internal/sweeps/*` gate (from `env`,
   * docs/SPEC-SWEEP-AUTOMATION.md). BOTH required to open it; either absent and
   * every internal route answers 503 `scheduler_disabled` and no background
   * sweep can run. Unlike the other optional credential blocks above, absent
   * here means CLOSED rather than degraded — this credential IS the lock.
   */
  scheduler?: {
    audience?: string | undefined
    allowedServiceAccounts?: readonly string[] | undefined
  }
  /** Test seam: inject an OIDC verifier instead of calling Google. */
  verifyOidc?: OidcVerifier
  /**
   * Cloud Tasks queue for the event-driven sweep triggers (`lib/tasks.ts`,
   * docs/WIP-EVENT-DRIVEN-SWEEPS.md). Every field must be present or the whole
   * thing is off — `env.ts` enforces that at boot, so a half-set queue cannot
   * reach here.
   *
   * Absent is a fully supported state and the default: the daily Cloud
   * Scheduler jobs remain the backstop, so no queue means retries are slower,
   * never lost.
   */
  tasks?: {
    project?: string | undefined
    location?: string | undefined
    queue?: string | undefined
    targetBaseUrl?: string | undefined
    serviceAccountEmail?: string | undefined
  }
  /** Test seam: assert enqueue intent without touching GCP. */
  taskEnqueuer?: TaskEnqueuer
  /** Injected in tests; otherwise built from `tasks` + `scheduler.audience`. */
  replenishmentTaskEnqueuer?: ReplenishmentTaskEnqueuer
  /**
   * Shared secret for the inbound Grafana alert webhook
   * (`routes/grafanaAlertWebhook.ts`). Absent ⇒ the webhook answers 503.
   */
  grafanaAlertWebhookSecret?: string | undefined
  /** Test seam: assert alert-email enqueue intent without touching GCP. */
  alertEmailTaskEnqueuer?: AlertEmailTaskEnqueuer
  /** Test seam: inject a fetch for the Grafana-alert email's direct-send fallback. */
  alertEmailFetchImpl?: typeof fetch
  /**
   * Image-intake Worker credentials for `POST /v1/admin/media/upload` (from
   * `env`). `baseUrl` defaults inside `env.ts`; `uploadToken` absent -> the
   * route answers 503 `media_disabled` rather than uploading unauthenticated.
   */
  imageIntake?: {
    baseUrl?: string | undefined
    uploadToken?: string | undefined
  }
  /** Test seam: inject a fetch for the media-upload proxy instead of calling the real Worker. */
  mediaUploadFetchImpl?: typeof fetch
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const verifyToken =
    opts.verifyToken ??
    (() => {
      if (!opts.firebaseProjectId) {
        throw new Error('buildApp: firebaseProjectId is required without a verifyToken override')
      }
      return createFirebaseVerifier(opts.firebaseProjectId)
    })()

  // Lazy, unlike `verifyToken` above: profile routes register on EVERY app
  // (not gated behind an `if (configured)` like payments/geocode), and the
  // overwhelming majority of tests never touch `DELETE /v1/me` — so this must
  // not throw at buildApp() time just because `firebaseProjectId` is unset.
  // The check only fires if the route is actually called without either a
  // test override or a configured project id.
  const deleteFirebaseUser: FirebaseUserDeleter =
    opts.deleteFirebaseUser ??
    ((uid) => {
      if (!opts.firebaseProjectId) {
        return Promise.reject(
          new Error(
            'DELETE /v1/me: firebaseProjectId is required without a deleteFirebaseUser override'
          )
        )
      }
      return createFirebaseUserDeleter(opts.firebaseProjectId)(uid)
    })

  // Hoisted above the `fastify()` call (it used to live down by the `onSend`
  // hook below) because the logger default now needs it too.
  const appEnv: AppEnv = opts.appEnv ?? 'development'

  const app = fastify({
    // GCP Cloud Logging severity mapping + the auth/proxy-header redaction —
    // see lib/logger.ts for why this moved out of an inline object here.
    logger: opts.logger ?? buildLoggerOptions(appEnv),
    // Request-id on every log line. `requestIdHeader: false` looks like it
    // disables upstream propagation, but the opposite is true — it hands the
    // header to `genReqId` below so the value can be VALIDATED before it is
    // adopted. With `requestIdHeader: 'x-request-id'` Fastify takes the raw
    // header verbatim, and since that value is stamped onto every log line for
    // the request, an unbounded caller-controlled string becomes a log-bloat
    // vector. The edge Worker overwrites the header on the proxied path
    // (edge/worker.js handleApiProxy), but this service is also reachable
    // directly on its *.run.app host — and the proxy-secret gate that rejects
    // those callers runs in `onRequest`, i.e. AFTER the id is assigned and the
    // "incoming request" line is already logged. So validate here too.
    requestIdHeader: false,
    genReqId: (req) => {
      const upstream = req.headers['x-request-id']
      const value = Array.isArray(upstream) ? upstream[0] : upstream
      // Deliberately narrow: the edge sends a CF Ray (16 hex chars), and this
      // also accepts a UUID from a local/dev caller. Anything else is replaced
      // rather than sanitized — a rewritten id would silently break the join
      // with the edge log, which is worse than an obviously unrelated one.
      return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : randomUUID()
    },
    // Behind the Cloudflare edge Worker AND Cloud Run's own front end, the
    // TCP peer Fastify sees is always Cloud Run's load balancer, not the
    // caller — every request would otherwise collapse into one IP and
    // `request.ip` becomes useless (notably it feeds the per-IP rate limiter
    // in routes/geocode.ts, which would then bucket every caller together).
    // `trustProxy: true` makes Fastify derive `request.ip` from
    // `X-Forwarded-For` instead. A direct caller could spoof that header, but
    // once `proxySharedSecret` is set below, direct callers are rejected
    // before routing anyway — and the Worker's own hop overwrites XFF with
    // the real `CF-Connecting-IP`-derived value, so a legitimate request's
    // header cannot be forged by the client that originated it.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Stamp every response — success, error, 404 alike — with the environment
  // that actually served it. onSend runs for all of them, which is the point:
  // an operator debugging a 500 needs to know which deployment produced it just
  // as much as one reading a 200 does.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('X-TinyTales-Env', appEnv)
    // Echo the correlation id back so a client can attach it to a crash report
    // (docs/OBSERVABILITY.md P1). Without this the id exists only in server
    // logs, and "which API call preceded this crash" stays unanswerable from
    // the client side. Same reason this is on `onSend` rather than a success
    // path: a 500 is exactly when the id matters most.
    void reply.header('X-Request-Id', request.id)
  })

  // Built unconditionally (never `undefined`) — appEnv + a logger are always
  // on hand here, and the class itself is what decides whether anything
  // actually gets sent (see lib/alerts.ts: `enabled` requires staging/prod
  // AND Brevo config). `opts.alerter` is the test seam, same precedence as
  // `paymentsGateway` over `razorpay` below.
  const alerter =
    opts.alerter ??
    (() => {
      const { brevoApiKey, emailFrom, emailTo, githubToken, githubRepo } = opts.alerts ?? {}
      const brevo: BrevoConfig | undefined =
        brevoApiKey && emailFrom && emailTo
          ? { apiKey: brevoApiKey, emailFrom, emailTo }
          : undefined
      const github: GithubConfig | undefined =
        githubToken && githubRepo ? { token: githubToken, repo: githubRepo } : undefined
      return new ErrorAlerter({
        appEnv,
        log: app.log,
        ...(brevo ? { brevo } : {}),
        ...(github ? { github } : {}),
      })
    })()

  // Same Brevo credentials as `ErrorAlerter` above, distinct sender name —
  // see the `complaintEmailFetchImpl` doc comment. Absent → complaint tickets
  // are still created and returned with a tracking number; only the
  // notification/confirmation emails are skipped.
  const complaintEmail: EmailSenderConfig | undefined = (() => {
    const { brevoApiKey, emailFrom } = opts.alerts ?? {}
    return brevoApiKey && emailFrom
      ? { apiKey: brevoApiKey, fromEmail: emailFrom, fromName: 'Tiny Tales Support' }
      : undefined
  })()

  // Same credentials again, third sender name. An invoice arrives from the
  // shop, not from its support desk or its error alerter — the From line is
  // the first thing a shopper reads, and it should say who sold them the thing.
  const invoiceEmail: EmailSenderConfig | undefined = (() => {
    const { brevoApiKey, emailFrom } = opts.alerts ?? {}
    return brevoApiKey && emailFrom
      ? { apiKey: brevoApiKey, fromEmail: emailFrom, fromName: 'Tiny Tales' }
      : undefined
  })()

  // Fourth sender identity on the same Brevo credentials — the Grafana
  // ERROR-alert path (`routes/grafanaAlertWebhook.ts` → `lib/alertEmailTask.ts`
  // → `routes/internalAlertEmail.ts`), distinct from `ErrorAlerter`'s own
  // in-process 500/client-error pipeline above.
  const alertEmail: EmailSenderConfig | undefined = (() => {
    const { brevoApiKey, emailFrom } = opts.alerts ?? {}
    return brevoApiKey && emailFrom
      ? { apiKey: brevoApiKey, fromEmail: emailFrom, fromName: 'Tiny Tales Monitoring' }
      : undefined
  })()

  // The carrier adapter, or nothing. Both a token AND a base URL are required —
  // a token with no base URL has no host to talk to, and a base URL with no
  // token gets 401s from Delhivery. Half a config is not a degraded carrier,
  // it is a broken one, so it degrades to none (503) rather than to failures.
  const carrierAdapter: CarrierAdapter | undefined =
    opts.carrierAdapter ??
    (() => {
      const { apiToken, baseUrl, clientName } = opts.delhivery ?? {}
      if (!apiToken || !baseUrl) return undefined
      return createDelhiveryAdapter({
        apiToken,
        baseUrl,
        clientName: clientName ?? '',
        mode: modeFromBaseUrl(baseUrl),
      })
    })()

  // Hand-booked carriers the reconcile poll can still track. No credentials —
  // their tracking endpoint is public — so these exist in every environment.
  const carrierTrackers: Record<string, CarrierTracker> = opts.carrierTrackers ?? {
    [SHREE_MARUTI_COURIER_CODE]: createShreeMarutiTracker(),
  }

  // The ops notification channel registry, or an empty one. All four WhatsApp
  // values are required together — a token with no template to send is not a
  // degraded channel, it is one that cannot send anything — so a partial
  // config resolves to "unconfigured" here exactly like a partial Delhivery
  // config resolves to no carrier adapter above.
  const notificationChannels: NotificationChannelRegistry =
    opts.notificationChannels ??
    (() => {
      const { phoneNumberId, accessToken, templateName, templateLocale } = opts.whatsapp ?? {}
      if (!phoneNumberId || !accessToken || !templateName || !templateLocale) return {}
      return {
        whatsapp_cloud: createWhatsAppCloudChannel({
          phoneNumberId,
          accessToken,
          templateName,
          templateLocale,
        }),
      }
    })()

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } })
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const message = err.validation
        .map((issue) => issue.message)
        .filter(Boolean)
        .join('; ')
      return reply.code(422).send({
        error: { code: 'validation_failed', message: message || 'Request validation failed' },
      })
    }

    // Unparseable/absent JSON body and friends — the client's request, not our bug.
    if (typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP')) {
      return reply
        .code(422)
        .send({ error: { code: 'validation_failed', message: 'Malformed request body' } })
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, 'response failed serialization')
      alerter.notifyServerError(err, serverErrorAlertCtx(request, 500))
      return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } })
    }

    // Everything else is a bug or an outage: log it in full, say nothing specific.
    request.log.error({ err }, 'unhandled error')
    alerter.notifyServerError(err, serverErrorAlertCtx(request, 500))
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } })
  })

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } })
  )

  // Proxy gate — registered here, before auth and any route plugin, because
  // onRequest hooks added at the root run in registration order and this one
  // must run first: everything downstream (CORS, auth, every route) should
  // only ever see traffic that already cleared it.
  //
  // Rejects any request that didn't arrive through the tiny-tales-forus Cloudflare
  // edge Worker (which proxies `www.tinytalesforus.com/api/*` here and injects the
  // `X-TinyTales-Proxy-Auth` header checked below). Optional: unset
  // `proxySharedSecret` (default) registers nothing, so the app behaves
  // exactly as it does today and the run.app URL stays open — the state the
  // service is in until clients finish migrating to the edge URL.
  if (opts.proxySharedSecret) {
    // Buffer once at startup rather than per-request.
    const secret = Buffer.from(opts.proxySharedSecret, 'utf8')

    app.addHook('onRequest', async (request, reply) => {
      // Cloud Scheduler's keepalive ping and Cloud Run's/GCP's own health
      // probes hit the public run.app URL directly, never through the edge
      // Worker — they must stay reachable without the header. Compared as a
      // path (query string stripped) rather than `request.routerPath` so this
      // still applies even if routing hasn't resolved yet for some path.
      const path = request.url.split('?', 1)[0]
      if (path === '/livez' || path === '/readyz') return

      const header = request.headers['x-tinytales-proxy-auth']
      const provided = typeof header === 'string' ? Buffer.from(header, 'utf8') : undefined

      // Length check BEFORE timingSafeEqual: unlike most comparisons,
      // timingSafeEqual THROWS (rather than returning false) on a length
      // mismatch, so the pre-check is required, not optional — same pattern
      // as the webhook HMAC compare in services/payments.ts.
      const ok =
        provided !== undefined &&
        provided.length === secret.length &&
        timingSafeEqual(provided, secret)

      if (!ok) {
        // 404, not 401/403. A 401/403 confirms "this route exists and is
        // guarded" — information a direct caller of the run.app URL could use
        // to tell the gate is there and worth attacking (e.g. brute-forcing
        // the header). A 404 is indistinguishable from hitting a route that
        // doesn't exist at all, so the public URL leaks nothing about why it
        // refused.
        return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } })
      }
    })
  }

  // CORS for the admin SPA (cross-origin, Bearer-authed). Only registered when
  // an allow-list is supplied; a request from a disallowed origin gets no CORS
  // headers, so the browser blocks it. Bearer tokens ride the Authorization
  // header (not cookies), so credentials stay off.
  if (opts.allowedOrigins && opts.allowedOrigins.length > 0) {
    const allowed = new Set(opts.allowedOrigins)
    app.register(cors, {
      origin(origin, cb) {
        // No Origin header = same-origin or a non-browser client; allow.
        if (!origin || allowed.has(origin)) return cb(null, true)
        cb(null, false)
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      // Without this the browser hides X-TinyTales-Env from cross-origin JS, so the
      // admin SPA — which is always cross-origin to this API — could set the
      // header and still be unable to read it back.
      // X-Request-Id is exposed for the same reason: the onSend hook always
      // sets it, but a cross-origin caller cannot read an unlisted header, so
      // without this the admin SPA's error reports would carry no correlation
      // id even though the server sent one.
      exposedHeaders: ['X-TinyTales-Env', 'X-Request-Id'],
      credentials: false,
      maxAge: 86400,
    })
  }

  app.register(authPlugin, {
    db: opts.db,
    verifyToken,
    userCache: createAuthCache(
      opts.authCacheTtlMs !== undefined ? { ttlMs: opts.authCacheTtlMs } : {}
    ),
  })
  app.register(schedulerPlugin, {
    ...(opts.scheduler?.audience !== undefined ? { audience: opts.scheduler.audience } : {}),
    ...(opts.scheduler?.allowedServiceAccounts !== undefined
      ? { allowedServiceAccounts: opts.scheduler.allowedServiceAccounts }
      : {}),
    ...(opts.verifyOidc !== undefined ? { verifyOidc: opts.verifyOidc } : {}),
  })
  app.register(healthRoutes, { db: opts.db })
  app.register(addressRoutes, { db: opts.db, prefix: '/v1/addresses' })
  app.register(profileRoutes, {
    db: opts.db,
    deleteFirebaseUser,
    ...(opts.analytics ? { analytics: opts.analytics } : {}),
    prefix: '/v1/me',
  })
  app.register(configRoutes, { db: opts.db, prefix: '/v1/config' })
  app.register(catalogRoutes, { db: opts.db, prefix: '/v1/catalog' })
  app.register(adminConfigRoutes, { db: opts.db, prefix: '/v1/admin/config' })
  app.register(catalogAdminRoutes, { db: opts.db, prefix: '/v1/admin/catalog' })
  app.register(codAdminRoutes, { db: opts.db, prefix: '/v1/admin/cod' })
  app.register(cartRoutes, { db: opts.db, prefix: '/v1/cart' })
  app.register(reviewRoutes, { db: opts.db, prefix: '/v1/reviews' })
  app.register(authedReviewRoutes, { db: opts.db, prefix: '/v1/reviews' })
  app.register(couponRoutes, { db: opts.db, prefix: '/v1/coupons' })
  app.register(adminCouponsRoutes, { db: opts.db, prefix: '/v1/admin/coupons' })
  app.register(shippingRoutes, { db: opts.db, prefix: '/v1/shipping' })
  app.register(shippingAdminRoutes, {
    db: opts.db,
    // Same key the public reverse-geocode proxy uses. Absent → forward geocode
    // answers 503 and the node form falls back to typing coordinates by hand.
    ...(opts.googleMapsServerKey ? { mapsApiKey: opts.googleMapsServerKey } : {}),
    prefix: '/v1/admin/shipping',
  })
  app.register(stockRoutes, { db: opts.db, prefix: '/v1/stock' })
  app.register(stockAdminRoutes, { db: opts.db, prefix: '/v1/admin/stock' })
  app.register(mediaAdminRoutes, {
    imageIntakeBaseUrl: opts.imageIntake?.baseUrl ?? 'https://image-intake.adix-ai.workers.dev',
    uploadToken: opts.imageIntake?.uploadToken,
    ...(opts.mediaUploadFetchImpl ? { fetchImpl: opts.mediaUploadFetchImpl } : {}),
    prefix: '/v1/admin/media',
  })
  app.register(geocodeRoutes, {
    ...(opts.googleMapsServerKey ? { apiKey: opts.googleMapsServerKey } : {}),
    prefix: '/v1/geocode',
  })
  // Built once and used twice: the shopper-facing payment routes and the
  // scheduled recovery sweep (`/v1/internal/sweeps/payments-recover`) must
  // resolve the SAME gateway, analytics hook and notification channels. An
  // order recovered by the cron is otherwise subtly different from one
  // recovered by hand — and the cron's orders are, by definition, the ones
  // nobody watched happen.
  // Resolved once, here, so the shopper-facing routes and the recovery sweep
  // share one enqueuer — same reason `paymentOptions` itself is built once.
  // The audience is the SCHEDULER's: a task and a scheduler job authenticate as
  // the same identity against the same allowlist, so `plugins/scheduler.ts`
  // needs no second gate to keep in sync.
  const taskEnqueuer: TaskEnqueuer | undefined =
    opts.taskEnqueuer ??
    (opts.tasks?.project &&
    opts.tasks.location &&
    opts.tasks.queue &&
    opts.tasks.targetBaseUrl &&
    opts.tasks.serviceAccountEmail &&
    (opts.scheduler?.audience ?? '') !== ''
      ? createCloudTasksEnqueuer({
          project: opts.tasks.project,
          location: opts.tasks.location,
          queue: opts.tasks.queue,
          targetBaseUrl: opts.tasks.targetBaseUrl,
          serviceAccountEmail: opts.tasks.serviceAccountEmail,
          audience: opts.scheduler?.audience ?? '',
        })
      : undefined)

  // Same Cloud Tasks queue/identity as `taskEnqueuer` above, different
  // producer: this one carries an actual rendered email rather than a bare
  // debounce trigger (see `lib/alertEmailTask.ts`'s header for why it isn't
  // folded into `TaskEnqueuer`/`SweepTaskKind`).
  const alertEmailTaskEnqueuer: AlertEmailTaskEnqueuer | undefined =
    opts.alertEmailTaskEnqueuer ??
    (opts.tasks?.project &&
    opts.tasks.location &&
    opts.tasks.queue &&
    opts.tasks.targetBaseUrl &&
    opts.tasks.serviceAccountEmail &&
    (opts.scheduler?.audience ?? '') !== ''
      ? createAlertEmailTaskEnqueuer({
          project: opts.tasks.project,
          location: opts.tasks.location,
          queue: opts.tasks.queue,
          targetBaseUrl: opts.tasks.targetBaseUrl,
          serviceAccountEmail: opts.tasks.serviceAccountEmail,
          audience: opts.scheduler?.audience ?? '',
        })
      : undefined)

  // Third Cloud Tasks producer, same queue and identity as the two above. This
  // one carries an order id and an absolute due date, and its `scheduleTime` is
  // months out rather than minutes — see `lib/replenishmentTask.ts` for why the
  // 30-day ceiling makes it a chain.
  const replenishmentTaskEnqueuer: ReplenishmentTaskEnqueuer | undefined =
    opts.replenishmentTaskEnqueuer ??
    (opts.tasks?.project &&
    opts.tasks.location &&
    opts.tasks.queue &&
    opts.tasks.targetBaseUrl &&
    opts.tasks.serviceAccountEmail &&
    (opts.scheduler?.audience ?? '') !== ''
      ? createReplenishmentTaskEnqueuer({
          project: opts.tasks.project,
          location: opts.tasks.location,
          queue: opts.tasks.queue,
          targetBaseUrl: opts.tasks.targetBaseUrl,
          serviceAccountEmail: opts.tasks.serviceAccountEmail,
          audience: opts.scheduler?.audience ?? '',
        })
      : undefined)

  // Asked live, per paid order, rather than resolved at boot: fulfilment is
  // switched on by an admin edit (`db:enable-prod-fulfilment-carrier`), and a
  // cached answer would keep declining to enqueue until someone restarted the
  // service. `manifestBlockedBy` is the SAME predicate the manifest sweep
  // reports as `blockedBy`, so the trigger and the sweep cannot disagree.
  const manifestReady =
    carrierAdapter === undefined
      ? undefined
      : async (db: Db) => manifestBlockedBy(await resolveFulfilmentRule(db), true) === null

  const paymentOptions: PaymentRoutesOptions = {
    db: opts.db,
    ...(manifestReady ? { manifestReady } : {}),
    // Cancel path only: recall a manifested label when a shopper self-cancels.
    ...(carrierAdapter ? { carrierAdapter } : {}),
    // Absent ⇒ every retry falls back to the daily backstop cron, which is the
    // behaviour that shipped before this existed.
    ...(taskEnqueuer ? { tasks: taskEnqueuer } : {}),
    ...(opts.razorpay ? { razorpay: opts.razorpay } : {}),
    ...(opts.paymentsGateway ? { gateway: opts.paymentsGateway } : {}),
    // The paid transition mints the invoice; this is how its emailed copy goes out.
    ...(invoiceEmail ? { email: invoiceEmail } : {}),
    ...(opts.invoiceEmailFetchImpl ? { emailFetchImpl: opts.invoiceEmailFetchImpl } : {}),
    // The paid transition is also where the authoritative `Order Completed`
    // comes from — see docs/ANALYTICS.md §7 for why it can live nowhere else.
    ...(opts.analytics ? { analytics: opts.analytics } : {}),
    // The same paid transition feeds ChatGPT Ads' `order_created`.
    ...(opts.openAiAds ? { openAiAds: opts.openAiAds } : {}),
    // Ops WhatsApp fan-out on order-paid (docs/SPEC-MANUAL-FULFILMENT.md §4A).
    notificationChannels,
    // The unpaid-order nudge rides the replenishment queue (lib/replenishmentTask.ts).
    ...(replenishmentTaskEnqueuer ? { followUpTasks: replenishmentTaskEnqueuer } : {}),
  }
  app.register(paymentRoutes, { ...paymentOptions, prefix: '/v1/payments' })
  app.register(invoiceRoutes, { db: opts.db, prefix: '/v1/invoices' })
  app.register(adminInvoiceRoutes, {
    db: opts.db,
    ...(invoiceEmail ? { email: invoiceEmail } : {}),
    ...(opts.invoiceEmailFetchImpl ? { emailFetchImpl: opts.invoiceEmailFetchImpl } : {}),
    prefix: '/v1/admin/invoices',
  })
  app.register(clientErrorsRoutes, { alerter, prefix: '/v1/client-errors' })
  app.register(complaintRoutes, {
    db: opts.db,
    ...(complaintEmail ? { email: complaintEmail } : {}),
    ...(opts.complaintEmailFetchImpl ? { emailFetchImpl: opts.complaintEmailFetchImpl } : {}),
    prefix: '/v1/complaints',
  })
  app.register(adminComplaintRoutes, { db: opts.db, prefix: '/v1/admin/complaints' })
  app.register(fulfilmentRoutes, {
    db: opts.db,
    ...(opts.delhivery?.webhookSecret ? { webhookSecret: opts.delhivery.webhookSecret } : {}),
    // A delivery scan schedules the replenishment reminder from here.
    ...(replenishmentTaskEnqueuer ? { replenishmentTasks: replenishmentTaskEnqueuer } : {}),
    // …and sends the out-for-delivery / delivered message as the scan lands.
    channels: notificationChannels,
    ...(taskEnqueuer ? { tasks: taskEnqueuer } : {}),
    prefix: '/v1/fulfilment',
  })
  app.register(fulfilmentAdminRoutes, {
    db: opts.db,
    ...(carrierAdapter ? { adapter: carrierAdapter } : {}),
    trackers: carrierTrackers,
    loadRule: resolveFulfilmentRule,
    ...(replenishmentTaskEnqueuer ? { replenishmentTasks: replenishmentTaskEnqueuer } : {}),
    channels: notificationChannels,
    prefix: '/v1/admin/fulfilment',
  })
  app.register(notificationsAdminRoutes, {
    db: opts.db,
    channels: notificationChannels,
    prefix: '/v1/admin/notifications',
  })

  // Inbound WhatsApp (TASK-04 phase 1). The webhook is PUBLIC and authenticates
  // its caller by HMAC; the inbox is admin-gated. They are two plugins on two
  // prefixes precisely so an unauthenticated route can never end up inside an
  // admin-hooked scope.
  const whatsappInboundConfig = {
    appSecret: opts.whatsappInbound?.appSecret,
    verifyToken: opts.whatsappInbound?.verifyToken,
    // Receiving needs neither of these; REPLYING needs both. Absent, a reply is
    // recorded as `failed` with the reason rather than silently dropped.
    phoneNumberId: opts.whatsapp?.phoneNumberId,
    accessToken: opts.whatsapp?.accessToken,
  }
  // Push is opt-in twice over: an explicit sender (tests), else a real FCM one
  // only when there is a Firebase project to send through. No project means the
  // inbox works and nobody is notified — the same posture as the send
  // credentials above, and for the same reason: a missing OUTBOUND credential
  // must never close an inbound path.
  const adminPushSender =
    opts.adminPushSender ??
    (opts.firebaseProjectId ? createFcmPushSender(opts.firebaseProjectId) : undefined)

  app.register(whatsappRoutes, {
    db: opts.db,
    config: whatsappInboundConfig,
    ...(opts.whatsappFetch ? { fetchImpl: opts.whatsappFetch } : {}),
    ...(adminPushSender ? { pushSender: adminPushSender } : {}),
    adminBaseUrl: opts.adminBaseUrl ?? 'https://www.tinytalesforus.com',
    prefix: '/v1/whatsapp',
  })
  app.register(whatsappAdminRoutes, {
    db: opts.db,
    config: whatsappInboundConfig,
    ...(opts.whatsappFetch ? { fetchImpl: opts.whatsappFetch } : {}),
    prefix: '/v1/admin/whatsapp',
  })

  // Built once and registered twice: the scheduler-gated sweep routes and the
  // admin-gated readiness route answer from the same wiring, so an operator
  // reading readiness cannot be told a different story than the one the
  // scheduler is living in.
  const sweepOptions: InternalSweepRoutesOptions = {
    db: opts.db,
    ...(carrierAdapter ? { adapter: carrierAdapter } : {}),
    trackers: carrierTrackers,
    loadRule: resolveFulfilmentRule,
    channels: notificationChannels,
    ...(invoiceEmail ? { email: invoiceEmail } : {}),
    ...(opts.invoiceEmailFetchImpl ? { emailFetchImpl: opts.invoiceEmailFetchImpl } : {}),
    payments: paymentOptions,
    // Chains the carrier sweeps forward while parcels are waiting or moving.
    ...(taskEnqueuer ? { tasks: taskEnqueuer } : {}),
    ...(replenishmentTaskEnqueuer ? { replenishmentTasks: replenishmentTaskEnqueuer } : {}),
    schedulerConfigured:
      (opts.scheduler?.audience ?? '') !== '' &&
      (opts.scheduler?.allowedServiceAccounts ?? []).length > 0,
  }
  app.register(internalSweepRoutes, { ...sweepOptions, prefix: '/v1/internal/sweeps' })
  app.register(adminReadinessRoutes, { ...sweepOptions, prefix: '/v1/admin/fulfilment' })

  // `alertEmail` (the sender identity) requires only brevoApiKey+emailFrom;
  // sending also needs a destination, so gate the usable sender on emailTo too
  // rather than let a partial config silently attempt a send to ''.
  const alertEmailTo = opts.alerts?.emailTo
  const usableAlertEmail = alertEmail && alertEmailTo ? alertEmail : undefined

  // Receiving end of the Grafana-alert Cloud Task — same OIDC gate as the
  // sweeps above, since the only caller is Cloud Tasks itself.
  app.register(internalAlertEmailRoutes, {
    ...(usableAlertEmail ? { email: usableAlertEmail } : {}),
    alertEmailTo: alertEmailTo ?? '',
    ...(opts.alertEmailFetchImpl ? { emailFetchImpl: opts.alertEmailFetchImpl } : {}),
    prefix: '/v1/internal',
  })

  // Receiving end of the delayed replenishment task — same OIDC gate as the
  // sweeps, since Cloud Tasks is again the only caller.
  app.register(internalReplenishmentRoutes, {
    db: opts.db,
    ...(replenishmentTaskEnqueuer ? { tasks: replenishmentTaskEnqueuer } : {}),
    // A payment reminder is only worth sending immediately; see the route.
    channels: notificationChannels,
    prefix: '/v1/internal/tasks',
  })

  // Grafana can't hold a Google identity, so this one gates itself with a
  // shared secret instead of `authenticateScheduler` — see the route's header.
  app.register(grafanaAlertWebhookRoutes, {
    ...(opts.grafanaAlertWebhookSecret ? { webhookSecret: opts.grafanaAlertWebhookSecret } : {}),
    ...(alertEmailTaskEnqueuer ? { taskEnqueuer: alertEmailTaskEnqueuer } : {}),
    ...(usableAlertEmail ? { email: usableAlertEmail } : {}),
    alertEmailTo: alertEmailTo ?? '',
    ...(opts.alertEmailFetchImpl ? { emailFetchImpl: opts.alertEmailFetchImpl } : {}),
    prefix: '/v1/webhooks',
  })

  return app
}
