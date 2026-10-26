/**
 * Payments business rules (SPEC-PAYMENTS.md v3). A port of the
 * adixai-payment-service Razorpay flow — server-side pricing, timing-safe HMAC
 * verification, idempotent grant-on-capture, raw-body webhook, recover sweep —
 * onto Fastify/TS/Zod/Drizzle/Neon.
 *
 * FOUR paths can transition an order to `paid`, all through the one guarded
 * `markPaid`: the shopper's `verify`, the webhook, the status poll's live
 * lookup (the mobile UPI intent flow has no signature, so there is no verify
 * call on it) and the recover sweep. `payment_attempts.observed_by` records
 * which one won.
 *
 * Cross-module rule (docs/ARCHITECTURE.md): this module owns the `payments`
 * table and consumes the shared `users`/`cart_items`/`addresses` read models;
 * it never imports another module's service and never reads `app_config` or
 * `env` directly. The ROUTE layer resolves config (`payments.enabled`, the
 * wholesale rule → a priced cart, the Razorpay secrets → a {@link
 * PaymentsGateway}) and hands plain values in. The single pricing source is
 * the cart read API, so the amount is NEVER client-supplied.
 *
 * Security invariants (each has a test — SPEC-PAYMENTS.md §"Security invariants"):
 * 1. Amount computed server-side from the cart, never the request body.
 * 2. Rows are user-scoped; cross-user access reads as 404.
 * 3. Webhook HMAC is over the RAW request body (the route wires a scoped
 *    buffer parser; this module receives the raw `Buffer`).
 * 4. Every signature comparison: length pre-check then `crypto.timingSafeEqual`.
 * 5. The `paid` transition is a single guarded UPDATE (`status in
 *    ('pending','failed')` predicate — `failed` is included so a Checkout retry
 *    after a decline still lands; see `markPaid`) — replays are no-ops. On the
 *    webhook path the event amount AND currency must equal the stored row; a
 *    mismatch does NOT transition and is logged ERROR for manual review, plus
 *    recorded in `payment_attempts` so it is queryable per order.
 * 6. The `paid` transition clears the user's `cart_items` in the SAME transaction.
 * 7. No key material in responses beyond the public `keyId`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'

import type {
  InvoiceSeller,
  Order,
  OrderCancelResponse,
  OrderDetail,
  OrderInvoice,
  OrderItem,
  OrderRefund,
  PaymentAttempt,
  PaymentOrder,
  PaymentRecoverResponse,
  PaymentStatusResponse,
  PaymentVerify,
  PaymentVerifyResponse,
  UpiApp,
  UpiIntent,
  UpiIntentApp,
} from '../contracts/payment.js'
import type { Db } from '../db/client.js'
import { cartItems, paymentAttempts, payments, users, type PaymentRow } from '../db/schema.js'
import {
  conflict,
  notFound,
  shippingQuoteStale,
  shippingUnserviceable,
  signatureInvalid,
  validationFailed,
} from '../lib/errors.js'
import { RAZORPAY_STORE_TAG } from '../lib/brand.js'
import { gatewayErrorDescription, type PaymentsGateway, type RazorpayApi } from '../lib/razorpay.js'
import { getItemsBySkus, getSkusByProductId, type CatalogItem } from './catalog.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Pending payments older than this are eligible for the recover sweep. */
export const RECOVER_STALE_AFTER_MS = 15 * 60 * 1000
/**
 * How old a pending row must be before the status poll will ask Razorpay about
 * it directly. Below this the order was created moments ago and no payment can
 * plausibly have been captured yet, so the round trip would buy nothing.
 */
export const POLL_LIVE_AFTER_MS = 5 * 1000
/**
 * Floor on the gap between two live gateway lookups for the SAME order,
 * whoever asks. The mobile client polls every 3s while a UPI intent is open;
 * this keeps that at roughly one Razorpay call per paying shopper per interval
 * and stops a client that polls faster (or several tabs of one) from
 * multiplying it.
 */
export const POLL_LIVE_MIN_INTERVAL_MS = 3 * 1000
/** A pending order with no captured payment after this long is failed by recover. */
export const RECOVER_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000
/**
 * Most rows one recover run will touch.
 *
 * The sweep makes ONE Razorpay round trip per stale row, serially, holding a
 * Neon compute awake for the whole loop — and the stale set is dominated by
 * abandoned checkouts, not by dropped payments: an abandoned cart leaves a
 * `pending` row that is indistinguishable from a lost capture until Razorpay is
 * asked, and it stays eligible for the full {@link RECOVER_EXPIRE_AFTER_MS}
 * window. Uncapped, a backlog of abandoned carts would turn a 30-second sweep
 * into a multi-minute one that bills compute the whole time and can outrun
 * Cloud Scheduler's 300s attempt deadline.
 *
 * Capped, the overflow is simply picked up by the next run — the sweep is a
 * drain, not a deadline. Rows are taken oldest-first so a backlog cannot starve
 * the orders that have been stuck longest.
 *
 * **Why 30 and not 100.** 100 serial round trips at a realistic 3s each is 300s
 * — Cloud Scheduler's attempt deadline exactly. A run that reaches the deadline
 * is not a clean partial: Cloud Scheduler marks it failed and retries, Cloud Run
 * leaves the original handler running, and the retry re-reads the same rows the
 * first attempt is still working through. 30 leaves the whole run comfortably
 * inside the deadline even when Razorpay is slow, and the overflow is picked up
 * by the next pass exactly as the cap was always designed for.
 * {@link RECOVER_TIME_BUDGET_MS} is the belt to this braces.
 */
export const RECOVER_MAX_BATCH = 30

/**
 * How long one recover run may spend in its per-row loop before it stops early
 * and leaves the rest for the next pass.
 *
 * The row cap bounds the COUNT of Razorpay round trips; it cannot bound their
 * DURATION. One gateway incident where every call sits at its timeout turns a
 * capped batch into a run that still outlives the 300s attempt deadline. This
 * is the guard that makes the sweep's cost a property of the sweep rather than
 * of Razorpay's worst day: 120s, well under the deadline, leaving room for the
 * in-flight call to finish and the response to be written.
 *
 * Stopping early is free of consequence — unvisited rows were never modified and
 * stay eligible, and the oldest-first ordering means the run always spends its
 * budget on the orders that have been stuck longest.
 */
export const RECOVER_TIME_BUDGET_MS = 120 * 1000

/**
 * A priced cart, as the ROUTE resolves it via the cart read API (wholesale
 * already applied). `totalInr` is the amount due; `items` freeze the priced
 * lines into `cart_snapshot`. Structurally a subset of the cart contract, so
 * the route can pass the `Cart` straight through.
 */
export interface PricedCart {
  items: Array<{ sku: string; qty: number; priceInr: number; active: boolean }>
  totalInr: number
  /**
   * Post-wholesale goods subtotal and the coupon taken off it. `code` is the
   * UPPERCASE code the discount came from — frozen into `cart_snapshot` so the
   * redemption ledger can be written at capture time, when the only thing in
   * hand is the row. Null when no code was requested; present-but-undiscounted
   * when the code did not apply, which is why the redemption hook keys off
   * `couponDiscountInr > 0` rather than off the code alone.
   */
  coupon?: { subtotalInr: number; discountInr: number; code?: string | null }
  /** The delivery block the cart was priced with; absent means no shipping fee. */
  shipping?: { feeInr: number }
}

/**
 * The shape frozen into `cart_snapshot` at order-create time.
 *
 * `totalInr` alone stopped being self-explanatory once delivery joined it:
 * Σ(items) no longer equals the total, and the order-history screen would show
 * an unexplained gap. So the components are frozen alongside it. Rows written
 * before this existed carry only `items` + `totalInr`, which is why every
 * reader treats the new fields as optional and derives `goodsInr` from
 * `totalInr` when they are missing.
 */
export interface CartSnapshot {
  items: Array<{
    sku: string
    qty: number
    priceInr: number
    active: boolean
    /**
     * The `pickup_nodes.id` the stock cascade picked for this line at ORDER
     * CREATE time, frozen here so the decrement on capture takes units off the
     * shelf we actually promised (docs/SPEC-STOCK.md §9).
     *
     * Frozen rather than recomputed because the cascade is a function of the
     * shopper's location AND of live stock: re-running it minutes later, after
     * another order has emptied the nearest shelf, would decrement a DIFFERENT
     * shop than the one whose availability the shopper was shown. The audit
     * trail would then record units leaving a shelf that never held this order.
     *
     * Optional and frequently absent — every row written before the stock
     * module existed lacks it, `force_in` produces no origin at all, and the
     * cascade may legitimately have found nothing. Absent simply means no
     * decrement runs.
     */
    stockNodeId?: string
    /**
     * `products.hsnCode`/`gstRatePct` at order time (docs plan §2.1) — frozen
     * here, exactly like `priceInr`, so a rate change or HSN correction made
     * after this order never alters a document already computed from it.
     * Optional: every row written before the tax engine existed lacks these,
     * and `orderInvoiceSourceFromRow` falls back to `''`/`0` for them, which
     * is what forces those orders' invoices to stay v1 (untaxed).
     */
    hsn?: string
    gstRatePct?: number
  }>
  totalInr: number
  goodsInr?: number
  couponDiscountInr?: number
  /**
   * The coupon code that produced `couponDiscountInr`, UPPERCASE. Optional and
   * absent on every order placed before the redemption ledger existed — which
   * is exactly why that ledger cannot be backfilled: those orders recorded the
   * rupees and threw the code away.
   */
  couponCode?: string
  shippingFeeInr?: number
}

/**
 * Everything an invoice needs to know about an order, read out of THIS module's
 * own row. Exported so the invoice composer (routes/invoices.ts) can build a
 * document without querying `payments` itself — ARCHITECTURE.md rule 2 cuts
 * both ways, and a stable shape here is cheaper than another module learning
 * this table's jsonb layout.
 */
export interface OrderInvoiceSource {
  orderId: string
  userId: string
  status: 'paid' | 'refunded'
  createdAt: Date
  paidAt: Date | null
  /** Gateway payment reference; null for a row that never carried one. */
  paymentReference: string | null
  amountPaise: number
  /** The `address_snapshot` frozen at order time — never the shopper's CURRENT address. */
  address: Record<string, unknown>
  /** `hsn`/`gstRatePct` are `''`/`0` for a pre-tax-engine order — see `CartSnapshot.items[].hsn`. */
  lines: Array<{ sku: string; qty: number; priceInr: number; hsn: string; gstRatePct: number }>
  goodsInr: number
  couponDiscountInr: number
  /** The code redeemed, or null for no coupon / an order that predates `CartSnapshot.couponCode`. */
  couponCode: string | null
  shippingFeeInr: number
  totalInr: number
}

/**
 * Row → {@link OrderInvoiceSource}. Pure, so the paid-order hook can use the
 * row it already has in hand rather than re-reading it inside the transition.
 * Returns undefined for a row that is not invoiceable: money must actually have
 * changed hands, so `pending`/`failed` have no invoice to issue.
 *
 * The `?? totalInr` / `?? 0` fallbacks are for rows written before delivery and
 * coupons existed, where the total WAS the goods — same rule every other reader
 * of `cart_snapshot` in this file applies.
 */
export function orderInvoiceSourceFromRow(row: PaymentRow): OrderInvoiceSource | undefined {
  if (row.status !== 'paid' && row.status !== 'refunded') return undefined
  const snapshot = row.cartSnapshot as CartSnapshot
  return {
    orderId: row.orderId,
    userId: row.userId,
    status: row.status,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    paymentReference: row.razorpayPaymentId,
    amountPaise: row.amountPaise,
    address: row.addressSnapshot as Record<string, unknown>,
    lines: snapshot.items.map((line) => ({
      sku: line.sku,
      qty: line.qty,
      priceInr: line.priceInr,
      hsn: line.hsn ?? '',
      gstRatePct: line.gstRatePct ?? 0,
    })),
    goodsInr: snapshot.goodsInr ?? snapshot.totalInr,
    couponDiscountInr: snapshot.couponDiscountInr ?? 0,
    couponCode: snapshot.couponCode ?? null,
    shippingFeeInr: snapshot.shippingFeeInr ?? 0,
    totalInr: snapshot.totalInr,
  }
}

/** One order's invoice source, by id. Undefined for an unknown or not-yet-paid order. */
export async function readOrderForInvoice(
  db: Db,
  orderId: string
): Promise<OrderInvoiceSource | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  return row ? orderInvoiceSourceFromRow(row) : undefined
}

/** Every `paid`/`refunded` order, oldest first — the order `scripts/backfill-invoices.ts` numbers them in. */
export async function listOrdersForInvoiceBackfill(db: Db): Promise<OrderInvoiceSource[]> {
  const rows = await db
    .select()
    .from(payments)
    .where(inArray(payments.status, ['paid', 'refunded']))
    // `paidAt` is null on rows that predate it, so `createdAt` is the tiebreak
    // that keeps the retroactive numbering chronological rather than arbitrary.
    .orderBy(payments.paidAt, payments.createdAt)
  return rows.map(orderInvoiceSourceFromRow).filter((o): o is OrderInvoiceSource => o !== undefined)
}

/**
 * Called inside the `paid` transition's OWN transaction, once, only when this
 * call performed the transition (never on a replay).
 *
 * A hook rather than a direct import because ARCHITECTURE.md rule 2 forbids one
 * service importing another's — but the decrement must share the payment's
 * transaction to be worth anything, so the route layer cannot make this call
 * itself the way it does for `hasPurchasedProduct`. Injecting it keeps payments
 * ignorant of stock while still giving stock the transaction.
 *
 * **It must not throw.** By the time it runs the money is captured; an
 * exception here rolls back a transition the payment processor has already
 * made, and the shopper has paid for an order that does not exist. The wiring
 * in `routes/payments.ts` is what guarantees that, not this type.
 */
export type OrderPaidHook = (
  tx: Tx,
  orderId: string,
  lines: ReadonlyArray<{ sku: string; qty: number; stockNodeId?: string | undefined }>,
  /**
   * The order as an invoice sees it, derived from the row this transition just
   * flipped. Passed rather than re-read because the hook runs INSIDE the
   * transaction: a second read would see the pre-update row on some drivers and
   * would cost a round trip on all of them. Hooks that don't need it (the stock
   * decrement) simply declare fewer parameters.
   */
  order: OrderInvoiceSource
) => Promise<void>

/**
 * Called inside the `refunded` transition's OWN transaction, once, only when
 * this call performed the transition (never on a replay) — same contract as
 * {@link OrderPaidHook}, mirrored for the inverse transition.
 *
 * **Must not throw.** By the time it runs the refund has already happened
 * outside our database — the Razorpay refund call in `cancelOrder`, or
 * Razorpay's own `refund.processed` webhook — so an exception here would roll
 * back a transition that cannot be un-done upstream. The wiring in
 * `routes/payments.ts` is what guarantees that, not this type.
 */
export type OrderRefundHook = (
  tx: Tx,
  orderId: string,
  order: OrderInvoiceSource,
  /** Shopper-given cancel reason, or a fallback string when the transition has none (e.g. the webhook path). */
  reason: string
) => Promise<void>

/**
 * What a winning `paid` transition just wrote, handed to the caller so it can
 * act AFTER the transaction commits.
 *
 * `markPaid` returns this instead of a bare boolean because "did I win the
 * race" and "what did I win" are the same question, and answering it in one
 * place is what keeps the exactly-once guard in one place. The three call
 * sites (verify, webhook, recover sweep) forward this value; none of them
 * re-derives the guard, which is the mistake the original boolean invited.
 */
export interface PaidTransition {
  order: OrderInvoiceSource
  /** The client's RudderStack anonymous id, frozen at order-create. */
  anonymousId: string | null
  /**
   * The campaign that produced the order, frozen at order-create. Carried to
   * the analytics hook so `Order Completed` lands in the warehouse already
   * attributed — the join that makes realised CAC computable.
   */
  attribution: OrderAttribution | null
  /**
   * The pickup node the stock cascade chose (`shipping_snapshot.nodeCode`), so
   * revenue can be attributed per store without a second query. Null for orders
   * placed before shipping existed, or while `shipping.enabled` is off.
   */
  storeCode: string | null
}

export interface PaymentHooks {
  onOrderPaid?: OrderPaidHook | undefined
  /**
   * Called AFTER the transition's transaction has committed, exactly once per
   * order — never on a replay, and never for a transaction that rolled back.
   *
   * That distinction is the entire reason this exists separately from
   * `onOrderPaid`. Analytics `Order Completed` is a purchase event: it feeds
   * revenue reporting and bids at Meta and Google Ads. Emitting it from inside
   * the transaction would announce a sale that a later rollback un-makes, and
   * no downstream system has any way to take that back.
   *
   * Synchronous and fire-and-forget by contract: the shopper's confirmation
   * must not wait on an analytics round trip. Like `onOrderPaid` it must not
   * throw — but the cost of a breach here is only a missing report row, since
   * the money and the order are already durable by the time it runs.
   */
  onOrderPaidCommitted?: ((paid: PaidTransition) => void) | undefined
  onOrderRefunded?: OrderRefundHook | undefined
}

/**
 * Whether a shopper may still cancel their own order, injected by
 * `routes/payments.ts` so that payments stays ignorant of fulfilment (same
 * reason `OrderPaidHook` is injected rather than imported).
 *
 * Absent ⇒ every paid order is cancellable, which is exactly the behaviour that
 * held before any courier existed.
 */
export interface OrderCancelPolicy {
  /**
   * A shopper-facing reason to refuse, or null to allow. Runs BEFORE any money
   * moves — a refund cannot be un-issued once the gateway has taken it.
   */
  block: (orderId: string) => Promise<string | null>
  /**
   * Runs after the refund has landed and the row is `refunded`.
   *
   * **Must not throw.** The money is already back with the shopper by this
   * point, so an exception here would report a failure for a cancellation that
   * fully succeeded. `routes/payments.ts` is what guarantees that, not this type.
   */
  onCancelled?: ((orderId: string) => Promise<void>) | undefined
}

/**
 * The delivery decision for this order, resolved by the route against the
 * ORDER'S OWN address — never a client-supplied pincode.
 */
export interface OrderShipping {
  /** Refuse the order outright: we cannot deliver there. */
  blocksOrder: boolean
  /** What the shopper is charged for delivery, already included in `cart.totalInr`. */
  feeInr: number
  /** Frozen onto the row for the ops margin report; null when no courier was chosen. */
  snapshot: unknown | null
  /** True when the client sent a quote token that no longer matches this quote. */
  quoteStale: boolean
}

/** The shipping address to freeze into `address_snapshot` (route resolves + ownership-checks it). */
export type AddressSnapshot = Record<string, unknown>

/** INR (whole rupees) → paise. */
function toPaise(inr: number): number {
  return inr * 100
}

/**
 * Timing-safe HMAC-SHA256 comparison. Computes HMAC of `payload` under
 * `secret`, then compares against `expectedHex` with a length pre-check
 * followed by `crypto.timingSafeEqual` (SPEC-PAYMENTS.md §"Security invariants"
 * #4 — `timingSafeEqual` throws on unequal lengths, so the pre-check is
 * required, not optional).
 */
function verifyHmacSha256(payload: string, secret: string, expectedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'utf8')
  const actual = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** DB row → the `PaymentOrder` shape the client opens Checkout with. */
function toPaymentOrder(row: PaymentRow, keyId: string, mode: 'test' | 'live'): PaymentOrder {
  return {
    orderId: row.orderId,
    keyId,
    amountInr: row.prepaidAmountPaise / 100,
    amountPaise: row.prepaidAmountPaise,
    currency: 'INR',
    status: row.status as PaymentOrder['status'],
    mode,
    orderTotalInr: row.amountPaise / 100,
  }
}

/**
 * POST /v1/payments/orders — price the caller's cart (done by the route via the
 * cart read API; the amount is the server-computed `cart.totalInr`), create a
 * Razorpay order for that amount, and insert a `pending` row snapshotting the
 * priced cart + the (ownership-checked) shipping address. An empty cart — no
 * ACTIVE lines / a zero total — is a 422 `validation_failed`.
 */
/**
 * What we know about the campaign that produced an order. Every field
 * optional: most orders are organic and carry none of it.
 */
export interface OrderAttribution {
  utmSource?: string | undefined
  utmMedium?: string | undefined
  utmCampaign?: string | undefined
  utmContent?: string | undefined
  gclid?: string | undefined
  oppref?: string | undefined
}

/**
 * The shopper's own answer to "How did you hear about us?", asked at checkout.
 *
 * Kept as its own type rather than folded into `OrderAttribution` on purpose:
 * attribution is what the click claimed, this is what the person says, and the
 * two are never summed. Both may be present on one order and disagree — an
 * Instagram discovery that converted days later on a paid brand click is the
 * normal case, not a conflict to resolve.
 */
export interface OrderSurvey {
  heardAbout?: string | undefined
  /** Only ever set alongside `heardAbout === 'other'`; the contract enforces it. */
  heardAboutOther?: string | undefined
}

export async function createOrder(
  db: Db,
  gateway: PaymentsGateway,
  userId: string,
  cart: PricedCart,
  address: AddressSnapshot,
  shipping?: OrderShipping,
  /**
   * sku -> the `pickup_nodes.id` the stock cascade chose for this shopper,
   * resolved by the ROUTE (ARCHITECTURE.md rule 2 — this service must not
   * import the stock service). Absent skus are simply not stamped, and a
   * missing map disables origin stamping entirely, which is what every caller
   * written before the stock module did.
   */
  stockOrigins?: ReadonlyMap<string, string>,
  /**
   * The caller's RudderStack `anonymousId`, straight off the request body.
   * Frozen onto the row so the server-side `Order Completed` can be stitched to
   * the session that produced the sale — see the column's own note in
   * `db/schema.ts`. Opaque and untrusted: echoed into the event stream, never
   * read back for any decision.
   */
  analyticsAnonymousId?: string,
  /**
   * WhatsApp MARKETING opt-in as ticked at checkout. Undefined ⇒ the client
   * did not present the checkbox (an older build), which is NOT the same as a
   * declined one and must not be recorded as an answer.
   */
  marketingWhatsappOptIn?: boolean,
  /**
   * Campaign attribution off the landing URL, straight from the request body.
   * Frozen here for the same reason `analyticsAnonymousId` is — see the
   * columns' note in `db/schema.ts`. Opaque and untrusted: written to the row
   * and echoed into the event stream, never read back for a decision.
   */
  attribution?: OrderAttribution,
  /**
   * The checkout survey answer, straight from the request body. Frozen here
   * like everything else on this row. Optional at every layer: most orders
   * will not carry one, because the question is skippable by design.
   */
  survey?: OrderSurvey,
  /**
   * Ad-audience opt-in as ticked at checkout. Same undefined-is-not-an-answer
   * rule as `marketingWhatsappOptIn`, and itemised separately in the snapshot
   * because it is a separate purpose.
   */
  adAudienceOptIn?: boolean
): Promise<PaymentOrder> {
  const activeLines = cart.items.filter((line) => line.active && line.qty > 0)
  if (activeLines.length === 0 || cart.totalInr <= 0) {
    throw validationFailed('Your cart is empty')
  }

  // Refuse before touching Razorpay. Creating the order first and discovering
  // at pack time that nobody delivers there means a refund, an apology, and a
  // shopper who does not come back.
  if (shipping?.blocksOrder) throw shippingUnserviceable()

  // The client is holding a quote that no longer matches what we just computed
  // for this address. Re-read and re-confirm — never silently re-price.
  if (shipping?.quoteStale) throw shippingQuoteStale()

  // HSN/rate at THIS moment, frozen into cart_snapshot below — same reason
  // the stock cascade winner is resolved here rather than at capture time
  // (see `CartSnapshot.items[].hsn`). Read directly off `catalog_items`
  // (the shared price-authority read model, ARCHITECTURE.md rule 3) rather
  // than through `cart`, which carries no tax fields on its public contract.
  const gstBySku = new Map(
    (
      await getItemsBySkus(
        db,
        activeLines.map((line) => line.sku)
      )
    ).map((item) => [item.sku, { hsn: item.hsnCode, gstRatePct: item.gstRatePct }])
  )

  const amountPaise = toPaise(cart.totalInr)

  const rzp = await gateway.client()
  const order = await rzp.orders.create({
    amount: amountPaise,
    currency: 'INR',
    // `store` tags the order as ours: the Razorpay account is shared with
    // another storefront, so both webhooks receive every event (see
    // lib/brand.ts and the foreign-order guard in handleWebhook).
    notes: { userId, store: RAZORPAY_STORE_TAG },
    // Force auto-capture regardless of the merchant dashboard's capture setting —
    // an authorized-but-not-captured payment can't be refunded (cancelOrder needs it captured).
    payment_capture: 1,
  })

  const [row] = await db
    .insert(payments)
    .values({
      orderId: order.id,
      userId,
      amountPaise,
      currency: 'INR',
      status: 'pending',
      cartSnapshot: {
        // The cascade winner is frozen HERE, at create time, not looked up at
        // capture time — see `CartSnapshot.items[].stockNodeId` for why.
        items: activeLines.map((line) => {
          const nodeId = stockOrigins?.get(line.sku)
          const gst = gstBySku.get(line.sku)
          return { ...line, ...(nodeId ? { stockNodeId: nodeId } : {}), ...gst }
        }),
        goodsInr: cart.coupon?.subtotalInr ?? cart.totalInr,
        couponDiscountInr: cart.coupon?.discountInr ?? 0,
        // Only stamped when the coupon actually discounted this order. A
        // requested-but-rejected code is not a redemption and must not read as
        // one later.
        ...(cart.coupon?.code && (cart.coupon.discountInr ?? 0) > 0
          ? { couponCode: cart.coupon.code }
          : {}),
        shippingFeeInr: shipping?.feeInr ?? cart.shipping?.feeInr ?? 0,
        totalInr: cart.totalInr,
      },
      addressSnapshot: address,
      shippingSnapshot: shipping?.snapshot ?? null,
      // Consent is captured at login now (plugins/auth.ts), not per-order —
      // the route already refused the request if it weren't true — so this
      // just timestamps when THIS order was placed under that consent.
      consentSnapshot: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        // Itemised beside the terms/privacy acceptance rather than replacing
        // it: marketing is a SEPARATE purpose under DPDP and bundling it into
        // one "accepted" flag is exactly what the itemisation rule forbids.
        //
        // Omitted entirely when the client sent nothing, so a snapshot can
        // distinguish "declined" from "never asked" — the same three-valued
        // distinction `users.marketingWhatsappOptIn` carries, and for the same
        // reason. This is EVIDENCE of what was agreed at this instant; the
        // send-time gate reads the user row, never this.
        ...(marketingWhatsappOptIn !== undefined
          ? {
              marketingWhatsapp: {
                accepted: marketingWhatsappOptIn,
                acceptedAt: new Date().toISOString(),
              },
            }
          : {}),
        ...(adAudienceOptIn !== undefined
          ? {
              adAudience: {
                accepted: adAudienceOptIn,
                acceptedAt: new Date().toISOString(),
              },
            }
          : {}),
      },
      analyticsAnonymousId: analyticsAnonymousId ?? null,
      utmSource: attribution?.utmSource ?? null,
      utmMedium: attribution?.utmMedium ?? null,
      utmCampaign: attribution?.utmCampaign ?? null,
      gclid: attribution?.gclid ?? null,
      utmContent: attribution?.utmContent ?? null,
      oppref: attribution?.oppref ?? null,
      heardAbout: survey?.heardAbout ?? null,
      heardAboutOther: survey?.heardAboutOther ?? null,
    })
    .returning()
  if (!row) throw new Error('payment insert returned no row')

  return toPaymentOrder(row, gateway.config.keyId, gateway.config.mode)
}

/**
 * How long a UPI intent link stays live, in minutes. Razorpay's own default is
 * 5; we state it explicitly so the number the shopper is shown ("open your UPI
 * app within 5 minutes") comes from the same place the gateway was told.
 */
export const DEFAULT_UPI_INTENT_EXPIRY_MINUTES = 5

/**
 * Razorpay requires an `email` on every S2S create, and a phone-auth shopper
 * may never have given us one (`users.email` is nullable — see db/schema.ts).
 * `void@razorpay.com` is Razorpay's own documented placeholder for exactly this
 * case; it is not a mailbox and nothing is ever sent to it.
 */
const UPI_INTENT_FALLBACK_EMAIL = 'void@razorpay.com'

/**
 * The four UPI apps worth deep-linking by name in India, with the URL prefix
 * each one answers to and its Android package.
 *
 * Every entry is the SAME payment: Razorpay's `upi://pay?…` link with its
 * scheme+path swapped, query string untouched. Google Pay is the odd one — its
 * scheme keeps a `upi/pay` path (`tez://upi/pay?…`) where the others sit
 * directly on `pay`.
 */
const UPI_APPS: ReadonlyArray<{ app: UpiApp; prefix: string; androidPackage: string }> = [
  {
    app: 'gpay',
    prefix: 'tez://upi/pay',
    androidPackage: 'com.google.android.apps.nbu.paisa.user',
  },
  { app: 'phonepe', prefix: 'phonepe://pay', androidPackage: 'com.phonepe.app' },
  { app: 'paytm', prefix: 'paytmmp://pay', androidPackage: 'net.one97.paytm' },
  { app: 'bhim', prefix: 'bhim://pay', androidPackage: 'in.org.npci.upiapp' },
]

/**
 * Re-scheme Razorpay's generic intent link for each named app, preserving the
 * query string byte-for-byte — it carries the payee VPA, the amount and the
 * transaction reference, and editing any of it would either break the signature
 * the PSP checks or, worse, pay a different account.
 *
 * A link with no query string cannot be re-schemed meaningfully, so the list
 * comes back empty and the client falls back to the generic `intentUrl` (which
 * raises the system chooser) rather than being handed four broken buttons.
 */
function upiAppLinks(intentUrl: string): UpiIntentApp[] {
  const query = intentUrl.slice(intentUrl.indexOf('?'))
  if (!query.startsWith('?')) return []
  return UPI_APPS.map(({ app, prefix, androidPackage }) => ({
    app,
    url: `${prefix}${query}`,
    androidPackage,
  }))
}

/**
 * The request-scoped client facts Razorpay demands on every S2S create. They
 * are descriptive only — the gateway uses them for its own risk checks — and
 * nothing here is trusted or stored.
 */
export interface UpiIntentClient {
  /** The shopper's IP, as the route saw it. */
  ip: string
  userAgent: string
  referer: string
}

/**
 * POST /v1/payments/orders/:orderId/upi/intent — open an S2S UPI payment
 * against an order this caller already created, and hand back the
 * `upi://pay?…` link that makes the shopper's UPI app open at the confirm
 * screen.
 *
 * **MOBILE only, and additive.** Checkout is untouched and remains the path for
 * every other instrument and for any client that cannot fire an intent; this
 * exists solely to delete the "type your UPI ID" step that loses payments at
 * the last screen.
 *
 * Three properties make it safe to bolt onto the existing lifecycle:
 *
 * 1. **It invents no money.** The amount and currency come off the stored row,
 *    which was priced server-side at create; nothing about the charge is
 *    re-derived here and nothing is client-supplied.
 * 2. **It transitions nothing.** The row stays `pending`. Capture arrives the
 *    same way it always did — `payment.captured` on the webhook, with the
 *    amount/currency guard, or the recover sweep if that webhook is lost. The
 *    probe against the live test key confirms an intent payment carries the
 *    same `order_id`, so every existing path finds it unchanged.
 * 3. **There is nothing to verify.** The intent flow returns no signature (the
 *    client never sees one), so there is no S2S analogue of `POST /verify` and
 *    the client polls `GET /orders/:orderId` instead.
 *
 * Only a `pending` order can be intent-paid: a `paid` one would be a double
 * charge and a `failed`/`refunded` one is finished. Calling it twice on the
 * same pending order is allowed and opens a SECOND payment attempt — which is
 * exactly what Checkout does when a shopper retries, and is how an expired link
 * is replaced.
 */
export async function createUpiIntent(
  db: Db,
  gateway: PaymentsGateway,
  userId: string,
  orderId: string,
  client: UpiIntentClient,
  expiryMinutes: number = DEFAULT_UPI_INTENT_EXPIRY_MINUTES
): Promise<UpiIntent> {
  // User-scoped, so another shopper's order id reads as 404 (invariant #2).
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Payment not found')
  if (row.status !== 'pending') throw conflict('This order is no longer awaiting payment')

  const [user] = await db
    .select({ phone: users.phone, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) throw notFound('Payment not found')

  const rzp = await gateway.client()
  let created: { razorpay_payment_id: string; link?: string }
  try {
    created = await rzp.payments.createUpi({
      // The gateway charge, which on a COD order is the token alone.
      amount: row.prepaidAmountPaise,
      currency: row.currency,
      order_id: row.orderId,
      email: user.email ?? UPI_INTENT_FALLBACK_EMAIL,
      contact: user.phone,
      method: 'upi',
      ip: client.ip,
      referer: client.referer,
      user_agent: client.userAgent,
      notes: { userId, store: RAZORPAY_STORE_TAG },
      upi: { flow: 'intent', expiry_time: expiryMinutes },
    })
  } catch (err) {
    // Razorpay refused to open the payment — S2S not enabled on the account, an
    // order that already has a captured payment, a blocked amount. A real
    // business outcome, so 422 rather than the generic 500, and the client can
    // fall back to Checkout on it.
    const description = gatewayErrorDescription(err)
    if (description === undefined) throw err
    throw validationFailed(`UPI could not be opened: ${description}`)
  }

  // `link` is optional on the SDK's own type because the `collect` flow has
  // none. For `intent` it IS the response, and a payment we cannot hand to a
  // UPI app is worth failing loudly over — the shopper is looking at a spinner.
  const intentUrl = created.link
  if (!intentUrl) throw new Error('razorpay returned no upi intent link')

  return {
    orderId: row.orderId,
    paymentId: created.razorpay_payment_id,
    intentUrl,
    apps: upiAppLinks(intentUrl),
    amountInr: row.prepaidAmountPaise / 100,
    amountPaise: row.prepaidAmountPaise,
    currency: 'INR',
    expiresInMinutes: expiryMinutes,
  }
}

/** Where an attempt observation came from — see `payment_attempts.observed_by`. */
type AttemptObserver = 'verify' | 'webhook' | 'recover' | 'poll'

/** One row for `payment_attempts`, minus the columns this module fills in itself. */
interface AttemptRecord {
  razorpayPaymentId?: string | null | undefined
  status: 'captured' | 'failed' | 'mismatched'
  amountPaise?: number | null | undefined
  method?: string | null | undefined
  errorCode?: string | null | undefined
  errorDescription?: string | null | undefined
  errorReason?: string | null | undefined
  errorSource?: string | null | undefined
  errorStep?: string | null | undefined
}

/**
 * Append one row to the gateway attempt log (see `payment_attempts` in
 * db/schema.ts). Idempotent on `razorpay_payment_id` — Razorpay retries a
 * webhook until it gets a 200, and verify races that webhook on the same
 * capture, so the same payment entity arrives repeatedly and must log once.
 *
 * **It never throws, and it never poisons its caller's transaction.** Every
 * call site is a path where money has already moved or is about to be reported
 * as moved; an exception escaping here would roll back a captured payment to
 * protect a log line, which is the worst trade in this file.
 *
 * A try/catch alone is NOT enough for that promise: a statement that errors
 * inside a Postgres transaction aborts the whole transaction, so the enclosing
 * `paid` transition would fail on its next statement no matter what this
 * function caught. The insert therefore runs in a nested transaction — a
 * SAVEPOINT when `db` is already a transaction handle — so a failure rolls back
 * to the savepoint and leaves the transition intact.
 *
 * `log` is optional only because `verifyPayment` is reachable without a request
 * logger — where it is absent, a failed write is genuinely silent, and that is
 * the accepted cost of never endangering the transition.
 */
async function recordAttempt(
  db: Tx,
  orderId: string,
  observedBy: AttemptObserver,
  attempt: AttemptRecord,
  log?: ((obj: Record<string, unknown>, msg: string) => void) | undefined
): Promise<void> {
  try {
    await db.transaction(async (t: Tx) => {
      await t
        .insert(paymentAttempts)
        .values({
          orderId,
          observedBy,
          status: attempt.status,
          razorpayPaymentId: attempt.razorpayPaymentId ?? null,
          amountPaise: attempt.amountPaise ?? null,
          method: attempt.method ?? null,
          errorCode: attempt.errorCode ?? null,
          errorDescription: attempt.errorDescription ?? null,
          errorReason: attempt.errorReason ?? null,
          errorSource: attempt.errorSource ?? null,
          errorStep: attempt.errorStep ?? null,
        })
        .onConflictDoNothing()
    })
  } catch (err) {
    log?.({ err, orderId, status: attempt.status }, 'payment attempt log write failed; ignored')
  }
}

/** One order's attempt log, newest first. Admin reconciliation read — never used for a decision. */
export async function listPaymentAttempts(db: Db, orderId: string): Promise<PaymentAttempt[]> {
  const rows = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, orderId))
    .orderBy(desc(paymentAttempts.createdAt))
  return rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    razorpayPaymentId: row.razorpayPaymentId,
    status: row.status as PaymentAttempt['status'],
    amountPaise: row.amountPaise,
    method: row.method,
    errorCode: row.errorCode,
    errorDescription: row.errorDescription,
    errorReason: row.errorReason,
    errorSource: row.errorSource,
    errorStep: row.errorStep,
    observedBy: row.observedBy as PaymentAttempt['observedBy'],
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * The one guarded, idempotent `paid` transition (SPEC-PAYMENTS.md invariants
 * #5/#6). A single UPDATE with a `status = 'pending'` predicate flips the row
 * and, in the SAME transaction, clears ONLY the cart lines this order actually
 * bought — the skus frozen into `cart_snapshot` at create time (a cart-screen
 * selection leaves the shopper's deselected lines sitting in the cart, exactly
 * as if they'd never been touched). A replay finds the row already `paid`
 * (0 rows updated) and is a silent no-op → returns `null`. Returns a
 * {@link PaidTransition} only when THIS call performed the transition, so the
 * caller can run post-commit work (analytics) on exactly the same guard without
 * re-deriving it.
 */
async function markPaid(
  tx: Tx,
  row: PaymentRow,
  razorpayPaymentId: string,
  hooks?: PaymentHooks,
  observedBy: AttemptObserver = 'webhook',
  log?: ((obj: Record<string, unknown>, msg: string) => void) | undefined
): Promise<PaidTransition | null> {
  const updated = await tx
    .update(payments)
    .set({
      status: 'paid',
      razorpayPaymentId,
      paidAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    // `failed` is accepted alongside `pending`, and that is a fix, not a
    // widening of the guard. Razorpay Checkout lets a shopper retry inside the
    // SAME order: a declined card fires `payment.failed` (which flips this row
    // to `failed`), and the retry that works then fires `payment.captured`. A
    // `pending`-only predicate matched nothing at that point, so the money was
    // captured, the order never became paid, and the recover sweep — which
    // scans `pending` only — never looked at it again. A capture is server
    // truth from the gateway and must win over an earlier failed attempt.
    // `paid`/`refunded` are still excluded, so replays remain no-ops.
    .where(and(eq(payments.orderId, row.orderId), inArray(payments.status, ['pending', 'failed'])))
    .returning({ orderId: payments.orderId })

  if (updated.length === 0) return null

  // Append-only trail, inside the guard so it logs exactly once per capture
  // however many of verify/webhook/recover raced. Best-effort by contract —
  // see `recordAttempt`.
  await recordAttempt(
    tx,
    row.orderId,
    observedBy,
    { razorpayPaymentId, status: 'captured', amountPaise: row.prepaidAmountPaise },
    log
  )
  const snapshot = row.cartSnapshot as CartSnapshot
  const orderedSkus = snapshot.items.map((line) => line.sku)
  await tx
    .delete(cartItems)
    .where(and(eq(cartItems.userId, row.userId), inArray(cartItems.sku, orderedSkus)))

  // Inside the guard, so it runs EXACTLY ONCE per order however many times the
  // webhook, the client verify and the recovery sweep race each other. A replay
  // returned above with 0 rows updated and never reaches here — which is the
  // whole reason the decrement lives inside this function rather than at any of
  // the three call sites, where each would have to re-derive the same guard and
  // one of them would eventually get it wrong.
  // The row in hand still says `pending`; the invoice must describe the order
  // as it now IS, so the status and payment reference are overlaid from what
  // this transition just wrote.
  const source = orderInvoiceSourceFromRow({
    ...row,
    status: 'paid',
    razorpayPaymentId,
    paidAt: row.paidAt ?? new Date(),
  })
  if (source && hooks?.onOrderPaid) {
    await hooks.onOrderPaid(
      tx,
      row.orderId,
      snapshot.items.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        stockNodeId: line.stockNodeId,
      })),
      source
    )
  }

  // `source` is undefined only for a row whose status is neither paid nor
  // refunded — impossible here, since the UPDATE above just made it `paid` and
  // the overlay says so. Returning null in that unreachable case rather than
  // asserting keeps the "won the race" signal honest: no caller should be told
  // it completed a transition it cannot describe.
  const shipping = (row.shippingSnapshot ?? {}) as { nodeCode?: unknown }
  return source
    ? {
        order: source,
        anonymousId: row.analyticsAnonymousId,
        // Null rather than an object of nulls when the order carried nothing:
        // "organic" and "campaign with every field blank" must not look alike
        // downstream.
        attribution:
          (row.utmSource ??
          row.utmMedium ??
          row.utmCampaign ??
          row.utmContent ??
          row.gclid ??
          row.oppref)
            ? {
                ...(row.utmSource ? { utmSource: row.utmSource } : {}),
                ...(row.utmMedium ? { utmMedium: row.utmMedium } : {}),
                ...(row.utmCampaign ? { utmCampaign: row.utmCampaign } : {}),
                ...(row.gclid ? { gclid: row.gclid } : {}),
                ...(row.utmContent ? { utmContent: row.utmContent } : {}),
                ...(row.oppref ? { oppref: row.oppref } : {}),
              }
            : null,
        storeCode: typeof shipping.nodeCode === 'string' ? shipping.nodeCode : null,
      }
    : null
}

/**
 * What we know about a refund at the moment we write it: the gateway's own
 * record of it, plus the instrument it went back to. Every field is optional
 * except the amount and status — Razorpay omits `speed_processed` on some
 * responses, and an out-of-band refund observed only through a webhook has no
 * instrument lookup attached.
 */
export interface RefundRecord {
  refundId: string | null
  status: 'pending' | 'processed' | 'failed'
  amountPaise: number
  speed: string | null
  /** Null on the webhook path for a refund we did not initiate — we never saw it start. */
  initiatedAt: Date | null
  processedAt: Date | null
  destination: RefundDestination | null
}

/** The stored `refund_destination` shape (see db/schema.ts `payments.refundDestination`). */
interface RefundDestination {
  method: string
  upiVpa?: string
  cardLast4?: string
  cardNetwork?: string
  bank?: string
  wallet?: string
}

/** A {@link RefundRecord} as drizzle column values — shared by the two writers below. */
function refundColumns(refund: RefundRecord) {
  return {
    razorpayRefundId: refund.refundId,
    refundStatus: refund.status,
    refundAmountPaise: refund.amountPaise,
    refundSpeed: refund.speed,
    refundInitiatedAt: refund.initiatedAt,
    refundProcessedAt: refund.processedAt,
    refundDestination: refund.destination,
  }
}

/**
 * Record a refund outcome on an order WITHOUT touching its status — the
 * counterpart to {@link markRefunded}, for the case where the transition
 * already happened.
 *
 * A self-service cancellation writes `refund_status = 'pending'` the moment
 * Razorpay accepts the refund; the bank releasing the money is a separate
 * event, minutes to days later, and arrives as `refund.processed`. By then the
 * order is already `refunded`, so `markRefunded`'s `status = 'paid'` predicate
 * matches nothing and the shopper would be left looking at "Processing"
 * forever. This is the write that closes that gap.
 *
 * Deliberately does NOT clobber an instrument we already resolved: a webhook
 * carries no payment entity, so its `destination` is null, and `coalesce`
 * keeps the one the cancel path looked up.
 */
async function applyRefundOutcome(tx: Tx, orderId: string, refund: RefundRecord): Promise<void> {
  await tx
    .update(payments)
    .set({
      razorpayRefundId: sql`coalesce(${refund.refundId}, ${payments.razorpayRefundId})`,
      refundStatus: refund.status,
      refundAmountPaise: refund.amountPaise,
      refundSpeed: sql`coalesce(${refund.speed}, ${payments.refundSpeed})`,
      refundInitiatedAt: sql`coalesce(${payments.refundInitiatedAt}, ${refund.initiatedAt})`,
      refundProcessedAt: refund.processedAt,
      updatedAt: sql`now()`,
    })
    .where(eq(payments.orderId, orderId))
}

/** Razorpay's refund status, narrowed to the three we store; anything unknown reads as pending. */
function toRefundStatus(status: string | undefined): RefundRecord['status'] {
  return status === 'processed' || status === 'failed' ? status : 'pending'
}

/**
 * The instrument a refund returns to, read off the PAYMENT entity (a refund
 * entity carries none, and a refund always goes back to source).
 *
 * Only ever partial identifiers — a VPA, a card's last four, a bank name. The
 * shopper has to recognise the account, not be able to pay from it. An unknown
 * or absent `method` yields null rather than a guess: "we don't know" is a
 * missing line on the sheet, while a wrong destination is a support ticket.
 */
function refundDestinationFromPayment(payment: {
  method?: string
  vpa?: string
  bank?: string
  wallet?: string
  card?: { last4?: string; network?: string } | null
  upi?: { vpa?: string } | null
}): RefundDestination | null {
  if (!payment.method) return null
  const destination: RefundDestination = { method: payment.method }
  const vpa = payment.upi?.vpa ?? payment.vpa
  if (vpa) destination.upiVpa = vpa
  if (payment.card?.last4) destination.cardLast4 = payment.card.last4
  if (payment.card?.network) destination.cardNetwork = payment.card.network
  if (payment.bank) destination.bank = payment.bank
  if (payment.wallet) destination.wallet = payment.wallet
  return destination
}

/**
 * The one guarded, idempotent `paid → refunded` transition, mirroring
 * `markPaid`'s shape exactly: a single UPDATE with a `status = 'paid'`
 * predicate, a replay finds 0 rows updated and returns `null` (silent no-op),
 * and `hooks.onOrderRefunded` fires INSIDE this transaction, only on the call
 * that actually won the transition. Two callers reach this — `cancelOrder`
 * (self-service, already holds the row before it ever calls Razorpay) and
 * `dispatchWebhook`'s `refund.processed` branch (server truth, reads the row
 * itself) — so the money-moving side effect (Razorpay refund / Razorpay's own
 * webhook) always happens BEFORE this runs, never after.
 *
 * `reason` is the shopper's self-service pick when there is one (`cancelOrder`
 * threads its own `reason` param through); the webhook path has none, so
 * `hooks.onOrderRefunded` always receives a fallback string rather than
 * `undefined` — a credit note's `reason` field is user-facing copy on a legal
 * document and must never print "undefined".
 */
async function markRefunded(
  tx: Tx,
  row: PaymentRow,
  hooks?: PaymentHooks,
  reason?: string,
  refund?: RefundRecord
): Promise<OrderInvoiceSource | null> {
  const updated = await tx
    .update(payments)
    .set({
      status: 'refunded',
      cancelReason: reason ?? null,
      updatedAt: sql`now()`,
      ...(refund ? refundColumns(refund) : {}),
    })
    .where(and(eq(payments.orderId, row.orderId), eq(payments.status, 'paid')))
    .returning({ orderId: payments.orderId })

  if (updated.length === 0) return null

  const source = orderInvoiceSourceFromRow({ ...row, status: 'refunded' })
  if (source && hooks?.onOrderRefunded) {
    await hooks.onOrderRefunded(tx, row.orderId, source, reason ?? 'Refund issued')
  }
  return source ?? null
}

/**
 * POST /v1/payments/verify — the client-driven confirmation path. Verifies
 * HMAC-SHA256(`orderId|paymentId`, KEY_SECRET) against the client-returned
 * signature (length pre-check + timing-safe), then transitions to `paid`
 * idempotently. The row must exist AND belong to the caller (else 404 — never
 * leak another user's order). A bad signature is 400 `signature_invalid` with
 * the row untouched. Replays return the already-`paid` status (no-op success).
 */
export async function verifyPayment(
  db: Db,
  gateway: PaymentsGateway,
  userId: string,
  body: PaymentVerify,
  hooks?: PaymentHooks,
  /**
   * Request logger, used only so a failed attempt-log write is visible. Optional
   * because the attempt log must never be a reason this call cannot be made.
   */
  log?: ((obj: Record<string, unknown>, msg: string) => void) | undefined
): Promise<PaymentVerifyResponse> {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = body

  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, razorpayOrderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Payment not found')

  const ok = verifyHmacSha256(
    `${razorpayOrderId}|${razorpayPaymentId}`,
    gateway.config.keySecret,
    razorpaySignature
  )
  if (!ok) throw signatureInvalid()

  const { status, paid } = await db.transaction(async (tx: Tx) => {
    const transition = await markPaid(tx, row, razorpayPaymentId, hooks, 'verify', log)
    // Re-read inside the tx so a concurrent transition is reflected in the response.
    const [current] = await tx
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, razorpayOrderId))
      .limit(1)
    return { status: current?.status ?? row.status, paid: transition }
  })

  // AFTER the commit, never inside it — see `onOrderPaidCommitted`. A rollback
  // between the UPDATE and here means `paid` is a value from a transaction that
  // no longer happened, so the await above is what makes this safe to announce.
  if (paid) hooks?.onOrderPaidCommitted?.(paid)

  return { orderId: razorpayOrderId, status: status as PaymentVerifyResponse['status'] }
}

/** A minimal shape of the Razorpay webhook envelope we consume. */
interface WebhookEvent {
  event?: string
  payload?: {
    payment?: {
      entity?: {
        id?: string
        order_id?: string
        amount?: number
        currency?: string
        /** Only read for the attempt log — never for a transition decision. */
        method?: string
        error_code?: string
        error_description?: string
        error_reason?: string
        error_source?: string
        error_step?: string
        /** Order notes Razorpay copies onto the payment; `store` tags whose order it is. */
        notes?: Record<string, unknown>
      }
    }
    refund?: {
      entity?: {
        id?: string
        order_id?: string
        payment_id?: string
        amount?: number
        /** Razorpay's refund lifecycle — mirrored onto the row, never inferred. */
        status?: string
        speed_processed?: string
        notes?: Record<string, unknown>
      }
    }
    order?: { entity?: { id?: string; notes?: Record<string, unknown> } }
  }
}

/**
 * POST /v1/payments/webhook — server-to-server truth from Razorpay. The
 * signature is HMAC-SHA256 over the RAW request body under WEBHOOK_SECRET
 * (length pre-check + timing-safe); a bad/missing signature is 400 (throws
 * `signatureInvalid`). AFTER a valid signature the handler always resolves so
 * the caller replies 200 — a processing error is logged and left for the
 * recover sweep, never surfaced to Razorpay (which would otherwise retry).
 *
 * `payment.captured` → `paid` (with the amount + currency re-check below);
 * `payment.failed` → `pending → failed`; `refund.processed` → `paid → refunded`
 * plus the refund's own outcome columns; `refund.failed` records the outcome
 * WITHOUT transitioning (money that never came back does not refund an order).
 * The amount+currency guard (invariant #5) protects the capture path: the event
 * amount must equal the stored `amount_paise` and the currency must match, else
 * the row is left untouched and an ERROR is logged for manual review.
 *
 * `log` is the request logger (Fastify's pino); it is called only for the
 * error/mismatch branches so a healthy webhook is silent.
 */
export async function handleWebhook(
  db: Db,
  gateway: PaymentsGateway,
  rawBody: Buffer,
  signature: string | undefined,
  log: (obj: Record<string, unknown>, msg: string) => void,
  hooks?: PaymentHooks
): Promise<void> {
  if (!signature) throw signatureInvalid('Missing webhook signature')
  const ok = verifyHmacSha256(rawBody.toString('utf8'), gateway.config.webhookSecret, signature)
  if (!ok) throw signatureInvalid('Webhook signature verification failed')

  // Past this point the signature is trusted: never throw to the caller (it must
  // reply 200). Any processing failure is logged and left for `recover`.
  let event: WebhookEvent
  try {
    event = JSON.parse(rawBody.toString('utf8')) as WebhookEvent
  } catch {
    log({ reason: 'unparseable_body' }, 'payments webhook: could not parse body')
    return
  }

  try {
    await dispatchWebhook(db, event, log, hooks)
  } catch (err) {
    log({ err, event: event.event }, 'payments webhook: processing failed (left for recover)')
  }
}

/** Route a verified webhook event to its status transition. Unknown events are ignored. */
async function dispatchWebhook(
  db: Db,
  event: WebhookEvent,
  log: (obj: Record<string, unknown>, msg: string) => void,
  hooks?: PaymentHooks
): Promise<void> {
  const payment = event.payload?.payment?.entity

  // The Razorpay account is shared with another storefront, so this webhook
  // receives every event on it. An event whose order carries ANOTHER store's
  // tag is not ours: drop it quietly, before any lookup or log. Untagged events
  // still go through, and each branch below already treats an unknown order
  // id as a no-op, so a foreign order without a tag is ignored the same way.
  const store =
    payment?.notes?.store ??
    event.payload?.refund?.entity?.notes?.store ??
    event.payload?.order?.entity?.notes?.store
  if (typeof store === 'string' && store !== RAZORPAY_STORE_TAG) return

  if (event.event === 'payment.captured') {
    const orderId = payment?.order_id
    const paymentId = payment?.id
    if (!orderId || !paymentId) return

    const paid = await db.transaction(async (tx: Tx) => {
      const [row] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
      if (!row) return null

      // Invariant #5: the captured amount AND currency must match the stored row,
      // else DO NOT transition — log ERROR and leave for manual review. Strict:
      // an ABSENT amount or currency in the event is a mismatch, never a pass.
      const amountMatches =
        typeof payment?.amount === 'number' && payment.amount === row.prepaidAmountPaise
      const currencyMatches = payment?.currency === row.currency
      if (!amountMatches || !currencyMatches) {
        log(
          {
            orderId,
            expectedAmountPaise: row.prepaidAmountPaise,
            eventAmountPaise: payment?.amount,
            expectedCurrency: row.currency,
            eventCurrency: payment?.currency,
          },
          'payments webhook: amount/currency mismatch — NOT transitioning'
        )
        // The row is deliberately left alone, so the log line above used to be
        // the only trace. Recording it here is what turns "money we refused to
        // recognise" into something an operator can query by order.
        await recordAttempt(
          tx,
          orderId,
          'webhook',
          {
            razorpayPaymentId: paymentId,
            status: 'mismatched',
            amountPaise: typeof payment?.amount === 'number' ? payment.amount : null,
            method: payment?.method,
            errorDescription: `expected ${row.prepaidAmountPaise} ${row.currency}, gateway reported ${String(payment?.amount)} ${String(payment?.currency)}`,
          },
          log
        )
        return null
      }

      return await markPaid(tx, row, paymentId, hooks, 'webhook', log)
    })
    // The webhook and the client verify race each other; whichever loses gets
    // null from `markPaid` and announces nothing. That is what keeps a single
    // purchase from being reported twice.
    if (paid) hooks?.onOrderPaidCommitted?.(paid)
    return
  }

  if (event.event === 'payment.failed') {
    const orderId = payment?.order_id
    if (!orderId) return
    // An order id we never created (the other storefront's, on the shared
    // account) is not ours to record: the attempt log has a foreign key to
    // `payments`, and inserting against a missing row would surface as an
    // ERROR on every declined card at the other store.
    const [known] = await db
      .select({ orderId: payments.orderId })
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1)
    if (!known) return
    // The declined attempt itself, with the gateway's own reason — the whole
    // point of the log. Written whether or not the UPDATE below matches
    // anything: a decline that arrives after the order is already paid (a
    // retry the shopper abandoned, a late webhook) is still a fact about this
    // order, and dropping it is what made these questions unanswerable.
    await recordAttempt(
      db as unknown as Tx,
      orderId,
      'webhook',
      {
        razorpayPaymentId: payment?.id,
        status: 'failed',
        amountPaise: typeof payment?.amount === 'number' ? payment.amount : null,
        method: payment?.method,
        errorCode: payment?.error_code,
        errorDescription: payment?.error_description,
        errorReason: payment?.error_reason,
        errorSource: payment?.error_source,
        errorStep: payment?.error_step,
      },
      log
    )
    // Guarded: only pending → failed (never clobber a paid/refunded row).
    await db
      .update(payments)
      .set({ status: 'failed', updatedAt: sql`now()` })
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
    return
  }

  if (event.event === 'refund.processed' || event.event === 'refund.failed') {
    // A refund.* payload carries its data under `payload.refund.entity`,
    // NOT `payload.payment.entity` — the refund entity is the source of truth for
    // the order id. Prefer it; fall back to the co-included payment entity's
    // order_id, then to a lookup by the stored razorpay_payment_id (which we set
    // on the paid transition), so a payload that only identifies the payment
    // still finds the row.
    const refund = event.payload?.refund?.entity
    let orderId = refund?.order_id ?? payment?.order_id
    if (!orderId) {
      const paymentId = refund?.payment_id ?? payment?.id
      if (!paymentId) return
      const [row] = await db
        .select({ orderId: payments.orderId })
        .from(payments)
        .where(eq(payments.razorpayPaymentId, paymentId))
        .limit(1)
      orderId = row?.orderId
    }
    if (!orderId) return
    const resolvedOrderId = orderId
    const processed = event.event === 'refund.processed'
    await db.transaction(async (tx: Tx) => {
      const [row] = await tx
        .select()
        .from(payments)
        .where(eq(payments.orderId, resolvedOrderId))
        .limit(1)
      if (!row) return
      const record: RefundRecord = {
        refundId: refund?.id ?? null,
        // The event type, not the entity's `status` field: this IS the status
        // transition Razorpay is telling us about, and a payload that omits
        // the field must not silently demote a processed refund to pending.
        status: processed ? 'processed' : 'failed',
        amountPaise: refund?.amount ?? row.refundAmountPaise ?? row.prepaidAmountPaise,
        speed: refund?.speed_processed ?? null,
        // Only meaningful for a refund we did not initiate ourselves; for one
        // we did, `applyRefundOutcome` keeps the initiation time already stored.
        initiatedAt: new Date(),
        processedAt: processed ? new Date() : null,
        // No payment entity on this payload — the instrument, if we resolved
        // one at cancel time, is preserved by `applyRefundOutcome`.
        destination: null,
      }
      // Guarded: only paid → refunded (enforced by `markRefunded`'s own UPDATE
      // predicate). No shopper-given reason on this path — `markRefunded`
      // supplies the fallback string. A `refund.failed` never transitions the
      // order: the money did not come back, so the order is still paid.
      if (processed) await markRefunded(tx, row, hooks, undefined, record)
      // Runs either way, and after the transition: the row this refund belongs
      // to is `refunded` by now (either from the line above or from the
      // self-service cancel that started this refund), and its refund columns
      // are what the shopper's Refund details sheet reads.
      await applyRefundOutcome(tx, resolvedOrderId, record)
    })
    return
  }

  // Any other event type is acknowledged (200) but not acted on.
}

/**
 * GET /v1/payments/orders/:orderId — the caller's own order status (polling
 * after Checkout closes, and throughout an open UPI intent). Cross-user or
 * unknown ids read as 404.
 *
 * Reads the stored row, and — only when handed `live`, and only for a pending
 * row inside the window described on {@link shouldAskGateway} — reconciles it
 * against Razorpay first, so a shopper whose webhook is late is told the truth
 * rather than kept on a spinner. See {@link askGatewayForStatus}.
 */
export async function getOrderStatus(
  db: Db,
  userId: string,
  orderId: string,
  live?: PollLiveLookup
): Promise<PaymentStatusResponse> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Payment not found')

  const status =
    live && shouldAskGateway(row, live.now ?? new Date())
      ? await askGatewayForStatus(db, row, live)
      : (row.status as PaymentStatusResponse['status'])

  return {
    orderId: row.orderId,
    status,
    // The gateway pair again — see `toPaymentOrder`. This endpoint exists to
    // reconcile against Razorpay, so it reports what Razorpay was asked for.
    amountInr: row.prepaidAmountPaise / 100,
    amountPaise: row.prepaidAmountPaise,
    currency: 'INR',
  }
}

/**
 * Wiring the status poll needs to ask Razorpay directly. Optional at the call
 * site: without it this endpoint is the plain database read it has always been,
 * which is what every non-polling caller (and every test that does not care)
 * wants.
 */
export interface PollLiveLookup {
  gateway: PaymentsGateway
  hooks?: PaymentHooks | undefined
  log: (obj: Record<string, unknown>, msg: string) => void
  /** Injectable clock, for tests. */
  now?: Date | undefined
}

/**
 * Last live gateway lookup per order id, for {@link POLL_LIVE_MIN_INTERVAL_MS}.
 *
 * Deliberately per-instance and in memory. It is a rate limiter, not a
 * correctness mechanism: a second Cloud Run instance asking Razorpay one extra
 * time costs one API call and reaches the identical answer, so paying for a
 * shared store to prevent that would buy nothing. Everything that decides
 * outcomes lives in the guarded `markPaid` transition.
 */
const lastGatewayPollAt = new Map<string, number>()
/** Cap on {@link lastGatewayPollAt}, so an idle instance cannot grow it forever. */
const POLL_LIVE_MAX_TRACKED = 5000

/**
 * Forget every recorded lookup. For tests only: they reuse a handful of order
 * ids inside one process, so without this the throttle from one case silently
 * suppresses the gateway call the next one is asserting on.
 */
export function resetGatewayPollThrottle(): void {
  lastGatewayPollAt.clear()
}

/**
 * Should this poll spend a Razorpay round trip?
 *
 * Only for a row that is still `pending` — a settled order has nothing left to
 * learn — and only inside the window where nothing else is watching: younger
 * than {@link POLL_LIVE_AFTER_MS} nothing can have been captured, older than
 * {@link RECOVER_STALE_AFTER_MS} the sweep owns the row and polling it here
 * would duplicate work the cron already does on a schedule.
 */
function shouldAskGateway(row: PaymentRow, now: Date): boolean {
  if (row.status !== 'pending') return false
  const age = now.getTime() - row.createdAt.getTime()
  if (age < POLL_LIVE_AFTER_MS || age > RECOVER_STALE_AFTER_MS) return false

  const last = lastGatewayPollAt.get(row.orderId)
  const nowMs = now.getTime()
  if (last !== undefined && nowMs - last < POLL_LIVE_MIN_INTERVAL_MS) return false

  if (lastGatewayPollAt.size >= POLL_LIVE_MAX_TRACKED) {
    for (const [key, at] of lastGatewayPollAt) {
      if (nowMs - at > RECOVER_STALE_AFTER_MS) lastGatewayPollAt.delete(key)
    }
    // Still full — every entry is inside the window, so drop the lot rather
    // than grow without bound. The cost of forgetting is one extra API call per
    // order, never a wrong answer.
    if (lastGatewayPollAt.size >= POLL_LIVE_MAX_TRACKED) lastGatewayPollAt.clear()
  }
  lastGatewayPollAt.set(row.orderId, nowMs)
  return true
}

/**
 * Reconcile a pending row against Razorpay and answer with what it now is.
 *
 * WHY THE POLL ASKS AT ALL: the mobile UPI intent flow returns no signature, so
 * there is no `POST /verify` to perform the transition — `payment.captured` on
 * the webhook is the only fast path, and the client sits on a spinner until it
 * lands. A webhook that is late, retried, or lost therefore shows the shopper
 * "payment expired" minutes after their money left, and nothing corrects it
 * until the sweep runs at {@link RECOVER_STALE_AFTER_MS}. Asking the gateway
 * during the poll closes that window with the gateway's own truth.
 *
 * A gateway failure is NOT an error here: the stored status is still a correct
 * answer to "what do we know", the shopper keeps polling, and the sweep remains
 * the backstop. Never fail a status read over it.
 */
async function askGatewayForStatus(
  db: Db,
  row: PaymentRow,
  live: PollLiveLookup
): Promise<PaymentStatusResponse['status']> {
  const stored = row.status as PaymentStatusResponse['status']
  let rzp: RazorpayApi
  try {
    rzp = await live.gateway.client()
  } catch {
    return stored
  }

  const outcome = await reconcilePendingFromGateway(db, rzp, row, 'poll', live.hooks, live.log)
  // `already` means a concurrent observer won the transition — the order is
  // paid either way, and reporting the row we read before the race would send
  // the shopper back to a payment screen for an order they have paid for.
  return outcome === 'paid' || outcome === 'already' ? 'paid' : stored
}

/**
 * Did this user ever complete a `paid` order containing this product (any of
 * its variants)? Used by `routes/reviews.ts` to freeze `verifiedPurchase` at
 * review-write time (ARCHITECTURE.md rule 2 — the reviews module may not read
 * `payments` itself, so its route calls this exported function instead).
 * Reads a user's whole `paid` history in application code rather than a jsonb
 * containment query — this scales fine at a shopper's actual order count and
 * keeps the sku match (frozen snapshot vs. the product's CURRENT skus) simple
 * to reason about.
 */
export async function hasPurchasedProduct(
  db: Db,
  userId: string,
  productId: string
): Promise<boolean> {
  const skus = await getSkusByProductId(db, productId)
  if (skus.length === 0) return false
  const skuSet = new Set(skus)

  const rows = await db
    .select({ cartSnapshot: payments.cartSnapshot })
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.status, 'paid')))

  return rows.some((row) =>
    (row.cartSnapshot as CartSnapshot).items.some((item) => skuSet.has(item.sku))
  )
}

/** Join frozen snapshot lines with live catalog rows for display (`name`/`size`/`imageUrl`). */
function toOrderItems(
  lines: CartSnapshot['items'],
  catalogBySku: Map<string, CatalogItem>
): OrderItem[] {
  return lines.map((line) => {
    const catalogItem = catalogBySku.get(line.sku)
    return {
      sku: line.sku,
      name: catalogItem?.name ?? line.sku,
      size: catalogItem?.size ?? '',
      imageUrl: catalogItem?.imageUrl ?? '',
      qty: line.qty,
      priceInr: line.priceInr,
    }
  })
}

/**
 * Working-day allowance behind the "credit by" date when `refunds.creditDays`
 * is unset. Five is the window Razorpay itself quotes for a normal-speed
 * refund to reach a bank account; the config key exists so ops can widen it
 * during a banking incident without a deploy.
 */
export const DEFAULT_REFUND_CREDIT_DAYS = 5

/** Refund display knobs the ROUTE resolves from config (services never read `app_config`). */
export interface RefundPolicy {
  /** Working days from refund initiation to the promised credit date. */
  creditDays: number
}

const REFUND_POLICY_DEFAULT: RefundPolicy = { creditDays: DEFAULT_REFUND_CREDIT_DAYS }

/**
 * `from` plus `days` WORKING days, weekends skipped, as a `YYYY-MM-DD` date.
 *
 * Banks do not settle on Saturdays and Sundays, so counting calendar days
 * produces a promise date that is routinely wrong in the one direction that
 * matters — early. No public-holiday calendar: getting Diwali right would mean
 * shipping and maintaining a holiday table for a single label, and the
 * shopper-facing copy is "by", not "on".
 *
 * Computed in IST (+05:30, the only timezone this shop's customers are in)
 * rather than the server's UTC, so a refund initiated at 23:00 IST does not
 * promise a date a day early.
 */
function creditByDate(from: Date, days: number): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
  const cursor = new Date(from.getTime() + IST_OFFSET_MS)
  let remaining = Math.max(0, days)
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) remaining -= 1
  }
  return cursor.toISOString().slice(0, 10)
}

/**
 * The shopper-facing name and recognisable reference for a stored refund
 * destination. Labels are deliberately the words a shopper used at checkout
 * ("UPI Account", "Card"), not Razorpay's method codes.
 */
function toRefundDestination(stored: unknown): OrderRefund['destination'] {
  if (typeof stored !== 'object' || stored === null) return null
  const { method, upiVpa, cardLast4, cardNetwork, bank, wallet } = stored as RefundDestination
  if (typeof method !== 'string' || method.length === 0) return null
  switch (method) {
    case 'upi':
      return { label: 'UPI Account', reference: upiVpa ?? null }
    case 'card':
      return {
        label: cardNetwork ? `${cardNetwork} Card` : 'Card',
        reference: cardLast4 ? `•••• ${cardLast4}` : null,
      }
    case 'netbanking':
      return { label: 'Net Banking', reference: bank ?? null }
    case 'wallet':
      return { label: 'Wallet', reference: wallet ?? null }
    case 'emi':
      return { label: 'EMI', reference: cardLast4 ? `•••• ${cardLast4}` : null }
    default:
      // A method Razorpay added after this was written: name it as-is rather
      // than dropping the whole destination card.
      return { label: method.toUpperCase(), reference: null }
  }
}

/**
 * The refund block for one order, or null when there is nothing honest to say.
 *
 * Two degraded shapes are deliberate. A `refunded` row with no refund columns
 * at all is an order cancelled before this data was recorded: it reports its
 * full amount as `processed` with no destination and no date, because that is
 * exactly what we know. And a non-`refunded` row returns null even if refund
 * columns exist (a `refund.failed` observed against a still-`paid` order) —
 * the order screen shows refunds under a refunded order, not a live one.
 */
function toOrderRefund(row: PaymentRow, policy: RefundPolicy): OrderRefund | null {
  if (row.status !== 'refunded') return null
  // Falls back to the PREPAID amount: a refund returns money that was taken
  // through the gateway, and on a COD order that is the token, never the total.
  const amountPaise = row.refundAmountPaise ?? row.prepaidAmountPaise
  const status = row.refundStatus === null ? 'processed' : toRefundStatus(row.refundStatus)
  const instant = row.refundSpeed === 'instant'
  const initiatedAt = row.refundInitiatedAt ?? null
  return {
    amountInr: Math.round(amountPaise / 100),
    status,
    destination: toRefundDestination(row.refundDestination),
    initiatedAt: initiatedAt ? initiatedAt.toISOString() : null,
    processedAt: row.refundProcessedAt ? row.refundProcessedAt.toISOString() : null,
    // No promise date once the money is already there (instant speed, or a
    // failed refund whose next step is support, not waiting).
    creditByDate:
      initiatedAt && !instant && status !== 'failed'
        ? creditByDate(initiatedAt, policy.creditDays)
        : null,
    instant,
  }
}

/** Batch-join a page of `payments` rows into `Order` shapes with a single catalog lookup. */
async function toOrders(
  db: Db,
  rows: PaymentRow[],
  refundPolicy: RefundPolicy = REFUND_POLICY_DEFAULT
): Promise<Order[]> {
  const skus = [
    ...new Set(rows.flatMap((row) => (row.cartSnapshot as CartSnapshot).items.map((i) => i.sku))),
  ]
  const catalogBySku = new Map((await getItemsBySkus(db, skus)).map((item) => [item.sku, item]))
  return rows.map((row) => {
    const snapshot = row.cartSnapshot as CartSnapshot
    return {
      orderId: row.orderId,
      status: row.status as Order['status'],
      totalInr: snapshot.totalInr,
      // Pre-shipping rows carry neither field; for them the total WAS the goods.
      goodsInr: snapshot.goodsInr ?? snapshot.totalInr,
      couponDiscountInr: snapshot.couponDiscountInr ?? 0,
      shippingFeeInr: snapshot.shippingFeeInr ?? 0,
      currency: 'INR',
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      items: toOrderItems(snapshot.items, catalogBySku),
      refund: toOrderRefund(row, refundPolicy),
    }
  })
}

/**
 * GET /v1/payments/orders — the caller's order history: every `payments` row
 * that reached a terminal status (`paid`/`failed`/`refunded`), newest first. A
 * still-`pending` row is a mid-checkout attempt, not an order, and is excluded.
 */
export async function listOrders(
  db: Db,
  userId: string,
  refundPolicy?: RefundPolicy
): Promise<Order[]> {
  const rows = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.userId, userId), inArray(payments.status, ['paid', 'failed', 'refunded']))
    )
    .orderBy(desc(payments.createdAt))
  return toOrders(db, rows, refundPolicy)
}

/**
 * GET /v1/payments/orders/:orderId/details — one order's items plus its frozen
 * shipping address, for the order-history detail screen. Cross-user access and
 * a still-`pending` row both read as 404 (never leak another user's order; a
 * pending row isn't a placed order yet).
 */
export async function getOrderDetail(
  db: Db,
  userId: string,
  orderId: string,
  refundPolicy?: RefundPolicy
): Promise<OrderDetail> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row || row.status === 'pending') throw notFound('Order not found')

  const [order] = await toOrders(db, [row], refundPolicy)
  if (!order) throw new Error('order join returned no row')
  const address = row.addressSnapshot as Record<string, unknown>
  return {
    ...order,
    address: {
      name: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      pincode: String(address.pincode ?? ''),
      city: String(address.city ?? ''),
      state: String(address.state ?? ''),
      houseNumber: String(address.houseNumber ?? ''),
      roadArea: String(address.roadArea ?? ''),
    },
  }
}

/**
 * GET /v1/payments/orders/:orderId/invoice — invoice data for a `paid` or
 * `refunded` order (money changed hands; `pending`/`failed` have none, both
 * read as 404). No GST/GSTIN/"Tax Invoice" fields anywhere — `seller` is
 * passed in by the route, resolved from `legal.company` config, never
 * hardcoded here (this module never reads `app_config` directly).
 */
export async function getOrderInvoice(
  db: Db,
  userId: string,
  orderId: string,
  seller: InvoiceSeller
): Promise<OrderInvoice> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row || (row.status !== 'paid' && row.status !== 'refunded'))
    throw notFound('Order not found')

  const [order] = await toOrders(db, [row])
  if (!order) throw new Error('order join returned no row')
  const address = row.addressSnapshot as Record<string, unknown>
  return {
    orderId: order.orderId,
    status: row.status as OrderInvoice['status'],
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    seller,
    buyerAddress: {
      name: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      pincode: String(address.pincode ?? ''),
      city: String(address.city ?? ''),
      state: String(address.state ?? ''),
      houseNumber: String(address.houseNumber ?? ''),
      roadArea: String(address.roadArea ?? ''),
    },
    items: order.items.map((item) => ({ ...item, lineTotalInr: item.qty * item.priceInr })),
    goodsInr: order.goodsInr,
    couponDiscountInr: order.couponDiscountInr,
    shippingFeeInr: order.shippingFeeInr,
    totalInr: order.totalInr,
    currency: 'INR',
  }
}

/**
 * POST /v1/payments/orders/:orderId/cancel — customer-initiated cancellation.
 * Cross-user or unknown ids, and a still-`pending` row, all read as 404 (same
 * rule as {@link getOrderDetail} — a pending row isn't a placed order yet). A
 * `failed` order has nothing to refund → 409 `conflict`. An already-`refunded`
 * row is an idempotent no-op (replay-safe, e.g. a retried request): returns the
 * current status WITHOUT calling Razorpay again.
 *
 * A paid order is otherwise cancellable **unless {@link OrderCancelPolicy}
 * refuses it** — which is how "the parcel has already left" is enforced now
 * that a courier exists. The check runs before Razorpay is touched, because a
 * refund cannot be recalled once issued.
 *
 * Issues a full refund for the stored `amount_paise` against the payment
 * (never a client-supplied amount), then performs the same guarded
 * `paid → refunded` UPDATE the webhook's `refund.processed` handler uses — so
 * if that webhook later arrives for this same refund, it finds the row already
 * `refunded` and is a no-op. `reason` (the shopper-picked cancel reason, from
 * the `orders.cancelReasons` config list) is stored as-is, UI copy only — never
 * validated against the config list server-side.
 */
export async function cancelOrder(
  db: Db,
  gateway: PaymentsGateway,
  userId: string,
  orderId: string,
  reason?: string,
  policy?: OrderCancelPolicy,
  hooks?: PaymentHooks
): Promise<OrderCancelResponse> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.userId, userId)))
    .limit(1)
  if (!row || row.status === 'pending') throw notFound('Order not found')
  if (row.status === 'refunded') return { orderId, status: 'refunded' }
  if (row.status === 'failed' || !row.razorpayPaymentId) {
    throw conflict('Only a paid order can be cancelled')
  }

  // Ordered deliberately: after the idempotent `refunded` short-circuit (so a
  // replayed cancel of an already-refunded order still succeeds even once the
  // parcel is moving) and before the gateway call (so a refused cancellation
  // costs nothing).
  if (policy !== undefined) {
    const blocked = await policy.block(orderId)
    if (blocked !== null) throw conflict(blocked)
  }

  const rzp = await gateway.client()

  let record: RefundRecord | undefined
  try {
    // A payment can be `paid` here (our `verify` transition is HMAC-only)
    // while still `authorized` on Razorpay's side if the merchant account's
    // capture setting is manual — a refund on an uncaptured payment is
    // rejected. Capture it first in that case; already-captured payments are
    // left alone.
    const payment = await rzp.payments.fetch(row.razorpayPaymentId)
    if (payment.status === 'authorized') {
      await rzp.payments.capture(row.razorpayPaymentId, row.prepaidAmountPaise, row.currency)
    }

    // The TOKEN, not the total. On a COD order only ₹49 ever reached us;
    // refunding `amountPaise` would hand back ₹651 of money nobody paid.
    const refund = await rzp.payments.refund(row.razorpayPaymentId, {
      amount: row.prepaidAmountPaise,
    })
    const status = toRefundStatus(refund.status)
    record = {
      refundId: refund.id ?? null,
      status,
      amountPaise: row.prepaidAmountPaise,
      speed: refund.speed_processed ?? null,
      // Our own clock, not Razorpay's `created_at`: this is the instant we
      // asked, and it is what the shopper's "credit by" date counts from.
      initiatedAt: new Date(),
      // An instant refund can come back already processed; anything else is
      // released by the bank later and arrives as `refund.processed`.
      processedAt: status === 'processed' ? new Date() : null,
      destination: refundDestinationFromPayment(payment),
    }
  } catch (err) {
    // Razorpay rejected the capture/refund (e.g. an authorized payment whose
    // capture window lapsed and was auto-voided, or a refund already issued
    // out-of-band) — a real, if opaque, business outcome, not a server bug.
    // Surface it as a 409 instead of falling into the generic 500 handler.
    const description = gatewayErrorDescription(err)
    if (description === undefined) throw err
    throw conflict(`Order cannot be cancelled right now: ${description}`)
  }

  await db.transaction((tx: Tx) => markRefunded(tx, row, hooks, reason, record))

  await policy?.onCancelled?.(orderId)

  return { orderId, status: 'refunded' }
}

/**
 * What asking Razorpay directly said about one `pending` row.
 *
 * `already` is not `paid`: the gateway reported a capture but the guarded
 * transition updated no rows, i.e. a concurrent observer got there first. The
 * order IS paid; THIS call is simply not the one that made it so, and callers
 * that count transitions must not count it twice.
 */
type ReconcileOutcome = 'paid' | 'already' | 'mismatched' | 'none' | 'unreachable'

/**
 * Ask the gateway what actually happened to one pending order, and apply it.
 *
 * The single place the "money exists at Razorpay but our row still says
 * pending" question is answered, shared by the recover sweep and the status
 * poll. Both need byte-identical rules — the amount AND currency guard, the
 * refusal to transition a mismatch, the once-only `markPaid` path — and the way
 * to guarantee that is to have one implementation rather than two that agree
 * today.
 *
 * A mismatch NEVER transitions, in either direction. Money was captured, so
 * failing the row would orphan it; paying it would honour an amount we did not
 * price. It is logged at ERROR, recorded as `mismatched`, and left pending for
 * a human.
 */
async function reconcilePendingFromGateway(
  db: Db,
  rzp: RazorpayApi,
  row: PaymentRow,
  observedBy: AttemptObserver,
  hooks: PaymentHooks | undefined,
  log: (obj: Record<string, unknown>, msg: string) => void
): Promise<ReconcileOutcome> {
  let found: { id: string; amount: number | string; currency?: string } | undefined
  try {
    const { items } = await rzp.orders.fetchPayments(row.orderId)
    found = items.find((p) => p.status === 'captured')
  } catch {
    // Razorpay unreachable for this order — say so and leave the row alone.
    return 'unreachable'
  }
  if (!found) return 'none'
  const captured = found

  const capturedAmount =
    typeof captured.amount === 'number' ? captured.amount : Number(captured.amount)
  // Same strictness as the webhook path: amount AND currency must match (an
  // absent currency is a mismatch, never a pass).
  if (capturedAmount === row.prepaidAmountPaise && captured.currency === row.currency) {
    const transition = await db.transaction((tx: Tx) =>
      markPaid(tx, row, captured.id, hooks, observedBy, log)
    )
    if (!transition) return 'already'
    // Post-commit announcements matter more on this path than on the happy one:
    // it only runs when the webhook has not (yet) arrived, so it is the first —
    // and in the sweep's case the last — chance to report the purchase.
    hooks?.onOrderPaidCommitted?.(transition)
    return 'paid'
  }

  log(
    {
      orderId: row.orderId,
      expectedAmountPaise: row.prepaidAmountPaise,
      capturedAmountPaise: capturedAmount,
      expectedCurrency: row.currency,
      capturedCurrency: captured.currency,
      observedBy,
    },
    'payments reconcile: amount/currency mismatch — NOT transitioning'
  )
  await recordAttempt(
    db as unknown as Tx,
    row.orderId,
    observedBy,
    {
      razorpayPaymentId: captured.id,
      status: 'mismatched',
      amountPaise: capturedAmount,
      errorDescription: `expected ${row.prepaidAmountPaise} ${row.currency}, gateway reported ${capturedAmount} ${String(captured.currency)}`,
    },
    log
  )
  return 'mismatched'
}

/**
 * POST /v1/payments/recover (admin) — reconcile rows stuck `pending`. For each
 * pending row older than {@link RECOVER_STALE_AFTER_MS}: fetch the order's
 * payments from Razorpay; a captured payment matching the stored amount AND
 * currency → transition `paid` (same guarded transition, so it clears the cart
 * + is idempotent); a captured payment that does NOT match → NEVER transition
 * (money was captured — failing the row would orphan it): log ERROR (same
 * shape as the webhook mismatch log), count it `mismatched`, leave it pending
 * for manual review; no captured payment at all and the order is older than
 * {@link RECOVER_EXPIRE_AFTER_MS} → `failed`. Returns summary counts.
 *
 * Driven both by `POST /v1/payments/recover` (an operator) and by
 * `POST /v1/internal/sweeps/payments-recover` (Cloud Scheduler, every 30
 * minutes — see `scripts/provision-schedulers.sh`). Both call THIS function
 * with the same hooks, so an automatic recovery and a hand-pressed one produce
 * an identical order.
 *
 * `limit` bounds one run to {@link RECOVER_MAX_BATCH} rows by default; see that
 * constant for why an unbounded scan is the expensive shape.
 */
export async function recover(
  db: Db,
  gateway: PaymentsGateway,
  log: (obj: Record<string, unknown>, msg: string) => void,
  now: Date = new Date(),
  hooks?: PaymentHooks,
  limit: number = RECOVER_MAX_BATCH
): Promise<PaymentRecoverResponse> {
  const staleBefore = new Date(now.getTime() - RECOVER_STALE_AFTER_MS)
  const expireBefore = new Date(now.getTime() - RECOVER_EXPIRE_AFTER_MS)

  const stale = await db
    .select()
    .from(payments)
    .where(and(eq(payments.status, 'pending'), lt(payments.createdAt, staleBefore)))
    // Oldest first: the row most likely to be a real lost capture (rather than a
    // cart abandoned minutes ago) is the one that must survive the cap.
    .orderBy(payments.createdAt)
    .limit(limit)

  const rzp = await gateway.client()
  let paid = 0
  let failed = 0
  let mismatched = 0
  let stillPending = 0
  let scanned = 0

  // Wall clock, deliberately not derived from the injected `now`: that argument
  // exists so tests can control ELIGIBILITY (which rows are stale enough), and
  // is a frozen instant. Elapsed time in the loop is a different question and
  // needs the real clock.
  const startedAt = Date.now()

  for (const row of stale) {
    // Checked before the round trip rather than after: the point is to not
    // START a call that would push the run past Cloud Scheduler's attempt
    // deadline. Unvisited rows are untouched and stay eligible for the next
    // pass, which is the same contract the row cap already relies on.
    if (Date.now() - startedAt > RECOVER_TIME_BUDGET_MS) {
      log(
        { scanned, remaining: stale.length - scanned, budgetMs: RECOVER_TIME_BUDGET_MS },
        'payments recover: time budget spent, leaving the rest for the next run'
      )
      break
    }
    scanned += 1

    const outcome = await reconcilePendingFromGateway(db, rzp, row, 'recover', hooks, log)
    if (outcome === 'paid') {
      paid += 1
      continue
    }
    if (outcome === 'mismatched') {
      mismatched += 1
      continue
    }
    // `unreachable` leaves the row for the next sweep; `already` means a
    // concurrent observer performed the transition, so this run transitioned
    // nothing. Neither is a capture this sweep can claim.
    if (outcome !== 'none') {
      stillPending += 1
      continue
    }

    if (row.createdAt < expireBefore) {
      await db
        .update(payments)
        .set({ status: 'failed', updatedAt: sql`now()` })
        .where(and(eq(payments.orderId, row.orderId), eq(payments.status, 'pending')))
      failed += 1
      continue
    }

    stillPending += 1
  }

  // `scanned` is rows VISITED, not rows selected — they differ only when the
  // time budget cut the run short, and reporting the selection would claim work
  // this run did not do.
  return { scanned, paid, failed, mismatched, stillPending }
}
