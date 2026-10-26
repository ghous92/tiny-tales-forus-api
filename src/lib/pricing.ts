/**
 * Pricing math shared by every path that must agree on what a shopper pays.
 *
 * A product may carry a `seasonalDiscountPct` (0..90) that applies ON TOP of a
 * variant's already-marked-down `priceInr`. The discounted result — the
 * "effective price" — is the single number that MUST be identical wherever it
 * surfaces, or the app would display one price and the cart would charge
 * another:
 *
 *   - the public catalog (`GET /v1/catalog`) exposes it as `effective_price_inr`
 *     so the app can show it as the sale price and strike the original;
 *   - the projection writes it into `catalog_items.priceInr`, which is cart's
 *     and payments' price authority — so the charged total already reflects it
 *     with no change to cart logic.
 *
 * Keeping the formula here (not inlined in each caller) is what guarantees
 * display == charge. Do not duplicate this arithmetic elsewhere.
 */

/** Clamp a possibly-out-of-range percent into the DB-enforced 0..90 band. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(90, Math.max(0, Math.trunc(pct)))
}

/**
 * The price a shopper actually pays for a variant after its product's seasonal
 * discount. `pct` of 0 (the default) returns `priceInr` unchanged, so products
 * without a seasonal discount are entirely unaffected. Rounded to whole rupees
 * (the app + cart deal only in integer INR); never returns below 0.
 *
 * @param priceInr  the variant's selling price (whole INR)
 * @param pct       the product's seasonal discount percent (0..90)
 */
export function effectivePriceInr(priceInr: number, pct: number): number {
  const p = clampPct(pct)
  if (p === 0) return priceInr
  return Math.max(0, Math.round((priceInr * (100 - p)) / 100))
}

// --- Wholesale ---------------------------------------------------------------
//
// Wholesale is a CART-LEVEL rule, not a property of the user: any cart whose
// retail subtotal reaches `thresholdInr` is billed at wholesale rates for that
// order. There is deliberately no `users.type` — nothing is "earned" or stored,
// so the rule is stateless, instantly reversible (drop below the threshold and
// retail pricing returns), and needs no order history (which does not exist
// yet). The three knobs live in `app_config` (wholesale.enabled /
// wholesale.thresholdInr / wholesale.discountPct) so they are tunable live with
// no deploy; the cart service receives them as a resolved {@link WholesaleRule}
// rather than reading config itself (ARCHITECTURE.md rule 2: no module imports
// another module's services).

/** The resolved wholesale knobs, as handed to the cart service. */
export interface WholesaleRule {
  /** Master switch — false disables wholesale pricing entirely. */
  enabled: boolean
  /** Retail subtotal (INR) at which a cart qualifies. Reaching it exactly qualifies. */
  thresholdInr: number
  /** Percent off each line once qualified, 0..90. */
  discountPct: number
}

/** Wholesale off, whatever the config says — the safe default when keys are absent. */
export const WHOLESALE_OFF: WholesaleRule = { enabled: false, thresholdInr: 0, discountPct: 0 }

/**
 * Does a cart qualify for wholesale? Compares the RETAIL subtotal — the sum the
 * shopper would pay at normal (seasonally-discounted) prices — against the
 * threshold. Reaching the threshold exactly qualifies (>=): "spend ₹5000 to
 * unlock" must trigger at ₹5000, not ₹5001. A disabled rule or a non-positive
 * discount never qualifies.
 */
export function qualifiesForWholesale(retailSubtotalInr: number, rule: WholesaleRule): boolean {
  if (!rule.enabled) return false
  if (clampPct(rule.discountPct) <= 0) return false
  if (!Number.isFinite(rule.thresholdInr) || rule.thresholdInr < 0) return false
  return retailSubtotalInr >= rule.thresholdInr
}

/**
 * A single line's unit price under wholesale. Applied PER LINE (not to the
 * subtotal) so each line's `priceInr` on the wire is the price actually charged
 * for it, and Σ(qty × priceInr) still equals the cart total — no phantom
 * order-level adjustment the client has to reproduce.
 *
 * Stacks on top of the seasonal discount: the input is already the
 * seasonally-effective price, so a 20% seasonal + 10% wholesale is 0.8 × 0.9 =
 * 72% of list, NOT a 30% flat cut.
 */
export function wholesalePriceInr(effectiveInr: number, rule: WholesaleRule): number {
  return effectivePriceInr(effectiveInr, rule.discountPct)
}
