/**
 * Zod-validated view of `process.env` — the ONLY place environment variables
 * are read. Imported by the bootstrap (`index.ts`) and the migration runner;
 * everything else receives config through explicit arguments so tests never
 * depend on ambient env. Parsing is fail-fast: a missing/invalid variable
 * kills the process at boot with a readable message instead of surfacing as
 * a confusing runtime error later.
 *
 * Values come from `.env` locally (loaded via `node --env-file`, never
 * committed) and from GCP Secret Manager / Cloud Run env vars in prod.
 */

import { z } from 'zod'

const EnvSchema = z
  .object({
    /** Neon pooled connection string — what the running app uses. */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Neon direct (unpooled) connection string — migrations only. Optional; falls back to DATABASE_URL. */
    DATABASE_URL_DIRECT: z.string().min(1).optional(),
    /** Firebase project whose ID tokens we accept (`tinytalesforus-prod`). */
    FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
    /**
     * Which deployment this process IS. Echoed on every response as
     * `X-TinyTales-Env` so a browser client can report the environment the SERVER
     * says it reached rather than the one the client believes it is pointed at.
     *
     * This distinction is the whole point. Staging and production share a
     * Firebase project, so the same admin login works against both, and the only
     * thing separating them is a build-time API origin baked into a JS bundle. A
     * stale bundle, a cached page, or an operator with two tabs open can all make
     * a client-rendered "STAGING" label lie. A header minted by the process that
     * actually served the request cannot.
     *
     * Explicit rather than inferred: deriving it from FIREBASE_PROJECT_ID would
     * report both environments as "prod" (they share one), and deriving it from
     * the Razorpay key prefix would silently flip if the keys were ever
     * misconfigured — which is precisely the failure this is meant to expose.
     */
    APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    /** HTTP port. Cloud Run injects PORT=8080. */
    PORT: z.coerce.number().int().positive().default(8080),
    /**
     * Per-instance `pg` pool ceiling. See db/client.ts for why this is
     * cost-neutral (idle connections close after 30s; only peak changes) and why
     * raising it much further just moves the queue into Neon's pooler.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).optional(),
    /**
     * Identity-cache entry lifetime for the auth hook, in ms (lib/authCache.ts).
     * 0 disables caching. This doubles as the staleness window for a manual-SQL
     * role change or a deleted account on OTHER instances, so keep it short —
     * read the module docs before raising it.
     */
    AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).optional(),
    /**
     * Comma-separated browser origins allowed to call the API cross-origin
     * (the admin SPA). Server-to-server and same-origin callers don't need this.
     * Defaults to local dev + the tinytalesforus.com admin origins. Set per-env in
     * Cloud Run to override (e.g. add a staging web origin).
     */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:3000,https://tinytalesforus.com,https://www.tinytalesforus.com')
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      ),
    /**
     * Razorpay credentials (Secret Manager refs in prod). ALL OPTIONAL — when
     * any is absent the payments module degrades gracefully: `POST /orders`
     * returns 503 `payments_disabled`, so the API ships safely before the
     * merchant's Razorpay account exists (SPEC-PAYMENTS.md strategy #4). The
     * `rzp_test_`/`rzp_live_` prefix on KEY_ID drives the client TEST-MODE banner.
     */
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * Google Maps Platform SERVER key for the reverse-geocoding proxy
     * (`/v1/geocode/reverse`). Must be a DIFFERENT key from the app's Android
     * Maps key: web-service APIs cannot use package+SHA-1 restriction. This key
     * is API-restricted to the Geocoding API alone and lives only in Secret
     * Manager — it never enters a client bundle, so there is no scrape vector.
     * (IP restriction was considered and skipped: Cloud Run has no static egress
     * here, and adding a VPC connector + NAT to get one costs more than it
     * defends. Revisit if the service ever gets a static egress IP.)
     * OPTIONAL — absent, the route answers 503 `geocoding_disabled` and the
     * mobile client falls back to its on-device geocoder (graceful degrade,
     * same as payments).
     */
    GOOGLE_MAPS_SERVER_KEY: z.string().min(1).optional(),
    /**
     * RudderStack source `tinytales-api`. BOTH must be set or server-side
     * analytics is an inert no-op — a supported state, not a broken boot, which
     * is what lets tests and local development run without an account.
     *
     * RUDDERSTACK_WRITE_KEY IS A SECRET, unlike the mobile app's. The mobile key
     * is public by design (it ships in the APK and can only write events); this
     * one authorises `Order Completed`, which fabricates revenue in the warehouse
     * and conversions at Meta and Google Ads. Secret Manager only — never a repo,
     * never a client bundle. One key serves every environment; they are separated
     * downstream by `context.app_env`, which every event carries.
     */
    RUDDERSTACK_WRITE_KEY: z.string().min(1).optional(),
    /** The workspace data plane, e.g. `https://<id>.dataplane.rudderstack.com`. */
    RUDDERSTACK_DATA_PLANE_URL: z.url().optional(),
    /**
     * ChatGPT Ads conversion measurement. BOTH must be set or the server-side
     * Conversions API sender is an inert no-op — same supported-unconfigured
     * state as RudderStack above.
     *
     * The pixel id is NOT secret: it ships in the tiny-tales-forus bundle as
     * `NEXT_PUBLIC_TINYTALES_OPENAI_PIXEL_ID` so the browser pixel can initialise.
     * OPENAI_ADS_CONVERSIONS_API_KEY IS a secret, and of the same class as
     * `RUDDERSTACK_WRITE_KEY`: it authorises `order_created`, which fabricates
     * conversions that oCPC bidding then optimises spend toward. Secret Manager
     * only. Unlike RudderStack there is no `app_env` dimension on the receiving
     * side, so non-production events are dropped before they are sent.
     */
    OPENAI_ADS_PIXEL_ID: z.string().min(1).optional(),
    OPENAI_ADS_CONVERSIONS_API_KEY: z.string().min(1).optional(),
    /**
     * OpenAI API key for caricature previews and the uploaded-character check
     * (routes/caricaturePreviews.ts). A different key from the Ads one above:
     * it spends money per call, so it lives in Secret Manager only. Unset ->
     * both routes answer 503 `preview_disabled` and the storefront still takes
     * the order without a preview.
     */
    OPENAI_API_KEY: z.string().min(1).optional(),
    /** Image model for previews. Token-priced; about ₹2 a preview at medium quality. */
    OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-2.5-flare'),
    /** Vision model that judges an uploaded character. */
    OPENAI_VISION_MODEL: z.string().min(1).default('gpt-5.4-mini'),
    /**
     * Previews across every shopper per India day; past it the preview step
     * says it is busy. The spend brake if limits per shopper are not enough.
     */
    CARICATURE_PREVIEW_DAILY_CAP: z.coerce.number().int().min(0).max(5000).default(200),
    /**
     * Shared secret proving a request reached this service through the
     * tiny-tales-forus Cloudflare edge Worker (which forwards `www.tinytalesforus.com/api/*`
     * here with the `/api` prefix stripped) rather than direct to the public
     * `*.run.app` URL. When set, every request must carry a matching
     * `X-TinyTales-Proxy-Auth` header — injected by the edge Worker, never by a
     * browser or mobile client — or `buildApp`'s proxy gate rejects it.
     *
     * OPTIONAL and unset by default (open: the run.app URL answers direct
     * traffic same as today) — this is the migration/dev state, true until
     * mobile/admin clients and the Razorpay webhook URL have all moved to
     * `https://www.tinytalesforus.com/api`. Once they have, setting this variable (and
     * the matching `API_PROXY_SECRET` in the Worker) is what makes the public
     * run.app URL useless to anyone calling it directly.
     */
    PROXY_SHARED_SECRET: z.string().min(1).optional(),
    /**
     * Signing key for delivery quote tokens (`services/shipping.ts`). The token
     * is what makes DISPLAY == CHARGE survive the gap between the cart screen
     * (which may price against a bare `?pincode=`) and order creation (which
     * prices against the order's own address): the cart returns a signed quote,
     * checkout sends it back, and a mismatch is a 409 "re-read and re-confirm"
     * rather than a silent re-price.
     *
     * OPTIONAL. Absent, the key is DERIVED from another configured server secret
     * (see `quoteSigningKey`) so that every Cloud Run instance derives the same
     * one — an instance-local random key would make instance A's token fail
     * verification on instance B and turn checkout into a 409 loop. Set it
     * explicitly once shipping is live; it can be rotated at will, at the cost
     * of invalidating quotes issued in the previous 15 minutes.
     */
    SHIPPING_QUOTE_SECRET: z.string().min(1).optional(),
    /**
     * Delhivery carrier credentials (docs/SPEC-LOGISTICS.md §7). ALL OPTIONAL:
     * absent, the fulfilment module answers 503 `fulfilment_disabled` on every
     * route that would have called out, and no shipment is ever manifested —
     * exactly how payments behaved before Razorpay keys existed. A deploy without
     * these is safe and inert, which is what lets the module ship before the
     * account manager issues a token.
     *
     * `DELHIVERY_BASE_URL` decides which world we are in and there is no third
     * option: `https://staging-express.delhivery.com` for UAT,
     * `https://track.delhivery.com` for production. Pointing a staging deploy at
     * the production host would create REAL shipments against a real account.
     */
    DELHIVERY_API_TOKEN: z.string().min(1).optional(),
    DELHIVERY_BASE_URL: z.string().url().optional(),
    /** Registered client/HQ name, as Delhivery spells it. */
    DELHIVERY_CLIENT_NAME: z.string().min(1).optional(),
    /**
     * Shared secret for the inbound scan webhook. Delhivery signs nothing, so
     * this header IS the authentication — it is not defence in depth, it is the
     * whole defence, which is why the webhook may never move money
     * (SPEC-LOGISTICS §1.1). Absent ⇒ the webhook answers 503 and ingests nothing.
     */
    DELHIVERY_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * Brevo (Sendinblue) transactional-email API key for error-alert emails
     * (`lib/alerts.ts`). ALL THREE of BREVO_API_KEY / ALERT_EMAIL_FROM /
     * ALERT_EMAIL_TO are optional — absent, alerting degrades to log-only
     * (every server 500 and `/v1/client-errors` batch is still logged to Cloud
     * Logging; no email or GitHub issue), same graceful-degrade philosophy as
     * payments/geocode. A partial set is rejected at boot (superRefine below),
     * for the same reason a partial Razorpay config is: it would silently look
     * like alerting is off on purpose when really a var was mistyped.
     */
    BREVO_API_KEY: z.string().min(1).optional(),
    /** Brevo sender address for alert emails — must be a verified Brevo sender/domain. */
    ALERT_EMAIL_FROM: z.string().trim().max(254).pipe(z.email()).optional(),
    /** Where alert emails land — an on-call inbox or distribution list, not necessarily a person. */
    ALERT_EMAIL_TO: z.string().trim().max(254).pipe(z.email()).optional(),
    /**
     * GitHub token (needs "Issues: write" on ALERT_GITHUB_REPO) the alerter
     * uses to search for and open `auto-fix-candidate` issues per unique error
     * fingerprint. Optional — this and ALERT_GITHUB_REPO must be set together
     * (superRefine below) or absent; absent, alert emails are still sent (if
     * Brevo is configured) but simply omit the GitHub issue step.
     */
    ALERT_GITHUB_TOKEN: z.string().min(1).optional(),
    /** `owner/name` of the repo issues get filed against — this repo, in practice. */
    ALERT_GITHUB_REPO: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'ALERT_GITHUB_REPO must look like "owner/name"')
      .optional(),
    /**
     * Shared secret for the inbound Grafana alert webhook
     * (`routes/grafanaAlertWebhook.ts`). Grafana signs nothing on its own, so
     * this header IS the authentication, same posture as
     * DELHIVERY_WEBHOOK_SECRET. Absent ⇒ the webhook answers 503.
     */
    GRAFANA_ALERT_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * WhatsApp Business Cloud API — the ops notification channel
     * (docs/SPEC-MANUAL-FULFILMENT.md §4A/§8). Meta Graph API direct, no BSP.
     * ALL FOUR OPTIONAL, and enforced all-or-nothing below: absent, every
     * `ops_notifications` row is written `skipped_unconfigured` and nothing
     * throws — the same graceful-degrade posture as Razorpay/Delhivery. This is
     * what lets the schema + outbox + hook ship (Phase 1) before Meta has
     * actually approved anything.
     *
     * OPERATOR TODO (still outstanding as of this writing, SPEC §8):
     * - `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN`: the WABA phone
     *   number id and a PERMANENT System User token (not the 24h dev token),
     *   from Secret Manager.
     * - `WHATSAPP_TEMPLATE_ORDER_PAID` / `WHATSAPP_TEMPLATE_LOCALE`: the
     *   `order_paid_ops` Utility template must be submitted and approved in
     *   Business Manager first — these two are PLACEHOLDERS until that
     *   approval exists and its exact name/language code are known.
     */
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    WHATSAPP_TEMPLATE_ORDER_PAID: z.string().min(1).optional(),
    WHATSAPP_TEMPLATE_LOCALE: z.string().min(1).optional(),
    /**
     * INBOUND WhatsApp (TASK-04 phase 1) — a different pair from the four above,
     * with the OPPOSITE failure posture.
     *
     * The four outbound vars degrade gracefully: absent, a message simply does
     * not go out. These two are a security boundary. A WhatsApp number resolves
     * straight to a Tiny Tales account (Firebase phone auth), so an inbound webhook
     * that skipped signature verification would let anyone read another shopper's
     * cart and orders by POSTing their number. Absent therefore means the webhook
     * answers 503 and accepts nothing — CLOSED, not degraded.
     *
     * - `WHATSAPP_APP_SECRET`: the Meta APP secret (App Dashboard → Settings →
     *   Basic), NOT the System User access token. HMAC-SHA256 key for
     *   `X-Hub-Signature-256`.
     * - `WHATSAPP_VERIFY_TOKEN`: an arbitrary string we invent and paste into the
     *   webhook subscription form; Meta echoes it back once during the GET
     *   handshake. It authenticates nothing after that.
     */
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
    /**
     * Cloud Scheduler → `/v1/internal/sweeps/*` authentication
     * (`plugins/scheduler.ts`, docs/SPEC-SWEEP-AUTOMATION.md). BOTH optional and
     * enforced together below.
     *
     * Unlike every other optional credential in this file, absent here means
     * CLOSED, not degraded: the internal routes answer 503 and no background
     * sweep runs. That is the safe direction — the alternative is an open
     * endpoint that manifests real parcels — but it is also a state that looks
     * identical to "everything is fine" from the outside, which is why
     * `GET /v1/admin/fulfilment/readiness` reports `schedulerConfigured`
     * explicitly rather than leaving it to be inferred.
     *
     * `SCHEDULER_OIDC_AUDIENCE` is an arbitrary stable string that must match
     * each job's `--oidc-token-audience` EXACTLY. Deliberately not the service
     * URL: the API answers on the `*.run.app` host, on `www.tinytalesforus.com/api`, and
     * on localhost, and an audience derived from the request would accept a token
     * minted for any of them.
     */
    SCHEDULER_OIDC_AUDIENCE: z.string().min(1).optional(),
    /**
     * Comma-separated service-account emails allowed to call the sweeps — in
     * practice one, the scheduler's own. Google will sign an OIDC token for ANY
     * GCP customer's service account against ANY audience, so this allowlist, not
     * the signature, is the actual access control.
     */
    SCHEDULER_SERVICE_ACCOUNTS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? '')
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean)
      ),
    /**
     * Cloud Tasks — the event-driven trigger for the same sweeps
     * (`lib/tasks.ts`, docs/WIP-EVENT-DRIVEN-SWEEPS.md). Absent ⇒ no enqueues,
     * and the daily Cloud Scheduler jobs drain everything as they do today.
     *
     * Unset is a fully supported state, deliberately: unlike the scheduler
     * allowlist above — where the missing credential IS the lock — a missing
     * queue only costs retry latency, because the backstop cron is still
     * provisioned. Degrade, don't close.
     */
    TASKS_QUEUE: z.string().min(1).optional(),
    /**
     * GCP project owning the queue. Explicit rather than derived from
     * `TASKS_SERVICE_ACCOUNT`'s domain or from Cloud Run's ambient
     * `GOOGLE_CLOUD_PROJECT`: both are correct until the day a task is enqueued
     * from somewhere else, and then they are wrong silently.
     */
    TASKS_PROJECT: z.string().min(1).optional(),
    /** Queue location. Must be `asia-southeast1` in prod — `asia-south1` is empty. */
    TASKS_LOCATION: z.string().min(1).optional(),
    /**
     * Where the task calls back in, no trailing slash. Explicit rather than
     * derived from the request: the API answers on the `*.run.app` host, on
     * `www.tinytalesforus.com/api` and on localhost, and a task minted against whichever
     * host happened to serve the failing request would be routed by accident.
     */
    TASKS_TARGET_BASE_URL: z.string().url().optional(),
    /**
     * The identity the task authenticates AS — `tinytales-scheduler@…`. The same
     * service account Cloud Scheduler uses, so `SCHEDULER_OIDC_AUDIENCE` and
     * `SCHEDULER_SERVICE_ACCOUNTS` cover task callers with no second allowlist
     * to keep in sync. Two identities for one trust boundary is how one of them
     * silently stops being checked.
     */
    TASKS_SERVICE_ACCOUNT: z.string().min(1).optional(),
    /**
     * Base URL of the image-intake Cloudflare Worker (R2 + resize-on-request,
     * see /Users/ghousnawaz/Desktop/Projects/image-resize) that the admin media
     * upload route proxies to. No trailing slash. Defaults to the production
     * custom domain; override for local dev against the Worker's *.workers.dev
     * host if needed.
     */
    IMAGE_INTAKE_BASE_URL: z.string().url().default('https://image-intake.adix-ai.workers.dev'),
    /**
     * Shared secret the Worker's `/api/*` gate checks as `x-upload-token`
     * (`UPLOAD_TOKEN` in its own env). Optional so admin media upload degrades
     * to "unavailable" rather than failing boot when unset (e.g. a fresh local
     * dev env); the route itself 500s with a clear message if a caller hits it
     * without this configured.
     */
    IMAGE_INTAKE_UPLOAD_TOKEN: z.string().min(1).optional(),
  })
  /**
   * Razorpay is all-or-nothing. Zero keys is a supported state (payments
   * degrade to 503); all three is the live state. One or two is ALWAYS a
   * misconfiguration — a typo'd Secret Manager name, a half-finished rollout —
   * and today it deploys silently, because the 503 it produces is
   * indistinguishable from payments being switched off on purpose. Fail at
   * boot instead of serving a lie.
   */
  .superRefine((env, ctx) => {
    const keys = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length > 0 && missing.length < keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_KEY_ID'],
        message: `Razorpay is partially configured — set all three or none. Missing: ${missing.join(', ')}`,
      })
    }
  })
  /** Same all-or-nothing rule as Razorpay above, for the Brevo alert-email trio. */
  .superRefine((env, ctx) => {
    const keys = ['BREVO_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO'] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length > 0 && missing.length < keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BREVO_API_KEY'],
        message: `Error-alerting email is partially configured — set all three (BREVO_API_KEY, ALERT_EMAIL_FROM, ALERT_EMAIL_TO) or none. Missing: ${missing.join(', ')}`,
      })
    }
  })
  /** Same all-or-nothing rule, for the GitHub auto-fix-issue pair. */
  .superRefine((env, ctx) => {
    const keys = ['ALERT_GITHUB_TOKEN', 'ALERT_GITHUB_REPO'] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length > 0 && missing.length < keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALERT_GITHUB_TOKEN'],
        message: `Auto-fix GitHub issue creation is partially configured — set both (ALERT_GITHUB_TOKEN, ALERT_GITHUB_REPO) or neither. Missing: ${missing.join(', ')}`,
      })
    }
  })
  /**
   * Same all-or-nothing rule as Razorpay/Brevo, for the WhatsApp quartet. A
   * token with no phone number id (or a template name with no locale) is not
   * a degraded channel, it is a broken one — fail at boot rather than let it
   * silently resolve to `skipped_unconfigured` when someone meant to wire it up.
   */
  .superRefine((env, ctx) => {
    const keys = [
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_TEMPLATE_ORDER_PAID',
      'WHATSAPP_TEMPLATE_LOCALE',
    ] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length > 0 && missing.length < keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_PHONE_NUMBER_ID'],
        message: `WhatsApp ops notifications are partially configured — set all four or none. Missing: ${missing.join(', ')}`,
      })
    }
  })
  /**
   * Same all-or-nothing rule for the inbound WhatsApp pair. A verify token with
   * no app secret is the dangerous half-state: Meta's subscription handshake
   * would SUCCEED and start delivering messages to a route that then refuses
   * every one of them, which looks like a broken integration rather than a
   * missing secret.
   */
  .superRefine((env, ctx) => {
    const keys = ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_APP_SECRET'],
        message: `Inbound WhatsApp is partially configured — set both or neither. Missing: ${missing.join(', ')}`,
      })
    }
  })
  /**
   * Same all-or-nothing rule for the scheduler pair. An audience with no
   * allowlist is a gate that rejects everyone; an allowlist with no audience is
   * a gate that cannot verify anything. Either half alone means somebody
   * intended to wire scheduled sweeps and stopped partway — and the resulting
   * silence is indistinguishable from the sweeps working.
   */
  .superRefine((env, ctx) => {
    const hasAudience = (env.SCHEDULER_OIDC_AUDIENCE ?? '') !== ''
    const hasAccounts = env.SCHEDULER_SERVICE_ACCOUNTS.length > 0
    if (hasAudience !== hasAccounts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_OIDC_AUDIENCE'],
        message:
          'Scheduled sweeps are partially configured — set both SCHEDULER_OIDC_AUDIENCE and SCHEDULER_SERVICE_ACCOUNTS or neither. ' +
          `Missing: ${hasAudience ? 'SCHEDULER_SERVICE_ACCOUNTS' : 'SCHEDULER_OIDC_AUDIENCE'}`,
      })
    }
  })
  /**
   * The Cloud Tasks group, same all-or-nothing rule — a queue with no target
   * URL, or a target with no service account, enqueues nothing and says so
   * nowhere.
   *
   * Also gated on the scheduler pair, because a task authenticates with exactly
   * the same OIDC identity and audience a scheduler job does. Tasks configured
   * without that pair would be created successfully, dispatched successfully,
   * and then rejected 503 `scheduler_disabled` at the door — a failure that
   * looks like a queue problem and is not.
   */
  .superRefine((env, ctx) => {
    const keys = [
      'TASKS_QUEUE',
      'TASKS_PROJECT',
      'TASKS_LOCATION',
      'TASKS_TARGET_BASE_URL',
      'TASKS_SERVICE_ACCOUNT',
    ] as const
    const missing = keys.filter((k) => !env[k])
    if (missing.length > 0 && missing.length < keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TASKS_QUEUE'],
        message: `Cloud Tasks is partially configured — set all five or none. Missing: ${missing.join(', ')}`,
      })
    }
    if (missing.length === 0 && (env.SCHEDULER_OIDC_AUDIENCE ?? '') === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_OIDC_AUDIENCE'],
        message:
          'Cloud Tasks is configured but the scheduler gate is not — set SCHEDULER_OIDC_AUDIENCE and SCHEDULER_SERVICE_ACCOUNTS, or every dispatched task will be refused 503 scheduler_disabled.',
      })
    }
  })

export type Env = z.infer<typeof EnvSchema>

/** Parse `process.env`, printing a readable report and exiting non-zero on failure. */
export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    console.error(`Invalid environment:\n${issues}`)
    process.exit(1)
  }
  return parsed.data
}
