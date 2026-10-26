/**
 * Bootstrap: env → db → app → listen. This is the only module that reads the
 * environment; everything downstream gets its dependencies passed in.
 * Listens on 0.0.0.0 for Cloud Run and closes the pool on shutdown (Cloud Run
 * sends SIGTERM before killing the instance).
 */

import { buildApp } from './app.js'
import { createDb } from './db/client.js'
import { loadEnv } from './env.js'
import { createAnalytics } from './lib/analytics.js'
import { createOpenAiAdsConversions } from './lib/openaiAdsConversions.js'

const env = loadEnv()
const { db, pool } = createDb(env.DATABASE_URL, {
  ...(env.DATABASE_POOL_MAX !== undefined ? { poolMax: env.DATABASE_POOL_MAX } : {}),
})

// Built before the app because the app takes it as a dependency, and given a
// console logger for the same reason — Fastify's does not exist yet. Both
// methods are only ever reached on a failure path, so the shape is enough.
const analytics = createAnalytics({
  writeKey: env.RUDDERSTACK_WRITE_KEY,
  dataPlaneUrl: env.RUDDERSTACK_DATA_PLANE_URL,
  appEnv: env.APP_ENV,
  log: {
    error: (obj, msg) => console.error(msg, obj),
    warn: (obj, msg) => console.warn(msg, obj),
  },
})

// Same construction order and console-logger reasoning as `analytics` above.
const openAiAds = createOpenAiAdsConversions({
  pixelId: env.OPENAI_ADS_PIXEL_ID,
  apiKey: env.OPENAI_ADS_CONVERSIONS_API_KEY,
  appEnv: env.APP_ENV,
  log: {
    info: (obj, msg) => console.log(msg, obj),
    error: (obj, msg) => console.error(msg, obj),
    warn: (obj, msg) => console.warn(msg, obj),
  },
})

const app = buildApp({
  analytics,
  openAiAds,
  db,
  firebaseProjectId: env.FIREBASE_PROJECT_ID,
  appEnv: env.APP_ENV,
  ...(env.AUTH_CACHE_TTL_MS !== undefined ? { authCacheTtlMs: env.AUTH_CACHE_TTL_MS } : {}),
  allowedOrigins: env.CORS_ALLOWED_ORIGINS,
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  },
  delhivery: {
    apiToken: env.DELHIVERY_API_TOKEN,
    baseUrl: env.DELHIVERY_BASE_URL,
    clientName: env.DELHIVERY_CLIENT_NAME,
    webhookSecret: env.DELHIVERY_WEBHOOK_SECRET,
  },
  googleMapsServerKey: env.GOOGLE_MAPS_SERVER_KEY,
  proxySharedSecret: env.PROXY_SHARED_SECRET,
  whatsapp: {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    templateName: env.WHATSAPP_TEMPLATE_ORDER_PAID,
    templateLocale: env.WHATSAPP_TEMPLATE_LOCALE,
  },
  whatsappInbound: {
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  },
  scheduler: {
    audience: env.SCHEDULER_OIDC_AUDIENCE,
    allowedServiceAccounts: env.SCHEDULER_SERVICE_ACCOUNTS,
  },
  // Event-driven sweep triggers (docs/WIP-EVENT-DRIVEN-SWEEPS.md). All-or-none,
  // enforced in env.ts; unset means the daily Cloud Scheduler backstop is the
  // only thing that drains, i.e. the behaviour before this existed.
  tasks: {
    project: env.TASKS_PROJECT,
    location: env.TASKS_LOCATION,
    queue: env.TASKS_QUEUE,
    targetBaseUrl: env.TASKS_TARGET_BASE_URL,
    serviceAccountEmail: env.TASKS_SERVICE_ACCOUNT,
  },
  alerts: {
    brevoApiKey: env.BREVO_API_KEY,
    emailFrom: env.ALERT_EMAIL_FROM,
    emailTo: env.ALERT_EMAIL_TO,
    githubToken: env.ALERT_GITHUB_TOKEN,
    githubRepo: env.ALERT_GITHUB_REPO,
  },
  imageIntake: {
    baseUrl: env.IMAGE_INTAKE_BASE_URL,
    uploadToken: env.IMAGE_INTAKE_UPLOAD_TOKEN,
  },
})
app.addHook('onClose', async () => {
  // Analytics first: Cloud Run kills instances aggressively and the SDK holds
  // events in memory, so an unflushed queue at SIGTERM is lost purchase
  // attribution. Ordered before the pool close because it is the one that can
  // still lose data — closing the pool afterwards cannot fail into a worse state.
  await analytics.flush()
  await pool.end()
})

// Say out loud which optional modules booted switched off, and name the
// variable responsible. Without this a developer meets graceful degrade as a
// bare 503 with nothing pointing at the cause. Names only, never values.
const razorpayUnset = (
  [
    ['RAZORPAY_KEY_ID', env.RAZORPAY_KEY_ID],
    ['RAZORPAY_KEY_SECRET', env.RAZORPAY_KEY_SECRET],
    ['RAZORPAY_WEBHOOK_SECRET', env.RAZORPAY_WEBHOOK_SECRET],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([name]) => name)
if (razorpayUnset.length > 0) {
  // NOT the only route to a payments 503: the `payments.enabled` config row
  // can switch payments off with every key present. This line rules out the
  // env half of that ambiguity.
  app.log.warn(
    { unset: razorpayUnset },
    'payments disabled: Razorpay keys unset — POST /v1/payments/* will answer 503 payments_disabled'
  )
}
if (!analytics.enabled) {
  // Silent by default otherwise: an inert analytics module changes no response
  // and fails no request, so without this line a missing purchase event looks
  // like a RudderStack problem rather than an unset variable.
  app.log.warn(
    { unset: ['RUDDERSTACK_WRITE_KEY', 'RUDDERSTACK_DATA_PLANE_URL'] },
    'server-side analytics disabled: no `Order Completed` will be emitted — ad platforms and the warehouse will see zero purchases'
  )
}
if (!env.GOOGLE_MAPS_SERVER_KEY) {
  app.log.warn(
    { unset: ['GOOGLE_MAPS_SERVER_KEY'] },
    'reverse geocoding disabled: GOOGLE_MAPS_SERVER_KEY unset — GET /v1/geocode/reverse will answer 503 geocoding_disabled'
  )
}
const delhiveryUnset = (
  [
    ['DELHIVERY_API_TOKEN', env.DELHIVERY_API_TOKEN],
    ['DELHIVERY_BASE_URL', env.DELHIVERY_BASE_URL],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([name]) => name)
if (delhiveryUnset.length > 0) {
  // Not the only route to a fulfilment 503: `fulfilment.enabled` config can
  // switch it off with every key present. This line rules out the env half.
  app.log.warn(
    { unset: delhiveryUnset },
    'fulfilment disabled: Delhivery credentials unset — POST /v1/admin/fulfilment/* will answer 503 fulfilment_disabled'
  )
}
if (!env.DELHIVERY_WEBHOOK_SECRET) {
  app.log.warn(
    { unset: ['DELHIVERY_WEBHOOK_SECRET'] },
    'Delhivery inbound webhook disabled: DELHIVERY_WEBHOOK_SECRET unset — scan updates will answer 503'
  )
}
const whatsappUnset = (
  [
    ['WHATSAPP_PHONE_NUMBER_ID', env.WHATSAPP_PHONE_NUMBER_ID],
    ['WHATSAPP_ACCESS_TOKEN', env.WHATSAPP_ACCESS_TOKEN],
    ['WHATSAPP_TEMPLATE_ORDER_PAID', env.WHATSAPP_TEMPLATE_ORDER_PAID],
    ['WHATSAPP_TEMPLATE_LOCALE', env.WHATSAPP_TEMPLATE_LOCALE],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([name]) => name)
if (whatsappUnset.length > 0) {
  // Not a broken deploy: ops_notifications rows are still enqueued on every
  // paid order (docs/SPEC-MANUAL-FULFILMENT.md §4A) — they just land
  // `skipped_unconfigured` until WhatsApp credentials AND the approved
  // `order_paid_ops` template exist. See docs/SPEC-MANUAL-FULFILMENT.md §8 for
  // what's still needed from the operator.
  app.log.warn(
    { unset: whatsappUnset },
    'ops WhatsApp notifications disabled: enqueued rows will be skipped_unconfigured until all four WHATSAPP_* vars are set'
  )
}
if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_VERIFY_TOKEN) {
  // Unlike the quartet above, absent here means CLOSED: `POST
  // /v1/whatsapp/webhook` answers 503 and no inbound message is accepted. That
  // is the safe direction — the alternative is an endpoint that resolves an
  // unverified phone number to a real account — but it is worth saying at boot,
  // because from Meta's side a 503 looks the same as an outage.
  app.log.warn(
    { unset: ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'].filter((k) => !process.env[k]) },
    'inbound WhatsApp disabled: the webhook will answer 503 and accept no messages'
  )
}
if (!env.SCHEDULER_OIDC_AUDIENCE || env.SCHEDULER_SERVICE_ACCOUNTS.length === 0) {
  // The loudest of these warnings, because its failure mode is the quietest.
  // Every other unset credential here produces a visible 503 on a route someone
  // is actively calling. This one produces NOTHING: no scheduler calls, so no
  // errors, so no logs — paid orders simply accumulate in `pending_manifest`
  // and tracking never advances, and the system looks idle rather than broken.
  // That is the exact state prod was in when this module was written.
  app.log.warn(
    { unset: ['SCHEDULER_OIDC_AUDIENCE', 'SCHEDULER_SERVICE_ACCOUNTS'] },
    'scheduled sweeps disabled: /v1/internal/sweeps/* will answer 503 — nothing will manifest, reconcile, ' +
      'retry invoice emails, or drain the ops notification outbox without a human pressing the admin buttons'
  )
}
if (!env.TASKS_QUEUE) {
  // Quiet by design, and much less serious than the scheduler warning above:
  // the daily sweep jobs still run, so nothing is lost — retries just wait for
  // them instead of firing minutes later. Logged anyway because "tasks are
  // silently off" is otherwise only discoverable from a Neon bill a fortnight
  // later, which is how the last cost surprise stayed invisible.
  app.log.warn(
    { unset: ['TASKS_QUEUE'] },
    'event-driven sweep triggers disabled: retries fall back to the daily backstop cron ' +
      '(0 4 * * *) — correct, but up to 24h slower than a Cloud Tasks enqueue'
  )
}
if (!env.PROXY_SHARED_SECRET) {
  app.log.warn(
    { unset: ['PROXY_SHARED_SECRET'] },
    'proxy gate disabled: PROXY_SHARED_SECRET unset — service accepts direct traffic on the run.app URL; ' +
      'set PROXY_SHARED_SECRET (Secret Manager) once clients have moved to https://www.tinytalesforus.com/api'
  )
}
const brevoUnset = (
  [
    ['BREVO_API_KEY', env.BREVO_API_KEY],
    ['ALERT_EMAIL_FROM', env.ALERT_EMAIL_FROM],
    ['ALERT_EMAIL_TO', env.ALERT_EMAIL_TO],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([name]) => name)
if (brevoUnset.length > 0) {
  app.log.warn(
    { unset: brevoUnset },
    'error alerting disabled: Brevo email vars unset — server errors and /v1/client-errors batches are still logged, no alert email will be sent'
  )
}
const githubAlertUnset = (
  [
    ['ALERT_GITHUB_TOKEN', env.ALERT_GITHUB_TOKEN],
    ['ALERT_GITHUB_REPO', env.ALERT_GITHUB_REPO],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([name]) => name)
if (githubAlertUnset.length > 0) {
  app.log.warn(
    { unset: githubAlertUnset },
    'auto-fix issue creation disabled: GitHub vars unset — alert emails (if Brevo is configured) will not link a GitHub issue'
  )
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
