/**
 * `POST /v1/internal/tasks/replenishment` — the receiving end of the delayed
 * Cloud Task `lib/replenishmentTask.ts` enqueues when an order is delivered
 * (docs/kb/tasks/TASK-01-whatsapp-retention.md §Backend work 5).
 *
 * Same OIDC gate as `internalSweepRoutes` and `internalAlertEmailRoutes`: the
 * caller is Cloud Tasks with the scheduler service account, so
 * `authenticateScheduler` covers it unchanged.
 *
 * ## Two jobs, decided by the clock
 *
 * A task arriving here is either the LAST leg of the chain or an intermediate
 * one, and the body's `dueAt` is what says which:
 *
 *   not yet due  → enqueue the next leg and return. Cloud Tasks caps
 *                  `scheduleTime` at 30 days, so a 60-day wait is two hops
 *                  (`lib/replenishmentTask.ts` explains the ceiling).
 *   due          → write the outbox row. Sending is NOT done here — the row
 *                  goes through the same claim-before-send, attempt cap,
 *                  consent gate and retry drain as everything else in
 *                  `ops_notifications`.
 *
 * ## Why this writes a row instead of sending
 *
 * An outbox row is sendable as soon as it exists and there is no "not before"
 * column, which is the whole reason the wait lives in the queue rather than the
 * table. Once the wait is over, though, the row is the right shape: it inherits
 * the consent gate, the template gate, the dedupe key and the retry sweep for
 * free. Sending inline from here would be a second delivery path around all
 * four.
 *
 * ## Failure posture
 *
 * A genuine fault throws (→ 500) and Cloud Tasks retries per the queue's
 * `MAX_ATTEMPTS`. There is deliberately no cron backstop for this path — that
 * poller is exactly the Neon cost this design avoids — so the queue's retry is
 * the only safety net and must not be swallowed.
 *
 * An order that has since been refunded, or whose shopper has no usable phone,
 * is NOT a fault: it returns 200 with `sent: false` and a reason, so the task
 * completes rather than retrying against a condition that will never change.
 *
 * ## Other follow-ups on the same task
 *
 * The body's optional `kind` (`lib/replenishmentTask.ts` `FOLLOW_UP_KINDS`)
 * routes two more per-order beats through this endpoint:
 *
 *   payment_reminder → the order is still `pending` some minutes after it was
 *                      created: nudge the shopper back to their cart, once.
 *   review_request   → a few days after delivery: ask for a rating, deep
 *                      linking to the product's rate dialog.
 *
 * Both re-check the order on arrival rather than trusting what was true when
 * they were scheduled, for the same reason the refill reminder does.
 */

import { and, eq, gt, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/fulfilment.js'
import type { Db } from '../db/client.js'
import { cartItems, catalogItems, payments, products, reviews } from '../db/schema.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import {
  FOLLOW_UP_KINDS,
  isDue,
  type ReplenishmentTaskEnqueuer,
  requestReplenishmentReminder,
} from '../lib/replenishmentTask.js'
import { getConfigValue } from '../services/config.js'
import { marketingConsentForOrder } from '../services/marketingConsent.js'
import { enqueueOpsNotification } from '../services/opsNotifications.js'
import { orderInvoiceSourceFromRow, type CartSnapshot } from '../services/payments.js'

import {
  customerTargetFor,
  firstNameFromAddress,
  headlineLine,
  paymentReminderParams,
  productLabelFor,
  replenishmentParams,
  reviewRequestParams,
  toWhatsAppTarget,
} from './customerNotifications.js'
import {
  PAYMENT_REMINDER_CUSTOMER_KIND,
  REPLENISHMENT_KIND,
  REVIEW_REQUEST_CUSTOMER_KIND,
  sendPendingOpsNotifications,
  WHATSAPP_CHANNEL,
} from './opsNotifications.js'

const ReplenishmentTaskBodySchema = z
  .object({
    orderId: z.string().min(1),
    dueAt: z.string().min(1),
    kind: z.enum(FOLLOW_UP_KINDS).optional(),
  })
  .strict()

const ReplenishmentTaskResponseSchema = z.object({
  /** True only when an outbox row was written by THIS call. */
  enqueued: z.boolean(),
  /** Set when nothing was enqueued — `rescheduled`, `order_not_found`, … */
  reason: z.string().nullable(),
})

type FollowUpOutcome = z.infer<typeof ReplenishmentTaskResponseSchema>

export interface InternalReplenishmentRoutesOptions {
  db: Db
  /** Absent ⇒ a not-yet-due task cannot chain, and says so rather than pretending. */
  tasks?: ReplenishmentTaskEnqueuer | undefined
  /**
   * Present ⇒ a payment reminder is sent the moment its row is written. Absent
   * ⇒ it waits for the daily outbox sweep, by which time the order has expired
   * and the nudge is pointless — so production must pass this.
   */
  channels?: NotificationChannelRegistry | undefined
}

export const internalReplenishmentRoutes: FastifyPluginAsyncZod<
  InternalReplenishmentRoutesOptions
> = async (app, opts) => {
  const { db, tasks, channels } = opts

  app.addHook('onRequest', app.authenticateScheduler)

  app.post(
    '/replenishment',
    {
      schema: {
        body: ReplenishmentTaskBodySchema,
        response: {
          200: ReplenishmentTaskResponseSchema,
          '4xx': ErrorEnvelopeSchema,
          '5xx': ErrorEnvelopeSchema,
        },
      },
    },
    async (request): Promise<FollowUpOutcome> => {
      const { orderId, dueAt, kind = 'replenishment' } = request.body
      const due = new Date(dueAt)
      if (Number.isNaN(due.getTime())) {
        // Unparseable due date: retrying cannot fix it, and re-enqueuing would
        // spin. Complete the task and say so.
        request.log.warn({ orderId, dueAt, kind }, 'follow-up task carried an unparseable dueAt')
        return { enqueued: false, reason: 'bad_due_at' }
      }

      if (!isDue(due)) {
        if (tasks === undefined) {
          request.log.warn(
            { orderId, dueAt, kind },
            'follow-up task is not due but no queue is configured; the chain stops here'
          )
          return { enqueued: false, reason: 'no_queue' }
        }
        // Next hop. `requestReplenishmentReminder` recomputes the leg from the
        // SAME absolute `dueAt` it was handed, which is what makes the chain
        // converge instead of walking forward — see `lib/replenishmentTask.ts`.
        requestReplenishmentReminder(tasks, { orderId, dueAt, kind }, request.log)
        return { enqueued: false, reason: 'rescheduled' }
      }

      if (kind === 'payment_reminder') {
        const outcome = await enqueuePaymentReminder(db, orderId, request.log)
        if (outcome.enqueued && channels !== undefined) {
          sendPendingOpsNotifications(db, orderId, channels, request.log)
        }
        return outcome
      }
      if (kind === 'review_request') {
        return enqueueReviewRequest(db, orderId, request.log)
      }
      return enqueueReplenishment(db, orderId, request.log)
    }
  )
}

/** The refill reminder — unchanged from when it was this route's only job. */
async function enqueueReplenishment(
  db: Db,
  orderId: string,
  log: FastifyBaseLogger
): Promise<FollowUpOutcome> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  if (row === undefined) {
    return { enqueued: false, reason: 'order_not_found' }
  }
  // `orderInvoiceSourceFromRow` returns undefined for anything that is not
  // paid or refunded. A refunded order is the case that matters: reminding
  // someone to reorder something they sent back reads as not knowing they
  // returned it.
  if (row.status !== 'paid') {
    return { enqueued: false, reason: `order_status_${row.status}` }
  }
  const order = orderInvoiceSourceFromRow(row)
  if (order === undefined) {
    return { enqueued: false, reason: 'order_not_invoiceable' }
  }

  const target = customerTargetFor(order)
  if (target === null) {
    log.warn({ orderId }, 'no usable customer phone; replenishment reminder dropped')
    return { enqueued: false, reason: 'no_phone' }
  }

  // The largest line by quantity is the one worth naming — a 1L shampoo
  // reads better in "Your {{2}} is likely running low" than the lip balm
  // that shared the basket.
  const headline = headlineLine(order)
  const productLabel = headline ? await productLabelFor(db, headline.sku) : 'your last order'

  // REQUIRED: `laanya_refill_reminder` was approved WITH an image header,
  // so a send without one is 132000. Left undefined when unset, which makes
  // the failure legible in `last_error` rather than silent.
  const headerUrl = await getConfigValue<unknown>(db, 'notify.customerHeaderImageUrl')
  const header =
    typeof headerUrl === 'string' && headerUrl.trim() !== ''
      ? { link: headerUrl.trim() }
      : undefined

  // Consent is NOT checked here, on purpose. `sendOpsNotification` gates it
  // at send time, which is the only check that reflects an opt-out made
  // after this row was written.
  await enqueueOpsNotification(db, {
    kind: REPLENISHMENT_KIND,
    orderId,
    channel: WHATSAPP_CHANNEL,
    target,
    message: replenishmentParams({
      firstName: firstNameFromAddress(order.address),
      productLabel,
      header,
    }),
  })

  return { enqueued: true, reason: null }
}

/** Both keys of a template pair set and non-empty — the same rule `resolveTemplate` applies. */
async function templateConfigured(db: Db, nameKey: string, localeKey: string): Promise<boolean> {
  const [name, locale] = await Promise.all([
    getConfigValue<unknown>(db, nameKey),
    getConfigValue<unknown>(db, localeKey),
  ])
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    typeof locale === 'string' &&
    locale.trim() !== ''
  )
}

/**
 * The unpaid-order nudge.
 *
 * Every gate here is checked BEFORE the row is written, unlike the refill
 * reminder, because this message is only true for a short while. A row parked
 * as `skipped_unconfigured` (template not yet approved, consent not yet given)
 * would be delivered by the daily sweep whenever the gap closed — a day or a
 * month later, telling someone their cart is waiting for an order that
 * expired long ago. So: send now, or never.
 */
async function enqueuePaymentReminder(
  db: Db,
  orderId: string,
  log: FastifyBaseLogger
): Promise<FollowUpOutcome> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  if (row === undefined) {
    return { enqueued: false, reason: 'order_not_found' }
  }
  // Paid in the meantime, or already expired by `recover`.
  if (row.status !== 'pending') {
    return { enqueued: false, reason: `order_status_${row.status}` }
  }

  if (
    !(await templateConfigured(
      db,
      'notify.paymentReminderCustomerTemplate',
      'notify.paymentReminderCustomerLocale'
    ))
  ) {
    return { enqueued: false, reason: 'template_unconfigured' }
  }

  // MARKETING. `unknown` is a no here too, not a "later" — see the header.
  const consent = await marketingConsentForOrder(db, orderId)
  if (consent !== 'granted') {
    return { enqueued: false, reason: `consent_${consent}` }
  }

  // A newer order means they came back on their own — paid or not, that
  // order owns its own reminder, and two nudges for one basket is spam.
  const [newer] = await db
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(
      and(
        eq(payments.userId, row.userId),
        ne(payments.orderId, orderId),
        gt(payments.createdAt, row.createdAt)
      )
    )
    .limit(1)
  if (newer !== undefined) {
    return { enqueued: false, reason: 'superseded' }
  }

  // The button opens the cart. An empty one (cleared on another device) would
  // make the message a dead end.
  const [inCart] = await db
    .select({ sku: cartItems.sku })
    .from(cartItems)
    .where(eq(cartItems.userId, row.userId))
    .limit(1)
  if (inCart === undefined) {
    return { enqueued: false, reason: 'cart_empty' }
  }

  const address = row.addressSnapshot as Record<string, unknown>
  const target = toWhatsAppTarget(address.phone)
  if (target === null) {
    log.warn({ orderId }, 'no usable customer phone; payment reminder dropped')
    return { enqueued: false, reason: 'no_phone' }
  }

  const snapshot = row.cartSnapshot as CartSnapshot
  const headline = [...snapshot.items].sort((a, b) => b.qty - a.qty)[0]
  const productLabel = headline ? await productLabelFor(db, headline.sku) : 'your order'

  await enqueueOpsNotification(db, {
    kind: PAYMENT_REMINDER_CUSTOMER_KIND,
    orderId,
    channel: WHATSAPP_CHANNEL,
    target,
    message: paymentReminderParams(firstNameFromAddress(address), productLabel),
  })
  return { enqueued: true, reason: null }
}

/**
 * The post-delivery review ask.
 *
 * UTILITY, so no consent check, and the row may wait in the outbox for the
 * template to be approved without going stale the way the payment nudge
 * would — a delivered order is still delivered next week.
 */
async function enqueueReviewRequest(
  db: Db,
  orderId: string,
  log: FastifyBaseLogger
): Promise<FollowUpOutcome> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  if (row === undefined) {
    return { enqueued: false, reason: 'order_not_found' }
  }
  // Refunded since delivery: asking for a rating of something they returned
  // reads as not knowing.
  if (row.status !== 'paid') {
    return { enqueued: false, reason: `order_status_${row.status}` }
  }
  const order = orderInvoiceSourceFromRow(row)
  if (order === undefined) {
    return { enqueued: false, reason: 'order_not_invoiceable' }
  }

  const headline = headlineLine(order)
  if (headline === undefined) {
    return { enqueued: false, reason: 'no_lines' }
  }
  const [product] = await db
    .select({ productId: products.id, slug: products.slug, name: catalogItems.name })
    .from(catalogItems)
    .innerJoin(products, eq(products.id, catalogItems.productId))
    .where(eq(catalogItems.sku, headline.sku))
    .limit(1)
  if (product === undefined) {
    return { enqueued: false, reason: 'product_not_found' }
  }

  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.userId, order.userId), eq(reviews.productId, product.productId)))
    .limit(1)
  if (existing !== undefined) {
    return { enqueued: false, reason: 'already_reviewed' }
  }

  const target = customerTargetFor(order)
  if (target === null) {
    log.warn({ orderId }, 'no usable customer phone; review request dropped')
    return { enqueued: false, reason: 'no_phone' }
  }

  await enqueueOpsNotification(db, {
    kind: REVIEW_REQUEST_CUSTOMER_KIND,
    orderId,
    channel: WHATSAPP_CHANNEL,
    target,
    message: reviewRequestParams(firstNameFromAddress(order.address), product.name, product.slug),
  })
  return { enqueued: true, reason: null }
}
