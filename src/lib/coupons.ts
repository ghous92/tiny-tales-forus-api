/**
 * Coupon pricing math — pure, no DB, mirrors `lib/pricing.ts`'s wholesale
 * section. A coupon is an ORDER-LEVEL discount computed on the post-wholesale,
 * post-seasonal cart subtotal (stacking order: seasonal -> wholesale ->
 * coupon — see `services/cart.ts`). Line prices are never touched by a
 * coupon: it is an explicit subtraction from the subtotal, like a receipt's
 * "Coupon DIRECT15  -Rs X" line, so the wholesale per-line invariant
 * Sum(qty × priceInr) === coupon.subtotalInr still holds exactly. New
 * invariant: totalInr === coupon.subtotalInr − coupon.discountInr.
 */

export type CouponDiscountType = 'flat' | 'percent'

/** A requested-but-unresolved/ineligible code reads as one of these, never a thrown error. */
export type CouponReason =
  | 'below_min'
  | 'invalid'
  | 'expired'
  | 'inactive'
  | 'usage_exceeded'
  | 'user_limit_exceeded'

/**
 * The resolved coupon row + eligibility facts, as handed to the cart/payments
 * services (mirrors `WholesaleRule`). `active`/`validFrom`/`validTo` are
 * carried through (not pre-filtered) so pricing re-checks them on every
 * request — a coupon can go inactive or fall out of its window between one
 * request and the next.
 */
export interface CouponRule {
  code: string
  label: string
  description: string
  discountType: CouponDiscountType
  discountValue: number
  minCartInr: number
  maxDiscountInr: number | null
  active: boolean
  validFrom: Date | null
  validTo: Date | null
  /** Total redemptions allowed across all shoppers; null = unlimited. */
  usageLimit: number | null
  /** Redemptions allowed for the shopper this lookup was resolved for; null = unlimited. */
  perUserLimit: number | null
  /**
   * Waive the delivery fee entirely while this coupon is applied, whatever the
   * subtotal. Set for retention codes whose message promises free delivery on a
   * cart that would never clear the weight-tiered threshold — see
   * `coupons.waives_shipping` in `db/schema.ts`.
   */
  waivesShipping: boolean
}

/**
 * Live (unrevoked) redemption counts for a coupon, as
 * `services/coupons.ts#getCouponUsage` reads them off `coupon_redemptions`.
 *
 * Carried on the {@link CouponLookup} rather than passed alongside it so that
 * neither `services/cart.ts` nor `services/payments.ts` grows a parameter for
 * it — both already take the lookup as an opaque value the ROUTE resolved.
 */
export interface CouponUsage {
  /** Redemptions by everyone. */
  total: number
  /** Redemptions by the shopper this lookup is for; 0 when the lookup had no user (public validate). */
  byUser: number
}

/**
 * What a route hands `getCart`/`resolveCouponDiscount` after resolving a
 * client-supplied coupon code (`?coupon=CODE` / `couponCode` body field).
 * `code: null` — the {@link COUPON_NONE} default — means no code was
 * requested at all. When a code WAS requested, `code` is the uppercased
 * request and `rule` is the matching row, or `null` when no such code exists
 * in the `coupons` table (→ `reason: 'invalid'`).
 */
export interface CouponLookup {
  code: string | null
  rule: CouponRule | null
  /**
   * Live redemption counts for this code. ABSENT means "not counted", which
   * reads as unlimited — the limits are simply not enforced for that lookup.
   * That is deliberate for the anonymous/stateless paths (`POST
   * /v1/coupons/validate` has no user to count against) and it is what keeps
   * every pre-limit caller and test behaving exactly as before.
   */
  usage?: CouponUsage
}

/** No coupon requested — the safe default every `getCart`/`getCouponRuleByCode` caller falls back to. */
export const COUPON_NONE: CouponLookup = { code: null, rule: null }

/**
 * Is a coupon row usable right now? `active` must be true AND `now` must fall
 * within `[validFrom, validTo]` (either bound absent = unbounded on that
 * side). Pure time/flag check — the min-cart check lives in
 * {@link resolveCouponDiscount} because it needs the cart's subtotal.
 */
export function isCouponValidNow(
  active: boolean,
  validFrom: Date | null,
  validTo: Date | null,
  now: Date = new Date()
): boolean {
  if (!active) return false
  if (validFrom && now.getTime() < validFrom.getTime()) return false
  if (validTo && now.getTime() > validTo.getTime()) return false
  return true
}

/**
 * The `coupon` block on a cart/validate response (mirrors `CartCouponSchema`
 * minus `subtotalInr`, which the caller — `services/cart.ts` or
 * `services/coupons.ts` — appends since only it knows the subtotal it priced
 * against).
 */
export interface CouponPricingResult {
  applied: boolean
  code: string | null
  label: string
  discountType: CouponDiscountType | null
  discountValue: number
  minCartInr: number
  maxDiscountInr: number | null
  discountInr: number
  reason: CouponReason | null
  /**
   * True only when the coupon is APPLIED and its row carries
   * `waivesShipping`. Never true on an unapplied result: an ineligible coupon
   * that still waived freight would hand out the benefit without the discount
   * the shopper was actually promised.
   */
  waivesShipping: boolean
}

const NONE_RESULT: Omit<CouponPricingResult, 'code' | 'reason'> = {
  applied: false,
  label: '',
  discountType: null,
  discountValue: 0,
  minCartInr: 0,
  maxDiscountInr: null,
  discountInr: 0,
  waivesShipping: false,
}

/**
 * Resolve a {@link CouponLookup} against a cart subtotal into the discount to
 * apply, per `designDecisions.stackingRule` / `criteriaBrokenBehavior`:
 *
 * - No code requested (`lookup === COUPON_NONE`) -> not applied, `reason: null`.
 * - Code requested but unknown (`rule` absent) -> not applied, `reason: 'invalid'`.
 * - Row found but currently switched off -> not applied, `reason: 'inactive'`.
 * - Row found but outside `[validFrom, validTo]` (either not yet started or
 *   past its end — the contract has no separate "not yet valid" code) ->
 *   not applied, `reason: 'expired'`.
 * - Row found, time-valid, but its `usageLimit` is already reached across all
 *   shoppers -> not applied, `reason: 'usage_exceeded'`; or this shopper has
 *   reached `perUserLimit` -> `reason: 'user_limit_exceeded'`. Both are
 *   skipped entirely when `lookup.usage` is absent (see {@link CouponLookup}).
 *   Checked BEFORE `below_min` because an exhausted code stays exhausted no
 *   matter what the shopper adds to their cart, so "add ₹X more" would be a
 *   lie.
 * - Row found, active, time-valid, within limits, but `subtotalInr <
 *   minCartInr` -> not applied, `reason: 'below_min'`.
 * - Otherwise: `percent` -> `min(round(subtotalInr × discountValue / 100),
 *   maxDiscountInr ?? Infinity)`; `flat` -> `discountValue`. Either way
 *   clamped to `[0, subtotalInr]` so a coupon can never make the total
 *   negative. `applied` is true only when the resulting discount is > 0 (an
 *   eligible coupon computing to ₹0, e.g. a percent coupon on an ₹0 subtotal,
 *   reports `applied: false` — nothing was actually discounted).
 */
export function resolveCouponDiscount(
  subtotalInr: number,
  lookup: CouponLookup,
  now: Date = new Date()
): CouponPricingResult {
  const { code, rule, usage } = lookup

  if (!rule) return { ...NONE_RESULT, code, reason: code ? 'invalid' : null }

  const base = {
    code: rule.code,
    label: rule.label,
    discountType: rule.discountType,
    discountValue: rule.discountValue,
    minCartInr: rule.minCartInr,
    maxDiscountInr: rule.maxDiscountInr,
    // False in every early return below. The flag rides with the DISCOUNT, so
    // a coupon that is inactive, expired, exhausted or below its minimum
    // waives nothing — otherwise a shopper under `minCartInr` would be told
    // "add ₹X more to use this code" while already banking its free delivery.
    waivesShipping: false,
  }

  if (!rule.active) return { ...base, applied: false, discountInr: 0, reason: 'inactive' }
  if (!isCouponValidNow(rule.active, rule.validFrom, rule.validTo, now)) {
    return { ...base, applied: false, discountInr: 0, reason: 'expired' }
  }
  if (usage) {
    if (rule.usageLimit !== null && usage.total >= rule.usageLimit) {
      return { ...base, applied: false, discountInr: 0, reason: 'usage_exceeded' }
    }
    if (rule.perUserLimit !== null && usage.byUser >= rule.perUserLimit) {
      return { ...base, applied: false, discountInr: 0, reason: 'user_limit_exceeded' }
    }
  }
  if (subtotalInr < rule.minCartInr) {
    return { ...base, applied: false, discountInr: 0, reason: 'below_min' }
  }

  const raw =
    rule.discountType === 'percent'
      ? Math.round((subtotalInr * rule.discountValue) / 100)
      : rule.discountValue
  const capped =
    rule.discountType === 'percent' && rule.maxDiscountInr !== null
      ? Math.min(raw, rule.maxDiscountInr)
      : raw
  const discountInr = Math.max(0, Math.min(capped, subtotalInr))

  const applied = discountInr > 0
  return {
    ...base,
    applied,
    discountInr,
    reason: null,
    // Gated on `applied`, not on eligibility: an eligible coupon computing to a
    // ₹0 discount reports `applied: false`, and it must not silently waive
    // freight either.
    waivesShipping: applied && rule.waivesShipping,
  }
}
