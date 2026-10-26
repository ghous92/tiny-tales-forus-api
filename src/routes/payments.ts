/**
 * /v1/payments — HTTP layer only (SPEC-PAYMENTS.md v3). Zod schemas validate
 * every JSON input (strict: unknown keys rejected) and serialize every output;
 * business rules live in `services/payments.ts`.
 *
 * This route layer owns the cross-module wiring the service is forbidden to do
 * (ARCHITECTURE.md module rules): it resolves the Razorpay secrets from `env`
 * into a {@link PaymentsGateway}, reads `payments.enabled` through the config
 * service, prices the caller's cart through the cart read API (the single
 * pricing source — with the wholesale rule resolved from config exactly as the
 * cart routes do), and ownership-checks the `addressId` — then hands plain
 * values to the service. Missing keys OR `payments.enabled === false` →
 * 503 `payments_disabled`.
 *
 * The webhook is the Fastify raw-body pitfall (SPEC invariant #3): its HMAC is
 * over the RAW body, which the default JSON parser destroys. It is therefore
 * mounted in its own ENCAPSULATED child plugin with a scoped
 * `application/json` content-type parser (`parseAs: 'buffer'`) and NO auth
 * hook — the authed JSON routes live in a separate child scope and keep normal
 * JSON parsing (a regression test proves other routes are unaffected).
 */

import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  OrderCancelBodySchema,
  OrderCancelResponseSchema,
  OrderDetailSchema,
  OrderInvoiceSchema,
  OrderListResponseSchema,
  PaymentAttemptListSchema,
  PaymentOrderCreateSchema,
  PaymentOrderParamsSchema,
  PaymentOrderSchema,
  PaymentRecoverResponseSchema,
  PaymentStatusResponseSchema,
  PaymentVerifyResponseSchema,
  PaymentVerifySchema,
  UpiIntentSchema,
  type InvoiceSeller,
  type PaymentRecoverResponse,
} from '../contracts/payment.js'
import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { payments } from '../db/schema.js'
import type { Analytics } from '../lib/analytics.js'
import type { OpenAiAdsConversions } from '../lib/openaiAdsConversions.js'
import type { CouponLookup } from '../lib/coupons.js'
import type { EmailSenderConfig } from '../lib/email.js'
import { invoiceUnavailable, paymentsDisabled, validationFailed } from '../lib/errors.js'
import { makeCreditNoteIssuanceHook } from './creditNotes.js'
import {
  makeInvoiceIssuanceHook,
  newInvoiceCapture,
  sendCapturedInvoiceEmails,
  type InvoiceCapture,
} from './invoices.js'
import { makeCustomerOrderConfirmedHook, schedulePaymentReminder } from './customerNotifications.js'
import {
  enqueueShipmentCancelFailedNotification,
  makeOpsNotificationHook,
  makeOpsNotificationSendHook,
  makeOrderCancelledNotificationHook,
  sendPendingOpsNotifications,
} from './opsNotifications.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import { WHOLESALE_OFF, type WholesaleRule } from '../lib/pricing.js'
import { requestSweep, MINUTE_MS, RECOVER_BUCKET_MS, type TaskEnqueuer } from '../lib/tasks.js'
import { createPaymentsGateway, type PaymentsGateway } from '../lib/razorpay.js'
import { getAddress } from '../services/addresses.js'
import { getCart, type CartShippingResolver } from '../services/cart.js'
import { assertCodAllowed } from '../services/cod.js'
import { checkAvailability, decrementForOrder } from '../services/stock.js'
import {
  loadShippingContext,
  priceShipping,
  quotePayloadFor,
  verifyQuoteToken,
  type PricedShipping,
} from '../services/shipping.js'
import { getConfigValue } from '../services/config.js'
import {
  adAudienceConsentForOrder,
  setAdAudienceOptIn,
  setMarketingWhatsappOptIn,
} from '../services/marketingConsent.js'
import type { FollowUpTaskEnqueuer } from '../lib/replenishmentTask.js'
import { getCouponRuleByCode, recordRedemption, revokeRedemption } from '../services/coupons.js'
import type { CarrierAdapter } from '../lib/delhivery.js'
import {
  cancelShipmentsForOrder,
  createShipmentIntent,
  shipmentCancelBlock,
} from '../services/fulfilment.js'
import {
  cancelOrder,
  createOrder,
  createUpiIntent,
  getOrderDetail,
  getOrderInvoice,
  getOrderStatus,
  handleWebhook,
  listOrders,
  listPaymentAttempts,
  recover,
  verifyPayment,
  DEFAULT_REFUND_CREDIT_DAYS,
  DEFAULT_UPI_INTENT_EXPIRY_MINUTES,
  RECOVER_STALE_AFTER_MS,
  type OrderCancelPolicy,
  type RefundPolicy,
  type OrderPaidHook,
  type OrderRefundHook,
  type PaidTransition,
  type PaymentHooks,
  type PollLiveLookup,
} from '../services/payments.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/**
 * Build the `onOrderPaid` hook that takes sold units off the shelf the cascade
 * chose (docs/SPEC-STOCK.md §9). Wired here rather than imported by the payment
 * service, per ARCHITECTURE.md rule 2.
 *
 * **It swallows everything, deliberately.** It runs inside the transaction that
 * flips the order to `paid`, and by then the money is captured. Any error
 * escaping would roll that transition back and leave a shopper who has paid for
 * an order that no longer exists. Every failure mode is therefore logged and
 * absorbed:
 *
 * - a shelf that goes negative is allowed (`decrementForOrder` does not clamp)
 *   and shows up in the admin panel's oversell list;
 * - a line with no `stockNodeId` — pre-stock orders, `force_in`, a cascade that
 *   found nothing — is skipped;
 * - a thrown query error is logged at ERROR and the payment still completes.
 *
 * The trade is explicit: an inventory count that needs a human is strictly
 * cheaper than a payment that needs a refund.
 */
function makeStockDecrementHook(log: {
  error: (obj: Record<string, unknown>, msg: string) => void
}): OrderPaidHook {
  return async (tx, orderId, lines) => {
    for (const line of lines) {
      if (!line.stockNodeId) continue
      try {
        await decrementForOrder(tx as unknown as Db, line.stockNodeId, line.sku, line.qty, orderId)
      } catch (err) {
        log.error(
          { err, orderId, sku: line.sku, nodeId: line.stockNodeId },
          'stock decrement failed after capture; payment stands, count needs reconciling'
        )
      }
    }
  }
}

/**
 * Build the `onOrderPaid` hook that records the intent to ship
 * (docs/SPEC-LOGISTICS.md §6.1). Wired here rather than imported by the payment
 * service, per ARCHITECTURE.md rule 2 — same wiring as the stock decrement.
 *
 * **It inserts one row and makes no HTTP call.** The carrier request happens
 * later, from the manifest sweep. That split is the whole design: this hook
 * runs inside the transaction that flips the order to `paid`, its contract says
 * it must not throw, and a carrier API call is the single most likely thing in
 * this system to throw. Manifesting here would let a Delhivery outage roll back
 * a payment Razorpay has already captured.
 *
 * Like the stock hook it swallows everything. An order that is paid but has no
 * shipment row is recoverable by an operator in seconds; a payment rolled back
 * because a shipment row would not insert is not.
 *
 * `fulfilment.enabled` is deliberately NOT consulted here. The switch gates
 * carrier *calls*, not bookkeeping: recording that a paid order needs shipping
 * costs nothing, and an operator who enables fulfilment mid-week should find
 * the week's orders waiting rather than silently lost.
 */
function makeShipmentIntentHook(
  courierCode: string,
  log: { error: (obj: Record<string, unknown>, msg: string) => void }
): OrderPaidHook {
  return async (tx, orderId, _lines, order) => {
    try {
      // The shipping snapshot is on the row this transition just flipped; the
      // ETA is what the shopper was promised at checkout and is worth carrying
      // onto the shipment so tracking can compare promise against reality.
      const [row] = await tx
        .select({ shippingSnapshot: payments.shippingSnapshot })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .limit(1)
      const snapshot = (row?.shippingSnapshot ?? {}) as {
        etaDays?: unknown
        estimatedDeliveryDate?: unknown
      }
      const etaDays =
        typeof snapshot.etaDays === 'number' && Number.isFinite(snapshot.etaDays)
          ? snapshot.etaDays
          : null
      const deliveryDate =
        typeof snapshot.estimatedDeliveryDate === 'string' && snapshot.estimatedDeliveryDate !== ''
          ? snapshot.estimatedDeliveryDate
          : null

      await createShipmentIntent(tx, {
        orderId,
        userId: order.userId,
        courierCode,
        promisedEtaDays: etaDays,
        promisedDeliveryDate: deliveryDate,
      })
    } catch (err) {
      log.error(
        { err, orderId },
        'shipment intent insert failed after capture; payment stands, order needs manual fulfilment'
      )
    }
  }
}

/**
 * Build the `onOrderPaid` hook that writes the coupon redemption ledger row
 * (`coupon_redemptions`), which is what makes `coupons.usage_limit` /
 * `per_user_limit` enforceable. Wired here rather than imported by the payment
 * service, per ARCHITECTURE.md rule 2 — same wiring as the stock decrement.
 *
 * Keyed off `couponDiscountInr > 0`, not off the code alone: an order that
 * requested a code which did not apply (below its minimum, expired between the
 * cart screen and checkout) paid full price and has redeemed nothing.
 *
 * Like every other paid hook it swallows its own failures. A missing ledger row
 * means one shopper gets one extra use of a coupon; an exception here would roll
 * back a payment Razorpay has already captured.
 */
function makeCouponRedemptionHook(log: {
  error: (obj: Record<string, unknown>, msg: string) => void
}): OrderPaidHook {
  return async (tx, orderId, _lines, order) => {
    if (!order.couponCode || order.couponDiscountInr <= 0) return
    try {
      await recordRedemption(tx, {
        orderId,
        code: order.couponCode,
        userId: order.userId,
        discountInr: order.couponDiscountInr,
      })
    } catch (err) {
      log.error(
        { err, orderId, code: order.couponCode },
        'coupon redemption insert failed after capture; payment stands, usage limit under-counts'
      )
    }
  }
}

/**
 * The inverse: release the redeemed slot when the order is refunded (the ledger
 * row stays, stamped `revoked_at` — see the column note in db/schema.ts).
 *
 * Runs for every refund, coupon or not; `revokeRedemption` is a no-op when the
 * order has no ledger row, which is cheaper than teaching this hook to care.
 * Swallows its own failures for the same reason the issuance hook does — the
 * money has already moved by the time it runs.
 */
function makeCouponRevokeHook(log: {
  error: (obj: Record<string, unknown>, msg: string) => void
}): OrderRefundHook {
  return async (tx, orderId) => {
    try {
      await revokeRedemption(tx, orderId)
    } catch (err) {
      log.error(
        { err, orderId },
        'coupon redemption revoke failed after refund; refund stands, usage limit over-counts'
      )
    }
  }
}

/**
 * The cancellation policy payments enforces, built here because this is the
 * layer allowed to know about both modules (ARCHITECTURE.md rule 2).
 *
 * Its whole job is to stop the hole the courier integration opened: before
 * fulfilment existed, a `paid` order was by definition "not yet shipped", so
 * cancelling always meant a clean refund. Now a parcel can genuinely be on a
 * van, and a self-service full refund at that moment loses both the money and
 * the goods.
 *
 * `onCancelled` swallows its own errors: it runs after the refund has landed,
 * and the tidy-up it does (cancelling the order's live shipments) is not worth
 * reporting a successful cancellation as a failure over. A shipment it could
 * not recall is both logged AND put on the ops WhatsApp outbox rather than
 * hidden — the money is gone and the label is still live, which is the one
 * combination somebody has to act on the same day.
 */
function makeCancelPolicy(opts: {
  db: Db
  log: FastifyBaseLogger
  adminOrigin: string
  adapter?: CarrierAdapter | undefined
}): OrderCancelPolicy {
  const { db, log, adminOrigin, adapter } = opts
  return {
    block: (orderId) => shipmentCancelBlock(db, orderId),
    onCancelled: async (orderId) => {
      try {
        const sweep = await cancelShipmentsForOrder(db, orderId, adapter)
        if (sweep.unresolved.length === 0) return
        log.error(
          { orderId, unresolved: sweep.unresolved },
          'refunded order still has a live shipment; cancel it with the carrier by hand'
        )
        // Enqueue only. The send is post-commit, from the same drain that
        // flushes the cancellation notice — see the cancel route handler.
        await enqueueShipmentCancelFailedNotification(db, {
          orderId,
          unresolved: sweep.unresolved.map((s) => ({ awb: s.awb, remark: s.remark })),
          adminOrigin,
        })
      } catch (err) {
        log.error({ err, orderId }, 'could not cancel shipments for a refunded order')
      }
    },
  }
}

/**
 * Run several `onOrderPaid` hooks as one, in order, inside the transition's
 * transaction. Sequential rather than concurrent on purpose: they share a
 * single transaction handle, and drizzle's transaction object is not safe to
 * drive from two overlapping queries.
 *
 * Every hook here is individually responsible for swallowing its own failures
 * (both of today's do) — this composer does not add a safety net, because a
 * blanket catch would hide a future hook that genuinely must not fail.
 */
function composeOrderPaidHooks(...hooks: OrderPaidHook[]): OrderPaidHook {
  return async (tx, orderId, lines, order) => {
    for (const hook of hooks) {
      await hook(tx, orderId, lines, order)
    }
  }
}

/**
 * Run several `onOrderPaidCommitted` hooks as one. Unlike
 * {@link composeOrderPaidHooks} these are synchronous/fire-and-forget by
 * contract (see `PaymentHooks.onOrderPaidCommitted`), so this just calls each
 * in turn rather than awaiting anything — every hook is individually
 * responsible for not throwing, same rule as the paid-transaction composer.
 */
function composeOrderPaidCommittedHooks(
  ...hooks: Array<(paid: PaidTransition) => void>
): (paid: PaidTransition) => void {
  return (paid) => {
    for (const hook of hooks) hook(paid)
  }
}

/**
 * Run several `onOrderRefunded` hooks as one, in order, inside the refund
 * transition's transaction — the mirror of {@link composeOrderPaidHooks}, with
 * the same rules: sequential (one shared transaction handle) and no blanket
 * catch (each hook swallows its own).
 */
function composeOrderRefundHooks(...hooks: OrderRefundHook[]): OrderRefundHook {
  return async (tx, orderId, order, reason) => {
    for (const hook of hooks) {
      await hook(tx, orderId, order, reason)
    }
  }
}

/** Coerce a JSON config value to a finite number, or undefined if it isn't one. */
function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * Resolve the wholesale knobs from config for this request — identical to the
 * cart routes (payments must price the cart the exact same way cart does). Any
 * missing/malformed key falls back to wholesale OFF.
 */
async function resolveWholesaleRule(db: Db): Promise<WholesaleRule> {
  const [enabled, thresholdInr, discountPct] = await Promise.all([
    getConfigValue(db, 'wholesale.enabled'),
    getConfigValue(db, 'wholesale.thresholdInr'),
    getConfigValue(db, 'wholesale.discountPct'),
  ])
  if (enabled !== true) return WHOLESALE_OFF
  const threshold = asNumber(thresholdInr)
  const pct = asNumber(discountPct)
  if (threshold === undefined || pct === undefined) return WHOLESALE_OFF
  return { enabled: true, thresholdInr: Math.trunc(threshold), discountPct: Math.trunc(pct) }
}

/**
 * Resolve a client-supplied coupon code (`couponCode` body field) into a
 * {@link CouponLookup} — identical to `resolveCouponRule` in routes/cart.ts
 * (duplicated rather than imported across route files, matching how
 * `resolveWholesaleRule` above is already duplicated). Blank/absent code
 * resolves to `COUPON_NONE`.
 */
async function resolveCouponRule(
  db: Db,
  code: string | undefined,
  userId: string
): Promise<CouponLookup> {
  return getCouponRuleByCode(db, code, userId)
}

/**
 * Resolve the refund display policy from `refunds.creditDays` config — the
 * working-day allowance behind the "credit by" date on a refunded order.
 * Absent or malformed falls back to {@link DEFAULT_REFUND_CREDIT_DAYS}: a
 * missing config key must never cost a shopper the date on their refund.
 */
async function resolveRefundPolicy(db: Db): Promise<RefundPolicy> {
  const configured = asNumber(await getConfigValue(db, 'refunds.creditDays'))
  if (configured === undefined || configured < 0) return { creditDays: DEFAULT_REFUND_CREDIT_DAYS }
  return { creditDays: Math.trunc(configured) }
}

/**
 * Resolve the invoice seller-of-record from `legal.company` config (never
 * hardcoded — see `scripts/seed-config.ts`). Throws 503 `invoice_unavailable`
 * if the key isn't seeded yet or is missing its `legalName`/`address`, rather
 * than emitting an invoice with a blank seller.
 */
async function resolveInvoiceSeller(db: Db): Promise<InvoiceSeller> {
  const company = await getConfigValue<Record<string, unknown>>(db, 'legal.company')
  const legalName = company?.legalName
  const address = company?.address
  if (typeof legalName !== 'string' || !legalName || typeof address !== 'string' || !address) {
    throw invoiceUnavailable()
  }
  return { legalName, address }
}

/**
 * The UPI-intent knobs, read from config on the request that needs them.
 *
 * `payments.upiIntent.enabled` is a kill switch with the same shape as
 * `payments.enabled` — absent means ON (it ships enabled once S2S is live on
 * the account), and flipping it false makes the endpoint 503, which every
 * client is required to read as "use Checkout instead". That is the whole
 * rollback plan for this feature: one config edit, no deploy, and the shopper
 * still pays, just with the typing back.
 *
 * `payments.upiIntent.expiryMinutes` is the link lifetime. Malformed or absent
 * falls back to {@link DEFAULT_UPI_INTENT_EXPIRY_MINUTES}, and a value ≤ 0 is
 * treated as malformed rather than obeyed — an already-expired link is not a
 * configuration anyone means to express.
 */
async function resolveUpiIntentPolicy(
  db: Db
): Promise<{ enabled: boolean; expiryMinutes: number }> {
  const [enabled, expiry] = await Promise.all([
    getConfigValue(db, 'payments.upiIntent.enabled'),
    getConfigValue(db, 'payments.upiIntent.expiryMinutes'),
  ])
  const minutes = asNumber(expiry)
  return {
    enabled: enabled !== false,
    expiryMinutes:
      minutes === undefined || minutes <= 0
        ? DEFAULT_UPI_INTENT_EXPIRY_MINUTES
        : Math.trunc(minutes),
  }
}

/**
 * Is payments switched on? Both must hold: the Razorpay gateway is configured
 * (keys present) AND the `payments.enabled` config kill switch is not `false`
 * (absent key ⇒ enabled — ships enabled once keys exist, but the operator can
 * flip it off live). Returns the gateway when live, else throws 503
 * `payments_disabled`.
 */
async function requirePaymentsEnabled(
  db: Db,
  gateway: PaymentsGateway | undefined
): Promise<PaymentsGateway> {
  if (!gateway) throw paymentsDisabled()
  const enabled = await getConfigValue(db, 'payments.enabled')
  if (enabled === false) throw paymentsDisabled()
  return gateway
}

export interface PaymentRoutesOptions {
  db: Db
  /** Razorpay env values — the route builds the gateway; undefined when unconfigured (→ 503). */
  razorpay?: {
    keyId?: string | undefined
    keySecret?: string | undefined
    webhookSecret?: string | undefined
  }
  /**
   * Test seam: inject a ready-made gateway (real HMAC math, mocked SDK) instead
   * of building one from env. Takes precedence over `razorpay` when provided.
   */
  gateway?: PaymentsGateway
  /**
   * Brevo sender identity for the customer's invoice copy — the same
   * credentials the complaints module uses, with its own `fromName`. Absent →
   * invoices are still ISSUED and stored (that is the legal record); only the
   * emailed copy is skipped, and the row stays `pending` for the retry sweep.
   */
  email?: EmailSenderConfig
  /** Test seam: injected fetch for the Brevo call. */
  emailFetchImpl?: typeof fetch
  /**
   * Which carrier the shipment intent is recorded against. Defaults to
   * 'delhivery' per docs/FEASIBILITY-LOGISTICS.md §5.1. It is a plain string
   * rather than a config read because the hook runs inside the paid
   * transaction, where a config query would add a round trip to the money path
   * for a value that changes roughly never.
   */
  carrierCode?: string
  /**
   * The carrier, used on the cancel path only: a self-cancelled order whose
   * shipment is already `manifested` has a live label that must be recalled, or
   * the shopper keeps reading "Order packed, awaiting pickup" after their
   * refund. Absent ⇒ only unmanifested shipments are voided and a manifested
   * one is logged for ops (`app.ts` builds no adapter without full Delhivery
   * config — see its own note).
   */
  carrierAdapter?: CarrierAdapter
  /**
   * Server-side analytics. Absent → no `Order Completed` is emitted and nothing
   * else changes; see `lib/analytics.ts` for why unconfigured is a supported
   * state rather than a degraded one.
   */
  analytics?: Analytics
  /**
   * ChatGPT Ads server-side conversions. Absent → no `order_created` is sent;
   * same supported-unconfigured state as `analytics`.
   */
  openAiAds?: OpenAiAdsConversions
  /**
   * Notification channel adapters (docs/SPEC-MANUAL-FULFILMENT.md §4A) — keyed
   * by channel name, e.g. `{ whatsapp_cloud: createWhatsAppCloudChannel(...) }`.
   * Absent/missing entries resolve every ops notification send to
   * `skipped_unconfigured`; nothing throws and no route's behaviour changes —
   * same posture as an unconfigured `email` sender above.
   */
  notificationChannels?: NotificationChannelRegistry
  /**
   * Origin the ops WhatsApp message's deep link points at, e.g.
   * `https://laanya.shop` → `.../admin/orders/<orderId>` (SPEC §3). Defaults to
   * the production admin origin; tests override it to assert on the exact link.
   */
  adminOrigin?: string
  /**
   * Cloud Tasks enqueuer (`lib/tasks.ts`). Absent ⇒ every retry waits for the
   * daily backstop cron, which is exactly the behaviour before this existed.
   *
   * Threaded through the paid-transition hooks rather than resolved inside
   * them, for the same reason `notificationChannels` is: an order recovered by
   * the sweep must schedule its follow-ups identically to one paid at the
   * checkout, and the recovered ones are by definition the ones nobody watched.
   */
  tasks?: TaskEnqueuer
  /**
   * Delayed per-order follow-ups (`lib/replenishmentTask.ts`). Used here only
   * to schedule the unpaid-order nudge at creation. Absent ⇒ no nudge.
   */
  followUpTasks?: FollowUpTaskEnqueuer
  /**
   * Whether the manifest sweep could actually manifest anything right now —
   * `manifestBlockedBy(rule, hasAdapter) === null`, injected by `app.ts`
   * because only it knows whether a carrier adapter exists.
   *
   * Absent (or answering false) ⇒ no manifest task is requested and the daily
   * backstop cron covers it. That is the whole point of asking: with fulfilment
   * off or in manual mode, every enqueued task would buy a Neon compute window
   * to be told `ran: false, reason: fulfilment_disabled`.
   */
  manifestReady?: (db: Db) => Promise<boolean>
}

/**
 * The manifest trigger as a spreadable list, so all three paid entry points
 * (verify, webhook, recover sweep) compose it identically and none can quietly
 * forget it — the same shape `analyticsHook` uses.
 */
function manifestHooks(
  opts: PaymentRoutesOptions,
  log: FastifyBaseLogger
): Array<(paid: PaidTransition) => void> {
  return opts.tasks && opts.manifestReady
    ? [makeManifestSweepHook(opts.db, opts.tasks, opts.manifestReady, log)]
    : []
}

/**
 * Everything that must happen when an order becomes paid, as one value.
 *
 * FOUR paths can now perform that transition — the shopper's `verify`, the
 * webhook, the status poll (the UPI intent flow has no signature to verify, so
 * the poll asks Razorpay directly) and the recover sweep — and a purchase is
 * only fully processed if the path that happened to win composed every hook.
 * Stock, invoice, shipment intent, ops and shopper notifications, coupon
 * redemption, analytics: forgetting one at one call site is a silent, partial
 * order, so there is exactly one list and all four spread it.
 *
 * `capture` crosses the transaction boundary: invoice numbers are minted INSIDE
 * the transition (once, whoever wins) and the emails go out after it commits.
 */
function paidHooks(
  opts: PaymentRoutesOptions,
  wiring: ReturnType<typeof resolvePaymentWiring>,
  capture: InvoiceCapture,
  log: FastifyBaseLogger
): PaymentHooks {
  const { carrierCode, analyticsHook, openAiAdsHook, notificationChannels, adminOrigin } = wiring
  return {
    onOrderPaid: composeOrderPaidHooks(
      makeStockDecrementHook(log),
      makeShipmentIntentHook(carrierCode, log),
      makeInvoiceIssuanceHook({ capture, log }),
      makeOpsNotificationHook({ adminOrigin, log }),
      // The shopper's own confirmation, alongside the ops fan-out. Silent until
      // its template is approved and configured — see the hook.
      makeCustomerOrderConfirmedHook({ log }),
      makeCouponRedemptionHook(log)
    ),
    onOrderPaidCommitted: composeOrderPaidCommittedHooks(
      ...(analyticsHook ? [analyticsHook] : []),
      ...(openAiAdsHook ? [openAiAdsHook] : []),
      makeOpsNotificationSendHook(opts.db, notificationChannels, log, opts.tasks),
      ...manifestHooks(opts, log)
    ),
  }
}

/**
 * Ask for a manifest drain once a paid order has booked its shipment intent.
 *
 * Wired to `onOrderPaidCommitted` for the same reason the analytics hook is:
 * the `pending_manifest` row must be durable before anything is scheduled to
 * go looking for it, or the task can arrive before the row exists and find
 * nothing.
 *
 * The gate is a live config read rather than a boot-time flag: fulfilment is
 * switched on by an admin edit (`db:enable-prod-fulfilment-carrier`), and a
 * deploy that cached the answer at boot would keep declining to enqueue until
 * someone restarted it. One indexed SELECT, post-commit, on a connection Neon
 * has open anyway.
 */
function makeManifestSweepHook(
  db: Db,
  tasks: TaskEnqueuer,
  manifestReady: (db: Db) => Promise<boolean>,
  log: FastifyBaseLogger
): NonNullable<PaymentHooks['onOrderPaidCommitted']> {
  return ({ order }) => {
    void (async () => {
      try {
        if (await manifestReady(db)) requestSweep(tasks, 'manifest', log)
      } catch (err) {
        // Same trade every post-commit hook makes: the money is captured and
        // the shipment intent is durable, so the worst case here is that the
        // parcel waits for the backstop cron instead of five minutes.
        log.error({ err, orderId: order.orderId }, 'manifest sweep request failed')
      }
    })()
  }
}

/**
 * Turn a committed `paid` transition into the authoritative `Order Completed`.
 *
 * **Wired to `onOrderPaidCommitted`, not `onOrderPaid`.** The stock decrement
 * and the shipment intent belong inside the transaction because they must be
 * undone if it rolls back. A purchase event is the opposite: once Meta and
 * Google Ads have been told a sale happened, there is no retraction, so it must
 * not be said until the sale is durable.
 *
 * Rupees, not paise. GA4 and both ad platforms read `revenue`/`total` as major
 * units, and a value silently multiplied by 100 does not look wrong in a report
 * — it looks like a very good week.
 *
 * `revenue` deliberately excludes shipping. The ecommerce spec draws that line
 * so a shop can compare product revenue with delivery cost; `total` is what the
 * shopper was actually charged and is what the conversion value should be.
 *
 * Nothing about the shopper travels. The address snapshot on the order carries
 * a name, a phone number and a street; none of it is read here. Meta's advanced
 * matching is fed from `identify` traits (docs/ANALYTICS.md §4), which is the
 * one channel allowed to carry an identifier.
 */
function makeAnalyticsHook(
  analytics: Analytics
): NonNullable<PaymentHooks['onOrderPaidCommitted']> {
  return ({ order, anonymousId, storeCode, attribution }) => {
    analytics.orderCompleted({
      orderId: order.orderId,
      userId: order.userId,
      anonymousId,
      paymentReference: order.paymentReference,
      currency: 'INR',
      total: order.totalInr,
      revenue: order.goodsInr,
      shipping: order.shippingFeeInr,
      discount: order.couponDiscountInr,
      products: order.lines.map((line) => ({
        // The sku IS the product identifier the catalogue and the ad platforms
        // both key on — there is no separate per-product id on a frozen order
        // line, and inventing one here would not match the client's events.
        product_id: line.sku,
        sku: line.sku,
        price: line.priceInr,
        quantity: line.qty,
      })),
      storeCode,
      // Frozen at order-create, not read from this request: by now the caller
      // may be a Razorpay webhook or the recovery sweep.
      campaign: attribution
        ? {
            ...(attribution.utmSource ? { source: attribution.utmSource } : {}),
            ...(attribution.utmMedium ? { medium: attribution.utmMedium } : {}),
            ...(attribution.utmCampaign ? { name: attribution.utmCampaign } : {}),
            ...(attribution.utmContent ? { content: attribution.utmContent } : {}),
          }
        : null,
      gclid: attribution?.gclid ?? null,
    })
  }
}

/** A string field off the frozen `address_snapshot`, or null if absent/blank. */
function addressField(address: Record<string, unknown>, key: string): string | null {
  const v = address[key]
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * The ChatGPT Ads twin of {@link makeAnalyticsHook}, on the same committed-paid
 * transition and for the same reason.
 *
 * The phone is stored bare (10 digits, `contracts/address.ts`) but OpenAI
 * matches on a number that still carries its country calling code, so `91` is
 * prefixed here. Getting this wrong does not error — it silently matches
 * nothing, which is worse.
 *
 * CONSENT. The hashed phone and the city / state / pincode are personal data
 * leaving for an ad platform, so they ride along only when the shopper has
 * opted in to ad sharing (`users.ad_audience_opt_in`, read live). Without it
 * the conversion still goes — order id, value, products, and the `oppref` the
 * browser captured under its own consent rules — so measurement keeps working
 * on click attribution alone. A failed consent lookup is treated as "no".
 */
function makeOpenAiAdsHook(
  openAiAds: OpenAiAdsConversions,
  adminOrigin: string,
  db: Db
): NonNullable<PaymentHooks['onOrderPaidCommitted']> {
  return ({ order, attribution }) => {
    void adAudienceConsentForOrder(db, order.orderId)
      .catch(() => false)
      .then((consented) =>
        sendOpenAiOrderCreated(openAiAds, adminOrigin, order, attribution, consented)
      )
  }
}

function sendOpenAiOrderCreated(
  openAiAds: OpenAiAdsConversions,
  adminOrigin: string,
  order: PaidTransition['order'],
  attribution: PaidTransition['attribution'],
  consented: boolean
): void {
  const phone = consented ? addressField(order.address, 'phone') : null
  openAiAds.orderCreated({
    orderId: order.orderId,
    ...(attribution?.oppref ? { oppref: attribution.oppref } : {}),
    // The confirmation URL the shopper would have landed on. Required for a
    // `web` event; by now the caller may be a webhook with no request of its own.
    sourceUrl: `${adminOrigin}/checkout/success/`,
    totalInr: order.totalInr,
    ...(phone ? { phone: `91${phone}` } : {}),
    ...(consented
      ? {
          city: addressField(order.address, 'city'),
          region: addressField(order.address, 'state'),
          postalCode: addressField(order.address, 'pincode'),
        }
      : {}),
    products: order.lines.map((line) => ({
      sku: line.sku,
      priceInr: line.priceInr,
      quantity: line.qty,
    })),
  })
}

/**
 * Apply the option defaults once, in one place.
 *
 * Extracted from the plugin body because the recovery sweep is now reachable
 * from TWO plugins — this one (`POST /v1/payments/recover`, an operator) and
 * `routes/internalSweeps.ts` (`POST /v1/internal/sweeps/payments-recover`,
 * Cloud Scheduler). Both must resolve `carrierCode`, the analytics hook and the
 * gateway identically, or a scheduled recovery would mint a subtly different
 * order than a hand-pressed one.
 */
function resolvePaymentWiring(opts: PaymentRoutesOptions) {
  return {
    carrierCode: opts.carrierCode ?? 'delhivery',
    analyticsHook: opts.analytics ? makeAnalyticsHook(opts.analytics) : undefined,
    openAiAdsHook: opts.openAiAds
      ? makeOpenAiAdsHook(opts.openAiAds, opts.adminOrigin ?? 'https://laanya.shop', opts.db)
      : undefined,
    gateway: opts.gateway ?? createPaymentsGateway(opts.razorpay ?? {}),
    notificationChannels: opts.notificationChannels ?? {},
    adminOrigin: opts.adminOrigin ?? 'https://laanya.shop',
  }
}

/**
 * Is the recovery sweep switched on? Same two conditions as
 * {@link requirePaymentsEnabled}, reported instead of thrown.
 *
 * The scheduler needs the answer as a value, not as a 503: Cloud Scheduler
 * retries every non-2xx and marks the job red, so a deploy with no Razorpay
 * keys (staging, most of the time) would produce a permanent retry storm on a
 * sweep that is CORRECTLY doing nothing. Same reasoning as `carrierBlockedBy`
 * in `routes/internalSweeps.ts`.
 */
export async function paymentsRecoverBlockedBy(
  opts: PaymentRoutesOptions | undefined
): Promise<'payments_disabled' | null> {
  if (opts === undefined) return 'payments_disabled'
  if (resolvePaymentWiring(opts).gateway === undefined) return 'payments_disabled'
  return (await getConfigValue(opts.db, 'payments.enabled')) === false ? 'payments_disabled' : null
}

/**
 * Run one payment recovery pass with the full paid-transition hook chain.
 *
 * THE shared runner behind both entry points, exported so `internalSweeps.ts`
 * has no second implementation to drift from (the rule that module's header
 * states for every other sweep). A recovered order therefore decrements stock,
 * books a shipment intent, mints an invoice, records the coupon redemption and
 * announces itself exactly as one recovered by hand.
 *
 * The post-commit hooks matter MORE here than on the happy path: this sweep
 * only ever sees orders where both the client `verify` and the webhook were
 * lost, so it is the last thing that will ever report those purchases.
 */
export async function runPaymentRecoverSweep(
  opts: PaymentRoutesOptions,
  log: FastifyBaseLogger,
  limit?: number
): Promise<PaymentRecoverResponse> {
  const { db, email, emailFetchImpl } = opts
  const wiring = resolvePaymentWiring(opts)
  const gw = await requirePaymentsEnabled(db, wiring.gateway)
  // One capture for the whole sweep: a single recover call can transition
  // several stuck orders, and each one earns its own invoice and email.
  const capture = newInvoiceCapture()
  const result = await recover(
    db,
    gw,
    (obj, msg) => log.error(obj, msg),
    new Date(),
    paidHooks(opts, wiring, capture, log),
    limit
  )
  sendCapturedInvoiceEmails(db, capture, email, emailFetchImpl, log, opts.tasks)
  return result
}

export const paymentRoutes: FastifyPluginAsyncZod<PaymentRoutesOptions> = async (app, opts) => {
  const { db, email, emailFetchImpl } = opts
  // Built once for the plugin, not per request: the analytics hook closes over
  // nothing request-scoped, and `Order Completed` must look identical whether it
  // came from the shopper's verify call, Razorpay's webhook, or the sweep.
  const wiring = resolvePaymentWiring(opts)
  // `carrierCode` and the analytics hook are reached through `paidHooks`, which
  // is the only thing that should be composing them.
  const { gateway, notificationChannels, adminOrigin } = wiring

  // --- Authed JSON routes (own encapsulated scope; normal JSON parsing) -------
  app.register(async (scope) => {
    const authed = scope.withTypeProvider<ZodTypeProvider>()
    authed.addHook('onRequest', authed.authenticate)

    authed.post(
      '/orders',
      {
        schema: {
          body: PaymentOrderCreateSchema,
          response: { 201: PaymentOrderSchema, ...errorResponses },
        },
      },
      async (request, reply) => {
        const gw = await requirePaymentsEnabled(db, gateway)
        // Terms + Privacy consent is captured at login (plugins/auth.ts), not
        // per-order. This should never trip in practice — a shopper can't
        // reach an authed route without a login that set it true — but the
        // charge is guarded on it anyway rather than trusting that invariant.
        if (!request.user.consentAccepted) throw validationFailed('Consent required')
        // Ownership check: getAddress 404s for a foreign/unknown id.
        const address = await getAddress(db, request.user.id, request.body.addressId)

        // Delivery is priced against THIS ORDER'S address and nothing else. The
        // cart screen may have previewed a `?pincode=`; that number has no
        // authority here, which is the whole reason the preview is safe.
        const destPincode = String(address.pincode ?? '')

        const context = await loadShippingContext(db, destPincode)
        let priced: PricedShipping | undefined
        // Kept so the quote can be re-priced once the payment mode is known —
        // see the COD re-price below. The resolver is the only place these
        // inputs exist, and `getCart` does not hand them back.
        let pricedFrom: Parameters<CartShippingResolver>[0] | undefined
        const resolveShipping: CartShippingResolver = (input) => {
          pricedFrom = input
          priced = priceShipping({ context, destPincode, ...input })
          return priced.block
        }

        // Single pricing source — same wholesale + coupon resolution as the
        // cart routes. `skus`, when the client sent a cart-screen selection,
        // prices/orders only those lines; the rest of the cart is untouched
        // by this order. `couponCode`, when sent, is re-resolved against the
        // coupons table here (never trusting a client-supplied discount), so
        // the priced cart — and therefore the Razorpay amount — already
        // reflects it.
        const cart = await getCart(
          db,
          request.user.id,
          await resolveWholesaleRule(db),
          request.body.skus,
          await resolveCouponRule(db, request.body.couponCode, request.user.id),
          resolveShipping
        )

        // COD eligibility is re-evaluated HERE, against THIS order's address
        // and the cap as it stands right now — never against whatever the cart
        // screen was told a moment ago (docs/SPEC-COD.md D7). It runs after the
        // cart is priced because the ceiling and the token both apply to the
        // final total, delivery included.
        const cod =
          request.body.paymentMode === 'cod'
            ? await assertCodAllowed(db, {
                cartTotalInr: cart.totalInr,
                destPincode,
              })
            : undefined

        // Re-price the SNAPSHOT with the COD component now that the mode is
        // settled. Safe to do after the cart was priced because this moves
        // nothing the shopper saw — not the courier, not the fee, not the
        // total (docs/SPEC-COD.md D8) — so `cart.totalInr` and the quote token
        // below are still the ones they were shown. All it changes is
        // `trueCostInr`, which is what the margin report reads.
        if (cod && pricedFrom) {
          priced = priceShipping({ context, destPincode, ...pricedFrom, isCod: true })
        }

        const token = request.body.quoteToken
        const quoteStale =
          token !== undefined &&
          !verifyQuoteToken(token, quotePayloadFor(cart.shipping, cart.updatedAt)).ok

        // Resolve the stock cascade HERE, in the route, because
        // `services/payments.ts` may not import another module's service
        // (ARCHITECTURE.md rule 2). The winning shelf per sku is frozen into
        // `cart_snapshot` so the decrement on capture takes units off the shop
        // we actually promised, not off whichever shop happens to be nearest
        // when the money lands.
        //
        // A failure here NEVER blocks the order. Availability was already shown
        // to the shopper on the PDP; refusing a checkout because a stock query
        // fell over would turn an inventory bookkeeping problem into a lost
        // sale. Un-stamped lines simply do not decrement, and the admin panel's
        // audit view is where that shows up.
        const stockOrigins = new Map<string, string>()
        try {
          const activeSkus = cart.items
            .filter((line) => line.active && line.qty > 0)
            .map((line) => line.sku)
          if (activeSkus.length > 0) {
            for (const result of await checkAvailability(db, destPincode, activeSkus)) {
              if (result.origin) stockOrigins.set(result.sku, result.origin.nodeId)
            }
          }
        } catch (err) {
          request.log.error(
            { err, destPincode },
            'stock cascade failed at order create; no origins stamped'
          )
        }

        const order = await createOrder(
          db,
          gw,
          request.user.id,
          cart,
          address,
          {
            blocksOrder: priced?.blocksOrder ?? false,
            feeInr: cart.shipping.feeInr,
            snapshot: priced?.snapshot ?? null,
            quoteStale,
          },
          stockOrigins,
          // Frozen onto the row now so the server-side `Order Completed` can be
          // stitched to the session that produced it. Captured at CREATE rather
          // than read at capture time because by then the request may be a
          // webhook from Razorpay or the recovery sweep — neither of which has
          // any connection to the shopper's device.
          request.body.anonymousId,
          request.body.marketingWhatsappOptIn,
          request.body.attribution,
          // The shopper's own "how did you hear about us?" answer. Frozen next
          // to the UTMs, never merged with them — see `OrderSurvey`.
          request.body.heardAbout === undefined && request.body.heardAboutOther === undefined
            ? undefined
            : {
                heardAbout: request.body.heardAbout,
                heardAboutOther: request.body.heardAboutOther,
              },
          // Only the token travels down. The service does not re-derive
          // eligibility (it may not import another module's service); the
          // guard above is the authority.
          cod ? { tokenInr: cod.tokenInr } : undefined,
          request.body.adAudienceOptIn
        )

        // The order snapshot froze what was agreed at this instant; this is the
        // live state a send actually consults. Written after `createOrder` so a
        // failed order does not leave a consent change behind, and awaited so a
        // shopper who ticks the box at checkout is opted in before the
        // replenishment task for THIS order could ever fire.
        if (request.body.marketingWhatsappOptIn !== undefined) {
          await setMarketingWhatsappOptIn(db, request.user.id, request.body.marketingWhatsappOptIn)
        }
        if (request.body.adAudienceOptIn !== undefined) {
          await setAdAudienceOptIn(db, request.user.id, request.body.adAudienceOptIn)
        }

        // The one sweep with no success signal to hang a task on: recovery
        // exists precisely because BOTH the client's `/verify` and Razorpay's
        // webhook can be lost, and when they are, nothing downstream ever fires.
        // So the check is scheduled HERE, at create, while there is still an
        // event to hook — before anything can go missing.
        //
        // `RECOVER_STALE_AFTER_MS` + a minute, rounded up to the next 15-minute
        // boundary: a task that fired earlier would find this row too young to
        // be eligible and waste the wake, and every order created in the same
        // window collapses onto that one boundary — one task, one Neon wake,
        // draining all of them. Zero orders means zero tasks and no wake at all,
        // which is the entire point.
        if (opts.tasks) {
          requestSweep(
            opts.tasks,
            'payments-recover',
            request.log,
            RECOVER_BUCKET_MS,
            new Date(Date.now() + RECOVER_STALE_AFTER_MS + MINUTE_MS)
          )
        }
        // The nudge for a shopper who leaves before paying (the ₹49 COD token
        // or the full prepaid amount). Scheduled for every order; the task
        // decides on arrival whether the order is still unpaid. Not awaited
        // into the response: the shopper is waiting on the Razorpay sheet.
        if (opts.followUpTasks) {
          void schedulePaymentReminder(
            db,
            order.orderId,
            new Date(),
            opts.followUpTasks,
            request.log
          )
        }
        return reply.code(201).send(order)
      }
    )

    authed.post(
      '/verify',
      {
        schema: {
          body: PaymentVerifySchema,
          response: { 200: PaymentVerifyResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        const gw = await requirePaymentsEnabled(db, gateway)
        // The invoice is minted INSIDE the transition (so it happens exactly
        // once across verify/webhook/recover) and mailed AFTER it commits — the
        // capture object is how the number crosses that boundary.
        const capture = newInvoiceCapture()
        const result = await verifyPayment(
          db,
          gw,
          request.user.id,
          request.body,
          paidHooks(opts, wiring, capture, request.log),
          (obj, msg) => request.log.error(obj, msg)
        )
        sendCapturedInvoiceEmails(db, capture, email, emailFetchImpl, request.log, opts.tasks)
        return result
      }
    )

    // The mobile UPI-intent path (see `createUpiIntent`). Additive: Checkout is
    // unchanged, and a 503 here — keys absent, `payments.enabled` off, or the
    // intent kill switch flipped — is the client's signal to open Checkout as
    // before rather than to fail the purchase.
    authed.post(
      '/orders/:orderId/upi/intent',
      {
        schema: {
          params: PaymentOrderParamsSchema,
          response: { 201: UpiIntentSchema, ...errorResponses },
        },
      },
      async (request, reply) => {
        const gw = await requirePaymentsEnabled(db, gateway)
        const policy = await resolveUpiIntentPolicy(db)
        if (!policy.enabled) throw paymentsDisabled('UPI app payment is currently unavailable')

        // Razorpay wants the shopper's own client facts on an S2S create. The
        // app sends no Referer (it is not a browser), so the store origin
        // stands in — the header exists to tell the gateway which merchant
        // surface the payment came from, and inventing a fake page URL would
        // say less than the truth does.
        const forwarded = request.headers['x-forwarded-for']
        const ip =
          (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
          request.ip
        const userAgent = request.headers['user-agent']
        const referer = request.headers.referer

        const intent = await createUpiIntent(
          db,
          gw,
          request.user.id,
          request.params.orderId,
          {
            ip,
            userAgent: typeof userAgent === 'string' && userAgent ? userAgent : 'laanya-mobile',
            referer: typeof referer === 'string' && referer ? referer : adminOrigin,
          },
          policy.expiryMinutes
        )
        return reply.code(201).send(intent)
      }
    )

    authed.get(
      '/orders/:orderId',
      {
        schema: {
          params: PaymentOrderParamsSchema,
          response: { 200: PaymentStatusResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        // Deliberately NOT `requirePaymentsEnabled`: that throws 503, and
        // "what is my order's status" must keep answering when payments are
        // switched off or unconfigured. No gateway simply means no live
        // lookup — the stored status, exactly as before.
        const capture = newInvoiceCapture()
        let live: PollLiveLookup | undefined
        if (gateway && (await getConfigValue(db, 'payments.enabled')) !== false) {
          live = {
            gateway,
            hooks: paidHooks(opts, wiring, capture, request.log),
            log: (obj, msg) => request.log.error(obj, msg),
          }
        }
        const result = await getOrderStatus(db, request.user.id, request.params.orderId, live)
        // No-op unless this poll was the observer that transitioned the order —
        // the same once-per-order guarantee the other three paths rely on.
        sendCapturedInvoiceEmails(db, capture, email, emailFetchImpl, request.log, opts.tasks)
        return result
      }
    )

    authed.get(
      '/orders',
      { schema: { response: { 200: OrderListResponseSchema, ...errorResponses } } },
      async (request) => ({
        orders: await listOrders(db, request.user.id, await resolveRefundPolicy(db)),
      })
    )

    authed.get(
      '/orders/:orderId/details',
      {
        schema: {
          params: PaymentOrderParamsSchema,
          response: { 200: OrderDetailSchema, ...errorResponses },
        },
      },
      async (request) =>
        getOrderDetail(db, request.user.id, request.params.orderId, await resolveRefundPolicy(db))
    )

    // Ungated like `.../details` above — this only reads a stored row, it
    // never calls Razorpay, so `requirePaymentsEnabled` does not apply.
    authed.get(
      '/orders/:orderId/invoice',
      {
        schema: {
          params: PaymentOrderParamsSchema,
          response: { 200: OrderInvoiceSchema, ...errorResponses },
        },
      },
      async (request) => {
        const seller = await resolveInvoiceSeller(db)
        return getOrderInvoice(db, request.user.id, request.params.orderId, seller)
      }
    )

    authed.post(
      '/orders/:orderId/cancel',
      {
        schema: {
          params: PaymentOrderParamsSchema,
          body: OrderCancelBodySchema,
          response: { 200: OrderCancelResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        const gw = await requirePaymentsEnabled(db, gateway)
        const result = await cancelOrder(
          db,
          gw,
          request.user.id,
          request.params.orderId,
          request.body?.reason,
          makeCancelPolicy({
            db,
            log: request.log,
            adminOrigin,
            ...(opts.carrierAdapter ? { adapter: opts.carrierAdapter } : {}),
          }),
          {
            onOrderRefunded: composeOrderRefundHooks(
              makeCreditNoteIssuanceHook({ log: request.log }),
              makeCouponRevokeHook(request.log),
              makeOrderCancelledNotificationHook({ adminOrigin, log: request.log })
            ),
          }
        )
        // One drain for both rows this request can produce — the cancellation
        // notice (enqueued inside the refund transaction) and the stuck-parcel
        // alert (enqueued by `onCancelled`, after it). Both are durable by the
        // time `cancelOrder` returns, and this is fire-and-forget, so a WhatsApp
        // outage cannot delay or fail the response the shopper is waiting on.
        sendPendingOpsNotifications(
          db,
          result.orderId,
          notificationChannels,
          request.log,
          opts.tasks
        )
        return result
      }
    )

    // Admin-only reconciliation read: every attempt Razorpay ever reported for
    // this order, including the declines and the amount mismatches that leave
    // the order row untouched. Deliberately NOT on the shopper's
    // `/orders/:orderId/details` — gateway error codes and payment ids are ops
    // data, and a shopper reading "BAD_REQUEST_ERROR" learns nothing useful.
    authed.get(
      '/orders/:orderId/attempts',
      {
        onRequest: authed.requireAdmin,
        schema: {
          params: PaymentOrderParamsSchema,
          response: { 200: PaymentAttemptListSchema, ...errorResponses },
        },
      },
      async (request) => ({ attempts: await listPaymentAttempts(db, request.params.orderId) })
    )

    authed.post(
      '/recover',
      {
        // Admin-only: requireAdmin runs after the scope's `authenticate` hook
        // (it reads request.user), matching the admin/config + admin/catalog routes.
        onRequest: authed.requireAdmin,
        schema: { response: { 200: PaymentRecoverResponseSchema, ...errorResponses } },
      },
      // Delegates to the same runner the scheduled sweep calls, so pressing the
      // button and waiting for the cron produce the same order. Unlike the sweep
      // this one still 503s when payments are off — a human pressed it and is
      // owed the reason.
      async (request) => runPaymentRecoverSweep(opts, request.log)
    )
  })

  // --- Webhook (own encapsulated scope; RAW-body parser, NO auth) -------------
  // The scoped content-type parser lives ONLY here, so the authed JSON scope
  // above (and every other route in the app) keeps normal JSON parsing.
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body)
    )

    hook.post('/webhook', async (request, reply) => {
      // Unconfigured webhook secret → 503 (SPEC-PAYMENTS.md webhook row).
      const gw = await requirePaymentsEnabled(db, gateway)
      const rawBody = request.body as Buffer
      const signature = request.headers['x-razorpay-signature']
      const capture = newInvoiceCapture()
      const refunded: string[] = []
      await handleWebhook(
        db,
        gw,
        Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? ''),
        typeof signature === 'string' ? signature : undefined,
        (obj, msg) => request.log.error(obj, msg),
        {
          ...paidHooks(opts, wiring, capture, request.log),
          onOrderRefunded: composeOrderRefundHooks(
            makeCreditNoteIssuanceHook({ log: request.log }),
            makeCouponRevokeHook(request.log),
            makeOrderCancelledNotificationHook({ adminOrigin, log: request.log }),
            // Records which order the refund branch actually transitioned, so
            // the drain below knows what to flush. A rolled-back transaction
            // leaves an id here with no rows behind it, which the drain reads
            // as "nothing owed" — the same no-op a replay produces.
            async (_tx, orderId) => {
              refunded.push(orderId)
            }
          ),
        }
      )
      for (const orderId of refunded) {
        sendPendingOpsNotifications(db, orderId, notificationChannels, request.log, opts.tasks)
      }
      // Whichever of webhook/verify wins the race performed the transition, and
      // only that one's hook ran — so this mails at most one copy per order.
      sendCapturedInvoiceEmails(db, capture, email, emailFetchImpl, request.log, opts.tasks)
      // A valid signature always yields 200, even if processing was left for
      // recover; a bad/missing signature threw signatureInvalid → 400 above.
      return reply.code(200).send({ ok: true })
    })
  })
}
