/**
 * `/v1/internal/sweeps` — the machine-driven half of the background work
 * (docs/SPEC-SWEEP-AUTOMATION.md).
 *
 * Four sweeps already existed as operator buttons under `/v1/admin/*`. Nothing
 * ever pressed them: `gcloud scheduler jobs list --project=tinytalesforus-prod` returned
 * zero jobs, `.github/workflows/` has no `schedule:`, and there is no timer in
 * this process. So a paid order sat in `pending_manifest` until a human
 * remembered, tracking never advanced without an inbound scan push, and a failed
 * WhatsApp send was retried by nobody.
 *
 * This plugin is the same four sweeps behind a gate a scheduler can pass
 * (`plugins/scheduler.ts` — Google OIDC, allowlisted service account), calling
 * the SAME shared runners the admin buttons call. There is no second
 * implementation of any sweep here; if there were, the automated path and the
 * manual path would eventually disagree about which orders may ship.
 *
 * ## Why a skip is a 200
 *
 * The admin routes throw 503 `fulfilment_disabled` when the feature is off.
 * That is right for a human — they pressed a button and deserve to be told why
 * nothing happened. It is wrong for a scheduler: Cloud Scheduler retries
 * non-2xx and marks the job failed, so pointing it at a 503 that will persist
 * for as long as `fulfilment.enabled` is false (weeks, deliberately) produces a
 * permanently red job and a retry every few minutes. An operator learns to
 * ignore that red within a day, and then a real failure is invisible.
 *
 * So configuration-says-no is `200 { ran: false, reason }` plus a structured
 * `warn` log line. Green to the scheduler, explicit in the payload, loud in
 * Loki. Genuine faults still throw and still become 5xx, which is exactly what
 * the scheduler's retry is for.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/fulfilment.js'
import {
  FulfilmentReadinessSchema,
  InternalSweepResponseSchema,
  type InternalSweepResponse,
  type SweepSkipReason,
} from '../contracts/sweeps.js'
import type { Db } from '../db/client.js'
import type { CarrierAdapter } from '../lib/delhivery.js'
import type { CarrierTracker } from '../lib/shreeMaruti.js'
import type { EmailSenderConfig } from '../lib/email.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import type { ReplenishmentTaskEnqueuer } from '../lib/replenishmentTask.js'
import { countInvoicesNeedingEmail } from '../services/invoices.js'
import { countOpsNotificationsNeedingSend } from '../services/opsNotifications.js'
import {
  carrierSweepBlockedBy,
  countInFlightShipments,
  fulfilmentBacklog,
  manifestBlockedBy,
  manifestPending,
  reconcileStale,
  type FulfilmentRule,
} from '../services/fulfilment.js'
import { MINUTE_MS, RECONCILE_BUCKET_MS, requestSweep, type TaskEnqueuer } from '../lib/tasks.js'
import { makeManifestSourceResolver } from './fulfilmentAdmin.js'
import { reactToShipmentMilestone } from './customerNotifications.js'
import { runInvoiceEmailSweep } from './invoicesAdmin.js'
import { runOpsNotificationSweep } from './notificationsAdmin.js'
import {
  paymentsRecoverBlockedBy,
  runPaymentRecoverSweep,
  type PaymentRoutesOptions,
} from './payments.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface InternalSweepRoutesOptions {
  db: Db
  /** Absent ⇒ carrier sweeps skip with `carrier_unconfigured` rather than 503. */
  adapter?: CarrierAdapter | undefined
  /** Track-only carriers keyed by `shipments.courier_code`; see `reconcileStale`. */
  trackers?: Readonly<Record<string, CarrierTracker>> | undefined
  loadRule: (db: Db) => Promise<FulfilmentRule>
  sellerGstTin?: string | undefined
  hsnCode?: string | undefined
  channels: NotificationChannelRegistry
  email?: EmailSenderConfig
  emailFetchImpl?: typeof fetch
  /**
   * Whether `plugins/scheduler.ts` has an audience and an allowlist. Reported by
   * readiness, because "no scheduler can authenticate" and "the scheduler is
   * running fine" look identical from the database.
   */
  schedulerConfigured: boolean
  /**
   * The SAME options object `paymentRoutes` is registered with (`app.ts`), so
   * the scheduled recovery resolves the identical gateway, carrier code,
   * analytics hook and notification channels the shopper-facing payment routes
   * do. Absent ⇒ the sweep skips with `payments_disabled` instead of 503ing.
   */
  payments?: PaymentRoutesOptions
  /**
   * Cloud Tasks enqueuer, used ONLY to chain the carrier sweeps forward while
   * work remains (docs/WIP-EVENT-DRIVEN-SWEEPS.md §4). Absent ⇒ the daily
   * backstop cron is the only thing that runs them, which is what shipped
   * before this existed.
   */
  tasks?: TaskEnqueuer
  /**
   * Lets a delivery found by the reconcile poll schedule the refill and review
   * follow-ups, exactly as a delivery scan pushed by the webhook does.
   */
  replenishmentTasks?: ReplenishmentTaskEnqueuer | undefined
}

type SweepName = InternalSweepResponse['sweep']

function skipped(sweep: SweepName, reason: SweepSkipReason): InternalSweepResponse {
  return { sweep, ran: false, reason, scanned: 0, succeeded: 0, failed: 0, skipped: 0 }
}

/**
 * Which gate, if any, is shut for the carrier sweeps.
 *
 * The decision itself lives in `services/fulfilment.ts` because the
 * event-driven trigger asks the SAME question before enqueuing a Cloud Task —
 * two copies could drift into a trigger that pays for a Neon wake to be told
 * `ran: false`.
 */
function carrierBlockedBy(
  rule: FulfilmentRule,
  adapter: CarrierAdapter | undefined
): SweepSkipReason | null {
  return carrierSweepBlockedBy(rule, adapter !== undefined)
}

export const internalSweepRoutes: FastifyPluginAsyncZod<InternalSweepRoutesOptions> = async (
  app,
  opts
) => {
  const { db, adapter, loadRule, sellerGstTin, hsnCode, channels, email, emailFetchImpl } = opts

  app.addHook('onRequest', app.authenticateScheduler)

  /**
   * Manifest everything waiting. Idempotent: only `pending_manifest` rows under
   * the attempt cap are picked up, and a row that succeeds leaves that set
   * immediately, so two overlapping runs cannot double-book a parcel.
   */
  app.post(
    '/manifest',
    { schema: { response: { 200: InternalSweepResponseSchema, ...errorResponses } } },
    async (request): Promise<InternalSweepResponse> => {
      const rule = await loadRule(db)
      const blocked = manifestBlockedBy(rule, adapter !== undefined)
      if (blocked !== null) {
        request.log.warn(
          { sweep: 'manifest', reason: blocked },
          blocked === 'pickup_location_unset'
            ? 'fulfilment is enabled but fulfilment.pickupLocationName is empty; the carrier would reject every manifest'
            : 'sweep skipped by configuration'
        )
        return skipped('manifest', blocked)
      }

      const outcome = await manifestPending(
        db,
        // Non-null by `carrierBlockedBy` above.
        adapter as CarrierAdapter,
        rule,
        makeManifestSourceResolver(db, { sellerGstTin, hsnCode })
      )
      if (outcome.failed > 0) {
        request.log.warn({ sweep: 'manifest', outcome }, 'manifest sweep had failures')
      }

      if (opts.tasks) {
        // Chain forward while parcels are still waiting. This terminates: every
        // outcome in `manifestPending` — including an unbuildable manifest —
        // burns an attempt, so a row either leaves `pending_manifest` or hits
        // `manifestMaxAttempts` and stops being counted. What keeps the chain
        // alive after that is new orders, which is work, not spin.
        const backlog = await fulfilmentBacklog(db, rule)
        if (backlog.pendingManifest > 0) {
          requestSweep(opts.tasks, 'manifest', request.log)
        }
        // A parcel that just got an AWB is now in flight, and the tracking
        // webhook may never fire for it. Seed the reconcile chain from here so
        // the poll only exists once something is actually moving.
        if (outcome.succeeded > 0) {
          requestSweep(
            opts.tasks,
            'reconcile',
            request.log,
            RECONCILE_BUCKET_MS,
            new Date(Date.now() + rule.reconcileStaleMinutes * MINUTE_MS)
          )
        }
      }

      return {
        sweep: 'manifest',
        ran: true,
        reason: null,
        scanned: outcome.scanned,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        skipped: 0,
      }
    }
  )

  /**
   * Pull tracking for shipments the scan webhook has gone quiet on. This is the
   * safety net that makes inbound push an optimisation rather than a
   * dependency — without it, an unregistered or silently-broken webhook means
   * parcels never leave `in_transit`, and nothing says so.
   */
  app.post(
    '/reconcile',
    { schema: { response: { 200: InternalSweepResponseSchema, ...errorResponses } } },
    async (request): Promise<InternalSweepResponse> => {
      const rule = await loadRule(db)
      const blocked = carrierBlockedBy(rule, adapter)
      if (blocked !== null) {
        request.log.warn({ sweep: 'reconcile', reason: blocked }, 'sweep skipped by configuration')
        return skipped('reconcile', blocked)
      }

      const outcome = await reconcileStale(
        db,
        adapter as CarrierAdapter,
        rule,
        new Date(),
        async (result) => {
          try {
            await reactToShipmentMilestone(db, {
              orderId: result.orderId!,
              status: result.status,
              awb: result.awb,
              courierCode: result.courierCode,
              log: request.log,
              ...(opts.replenishmentTasks ? { replenishmentTasks: opts.replenishmentTasks } : {}),
              channels,
              ...(opts.tasks ? { tasks: opts.tasks } : {}),
            })
          } catch (err) {
            request.log.error(
              { err, orderId: result.orderId },
              'customer milestone notification failed'
            )
          }
        },
        opts.trackers
      )
      if (outcome.failed > 0) {
        request.log.warn({ sweep: 'reconcile', outcome }, 'reconcile sweep had failures')
      }

      if (opts.tasks) {
        // Keep polling while anything is still moving — NOT while anything is
        // stale, which this run just fixed. See `countInFlightShipments`. The
        // chain ends by itself when the last parcel is delivered or returned,
        // which is also when the cost ends.
        if ((await countInFlightShipments(db)) > 0) {
          requestSweep(
            opts.tasks,
            'reconcile',
            request.log,
            RECONCILE_BUCKET_MS,
            new Date(Date.now() + rule.reconcileStaleMinutes * MINUTE_MS)
          )
        }
      }

      return {
        sweep: 'reconcile',
        ran: true,
        reason: null,
        scanned: outcome.scanned,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        skipped: 0,
      }
    }
  )

  /**
   * Retry customer invoice copies. No config gate — an unconfigured Brevo
   * sender already resolves each row to a skip inside `sendInvoiceEmail`, and
   * phone-only accounts are terminal `skipped_no_email` and never selected.
   */
  app.post(
    '/invoice-emails',
    { schema: { response: { 200: InternalSweepResponseSchema, ...errorResponses } } },
    async (request): Promise<InternalSweepResponse> => {
      const outcome = await runInvoiceEmailSweep(db, email, emailFetchImpl, request.log)
      if (outcome.failed > 0) {
        request.log.warn({ sweep: 'invoice-emails', outcome }, 'invoice email sweep had failures')
      }
      return {
        sweep: 'invoice-emails',
        ran: true,
        reason: null,
        scanned: outcome.scanned,
        succeeded: outcome.sent,
        failed: outcome.failed,
        skipped: outcome.skipped,
      }
    }
  )

  /**
   * Drain the ops notification outbox. Also no config gate: with WhatsApp
   * unwired every row records `skipped_unconfigured` and stays eligible, which
   * is precisely what makes this sweep the thing that delivers the backlog the
   * moment Meta moves `order_paid_ops` out of PENDING — with no deploy and
   * nobody watching for the approval email.
   *
   * That eligibility is `OPS_NOTIFICATION_SENDABLE_STATUSES` including
   * `skipped_unconfigured`, and it is load-bearing. Until 2026-08-23 the sweep
   * predicate was `('pending','failed')` only, so the state every row lands in
   * during an outage was terminal in practice and this paragraph was false: the
   * backlog would have sat there after approval landed, reporting nothing.
   */
  app.post(
    '/ops-notifications',
    { schema: { response: { 200: InternalSweepResponseSchema, ...errorResponses } } },
    async (request): Promise<InternalSweepResponse> => {
      const outcome = await runOpsNotificationSweep(db, channels, request.log)
      if (outcome.failed > 0) {
        request.log.warn(
          { sweep: 'ops-notifications', outcome },
          'ops notification sweep had failures'
        )
      }
      return {
        sweep: 'ops-notifications',
        ran: true,
        reason: null,
        scanned: outcome.scanned,
        succeeded: outcome.sent,
        failed: outcome.failed,
        skipped: outcome.skipped,
      }
    }
  )

  /**
   * Reconcile payments stuck `pending` against Razorpay.
   *
   * The only sweep here that guards MONEY rather than logistics. Both live paid
   * signals can be lost at once — the client's `/verify` call dies with the tab,
   * the webhook is dropped in transit — and when they are, the shopper has been
   * charged and no order exists. Nothing else in the system ever notices: the
   * row simply sits `pending` until somebody thinks to press the admin button.
   * That is true at one order a day exactly as it is at ten thousand, which is
   * why this is wired now rather than at scale.
   *
   * Bounded to `RECOVER_MAX_BATCH` rows per run by the service. The overflow is
   * picked up by the next pass — see that constant for why an unbounded scan is
   * both the expensive shape and the one that can outrun the 300s attempt
   * deadline.
   */
  app.post(
    '/payments-recover',
    { schema: { response: { 200: InternalSweepResponseSchema, ...errorResponses } } },
    async (request): Promise<InternalSweepResponse> => {
      const blocked = await paymentsRecoverBlockedBy(opts.payments)
      if (blocked !== null) {
        request.log.warn(
          { sweep: 'payments-recover', reason: blocked },
          'sweep skipped by configuration'
        )
        return skipped('payments-recover', blocked)
      }

      // Non-null by `paymentsRecoverBlockedBy` above.
      const outcome = await runPaymentRecoverSweep(
        opts.payments as PaymentRoutesOptions,
        request.log
      )
      // `mismatched` is money the system cannot account for and no retry will
      // fix — logged at ERROR (not warn) because it is the one outcome here
      // that needs a person today. `recover` also logs each row individually
      // with the amounts; this is the summary an alert can key on.
      if (outcome.mismatched > 0) {
        request.log.error(
          { sweep: 'payments-recover', outcome },
          'payment recover sweep found captured payments that do not match their order — manual review required'
        )
      }
      return {
        sweep: 'payments-recover',
        ran: true,
        reason: null,
        scanned: outcome.scanned,
        // Only recovered orders count as work done. A run that scans 40
        // abandoned carts and recovers nothing succeeded at zero, and should
        // read that way.
        succeeded: outcome.paid,
        // Nothing this sweep does is a retryable failure: a row either
        // transitions, expires, mismatches, or stays eligible. Razorpay being
        // unreachable lands in `stillPending`, not here.
        failed: 0,
        // Left `pending` on purpose: too young to expire, or Razorpay was
        // unreachable. Both are eligible again next run.
        skipped: outcome.stillPending,
        mismatched: outcome.mismatched,
        expired: outcome.failed,
      }
    }
  )

  app.get(
    '/readiness',
    { schema: { response: { 200: FulfilmentReadinessSchema, ...errorResponses } } },
    async () => buildReadiness(opts)
  )
}

/**
 * `GET /v1/admin/fulfilment/readiness` — the human twin of the route above,
 * behind `authenticate` + `requireAdmin` instead of the scheduler gate.
 *
 * Registered as its own plugin on the same prefix rather than as a route inside
 * `fulfilmentAdminRoutes`, because it needs the notification registry and the
 * scheduler flag, and threading those into the carrier-and-shipments plugin
 * just to answer one question would widen that module for no other reason.
 */
export const adminReadinessRoutes: FastifyPluginAsyncZod<InternalSweepRoutesOptions> = async (
  app,
  opts
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/readiness',
    { schema: { response: { 200: FulfilmentReadinessSchema, ...errorResponses } } },
    async () => buildReadiness(opts)
  )
}

/**
 * The resolved truth about whether scheduled fulfilment will do anything.
 *
 * Shared with the admin-side twin (`GET /v1/admin/fulfilment/readiness`) so an
 * operator and a monitor read the identical answer. Reports the rule as
 * `parseFulfilmentRule` RESOLVED it, not as `app_config` stores it — those
 * differ precisely in the failure this endpoint exists to catch, where one
 * missing key collapses the whole rule to `FULFILMENT_OFF` and every stored key
 * still looks fine in the admin config table.
 */
export async function buildReadiness(opts: InternalSweepRoutesOptions) {
  const { db, adapter, loadRule, channels, schedulerConfigured } = opts
  const rule = await loadRule(db)
  const blockedBy =
    carrierBlockedBy(rule, adapter) ??
    (rule.pickupLocationName === '' ? 'pickup_location_unset' : null)

  const [backlog, opsOwed, invoiceOwed] = await Promise.all([
    fulfilmentBacklog(db, rule),
    countOpsNotificationsNeedingSend(db),
    countInvoicesNeedingEmail(db),
  ])

  return {
    // Config-ready AND schedulable. A perfect rule that no scheduler can reach
    // is not ready — that combination is the exact state prod was in, and
    // reporting it as ready is how it stayed invisible for a month.
    ready: blockedBy === null && schedulerConfigured,
    blockedBy,
    rule: {
      enabled: rule.enabled,
      mode: rule.mode,
      carrier: rule.carrier,
      autoManifest: rule.autoManifest,
      pickupLocationName: rule.pickupLocationName,
      manifestMaxAttempts: rule.manifestMaxAttempts,
      reconcileStaleMinutes: rule.reconcileStaleMinutes,
      reconcileBatchSize: rule.reconcileBatchSize,
    },
    carrierConfigured: adapter !== undefined,
    notificationsConfigured: Object.keys(channels).length > 0,
    schedulerConfigured,
    backlog: {
      pendingManifest: backlog.pendingManifest,
      manifestExhausted: backlog.manifestExhausted,
      staleTracking: backlog.staleTracking,
      opsNotificationsOwed: opsOwed,
      invoiceEmailsOwed: invoiceOwed,
      oldestPendingManifestHours: backlog.oldestPendingManifestHours,
    },
  }
}
