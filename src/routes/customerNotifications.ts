/**
 * Customer-facing WhatsApp composition
 * (docs/kb/tasks/TASK-01-whatsapp-retention.md).
 *
 * Sits at the route layer beside `routes/opsNotifications.ts` and for the same
 * reason (ARCHITECTURE.md rule 2): it wires the payment/fulfilment transitions
 * to the outbox to the channel adapters, and cross-module composition lives
 * here rather than in any one of them.
 *
 * ## Why a separate file from the ops composition
 *
 * The recipient is different, and that difference is worth a file boundary.
 * Every enqueue in `opsNotifications.ts` fans out to `ops.notifyNumbers` — the
 * people who pack parcels, a fixed list, no consent question, and messages
 * carrying /admin deep links. Every enqueue here goes to ONE shopper, resolved
 * from the order, under templates Meta categorises separately and (for
 * marketing) gates on stored opt-in.
 *
 * They share the outbox deliberately — `ops_notifications` already has
 * claim-before-send, an attempt cap, the unique dedupe key and a Cloud Tasks
 * retry drain, and a second delivery mechanism would be a second set of those
 * bugs. What they do not share is composition.
 *
 * ## Everything here is silent until Meta approves
 *
 * Customer kinds are in `TEMPLATE_REQUIRED_KINDS`, so no unconfigured kind can
 * fall back to the ops template. Out-for-delivery is time sensitive: it is only
 * enqueued after its template pair is configured, avoiding a stale update when
 * Meta approves the template after the parcel has arrived.
 */

import type { FastifyBaseLogger } from 'fastify'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { catalogItems, payments } from '../db/schema.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import type { NotificationMessage } from '../lib/notify/types.js'
import type { TaskEnqueuer } from '../lib/tasks.js'
import {
  requestReplenishmentReminder,
  type FollowUpTaskEnqueuer,
  type ReplenishmentTaskEnqueuer,
} from '../lib/replenishmentTask.js'
import { getConfigValue } from '../services/config.js'
import { enqueueOpsNotification } from '../services/opsNotifications.js'
import {
  orderInvoiceSourceFromRow,
  type OrderInvoiceSource,
  type OrderPaidHook,
} from '../services/payments.js'
import {
  ORDER_CONFIRMED_CUSTOMER_KIND,
  ORDER_DELIVERED_CUSTOMER_KIND,
  ORDER_OUT_FOR_DELIVERY_CUSTOMER_KIND,
  REPLENISHMENT_KIND,
  sendPendingOpsNotifications,
  WHATSAPP_CHANNEL,
} from './opsNotifications.js'

/** Default gap between delivery and the reminder, overridable via `notify.replenishmentDelayDays`. */
export const DEFAULT_REPLENISHMENT_DELAY_DAYS = 60
/** Default gap between order creation and the unpaid-order nudge, via `notify.paymentReminderDelayMinutes`. */
export const DEFAULT_PAYMENT_REMINDER_DELAY_MINUTES = 45
/**
 * Upper bound on the nudge delay. `recover` fails an unpaid order after 24h
 * (`RECOVER_EXPIRE_AFTER_MS`), so a nudge scheduled past that would always find
 * the order gone; 12h keeps a typo in config from silently disabling it.
 */
const MAX_PAYMENT_REMINDER_DELAY_MINUTES = 12 * 60
/** Default gap between delivery and the review ask, via `notify.reviewRequestDelayDays`. */
export const DEFAULT_REVIEW_REQUEST_DELAY_DAYS = 4
/** Clamp so the ask is always one Cloud Tasks hop (`MAX_HORIZON_MS` is 29 days). */
const MAX_REVIEW_REQUEST_DELAY_DAYS = 28

/**
 * Normalise a stored phone to what the Graph API wants as `to`.
 *
 * `users.phone` and `addresses.phone` are both E.164 WITH the leading `+`
 * ("+919876543210"); `ops_notifications.target` is documented as E.164 WITHOUT
 * it, which is the form Meta accepts. Returns null rather than guessing when
 * the result is not a plausible msisdn — an enqueue against a malformed target
 * is a row that can only ever fail, five times, and then sit in the admin table
 * looking like a Meta problem.
 */
export function toWhatsAppTarget(phone: unknown): string | null {
  if (typeof phone !== 'string') return null
  const digits = phone.replace(/[^\d]/g, '')
  // 10 digits is a bare Indian mobile; anything shorter is not a phone number,
  // and E.164 caps at 15.
  if (digits.length < 10 || digits.length > 15) return null
  // A bare 10-digit number is stored without its country code by older rows.
  return digits.length === 10 ? `91${digits}` : digits
}

/**
 * The shopper's number for an order, from the FROZEN address snapshot.
 *
 * Deliberately the snapshot rather than `users.phone`: the snapshot is the
 * contact detail the shopper gave for THIS delivery, which is the one they
 * expect updates about — a shared household account ordering to a relative's
 * address is the ordinary case, not an edge one.
 */
export function customerTargetFor(order: OrderInvoiceSource): string | null {
  return toWhatsAppTarget(order.address.phone)
}

function customerFirstName(order: OrderInvoiceSource): string {
  return firstNameFromAddress(order.address)
}

/**
 * First name from a frozen address snapshot. Separate from
 * {@link customerFirstName} because the unpaid-order nudge has no
 * `OrderInvoiceSource` — that projection exists only for paid orders.
 */
export function firstNameFromAddress(address: Record<string, unknown>): string {
  const name = address.fullName ?? address.name
  if (typeof name !== 'string' || name.trim() === '') return 'there'
  // First name only. The templates open "Hi {{1}}," and a full legal name with
  // honorifics reads like a bank letter, not a shop.
  return (name.trim().split(/\s+/)[0] ?? 'there').slice(0, 40)
}

/**
 * Squeeze a value into something a WhatsApp template variable will accept.
 *
 * Same rule and same reason as the ops composition's `oneLine`: Meta rejects a
 * parameter containing a newline, a tab, or 4+ consecutive spaces with 132000,
 * and the adapter deliberately does not sanitise. Duplicated rather than
 * shared because the two files are otherwise independent and this is four
 * lines — a shared helper here would be the only coupling between them.
 */
function oneLine(value: string, max = 120): string {
  const flattened = value.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened
}

/** A human item summary for the `*Items:*` line — "2 items" or the single SKU's name. */
function itemSummary(order: OrderInvoiceSource): string {
  const count = order.lines.reduce((sum, line) => sum + line.qty, 0)
  return `${count} item${count === 1 ? '' : 's'}`
}

/**
 * The image header every customer template carries, from config.
 *
 * One configured URL rather than a per-order product shot, on purpose for v1:
 * a template approved with a header REQUIRES one on every send, so a per-order
 * lookup that came back empty would fail the send outright (132000). A brand
 * image that is always present cannot do that. Per-SKU headers are a later
 * change, and want a fallback to exactly this value.
 *
 * Returns undefined when unset — which produces a body-only send, correct for a
 * template approved without a header.
 */
async function headerImage(db: Db): Promise<{ link: string } | undefined> {
  const url = await getConfigValue<unknown>(db, 'notify.customerHeaderImageUrl')
  return typeof url === 'string' && url.trim() !== '' ? { link: url.trim() } : undefined
}

/**
 * Build the `order_confirmed_customer` params:
 * `Hi {{1}}, your order *{{2}}* is confirmed. / Items: {{3}} / Total: ₹{{4}} /
 * Arriving by: {{5}}`.
 *
 * `{{5}}` is deliberately vague ("in 3–5 days") rather than a date. A promised
 * date we then miss is worse than no date, and the ETA at confirmation time
 * predates the AWB — the shipped message carries the real one.
 *
 * `{{4}}` is where this hook fires on a COD order too — `onOrderPaid` runs the
 * moment the ₹49 token clears, which for COD is nowhere near the whole total.
 * The template's surrounding text is fixed and already reads "Total: ₹{{4}}",
 * and carries the plain order total (every order is prepaid).
 */
function orderConfirmedParams(
  order: OrderInvoiceSource,
  etaCopy: string,
  header: { link: string } | undefined
): NotificationMessage {
  const totalParam = String(order.totalInr)
  return {
    params: [
      oneLine(customerFirstName(order)),
      order.orderId,
      oneLine(itemSummary(order)),
      totalParam,
      oneLine(etaCopy),
    ],
    ...(header ? { header } : {}),
    // The URL button is approved with a static prefix plus one variable, so
    // only the suffix travels — see `NotificationUrlButton`.
    buttons: [{ index: 0, suffix: `account/orders/${encodeURIComponent(order.orderId)}` }],
  }
}

/**
 * Build the `tinytales_order_delivered` params — the APPROVED shape, verified
 * against Meta on 2026-08-31:
 *
 *   BODY    `Hi {{1}}, / Your Tiny Tales order containing {{2}} has been
 *            delivered! 📦 / …`      → exactly TWO params
 *   HEADER  none
 *   BUTTON  static URL `https://www.tinytalesforus.com/` — NO variable
 *
 * All three facts are load-bearing and none of them are what TASK-01 drafted.
 * Sending a header to a template approved without one is 132000; so is sending
 * a button parameter to a button whose URL carries no `{{1}}`. This function
 * therefore emits neither, and must keep emitting neither unless the template
 * is re-approved with them.
 */
function orderDeliveredParams(firstName: string, productLabel: string): NotificationMessage {
  return { params: [oneLine(firstName), oneLine(productLabel, 60)] }
}

/** The submitted out-for-delivery template has two body params and a static URL button. */
function orderOutForDeliveryParams(firstName: string, orderId: string): NotificationMessage {
  return { params: [oneLine(firstName), oneLine(orderId)] }
}

/**
 * Build the `tinytales_payment_reminder` params — the shape to SUBMIT to Meta:
 *
 *   BODY    `Hi {{1}}, your {{2}} is still in your cart and the order is not
 *            placed yet. …`   → exactly TWO params
 *   HEADER  none
 *   BUTTON  static URL `https://www.tinytalesforus.com/cart/` — NO variable
 *
 * The button goes to the cart, not to the abandoned order: there is no
 * "resume this order" route, and the cart is server-side per user, so it still
 * holds what they picked. Checkout from there creates a fresh order.
 */
export function paymentReminderParams(
  firstName: string,
  productLabel: string
): NotificationMessage {
  return { params: [oneLine(firstName), oneLine(productLabel, 60)] }
}

/**
 * Build the `tinytales_review_request` params — the shape to SUBMIT to Meta:
 *
 *   BODY    `Hi {{1}}, how are you finding your {{2}}? …` → exactly TWO params
 *   HEADER  none
 *   BUTTON  URL `https://www.tinytalesforus.com/{{1}}` — ONE variable, the suffix
 *
 * The suffix lands on the PDP with `?review=1`, which opens the rate dialog
 * (after sign-in if needed). Deep-linking to the product rather than the order
 * is what makes the review attach to the right product.
 */
export function reviewRequestParams(
  firstName: string,
  productLabel: string,
  productSlug: string
): NotificationMessage {
  return {
    params: [oneLine(firstName), oneLine(productLabel, 60)],
    buttons: [{ index: 0, suffix: `products/${encodeURIComponent(productSlug)}/?review=1` }],
  }
}

/**
 * Build the `tinytales_refill_reminder` params — the APPROVED shape, verified
 * against Meta on 2026-08-31:
 *
 *   BODY    `Hi {{1}}, time for a quick refill! 🧴 / Your {{2}} is likely
 *            running low. …`          → exactly TWO params
 *   HEADER  IMAGE — REQUIRED, since the template was approved with one
 *   BUTTON  static URL `https://tinytalesforus.com/` — NO variable
 *
 * Note there is no "days since order" variable: the approved copy says only
 * "likely running low". `notify.replenishmentDelayDays` still governs WHEN this
 * fires, it simply no longer appears in the text.
 *
 * The body also commits to a live offer — *10% OFF + Free Express Shipping*,
 * code `REFILL10`. Nothing in this codebase creates or validates that coupon;
 * if it does not exist in `coupons`, every shopper who follows this message
 * hits a rejected code.
 *
 * MARKETING. Consent is not checked here — the gate is at send time in
 * `sendOpsNotification`, because consent can be withdrawn between this enqueue
 * and the send sixty days later, and only the later check sees that.
 */
export function replenishmentParams(input: {
  firstName: string
  productLabel: string
  header: { link: string } | undefined
}): NotificationMessage {
  return {
    params: [oneLine(input.firstName), oneLine(input.productLabel, 60)],
    ...(input.header ? { header: input.header } : {}),
  }
}

/**
 * `onOrderPaid` hook — tell the shopper their order is confirmed.
 *
 * Runs inside the paid transition's transaction, exactly like
 * `makeOpsNotificationHook`, so the row rolls back with the money and a replay
 * of verify/webhook/recover is absorbed by the dedupe key.
 *
 * Swallows everything, for the reason every paid-order hook does: the payment
 * has captured by the time this runs, and throwing would roll back a completed
 * charge to protect a WhatsApp message.
 */
export function makeCustomerOrderConfirmedHook(opts: { log: FastifyBaseLogger }): OrderPaidHook {
  return async (tx, orderId, _lines, order) => {
    try {
      const target = customerTargetFor(order)
      if (target === null) {
        opts.log.warn({ orderId }, 'order has no usable customer phone; confirmation not enqueued')
        return
      }
      const db = tx as unknown as Db
      const etaCopy = (await getConfigValue<string>(db, 'notify.customerEtaCopy')) ?? 'in 3–5 days'
      await enqueueOpsNotification(tx, {
        kind: ORDER_CONFIRMED_CUSTOMER_KIND,
        orderId,
        channel: WHATSAPP_CHANNEL,
        target,
        message: orderConfirmedParams(order, etaCopy, await headerImage(db)),
      })
    } catch (err) {
      opts.log.error(
        { err, orderId },
        'customer order-confirmed enqueue failed; payment stands, shopper not notified'
      )
    }
  }
}

/**
 * The catalog NAME for a sku — what the approved templates actually render.
 *
 * Both customer templates interpolate a product ("Your {{2}} is likely running
 * low"), and their approved examples use full names like "Daniya Multi-Purpose
 * Body Cream". A raw sku there reads like a database leak to the shopper.
 *
 * Falls back to the sku rather than failing: a name that has since been removed
 * from the catalog is not a reason to withhold a delivery notification.
 */
export async function productLabelFor(db: Db, sku: string): Promise<string> {
  const [row] = await db
    .select({ name: catalogItems.name })
    .from(catalogItems)
    .where(eq(catalogItems.sku, sku))
    .limit(1)
  return row?.name ?? sku
}

/** The line worth naming in a one-product message — the largest by quantity. */
export function headlineLine(order: OrderInvoiceSource): { sku: string; qty: number } | undefined {
  return [...order.lines].sort((a, b) => b.qty - a.qty)[0]
}

/**
 * Enqueue the "your order has been delivered" message.
 *
 * Called post-commit from the carrier webhook once a scan moves the shipment to
 * `delivered`. Runs OUTSIDE a transaction, against `db` — the scan has already
 * committed — and relies on the outbox's unique dedupe key to absorb the
 * repeated delivery scans Delhivery is entitled to send.
 */
export async function enqueueCustomerDeliveredNotification(
  db: Db,
  order: OrderInvoiceSource,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const target = customerTargetFor(order)
    if (target === null) {
      log.warn({ orderId: order.orderId }, 'no usable customer phone; delivered msg skipped')
      return
    }
    const headline = headlineLine(order)
    const productLabel = headline ? await productLabelFor(db, headline.sku) : 'your order'
    await enqueueOpsNotification(db, {
      kind: ORDER_DELIVERED_CUSTOMER_KIND,
      orderId: order.orderId,
      channel: WHATSAPP_CHANNEL,
      target,
      message: orderDeliveredParams(customerFirstName(order), productLabel),
    })
  } catch (err) {
    log.error({ err, orderId: order.orderId }, 'customer delivered enqueue failed')
  }
}

/** Enqueue once per order when the carrier reports that the parcel is out for delivery. */
export async function enqueueCustomerOutForDeliveryNotification(
  db: Db,
  order: OrderInvoiceSource,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const [template, locale] = await Promise.all([
      getConfigValue<unknown>(db, 'notify.orderOutForDeliveryCustomerTemplate'),
      getConfigValue<unknown>(db, 'notify.orderOutForDeliveryCustomerLocale'),
    ])
    if (
      typeof template !== 'string' ||
      template.trim() === '' ||
      typeof locale !== 'string' ||
      locale.trim() === ''
    )
      return

    const target = customerTargetFor(order)
    if (target === null) {
      log.warn({ orderId: order.orderId }, 'no usable customer phone; out-for-delivery msg skipped')
      return
    }
    await enqueueOpsNotification(db, {
      kind: ORDER_OUT_FOR_DELIVERY_CUSTOMER_KIND,
      orderId: order.orderId,
      channel: WHATSAPP_CHANNEL,
      target,
      message: orderOutForDeliveryParams(customerFirstName(order), order.orderId),
    })
  } catch (err) {
    log.error({ err, orderId: order.orderId }, 'customer out-for-delivery enqueue failed')
  }
}

/**
 * Schedule the replenishment reminder, at delivery.
 *
 * Enqueues a DELAYED Cloud Task rather than writing an outbox row: an
 * `ops_notifications` row is sendable the moment it exists, and there is no
 * "not before" column to hold one for sixty days. The row is written when the
 * task fires — see `routes/internalReplenishment.ts`.
 *
 * Consent is NOT checked here. A shopper who has not opted in today may well
 * have by the time the reminder is due, and refusing to schedule would make
 * that impossible; a shopper who opts out is caught by the send-time gate,
 * which is the check that is actually current.
 */
export async function scheduleReplenishmentReminder(
  db: Db,
  orderId: string,
  deliveredAt: Date,
  tasks: ReplenishmentTaskEnqueuer,
  log: FastifyBaseLogger
): Promise<void> {
  const configured = await getConfigValue<unknown>(db, 'notify.replenishmentDelayDays')
  const days =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_REPLENISHMENT_DELAY_DAYS
  const dueAt = new Date(deliveredAt.getTime() + days * 24 * 60 * 60 * 1000)
  requestReplenishmentReminder(tasks, { orderId, dueAt: dueAt.toISOString() }, log)
}

/** A positive finite number from config, clamped to `max`, else `fallback`. */
async function delayFromConfig(
  db: Db,
  key: string,
  fallback: number,
  max: number
): Promise<number> {
  const configured = await getConfigValue<unknown>(db, key)
  const value =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : fallback
  return Math.min(value, max)
}

/**
 * Schedule the unpaid-order nudge, at order creation.
 *
 * Every order starts `pending`, so this is scheduled unconditionally; the task
 * handler decides on arrival whether the order is still unpaid and whether a
 * nudge is allowed (template, consent, cart, no newer order). Deciding late is
 * the point: a shopper who pays two minutes after creating the order must not
 * be nudged, and only the later check sees that.
 *
 * Never throws — the order has been created and the shopper is mid-checkout.
 */
export async function schedulePaymentReminder(
  db: Db,
  orderId: string,
  createdAt: Date,
  tasks: FollowUpTaskEnqueuer,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const minutes = await delayFromConfig(
      db,
      'notify.paymentReminderDelayMinutes',
      DEFAULT_PAYMENT_REMINDER_DELAY_MINUTES,
      MAX_PAYMENT_REMINDER_DELAY_MINUTES
    )
    const dueAt = new Date(createdAt.getTime() + minutes * 60 * 1000)
    requestReplenishmentReminder(
      tasks,
      { orderId, dueAt: dueAt.toISOString(), kind: 'payment_reminder' },
      log
    )
  } catch (err) {
    log.error({ err, orderId }, 'payment reminder scheduling failed; order stands')
  }
}

/**
 * Schedule the review ask, at delivery.
 *
 * A few days rather than at the doorstep: a cream judged on the day it arrives
 * gets a rating for the packaging. Same posture as the refill reminder — the
 * handler re-checks the order on arrival, so a refund in between cancels it.
 */
export async function scheduleReviewRequest(
  db: Db,
  orderId: string,
  deliveredAt: Date,
  tasks: FollowUpTaskEnqueuer,
  log: FastifyBaseLogger
): Promise<void> {
  const days = await delayFromConfig(
    db,
    'notify.reviewRequestDelayDays',
    DEFAULT_REVIEW_REQUEST_DELAY_DAYS,
    MAX_REVIEW_REQUEST_DELAY_DAYS
  )
  const dueAt = new Date(deliveredAt.getTime() + days * 24 * 60 * 60 * 1000)
  requestReplenishmentReminder(
    tasks,
    { orderId, dueAt: dueAt.toISOString(), kind: 'review_request' },
    log
  )
}

/**
 * React to a shipment milestone.
 *
 * Out-for-delivery and delivered each have their own customer template.
 * Earlier transit scans are ignored because neither template describes them.
 *
 * Called post-commit from the carrier webhook, never awaited into the carrier's
 * response. Both effects are idempotent under the repeat delivery scans
 * Delhivery is entitled to send — the message via the outbox's unique dedupe
 * key, the reminder via the Cloud Tasks task name.
 */
export async function reactToShipmentMilestone(
  db: Db,
  input: {
    orderId: string
    status: string | null
    awb: string | null
    courierCode: string | null
    log: FastifyBaseLogger
    replenishmentTasks?: ReplenishmentTaskEnqueuer | undefined
    /**
     * Present ⇒ the message is sent now, while it is still true. Absent ⇒ it
     * waits for the daily outbox sweep — fine for "delivered", useless for
     * "out for delivery", which is stale by the evening it arrives.
     */
    channels?: NotificationChannelRegistry | undefined
    /** Debounced retry drain when the immediate send fails; see `sendPendingOpsNotifications`. */
    tasks?: TaskEnqueuer | undefined
  }
): Promise<void> {
  const { orderId, status, log } = input
  if (status !== 'out_for_delivery' && status !== 'delivered') return

  const order = await loadPaidOrder(db, orderId)
  if (order === undefined) return

  if (status === 'out_for_delivery') {
    await enqueueCustomerOutForDeliveryNotification(db, order, log)
    sendNow(db, orderId, input)
    return
  }

  await enqueueCustomerDeliveredNotification(db, order, log)
  sendNow(db, orderId, input)

  if (input.replenishmentTasks !== undefined) {
    // Scheduled off "now" rather than the scan's own timestamp: a scan can
    // arrive late, and a reminder is a marketing beat, not a legal record. The
    // few hours of drift are irrelevant against a 60-day gap, and using the
    // arrival time keeps the due date from ever landing in the past.
    await scheduleReplenishmentReminder(db, orderId, new Date(), input.replenishmentTasks, log)
    await scheduleReviewRequest(db, orderId, new Date(), input.replenishmentTasks, log)
  }
}

/**
 * Drain this order's owed rows immediately when the caller has channels. The
 * outbox dedupe key already absorbed repeat scans, so a repeat finds nothing
 * owed and sends nothing.
 */
function sendNow(
  db: Db,
  orderId: string,
  input: {
    log: FastifyBaseLogger
    channels?: NotificationChannelRegistry | undefined
    tasks?: TaskEnqueuer | undefined
  }
): void {
  if (input.channels === undefined) return
  sendPendingOpsNotifications(db, orderId, input.channels, input.log, input.tasks)
}

/** The paid order behind an id, or undefined if it is not (or no longer) paid. */
async function loadPaidOrder(db: Db, orderId: string): Promise<OrderInvoiceSource | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  if (row === undefined || row.status !== 'paid') return undefined
  return orderInvoiceSourceFromRow(row)
}

export { REPLENISHMENT_KIND }
