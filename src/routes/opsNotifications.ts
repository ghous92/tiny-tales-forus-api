/**
 * Ops notification composition (docs/SPEC-MANUAL-FULFILMENT.md §4A). Lives at
 * the ROUTE layer, not in `services/opsNotifications.ts` or
 * `services/payments.ts`, because it wires THREE modules together —
 * `services/payments.ts`'s `OrderPaidHook`, `services/opsNotifications.ts`'s
 * outbox, and `lib/notify/*`'s channel adapters — and ARCHITECTURE.md rule 2
 * puts exactly that kind of cross-module composition here, the same place
 * `makeInvoiceIssuanceHook` / `sendCapturedInvoiceEmails` live in
 * `routes/invoices.ts`.
 */

import type { FastifyBaseLogger } from 'fastify'

import type { Db } from '../db/client.js'
import type { OpsNotificationRow } from '../db/schema.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import { resolveChannel } from '../lib/notify/registry.js'
import type { NotificationMessage, NotificationTemplate } from '../lib/notify/types.js'
import { requestSweep, type TaskEnqueuer } from '../lib/tasks.js'
import { getConfigValue } from '../services/config.js'
import { marketingConsentForOrder } from '../services/marketingConsent.js'
import {
  claimOpsNotification,
  enqueueOpsNotification,
  listPendingOpsNotificationsForOrder,
  recordOpsNotificationAttempt,
  MAX_OPS_NOTIFICATION_ATTEMPTS,
  OPS_NOTIFICATION_SENDABLE_STATUSES,
} from '../services/opsNotifications.js'
import type {
  OrderInvoiceSource,
  OrderPaidHook,
  OrderRefundHook,
  PaidTransition,
} from '../services/payments.js'

const ORDER_PAID_KIND = 'order_paid'
/** A refunded order — both the shopper's self-cancel and Razorpay's `refund.processed`. */
export const ORDER_CANCELLED_KIND = 'order_cancelled'
/** A refunded order whose parcel is still live because the carrier would not recall it. */
export const SHIPMENT_CANCEL_FAILED_KIND = 'shipment_cancel_failed'

// ── Customer-facing kinds ──────────────────────────────────────────────────
//
// Every kind above this line targets `ops.notifyNumbers` — the people who pack
// parcels. Every kind below targets the SHOPPER, and that difference is the
// reason `TEMPLATE_REQUIRED_KINDS` is not optional for them: the adapter's
// boot-time fallback template is `order_paid_ops`, whose approved body opens
// "New paid order …" and carries an /admin deep link. Delivering that to a
// customer would leak an ops surface to the person who bought the soap.

/** Order confirmed, to the shopper. UTILITY — transactional, no opt-in needed. */
export const ORDER_CONFIRMED_CUSTOMER_KIND = 'order_confirmed_customer'
/**
 * Parcel delivered, to the shopper. UTILITY — tied to an order they placed.
 *
 * DELIVERED, not shipped. The approved template (`laanya_order_delivered`) is
 * written around the parcel having arrived and links a usage guide; there is no
 * approved dispatch template, and repurposing this one for pickup would tell a
 * shopper their order had arrived while it sat on a van.
 */
export const ORDER_DELIVERED_CUSTOMER_KIND = 'order_delivered_customer'
/** Parcel on the last delivery leg, to the shopper. UTILITY. */
export const ORDER_OUT_FOR_DELIVERY_CUSTOMER_KIND = 'order_out_for_delivery_customer'
/**
 * "Running low?", to the shopper, ~60 days after delivery. MARKETING — needs
 * stored opt-in under DPDP and Meta policy, enforced at send time by
 * `routes/customerNotifications.ts`, not here.
 */
export const REPLENISHMENT_KIND = 'replenishment_reminder'
/**
 * "Your order is not placed yet", to a shopper who created an order and left
 * before paying (the ₹49 COD token or the prepaid amount). MARKETING — Meta
 * treats an unfinished-checkout reminder as promotional, so it needs stored
 * opt-in like the refill reminder.
 */
export const PAYMENT_REMINDER_CUSTOMER_KIND = 'payment_reminder_customer'
/**
 * "How is your {{product}}?", to the shopper a few days after delivery, deep
 * linking to the PDP's rate dialog. UTILITY — it is about one specific order
 * they received and carries no offer. If Meta re-categorises the template as
 * MARKETING on review, add this kind to `MARKETING_KINDS` so the send path
 * starts checking consent for it.
 */
export const REVIEW_REQUEST_CUSTOMER_KIND = 'review_request_customer'

/**
 * Kinds Meta categorises as MARKETING, which may only go to a shopper with a
 * stored opt-in. Everything absent from this set is UTILITY and sends on the
 * strength of the order itself.
 *
 * A set rather than a boolean on each kind because the question "is this
 * marketing" is asked exactly once, in the send path, and answering it in one
 * place keeps a future kind from being added without anyone deciding.
 */
const MARKETING_KINDS: ReadonlySet<string> = new Set([
  REPLENISHMENT_KIND,
  PAYMENT_REMINDER_CUSTOMER_KIND,
])

export const WHATSAPP_CHANNEL = 'whatsapp_cloud'

/**
 * Config keys holding the approved template for each notification kind.
 *
 * Template identity is config rather than env because it is the part most
 * likely to be WRONG and most urgent to correct: Meta matches the name and the
 * language code exactly, and a mismatch on either fails every send (132001)
 * without any of the credentials being at fault. As env it takes a build and
 * two pipeline runs to fix; as config it takes one admin edit, and the retry
 * sweep then drains the rows that already failed.
 */
const TEMPLATE_CONFIG_KEYS: Record<string, { name: string; locale: string }> = {
  [ORDER_PAID_KIND]: { name: 'notify.orderPaidTemplate', locale: 'notify.orderPaidLocale' },
  [ORDER_CANCELLED_KIND]: {
    name: 'notify.orderCancelledTemplate',
    locale: 'notify.orderCancelledLocale',
  },
  [SHIPMENT_CANCEL_FAILED_KIND]: {
    name: 'notify.shipmentCancelFailedTemplate',
    locale: 'notify.shipmentCancelFailedLocale',
  },
  [ORDER_CONFIRMED_CUSTOMER_KIND]: {
    name: 'notify.orderConfirmedCustomerTemplate',
    locale: 'notify.orderConfirmedCustomerLocale',
  },
  [ORDER_DELIVERED_CUSTOMER_KIND]: {
    name: 'notify.orderDeliveredCustomerTemplate',
    locale: 'notify.orderDeliveredCustomerLocale',
  },
  [ORDER_OUT_FOR_DELIVERY_CUSTOMER_KIND]: {
    name: 'notify.orderOutForDeliveryCustomerTemplate',
    locale: 'notify.orderOutForDeliveryCustomerLocale',
  },
  [REPLENISHMENT_KIND]: {
    name: 'notify.replenishmentTemplate',
    locale: 'notify.replenishmentLocale',
  },
  [PAYMENT_REMINDER_CUSTOMER_KIND]: {
    name: 'notify.paymentReminderCustomerTemplate',
    locale: 'notify.paymentReminderCustomerLocale',
  },
  [REVIEW_REQUEST_CUSTOMER_KIND]: {
    name: 'notify.reviewRequestCustomerTemplate',
    locale: 'notify.reviewRequestCustomerLocale',
  },
}

/**
 * Kinds that MUST have their template configured before anything is sent.
 *
 * `order_paid` predates this and may fall through to the adapter's boot-time
 * `WHATSAPP_TEMPLATE_ORDER_PAID`, because that env var was chosen for it. Every
 * kind added since must not: the fallback is a SPECIFIC approved template whose
 * body reads "New paid order {{1}} …", so letting a cancellation fall back to
 * it would render refund params into a purchase announcement and tell ops the
 * exact opposite of what happened. Silence is recoverable; a confidently wrong
 * WhatsApp message to the person who packs parcels is not.
 *
 * Unconfigured therefore resolves to `skipped_unconfigured`, which costs no
 * attempt — so the backlog delivers itself once Meta approves the template and
 * an admin sets the keys, exactly as it already does for missing credentials.
 *
 * For CUSTOMER kinds the same rule is not a nicety but the thing
 * standing between a shopper and an ops message: the fallback body announces a
 * new paid order to the packing team and deep-links into /admin. Membership
 * here is what makes an unconfigured customer template silent instead of
 * wrong — and silence is exactly right while Meta approval is pending, which
 * it is for all three (docs/kb/tasks/TASK-01-whatsapp-retention.md).
 */
const TEMPLATE_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  ORDER_CANCELLED_KIND,
  SHIPMENT_CANCEL_FAILED_KIND,
  ORDER_CONFIRMED_CUSTOMER_KIND,
  ORDER_DELIVERED_CUSTOMER_KIND,
  ORDER_OUT_FOR_DELIVERY_CUSTOMER_KIND,
  REPLENISHMENT_KIND,
  PAYMENT_REMINDER_CUSTOMER_KIND,
  REVIEW_REQUEST_CUSTOMER_KIND,
])

/**
 * What template (if any) a row should render with.
 *
 * `default` means "leave the adapter's own template in place"; `unconfigured`
 * means the kind requires an explicitly configured template and does not have
 * one, so nothing may be sent — see {@link TEMPLATE_REQUIRED_KINDS}.
 */
type TemplateResolution =
  | { kind: 'override'; template: NotificationTemplate }
  | { kind: 'default' }
  | { kind: 'unconfigured' }

/**
 * Resolve the template for one row's `kind`.
 *
 * Both keys must be present and non-empty to count. A half-set pair (name
 * swapped, locale forgotten) would otherwise pair a new template with the old
 * language code, which is a 132001 that looks like the swap simply did not
 * work — worse than not overriding at all.
 */
async function resolveTemplate(db: Db, kind: string): Promise<TemplateResolution> {
  const keys = TEMPLATE_CONFIG_KEYS[kind]
  const unset: TemplateResolution = TEMPLATE_REQUIRED_KINDS.has(kind)
    ? { kind: 'unconfigured' }
    : { kind: 'default' }
  if (keys === undefined) return unset
  const [name, locale] = await Promise.all([
    getConfigValue<unknown>(db, keys.name),
    getConfigValue<unknown>(db, keys.locale),
  ])
  if (typeof name !== 'string' || name.trim() === '') return unset
  if (typeof locale !== 'string' || locale.trim() === '') return unset
  return { kind: 'override', template: { name: name.trim(), locale: locale.trim() } }
}

/**
 * Squeeze a value into something a WhatsApp template variable will accept.
 *
 * Meta rejects a parameter containing a newline, a tab, or 4+ consecutive
 * spaces with error 132000, and `lib/notify/whatsappCloud.ts` deliberately does
 * not sanitise — it takes the caller's word. Cancel reasons are the first param
 * in this file sourced from free text a shopper can influence, so the
 * normalisation has to happen somewhere, and here is the layer that knows the
 * value is destined for a template.
 */
function oneLine(value: string, max = 120): string {
  const flattened = value.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened
}

/**
 * The msisdns ops notifications fan out to (`ops.notifyNumbers`). An empty or
 * malformed list means nobody is configured, which is a supported state — the
 * caller simply enqueues nothing.
 *
 * Takes a `Db`-shaped runner so the in-transaction hooks can pass their `tx`:
 * this is an indexed SELECT on the connection the transaction already holds,
 * not a network call.
 */
async function notifyTargets(db: Db): Promise<string[]> {
  const numbers = await getConfigValue<unknown>(db, 'ops.notifyNumbers')
  return Array.isArray(numbers)
    ? numbers.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : []
}

function customerNameFrom(address: Record<string, unknown>): string {
  const name = address.fullName ?? address.name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'Customer'
}

function cityFrom(address: Record<string, unknown>): string {
  return typeof address.city === 'string' ? address.city : ''
}

/** `https://laanya.shop` + `/admin/orders/<orderId>` — the `{{6}}` deep link (SPEC §3). No trailing slash assumed on the input. */
function adminOrderLink(adminOrigin: string, orderId: string): string {
  return `${adminOrigin.replace(/\/+$/, '')}/admin/orders/${encodeURIComponent(orderId)}`
}

/**
 * Build the frozen template params for the proposed `order_paid_ops` template
 * (SPEC §3): `New paid order {{1}} / Customer: {{2}} · {{3}} / Items: {{4}} ·
 * Total: ₹{{5}} / Open: {{6}}`.
 *
 * Built from ONLY `order` (the row the paid transition just wrote) — no
 * catalog lookup, no extra query beyond what the hook already does, and
 * deliberately no street address or phone number in the message body (SPEC
 * §3/§6: a WhatsApp message gets forwarded, and the full address belongs
 * behind an authenticated screen).
 */
function orderPaidParams(order: OrderInvoiceSource, adminOrigin: string): NotificationMessage {
  const address = order.address
  const itemCount = order.lines.reduce((sum, line) => sum + line.qty, 0)
  return {
    params: [
      order.orderId,
      customerNameFrom(address),
      cityFrom(address),
      `${itemCount} item${itemCount === 1 ? '' : 's'}`,
      String(order.totalInr),
      adminOrderLink(adminOrigin, order.orderId),
    ],
  }
}

/**
 * The `onOrderPaid` hook that enqueues the ops fan-out. Composed into
 * `onOrderPaid` alongside the stock/shipment/invoice hooks in
 * `routes/payments.ts`, and runs inside the SAME transaction — so it fires
 * exactly once however many times verify/webhook/recover race (the unique
 * dedupe key on the table is the actual guarantee; this hook just has to not
 * skip the insert).
 *
 * Reads `ops.notifyNumbers` from config — an indexed SELECT on the connection
 * the transaction already holds, not a network call, the same way
 * `makeShipmentIntentHook` reads `payments.shippingSnapshot` inside its own
 * transaction. **No HTTP call happens here** — the WhatsApp send is entirely
 * post-commit (`sendPendingOpsNotifications`) or from the retry sweep.
 *
 * Swallows everything, the same trade every other paid-order hook makes: by
 * the time this runs the money is captured, and a missed notification is
 * recoverable (an operator can still find the order in the invoice register),
 * while a rolled-back payment is not.
 */
export function makeOpsNotificationHook(opts: {
  adminOrigin: string
  log: FastifyBaseLogger
}): OrderPaidHook {
  return async (tx, orderId, _lines, order) => {
    try {
      const targets = await notifyTargets(tx as unknown as Db)
      if (targets.length === 0) return

      const message = orderPaidParams(order, opts.adminOrigin)
      for (const target of targets) {
        await enqueueOpsNotification(tx, {
          kind: ORDER_PAID_KIND,
          orderId,
          channel: WHATSAPP_CHANNEL,
          target,
          message,
        })
      }
    } catch (err) {
      opts.log.error(
        { err, orderId },
        'ops notification enqueue failed after capture; payment stands, order needs manual ops follow-up'
      )
    }
  }
}

/**
 * Build the frozen template params for the `order_cancelled_ops` template:
 * `Order {{1}} cancelled / Customer: {{2}} · {{3}} / Refunded: ₹{{4}} /
 * Reason: {{5}} / Open: {{6}}`.
 *
 * Same discipline as {@link orderPaidParams}: built from only the order the
 * transition wrote, and no street address or phone number in the body (SPEC
 * §3/§6 — a WhatsApp message gets forwarded).
 */
function orderCancelledParams(
  order: OrderInvoiceSource,
  reason: string,
  adminOrigin: string
): NotificationMessage {
  const address = order.address
  return {
    params: [
      order.orderId,
      oneLine(customerNameFrom(address)),
      oneLine(cityFrom(address)),
      String(order.totalInr),
      oneLine(reason),
      adminOrderLink(adminOrigin, order.orderId),
    ],
  }
}

/**
 * The `onOrderRefunded` hook that tells ops an order was cancelled.
 *
 * Wired to the REFUND transition rather than to the cancel route, so it covers
 * both ways an order reaches `refunded`: the shopper's own cancel, and
 * Razorpay's `refund.processed` webhook for a refund issued from their
 * dashboard. Runs inside the transition's transaction — same contract as
 * {@link makeOpsNotificationHook} — so the row rolls back with the transition
 * and the dedupe key makes a replay a no-op.
 *
 * Swallows everything: by the time it runs the money is already back with the
 * shopper, so an exception here would roll back a refund that cannot be undone
 * upstream, to protect a notification.
 */
export function makeOrderCancelledNotificationHook(opts: {
  adminOrigin: string
  log: FastifyBaseLogger
}): OrderRefundHook {
  return async (tx, orderId, order, reason) => {
    try {
      const targets = await notifyTargets(tx as unknown as Db)
      if (targets.length === 0) return

      const message = orderCancelledParams(order, reason, opts.adminOrigin)
      for (const target of targets) {
        await enqueueOpsNotification(tx, {
          kind: ORDER_CANCELLED_KIND,
          orderId,
          channel: WHATSAPP_CHANNEL,
          target,
          message,
        })
      }
    } catch (err) {
      opts.log.error(
        { err, orderId },
        'cancelled-order notification enqueue failed; refund stands, ops not told'
      )
    }
  }
}

/** One shipment the carrier would not recall, as the alert needs to describe it. */
export interface UnresolvedShipment {
  awb: string | null
  remark: string | null
}

/**
 * Enqueue the "we refunded but the parcel is still live" alert.
 *
 * Unlike every other enqueue in this file this one runs OUTSIDE a transaction,
 * against `db` — the fact it reports is only known after the refund has
 * committed and the carrier has answered, so there is no transaction left to
 * join. The dedupe key still makes a retried cancel request a no-op.
 *
 * One row per order rather than per shipment, because the dedupe key is keyed
 * on the order: an order with two stuck parcels is one situation for one person
 * to deal with, and two near-identical WhatsApp messages would not help them.
 */
export async function enqueueShipmentCancelFailedNotification(
  db: Db,
  input: { orderId: string; unresolved: readonly UnresolvedShipment[]; adminOrigin: string }
): Promise<void> {
  const targets = await notifyTargets(db)
  if (targets.length === 0 || input.unresolved.length === 0) return

  const awbs = input.unresolved.map((s) => s.awb ?? 'no AWB').join(', ')
  const remark = input.unresolved.find((s) => s.remark !== null)?.remark ?? 'Carrier refused'
  const message: NotificationMessage = {
    params: [
      input.orderId,
      oneLine(awbs, 60),
      oneLine(remark),
      adminOrderLink(input.adminOrigin, input.orderId),
    ],
  }

  for (const target of targets) {
    await enqueueOpsNotification(db, {
      kind: SHIPMENT_CANCEL_FAILED_KIND,
      orderId: input.orderId,
      channel: WHATSAPP_CHANNEL,
      target,
      message,
    })
  }
}

/**
 * Send one row and record the outcome. The shared step both the post-commit
 * fire-and-forget sender and the retry sweep call — neither re-implements the
 * channel-resolution or the bookkeeping.
 *
 * An unconfigured channel is a supported state, not a failure:
 * `skipped_unconfigured` is written, nothing throws, and the row is simply
 * never retried until an operator wires up WhatsApp credentials — same
 * posture `sendInvoiceEmail` takes for an unconfigured Brevo sender.
 *
 * ## Claim before send
 *
 * Both callers can hold the same row at the same instant — the post-commit
 * sender fires the moment a payment commits, and a sweep may be draining the
 * backlog right then (or two sweep runs may overlap, because Cloud Scheduler
 * retries past its 300s attempt deadline while Cloud Run leaves the first
 * handler running). `claimOpsNotification` is a compare-and-swap that resolves
 * that: the loser is handed `undefined` and calls WhatsApp not at all.
 *
 * Losing the claim is reported as `undefined` — the same value an unknown row
 * yields — because both mean "this call sent nothing", and the sweep already
 * counts that as `skipped`. It is a normal outcome, not an error: something
 * else is delivering this row, or its attempt budget is spent.
 *
 * The channel AND the template are resolved BEFORE the claim on purpose.
 * `skipped_unconfigured`
 * means nothing was attempted, so it must not burn an attempt, and claiming
 * first would do exactly that.
 */
export async function sendOpsNotification(
  db: Db,
  row: OpsNotificationRow,
  channels: NotificationChannelRegistry,
  log: FastifyBaseLogger
): Promise<OpsNotificationRow | undefined> {
  const channel = resolveChannel(channels, row.channel)
  if (channel === undefined) {
    return recordOpsNotificationAttempt(db, row.id, { status: 'skipped_unconfigured' })
  }

  // Resolved off `row.kind` and BEFORE the claim, for the same reason the
  // channel is. `kind` is immutable once inserted, so the caller's copy is as
  // good as a re-read — whereas claiming first would increment `attempts` on a
  // row nothing was ever going to send, and five of those would exhaust the
  // retry budget of a row whose only problem is a template nobody has approved
  // yet. That is precisely the backlog this kind is supposed to keep.
  //
  // The template is resolved here rather than read off the frozen payload: the
  // enqueued params describe an order that already happened and must not drift,
  // but the template is plumbing, and a wrong one has to be fixable for rows
  // that are ALREADY sitting in the outbox failing.
  const template = await resolveTemplate(db, row.kind)
  if (template.kind === 'unconfigured') {
    return recordOpsNotificationAttempt(db, row.id, { status: 'skipped_unconfigured' })
  }

  // MARKETING consent, checked BEFORE the claim for the third time in this
  // function and for the same reason: a row nothing will send must not spend an
  // attempt. A shopper who has not answered yet would otherwise exhaust the
  // budget of a reminder that becomes perfectly sendable the moment they tick
  // the box.
  //
  // Only MARKETING kinds reach this. Order confirmations and shipping updates
  // are UTILITY — withholding a delivery update from someone who declined
  // *offers* would be both wrong and, since they are transactional, unnecessary.
  if (MARKETING_KINDS.has(row.kind)) {
    const consent = await marketingConsentForOrder(db, row.orderId)
    if (consent === 'declined') {
      // Terminal — `skipped_no_consent` is not a sendable status, so nothing
      // reconsiders this row. That is the difference between an opt-out and a
      // pause.
      return recordOpsNotificationAttempt(db, row.id, { status: 'skipped_no_consent' })
    }
    if (consent === 'unknown') {
      return recordOpsNotificationAttempt(db, row.id, { status: 'skipped_unconfigured' })
    }
  }

  const claimed = await claimOpsNotification(db, row.id)
  if (claimed === undefined) return undefined

  try {
    // Read off the CLAIMED row, not the caller's copy: the claim re-read the
    // row under the same statement that took it, so this is the only version
    // guaranteed not to be stale by the time the send goes out.
    const payload = claimed.payload as NotificationMessage
    const result = await channel.send(
      claimed.target,
      template.kind === 'override' ? { ...payload, template: template.template } : payload
    )
    if (result.ok) {
      return recordOpsNotificationAttempt(db, claimed.id, {
        status: 'sent',
        providerMessageId: result.providerMessageId ?? null,
      })
    }
    log.error(
      { id: claimed.id, orderId: claimed.orderId, error: result.error },
      'ops notification send failed'
    )
    return recordOpsNotificationAttempt(db, claimed.id, {
      status: 'failed',
      error: result.error ?? 'Send failed',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, id: claimed.id, orderId: claimed.orderId }, 'ops notification send threw')
    return recordOpsNotificationAttempt(db, claimed.id, { status: 'failed', error: message })
  }
}

/**
 * Send everything a just-committed payment enqueued for one order.
 *
 * Meant to be wired to `onOrderPaidCommitted`, mirroring
 * `sendCapturedInvoiceEmails` exactly: fire-and-forget (never awaited by the
 * request), every failure caught and logged. A WhatsApp outage must not
 * affect the response the shopper already got — a failed send is already
 * durable on the row for the retry sweep to pick up.
 */
export function sendPendingOpsNotifications(
  db: Db,
  orderId: string,
  channels: NotificationChannelRegistry,
  log: FastifyBaseLogger,
  /** Absent ⇒ the daily backstop cron drains it, i.e. today's behaviour. */
  tasks?: TaskEnqueuer
): void {
  void (async () => {
    let stillOwed = false
    try {
      const owed = await listPendingOpsNotificationsForOrder(db, orderId)
      for (const row of owed) {
        const after = await sendOpsNotification(db, row, channels, log)
        // The SAME predicate the sweep selects on
        // (`OPS_NOTIFICATION_SENDABLE_STATUSES` under the attempt cap), so a
        // task is never enqueued for a row the sweep will not look at — that
        // would buy a guaranteed-empty Neon wake, which is the whole cost this
        // mechanism exists to avoid.
        //
        // `skipped_unconfigured` counts as owed on purpose: with WhatsApp
        // unwired every row lands there and keeps its full retry budget, and
        // that backlog delivering itself the moment Meta approves the template
        // is the behaviour this module's sweep exists for.
        if (
          after &&
          (OPS_NOTIFICATION_SENDABLE_STATUSES as readonly string[]).includes(after.status) &&
          after.attempts < MAX_OPS_NOTIFICATION_ATTEMPTS
        ) {
          stillOwed = true
        }
      }
    } catch (err) {
      log.error({ err, orderId }, 'ops notification dispatch failed')
      // Row states unknown, and the likeliest cause (Neon or Meta down) is
      // precisely when a retry is owed.
      stillOwed = true
    }
    if (stillOwed && tasks) requestSweep(tasks, 'ops-notifications', log)
  })()
}

/** `onOrderPaidCommitted` adapter — see {@link sendPendingOpsNotifications}. */
export function makeOpsNotificationSendHook(
  db: Db,
  channels: NotificationChannelRegistry,
  log: FastifyBaseLogger,
  tasks?: TaskEnqueuer
): (paid: PaidTransition) => void {
  return (paid) => sendPendingOpsNotifications(db, paid.order.orderId, channels, log, tasks)
}
