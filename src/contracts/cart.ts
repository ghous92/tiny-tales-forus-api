/**
 * Zod contracts for the cart resource (SPEC-V2.md §4) — the single source of
 * truth for request validation AND response types. Imports only `zod`, same
 * rule as `contracts/address.ts` / `contracts/config.ts`.
 */

import { z } from 'zod'

/** A cart line can hold 1..99 units of a sku — mirrors the `cart_items.qty` check constraint. */
export const MAX_QTY_PER_LINE = 99
/** Max distinct lines a cart may hold. */
export const MAX_LINES = 50
/** Max lines accepted in a single merge payload (independent of the cart's own 50-line cap). */
export const MAX_MERGE_ITEMS = 50

const sku = z.string().min(1, 'sku is required').max(100, 'sku must be 100 characters or fewer')
const qty = z
  .number()
  .int('qty must be a whole number')
  .min(1, `qty must be at least 1`)
  .max(MAX_QTY_PER_LINE, `qty must be ${MAX_QTY_PER_LINE} or fewer`)

/**
 * A single cart line as served by the API: `name`/`size`/`priceInr`/
 * `imageUrl`/`active` are joined live from `catalog_items` at read time
 * (`priceInr` is the CURRENT catalog price, not the stored snapshot — the
 * snapshot is for audit/orders only). `active: false` means the sku has gone
 * inactive since the line was added; the client shows "unavailable" and the
 * line is excluded from `count`/`totalInr` on the parent cart.
 */
export const CartLineSchema = z.object({
  sku: z.string(),
  productId: z.string(),
  name: z.string(),
  size: z.string(),
  qty: z.int(),
  priceInr: z.int(),
  imageUrl: z.string(),
  active: z.boolean(),
})

/**
 * Wholesale state for a cart. Wholesale is a CART-LEVEL rule, not a user
 * property: any cart whose retail subtotal reaches `thresholdInr` is billed at
 * wholesale rates for that order, and drops back to retail if it falls below.
 * Always present (even when wholesale is switched off) so the client can render
 * "spend ₹X more to unlock" without a second call.
 *
 * When `applied` is true, every line's `priceInr` is ALREADY the wholesale
 * price and `totalInr` already reflects it — `savedInr` is informational
 * ("you saved ₹Y"), never something the client subtracts itself.
 */
export const CartWholesaleSchema = z.object({
  /** True when this cart is being billed at wholesale rates right now. */
  applied: z.boolean(),
  /** Whether wholesale pricing is switched on at all (config `wholesale.enabled`). */
  enabled: z.boolean(),
  /** Retail subtotal needed to qualify (config `wholesale.thresholdInr`). */
  thresholdInr: z.int(),
  /** The percent off applied once qualified (config `wholesale.discountPct`). */
  discountPct: z.int(),
  /** Σ(qty × retail price) over active lines — what this cart would cost at retail. */
  retailTotalInr: z.int(),
  /** Retail total still needed to qualify; 0 once applied (or when disabled). */
  remainingInr: z.int(),
  /** retailTotalInr − totalInr; 0 unless `applied`. */
  savedInr: z.int(),
})

/**
 * Coupon state for a cart. Unlike wholesale (a property of the cart itself),
 * a coupon is a CODE THE CLIENT HOLDS and sends on every request
 * (`?coupon=CODE`) — the server is stateless about the selection (see
 * services/coupons.ts / lib/coupons.ts), re-resolving and re-validating it
 * every time. Always present (even when no code was requested) so the client
 * never has to special-case a missing block. It is an ORDER-LEVEL discount on
 * top of the post-wholesale subtotal: `totalInr === subtotalInr −
 * discountInr`, and `subtotalInr` here is the SAME number `totalInr` used to
 * be before this field existed (Σ(qty × priceInr) over active lines,
 * post-wholesale) — line prices are never touched by a coupon.
 *
 * When a requested code does not currently apply (unknown / inactive /
 * expired / below the cart minimum), `applied` is false, `discountInr` is 0,
 * and `reason` explains why (see designDecisions.criteriaBrokenBehavior) —
 * the client keeps its held code and can show a "spend ₹X more" hint, mirrored
 * from `label`/`minCartInr`, without a second lookup.
 */
export const CartCouponSchema = z.object({
  /** True when a valid coupon is discounting this cart right now. */
  applied: z.boolean(),
  /** The requested UPPERCASE code, or null when none was requested at all. */
  code: z.string().nullable(),
  /** '' when no matching coupon row was found (or none was requested). */
  label: z.string(),
  /** null when no matching coupon row was found (or none was requested). */
  discountType: z.enum(['flat', 'percent']).nullable(),
  /** Percent (1..90) or flat rupees per `discountType`; 0 when no row. */
  discountValue: z.int(),
  /** 0 when no row. */
  minCartInr: z.int(),
  /** Percent cap; null = uncapped / not applicable (also null when no row). */
  maxDiscountInr: z.int().nullable(),
  /** Rupees actually taken off this cart; 0 unless `applied`. */
  discountInr: z.int(),
  /** Σ(qty × priceInr) over active lines, POST-wholesale, pre-coupon. */
  subtotalInr: z.int(),
  /**
   * null when applied or no code was requested; set when a requested code did
   * not apply. `usage_exceeded` = the code is fully redeemed across all
   * shoppers; `user_limit_exceeded` = this shopper has used it as often as
   * they may. Neither is recoverable by changing the cart.
   */
  reason: z
    .enum(['below_min', 'invalid', 'expired', 'inactive', 'usage_exceeded', 'user_limit_exceeded'])
    .nullable(),
})

/**
 * Delivery state for a cart. Always present, exactly like `wholesale` and
 * `coupon`, so the client never special-cases a missing block — including when
 * shipping is switched off, no address is selected, or the destination cannot
 * be served (each of those sets a `reason`).
 *
 * The two booleans are split on purpose. `wholesale.applied` and
 * `coupon.applied` both mean "the benefit is on", so a single `applied` here
 * would invert that sense — a client would render "free delivery" on a cart
 * that is being charged for it. `feeApplied` is about the CHARGE, `freeApplied`
 * about the BENEFIT, and they are never both true.
 *
 * `wouldBeFeeInr` is what makes the cross-sell honest: it is the fee this cart
 * escapes by clearing the threshold, and it stays populated after the fee is
 * waived so the client can say what was saved. Adding an item can push the cart
 * into a heavier slab, so copy must read "save up to ₹60", never "save ₹60".
 */
export const CartShippingSchema = z.object({
  estimated: z.boolean().default(false),
  distanceKm: z.number().nullable().default(null),
  /** Whether delivery fees are switched on at all (config `shipping.enabled`). */
  enabled: z.boolean(),
  /** True when a non-zero fee is being charged right now. */
  feeApplied: z.boolean(),
  /** True when the threshold has been cleared and the fee waived. */
  freeApplied: z.boolean(),
  /** Rupees added to `totalInr` for delivery. 0 when free, disabled, or unquotable. */
  feeInr: z.int(),
  /** The free-delivery threshold for THIS cart's weight tier; 0 when no tier applies. */
  freeAboveInr: z.int(),
  /** Spend still needed to unlock free delivery; 0 once free (or when unreachable). */
  remainingInr: z.int(),
  /** The fee at this cart's current weight — the amount the threshold escapes. Non-zero even once free. */
  wouldBeFeeInr: z.int(),
  /** `wouldBeFeeInr` when `freeApplied`, else 0. Informational — never client-subtracted. */
  savedInr: z.int(),
  /**
   * The waiver came from an applied coupon carrying `waivesShipping`, not from
   * clearing the threshold. `freeApplied` is true either way; this says WHY, so
   * copy can read "Free delivery with REFILL10" instead of implying the cart
   * cleared a threshold it never reached.
   */
  waivedByCoupon: z.boolean(),
  /** Courier zone the quote was priced at; null when there is no quote. */
  zone: z.enum(['A', 'B', 'C', 'D', 'E', 'F']).nullable(),
  /** The winning courier's chargeable weight (dead vs volumetric vs its minimum). */
  chargeableWeightG: z.int(),
  /** The pincode this quote was priced against; '' when there is no destination. */
  destinationPincode: z.string(),
  /** Estimated delivery days; null when there is no quote. */
  etaDays: z.int().nullable(),
  /** Tentative delivery date, IST 'YYYY-MM-DD' — ship date (vs the node's cutoff) plus etaDays. Null when there is no quote. */
  estimatedDeliveryDate: z.string().nullable(),
  /** Display name of the chosen courier; '' when there is no quote. */
  courierLabel: z.string(),
  /** Machine code of the chosen courier ('delhivery'…); '' when there is no quote. */
  courierCode: z.string(),
  /** Opaque HMAC binding this quote to this priced cart (see services/shipping.ts). '' when no fee. */
  quoteToken: z.string(),
  /** Why there is no fee. null when a fee was quoted normally. */
  reason: z
    .enum([
      'disabled',
      'no_destination',
      'not_serviceable',
      'no_single_node',
      'weight_unknown',
      'dims_unknown',
    ])
    .nullable(),
})

/**
 * The delivery block a cart carries when shipping is switched off — and the
 * base every "no quote" answer is built from. Declared here beside the schema
 * so the cart service and the shipping service cannot drift apart on what
 * "no delivery fee" looks like on the wire.
 */
export const SHIPPING_NONE: CartShipping = {
  estimated: false,
  distanceKm: null,
  enabled: false,
  feeApplied: false,
  freeApplied: false,
  feeInr: 0,
  freeAboveInr: 0,
  remainingInr: 0,
  wouldBeFeeInr: 0,
  savedInr: 0,
  waivedByCoupon: false,
  zone: null,
  chargeableWeightG: 0,
  destinationPincode: '',
  etaDays: null,
  estimatedDeliveryDate: null,
  courierLabel: '',
  courierCode: '',
  quoteToken: '',
  reason: 'disabled',
}

/**
 * The cart resource. `count` = Σqty and `totalInr` = `coupon.subtotalInr` −
 * `coupon.discountInr` (== Σ(qty × priceInr) over active lines when no
 * coupon discounts this cart — fully backward compatible). `updatedAt` is the
 * max line `updatedAt`, or the epoch ISO string when the cart is empty
 * (mirrors the config snapshot's empty-table convention). Items are sorted
 * newest-first by `createdAt`.
 *
 * When `wholesale.applied` is true the line prices (and therefore
 * `coupon.subtotalInr`) are already the wholesale ones; a coupon on top of
 * that is a further ORDER-LEVEL subtraction, never a further line re-price.
 *
 * Delivery is the one component that is NOT part of `coupon.subtotalInr`: it
 * is added after the discount, so the full identity is
 * `totalInr === coupon.subtotalInr − coupon.discountInr + shipping.feeInr`
 * (and `shipping.feeInr` is 0 whenever shipping is off, which is why totals
 * are byte-identical to before this field existed).
 */
export const CartSchema = z.object({
  items: z.array(CartLineSchema),
  count: z.int(),
  totalInr: z.int(),
  wholesale: CartWholesaleSchema,
  coupon: CartCouponSchema,
  shipping: CartShippingSchema,
  updatedAt: z.iso.datetime(),
})

/**
 * GET /v1/cart query — an optional comma-separated sku allowlist, plus an
 * optional coupon code to fold into the priced total. Lets a caller preview
 * the priced total for a SUBSET of their cart (the mobile cart-screen "select
 * items to buy" checkboxes) before `POST /v1/payments/orders` prices/charges
 * that same subset via its own `skus` body field. Omitted → the full cart,
 * unchanged from before this existed.
 */
export const CartQuerySchema = z.object({
  skus: z.string().min(1).optional(),
  coupon: z.string().min(1).max(64).optional(),
  /**
   * Price delivery against a specific saved address (must belong to the
   * caller). This is the ONLY destination checkout may use — see `pincode`.
   */
  addressId: z.uuid().optional(),
  /**
   * Price delivery against a bare pincode, before the shopper has picked an
   * address. A PREVIEW ONLY: order creation re-prices against the order's own
   * address, and the `quoteToken` returned here is what proves the displayed
   * number and the charged number are the same one.
   */
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/, 'pincode must be 6 digits and not start with 0')
    .optional(),
})

/** PUT /v1/cart/items/:sku body — sets the line to exactly this qty (idempotent set, not increment). */
export const CartPutBodySchema = z.strictObject({
  qty,
})

/** Route params for the single-sku cart endpoints. */
export const CartSkuParamsSchema = z.strictObject({
  sku,
})

/** One line of a merge request payload. */
const CartMergeItemSchema = z.strictObject({
  sku,
  qty,
})

/**
 * POST /v1/cart/merge body — the caller's local (guest) cart at login time.
 * Duplicate skus within the SAME payload are rejected outright (ambiguous
 * intent); at most {@link MAX_MERGE_ITEMS} lines per request.
 */
export const CartMergeBodySchema = z
  .strictObject({
    items: z
      .array(CartMergeItemSchema)
      .max(MAX_MERGE_ITEMS, `items must be ${MAX_MERGE_ITEMS} or fewer`),
  })
  .refine(
    (body) => {
      const skus = body.items.map((item) => item.sku)
      return new Set(skus).size === skus.length
    },
    { message: 'Duplicate sku in merge payload', path: ['items'] }
  )

/** POST /v1/cart/merge response — the resulting cart plus any skus that were skipped. */
export const CartMergeResponseSchema = z.object({
  cart: CartSchema,
  skipped: z.array(z.string()),
})

/** The error envelope every non-2xx response uses (same shape as address.ts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type CartLine = z.infer<typeof CartLineSchema>
export type CartWholesale = z.infer<typeof CartWholesaleSchema>
export type CartCoupon = z.infer<typeof CartCouponSchema>
export type CartShipping = z.infer<typeof CartShippingSchema>
export type Cart = z.infer<typeof CartSchema>
export type CartQuery = z.infer<typeof CartQuerySchema>
export type CartPutBody = z.infer<typeof CartPutBodySchema>
export type CartSkuParams = z.infer<typeof CartSkuParamsSchema>
export type CartMergeBody = z.infer<typeof CartMergeBodySchema>
export type CartMergeItem = z.infer<typeof CartMergeItemSchema>
export type CartMergeResponse = z.infer<typeof CartMergeResponseSchema>
