/**
 * Zod contracts for the payments module (SPEC-PAYMENTS.md v3) — the single
 * source of truth for request validation AND response types. Imports only
 * `zod`, same rule as every other contracts file (shareable with mobile).
 *
 * Table (owned by `payments`, see db/schema.ts `payments`):
 *
 * ```
 * payments:
 *   order_id            text pk        -- Razorpay order id
 *   user_id             uuid fk -> users(id)
 *   amount_paise        int  check > 0
 *   currency            text default 'INR'
 *   status              text default 'pending'
 *                       check in ('pending','paid','failed','refunded')
 *   razorpay_payment_id text null
 *   cart_snapshot       jsonb          -- priced lines + totals at order time
 *   address_snapshot    jsonb          -- shipping address at order time
 *   created_at, updated_at timestamptz default now()
 *   paid_at             timestamptz null
 *   cancel_reason       text null     -- shopper-picked reason, set on cancel
 * ```
 *
 * Endpoints (all under `/v1/payments`) — see docs/CONTRACTS.md:
 * - `POST /orders` (auth): prices the caller's cart via the cart read API
 *   (never the client-sent amount — ARCHITECTURE.md "Price integrity"),
 *   validates `addressId` ownership, requires the caller's `users.consentAccepted`
 *   (Terms + Privacy, captured at login — see plugins/auth.ts — not per-order;
 *   422 if somehow false), creates the Razorpay order, inserts a `pending` row
 *   with all three snapshots.
 * - `POST /verify` (auth): HMAC-SHA256(`orderId|paymentId`, KEY_SECRET),
 *   length pre-check + timing-safe, before an idempotent transition to `paid`.
 * - `POST /webhook` (NO auth — verified by the `RAZORPAY_WEBHOOK_SECRET`
 *   signature over the RAW body): idempotent status transitions.
 * - `POST /orders/:orderId/upi/intent` (auth, MOBILE only): opens an S2S UPI
 *   payment on an existing `pending` order and returns the `upi://pay?…` intent
 *   link, so an installed UPI app opens at the confirm screen instead of the
 *   shopper typing a VPA into Checkout. No verify step — capture arrives on the
 *   webhook and the client polls `GET /orders/:orderId`.
 * - `GET /orders/:orderId` (auth): own row only — status polling.
 * - `GET /orders` (auth): own order history (terminal statuses only), newest first.
 * - `GET /orders/:orderId/details` (auth): one order's items + shipping address
 *   for the order-history detail screen; 404 while still `pending`.
 * - `POST /orders/:orderId/cancel` (auth): customer-initiated cancellation of a
 *   `paid` order whose parcel has not yet been handed to the courier (409
 *   otherwise — see `OrderCancelPolicy`). Issues a full Razorpay refund, then
 *   the same guarded `paid → refunded` transition the webhook uses.
 * - `GET /orders/:orderId/invoice` (auth): invoice data for a `paid`/`refunded`
 *   order — itemised lines, delivery fee, total, order number, seller +
 *   buyer address. No GST/GSTIN/"Tax Invoice" wording anywhere — see
 *   `InvoiceSellerSchema` below for why this stayed that way after
 *   registration. 404 for `pending`/`failed`.
 * - `POST /recover` (auth + admin): reconcile rows stuck `pending`.
 *
 * Env (optional — missing → 503 `payments_disabled`): `RAZORPAY_KEY_ID`,
 * `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
 */

import { z } from 'zod'

const sku = z.string().min(1, 'sku is required').max(100, 'sku must be 100 characters or fewer')
/** Mirrors `MAX_LINES` in contracts/cart.ts — a caller can never select more lines than a cart can hold. */
const MAX_ORDER_SKUS = 50

/**
 * POST /v1/payments/orders body. The amount is computed server-side from the
 * caller's cart (never the client), but a physical-goods order must capture a
 * shipping address at payment time, so the client sends the id of one of its
 * own saved addresses. Strict: unknown keys rejected. The address must belong
 * to the caller (else 404 `not_found`).
 *
 * `skus`: the shopper's cart-screen selection — buy only these lines, leaving
 * the rest of the cart untouched (see `getCart`'s `skus` filter and
 * `markPaid`'s ordered-lines-only clear). Omitted → every active cart line, the
 * pre-selection behavior. An empty array is rejected (nothing to buy) rather
 * than silently falling back to the whole cart.
 *
 * `couponCode`: an optional client-held coupon code (mirrors `GET
 * /v1/cart?coupon=CODE`) — the route re-resolves it into a `CouponRule` and
 * folds it into the same `getCart` pricing call before `createOrder`, so the
 * Razorpay amount and `cart_snapshot` already reflect the coupon. The amount
 * stays 100% server-computed: a client can only select a code, never supply a
 * discount amount.
 */
export const PaymentOrderCreateSchema = z
  .strictObject({
    addressId: z.uuid(),
    /**
     * How the shopper wants to pay. Omitted ⇒ `'prepaid'`, which is what every
     * client written before COD existed means and what the server must assume.
     *
     * A REQUEST, never a fact: the server re-evaluates eligibility against this
     * order's own address and the live cap, and refuses with `cod_unavailable`
     * if the answer moved since the cart screen. See docs/SPEC-COD.md D7.
     */
    paymentMode: z.enum(['prepaid', 'cod']).optional(),
    skus: z.array(sku).min(1, 'skus must not be empty').max(MAX_ORDER_SKUS).optional(),
    couponCode: z.string().min(1).max(64).optional(),
    /**
     * The `shipping.quoteToken` from the cart read the shopper actually saw.
     * Optional so older clients keep working, but a client that sends it gets a
     * guarantee: if the delivery fee moved between that screen and this request,
     * the order is refused with 409 rather than charged at a number nobody was
     * shown. The token asserts nothing on its own — the server recomputes the
     * quote and compares.
     */
    quoteToken: z.string().min(1).max(512).optional(),
    /**
     * The caller's RudderStack `anonymousId`. Frozen onto the order row so the
     * server-side `Order Completed` can be stitched to the pre-purchase session
     * the app recorded — the searches, the product views, the add-to-cart — which
     * all happened against this id and nothing else.
     *
     * Optional, and unvalidated beyond shape: it is an opaque client-generated
     * identifier we only ever echo back into the event stream, never trust, and
     * never use to authorise anything. Capped so a client cannot use it as free
     * storage on our order table.
     */
    anonymousId: z.string().min(1).max(128).optional(),
    /**
     * Campaign attribution read off the landing URL by the client and carried
     * through checkout. Frozen onto the order row so realised CAC is computable
     * — `spend / orders where utm_campaign = '<campaign>'`.
     *
     * Every field optional and capped, and treated exactly like `anonymousId`:
     * opaque, untrusted, echoed into the event stream and onto the row, never
     * read back to authorise or price anything. The cap stops a client using the
     * order table as free storage.
     */
    attribution: z
      .object({
        utmSource: z.string().min(1).max(128).optional(),
        utmMedium: z.string().min(1).max(128).optional(),
        utmCampaign: z.string().min(1).max(128).optional(),
        utmContent: z.string().min(1).max(128).optional(),
        gclid: z.string().min(1).max(512).optional(),
        oppref: z.string().min(1).max(2048).optional(),
      })
      .optional(),
    /**
     * "How did you hear about us?" — the shopper's own answer, asked once on the
     * payment screen and optional by design.
     *
     * This is NOT attribution and is never summed with `attribution.utmCampaign`
     * or with Ads conversions. UTMs say what the click claimed; this says what
     * the person believes, and they disagree exactly where it matters: someone
     * who saw the product on Instagram, searched the brand days later and
     * converted on a paid click carries both. Realised CAC stays UTM-based.
     *
     * Closed set, mirrored by the `payments_heard_about_valid` CHECK — unlike
     * `attribution`, an unknown value is rejected rather than stored, because
     * anything that reaches a roll-up has to be countable.
     */
    heardAbout: z
      .enum([
        'google_search',
        'instagram',
        'facebook',
        'youtube',
        'whatsapp',
        'amazon',
        'friend_family',
        'other',
      ])
      .optional(),
    /**
     * The free-text half, accepted only alongside `heardAbout: 'other'` — this
     * is what finds the channel the pick-list forgot. Capped like every other
     * opaque client string so the order table cannot be used as free storage.
     */
    heardAboutOther: z.string().trim().min(1).max(200).optional(),
    /**
     * WhatsApp MARKETING opt-in, ticked at checkout. Defaults OFF — omitting it
     * is not consent, and there is deliberately no way to express "yes" by
     * saying nothing.
     *
     * Sent here rather than only through `PATCH /v1/me` because the checkbox
     * lives on the payment screen, and the order-create request is the one that
     * can freeze the acceptance into `consent_snapshot` alongside the terms and
     * privacy record for the same instant. That snapshot is EVIDENCE; the
     * authoritative current state is `users.marketing_whatsapp_opt_in`, which
     * this also sets — see `services/marketingConsent.ts` for why the two are
     * separate and which one a send may read.
     */
    marketingWhatsappOptIn: z.boolean().optional(),
    /**
     * Ad-audience opt-in, ticked at checkout — consent to share the shopper's
     * hashed email/phone with ad platforms. Its own checkbox and its own field,
     * never folded into `marketingWhatsappOptIn`: DPDP itemises purposes. Same
     * default-OFF, omitted-is-not-consent rule, and the same snapshot-vs-state
     * split (`users.ad_audience_opt_in` is the state).
     */
    adAudienceOptIn: z.boolean().optional(),
  })
  /**
   * The free-text half is meaningless without the choice it explains, and a
   * row carrying one without the other would have to be defended against in
   * every roll-up. The DB says the same thing
   * (`payments_heard_about_other_requires_other`); rejecting it here turns a
   * 500 from a constraint violation into a 422 naming the field.
   */
  .refine((b) => b.heardAboutOther === undefined || b.heardAbout === 'other', {
    path: ['heardAboutOther'],
    message: "heardAboutOther is only accepted with heardAbout: 'other'",
  })

/**
 * POST /v1/payments/orders response — what the client needs to open Razorpay
 * Checkout. `mode` is derived server-side from the KEY_ID prefix
 * (`rzp_test_` → 'test', `rzp_live_` → 'live') so the client can render a
 * TEST-MODE banner; no key secret material ever leaves the server (only the
 * public `keyId`).
 */
export const PaymentOrderSchema = z.object({
  orderId: z.string(),
  keyId: z.string(),
  /**
   * WHAT THE GATEWAY IS CHARGING — not the order total.
   *
   * On a prepaid order they are the same number. On a COD order this is the
   * ₹49 token and nothing else, because this field exists for exactly one
   * purpose: it is handed to Razorpay Checkout. A client that renders it as
   * "your order total" will tell a COD shopper their ₹700 order costs ₹49.
   * `orderTotalInr` below is the total.
   */
  amountInr: z.int(),
  amountPaise: z.int(),
  currency: z.literal('INR'),
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  mode: z.enum(['test', 'live']),
  /** How this order is being paid. `'prepaid'` on everything before COD existed. */
  paymentMode: z.enum(['prepaid', 'cod']),
  /** The full order value — goods after coupon, plus delivery. */
  orderTotalInr: z.int(),
  /** Collected in cash at the door. 0 on a prepaid order. */
  codAmountInr: z.int(),
})

/** POST /v1/payments/verify body — the three fields Razorpay Checkout returns on success. */
export const PaymentVerifySchema = z.strictObject({
  razorpayOrderId: z.string().min(1, 'razorpayOrderId is required'),
  razorpayPaymentId: z.string().min(1, 'razorpayPaymentId is required'),
  razorpaySignature: z.string().min(1, 'razorpaySignature is required'),
})

/** POST /v1/payments/verify response — the (possibly already-final) status of the row. */
export const PaymentVerifyResponseSchema = z.object({
  orderId: z.string(),
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
})

/**
 * The UPI apps we hand back a scheme-specific deep link for, alongside the
 * generic `upi://` intent URL. Deliberately a closed list of the four that
 * matter in India: the client renders an app chooser from whichever of these it
 * finds installed, so an unknown value here would be a button that opens
 * nothing.
 */
export const UpiAppSchema = z.enum(['gpay', 'phonepe', 'paytm', 'bhim'])

/**
 * One installed-app target. `url` is the same payment re-schemed for that app
 * (`phonepe://pay?…`), which is what iOS opens directly after a
 * `canOpenURL` check; `androidPackage` is the package name to pin the generic
 * `intentUrl` to on Android, which is the documented way to route an intent at
 * one specific app rather than raising the system chooser.
 */
export const UpiIntentAppSchema = z.object({
  app: UpiAppSchema,
  url: z.string(),
  androidPackage: z.string(),
})

/**
 * POST /v1/payments/orders/:orderId/upi/intent response — everything the
 * MOBILE app needs to hand the shopper straight to their UPI app.
 *
 * `intentUrl` is Razorpay's own `upi://pay?pa=…&am=…&tr=…` link, unmodified;
 * `apps` are the same link re-schemed per app (see {@link UpiIntentAppSchema}).
 * `paymentId` is the Razorpay payment entity opened by this call — it is NOT a
 * completed payment, and the order stays `pending` until `payment.captured`
 * arrives on the webhook. The client polls `GET /v1/payments/orders/:orderId`
 * exactly as it does after Checkout; there is no S2S-specific verify, because
 * the intent flow returns no signature to verify.
 *
 * `expiresInMinutes` is the link's own lifetime as requested from Razorpay —
 * past it the shopper must ask for a fresh intent (a second call to this
 * endpoint), which is a new payment attempt against the same order.
 */
export const UpiIntentSchema = z.object({
  orderId: z.string(),
  paymentId: z.string(),
  intentUrl: z.string(),
  apps: z.array(UpiIntentAppSchema),
  amountInr: z.int(),
  amountPaise: z.int(),
  currency: z.literal('INR'),
  expiresInMinutes: z.int(),
})

/** Route params for `GET /v1/payments/orders/:orderId`. */
export const PaymentOrderParamsSchema = z.strictObject({
  orderId: z.string().min(1),
})

/** GET /v1/payments/orders/:orderId response — status polling after checkout closes. */
export const PaymentStatusResponseSchema = z.object({
  orderId: z.string(),
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  amountInr: z.int(),
  amountPaise: z.int(),
  currency: z.literal('INR'),
})

/**
 * POST /v1/payments/recover response — summary counts of the reconciliation
 * sweep. `mismatched` = rows whose captured payment does NOT match the stored
 * amount/currency: never transitioned (money exists!), logged ERROR, left
 * pending for manual review.
 */
export const PaymentRecoverResponseSchema = z.object({
  scanned: z.int(),
  paid: z.int(),
  failed: z.int(),
  mismatched: z.int(),
  stillPending: z.int(),
})

/**
 * One row of the gateway attempt log (`payment_attempts`) — admin-only
 * reconciliation. Purely descriptive: nothing in the system reads it back to
 * make a decision, so every gateway-supplied field is nullable exactly as the
 * event delivered it.
 */
export const PaymentAttemptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  /** Razorpay's payment entity id — the id a refund or support ticket is keyed by. */
  razorpayPaymentId: z.string().nullable(),
  /** 'mismatched' = money exists but its amount/currency did not match the order, so nothing transitioned. */
  status: z.enum(['captured', 'failed', 'mismatched']),
  amountPaise: z.int().nullable(),
  method: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorDescription: z.string().nullable(),
  errorReason: z.string().nullable(),
  errorSource: z.string().nullable(),
  errorStep: z.string().nullable(),
  /**
   * Which path observed it. `poll` is the status endpoint asking Razorpay
   * directly — the UPI intent flow has no signature, so there is no `verify`
   * call on it and a late webhook would otherwise leave the shopper waiting.
   */
  observedBy: z.enum(['verify', 'webhook', 'recover', 'poll']),
  createdAt: z.iso.datetime(),
})

export const PaymentAttemptListSchema = z.object({ attempts: z.array(PaymentAttemptSchema) })

/** The lifecycle of a payment row. */
export const PaymentStatusSchema = z.enum(['pending', 'paid', 'failed', 'refunded'])

/**
 * One line of an order, as shown in order history. `name`/`size`/`imageUrl`
 * are joined from the LIVE catalog by sku (catalog rows are never deleted,
 * only deactivated — see db/schema.ts `catalogItems`); `priceInr` is the
 * frozen `cart_snapshot` price actually charged, never the live catalog price.
 */
export const OrderItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  size: z.string(),
  imageUrl: z.string(),
  qty: z.int(),
  priceInr: z.int(),
})

/** The shipping address frozen into an order's `address_snapshot`. */
export const OrderAddressSchema = z.object({
  name: z.string(),
  phone: z.string(),
  pincode: z.string(),
  city: z.string(),
  state: z.string(),
  houseNumber: z.string(),
  roadArea: z.string(),
})

/**
 * Where a refund was sent — the instrument the payment came from, since a
 * refund always goes back to source. `label` is the shopper-facing name of the
 * method ("UPI Account", "Card", "Net Banking"); `reference` is the partial
 * identifier that lets them recognise the account (a VPA, a card's last four)
 * and is null when the method carries nothing recognisable.
 */
export const OrderRefundDestinationSchema = z.object({
  label: z.string(),
  reference: z.string().nullable(),
})

/**
 * The refund block on a refunded order — what the app's "Refund details" sheet
 * shows. Present only when `status === 'refunded'`, and every field inside is
 * nullable because a refund issued before this data was recorded still has to
 * render: an old order reports its amount and status and nothing more.
 *
 * `status` mirrors Razorpay, never our own inference — `pending` is money the
 * bank has not released yet, and calling that "Success" is the one lie this
 * whole feature exists to stop telling.
 *
 * `creditByDate` is a PROMISE DATE (YYYY-MM-DD), computed from the refund's
 * initiation plus the `refunds.creditDays` working-day allowance — Razorpay
 * publishes no per-refund ETA. It is null for an instant refund (already
 * landed) and for any refund whose initiation time was never recorded.
 */
export const OrderRefundSchema = z.object({
  amountInr: z.int(),
  status: z.enum(['pending', 'processed', 'failed']),
  destination: OrderRefundDestinationSchema.nullable(),
  initiatedAt: z.iso.datetime().nullable(),
  processedAt: z.iso.datetime().nullable(),
  creditByDate: z.iso.date().nullable(),
  /** True when Razorpay processed it at instant speed — money is already in the account. */
  instant: z.boolean(),
})

/**
 * One order in the caller's history — a `payments` row that reached a
 * terminal state. A still-`pending` row is a mid-checkout attempt, not an
 * order, and is excluded from both `GET /orders` and `GET /orders/:id/details`.
 */
export const OrderSchema = z.object({
  orderId: z.string(),
  status: z.enum(['paid', 'failed', 'refunded']),
  totalInr: z.int(),
  /**
   * The three components of `totalInr`, so the order screen can show a bill
   * that adds up: `goodsInr − couponDiscountInr + shippingFeeInr === totalInr`.
   * Orders placed before delivery fees existed report `goodsInr === totalInr`
   * with the other two at 0, which is exactly what they were.
   */
  goodsInr: z.int(),
  couponDiscountInr: z.int(),
  shippingFeeInr: z.int(),
  currency: z.literal('INR'),
  createdAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  items: z.array(OrderItemSchema),
  /** Present only on a `refunded` order; null on every other status. */
  refund: OrderRefundSchema.nullable(),
  /**
   * How this order was paid. `'prepaid'` on every order placed before COD
   * existed — the column defaults to it, so this is a fact about those orders
   * and not a fallback.
   */
  paymentMode: z.enum(['prepaid', 'cod']),
  /**
   * Still to be collected in cash at the door; 0 on a prepaid order. Part of
   * `totalInr`, never added to it — the bill identity above is unchanged.
   */
  codAmountInr: z.int(),
  /** Already paid through the gateway: `totalInr − codAmountInr`. */
  prepaidAmountInr: z.int(),
  /** When the courier's cash actually reached us; null until it does. */
  codCollectedAt: z.iso.datetime().nullable(),
})

/** GET /v1/payments/orders response — the caller's order history, newest first. */
export const OrderListResponseSchema = z.object({
  orders: z.array(OrderSchema),
})

/** GET /v1/payments/orders/:orderId/details response — one order plus its shipping address. */
export const OrderDetailSchema = OrderSchema.extend({
  address: OrderAddressSchema,
})

/**
 * POST /v1/payments/orders/:orderId/cancel body — the shopper-picked reason
 * (from the `orders.cancelReasons` config list), stored for reporting. The
 * whole body is optional (a bare POST with no payload still cancels — older
 * clients and existing tests rely on this); an unknown key is still rejected.
 */
export const OrderCancelBodySchema = z
  .strictObject({
    reason: z.string().min(1).max(200).optional(),
  })
  // Fastify hands POST/PUT bodies `null` (not `undefined`) when no payload is
  // sent at all — `.nullish()` accepts both so a bare POST still cancels.
  .nullish()

/**
 * POST /v1/payments/orders/:orderId/cancel response — the (possibly
 * already-`refunded`) status of the row, same idempotent-replay shape as
 * {@link PaymentVerifyResponseSchema}.
 */
export const OrderCancelResponseSchema = z.object({
  orderId: z.string(),
  status: z.enum(['paid', 'failed', 'refunded']),
})

/**
 * The seller-of-record block on an invoice — sourced from `legal.company`
 * config (never hardcoded), Adix's registered Jharkhand entity. Deliberately
 * has no GST/GSTIN field.
 *
 * NOTE (2026-09-04): the original reason — "Adix is not GST-registered" — no
 * longer holds. `gstRegistered` has been `true` in prod since 2026-08-13 and
 * the real GSTIN (`20AKLPA4779M1ZY`) landed 2026-09-04. This schema is the
 * legacy `GET /orders/:orderId/invoice` payment-route payload, NOT the tax
 * document: `routes/invoices.ts` + `lib/invoiceDocument.ts` own the real
 * invoice and do emit GSTIN/HSN/tax columns at `docVersion: 2`. Leaving this
 * payload GST-free is now a deliberate split, not a legal constraint — if it
 * is ever surfaced to a buyer as their invoice, it needs the tax fields.
 */
export const InvoiceSellerSchema = z.object({
  legalName: z.string(),
  address: z.string(),
})

/** One itemised invoice line — the frozen order price, with its computed line total. */
export const OrderInvoiceItemSchema = OrderItemSchema.extend({
  lineTotalInr: z.int(),
})

/**
 * GET /v1/payments/orders/:orderId/invoice response. Only ever issued for a
 * `paid` or `refunded` order (money changed hands) — a `pending`/`failed`
 * order has no invoice. `totalInr = goodsInr - couponDiscountInr +
 * shippingFeeInr`, same identity as {@link OrderSchema}.
 */
export const OrderInvoiceSchema = z.object({
  orderId: z.string(),
  status: z.enum(['paid', 'refunded']),
  createdAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  seller: InvoiceSellerSchema,
  buyerAddress: OrderAddressSchema,
  items: z.array(OrderInvoiceItemSchema),
  goodsInr: z.int(),
  couponDiscountInr: z.int(),
  shippingFeeInr: z.int(),
  totalInr: z.int(),
  currency: z.literal('INR'),
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type PaymentOrderCreate = z.infer<typeof PaymentOrderCreateSchema>
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>
export type PaymentVerify = z.infer<typeof PaymentVerifySchema>
export type PaymentVerifyResponse = z.infer<typeof PaymentVerifyResponseSchema>
export type PaymentOrderParams = z.infer<typeof PaymentOrderParamsSchema>
export type UpiApp = z.infer<typeof UpiAppSchema>
export type UpiIntentApp = z.infer<typeof UpiIntentAppSchema>
export type UpiIntent = z.infer<typeof UpiIntentSchema>
export type PaymentStatusResponse = z.infer<typeof PaymentStatusResponseSchema>
export type PaymentRecoverResponse = z.infer<typeof PaymentRecoverResponseSchema>
export type PaymentAttempt = z.infer<typeof PaymentAttemptSchema>
export type PaymentAttemptList = z.infer<typeof PaymentAttemptListSchema>
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>
export type OrderItem = z.infer<typeof OrderItemSchema>
export type OrderAddress = z.infer<typeof OrderAddressSchema>
export type OrderRefundDestination = z.infer<typeof OrderRefundDestinationSchema>
export type OrderRefund = z.infer<typeof OrderRefundSchema>
export type Order = z.infer<typeof OrderSchema>
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>
export type OrderDetail = z.infer<typeof OrderDetailSchema>
export type OrderCancelResponse = z.infer<typeof OrderCancelResponseSchema>
export type InvoiceSeller = z.infer<typeof InvoiceSellerSchema>
export type OrderInvoiceItem = z.infer<typeof OrderInvoiceItemSchema>
export type OrderInvoice = z.infer<typeof OrderInvoiceSchema>
