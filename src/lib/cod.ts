/**
 * Cash on delivery, partial-prepaid — the eligibility rule and the money split.
 *
 * Pure (ARCHITECTURE.md: `lib/` may not touch the database). Everything this
 * needs — config, destination, cart total, how many COD orders the month has
 * already taken — is passed in by the caller that read it.
 *
 * The design decisions this implements are locked in docs/SPEC-COD.md. The one
 * worth restating here, because it is the one a reader of this file could
 * plausibly undo: the ₹49 token is **part of** the order total, not on top of
 * it. A ₹700 order paid COD is ₹49 now and ₹651 at the door. It is not ₹700
 * at the door plus a ₹49 fee, and it is never a ₹749 order.
 */

/**
 * Which destinations may pay COD.
 *
 * Three modes rather than a single list because the two useful policies are
 * opposites of each other: at launch we want a small allowlist of pincodes we
 * are willing to risk cash in, and at scale we want everywhere-except-these.
 * Collapsing them into one list means the day the policy inverts, an operator
 * has to paste tens of thousands of pincodes to express "all but forty".
 */
export type CodPincodePolicy =
  | { mode: 'all' }
  | { mode: 'allow'; list: string[] }
  | { mode: 'block'; list: string[] }

export interface CodConfig {
  /** Master switch. Ships false — COD is a risk position, not a default. */
  enabled: boolean
  /** The partial prepayment, in rupees. */
  tokenInr: number
  /** Cart floor; 0 disables the floor. */
  minCartInr: number
  /** Cart ceiling — caps the cash at risk in any one parcel. */
  maxCartInr: number
  pincodes: CodPincodePolicy
  /** Hard cap on confirmed COD orders per calendar month (IST). */
  monthlyOrderCap: number
}

export const COD_CONFIG_DEFAULTS: CodConfig = {
  enabled: false,
  tokenInr: 49,
  minCartInr: 0,
  maxCartInr: 2000,
  pincodes: { mode: 'all' },
  monthlyOrderCap: 100,
}

/**
 * Why COD is not on offer. Sent to the client as a machine value; the copy is
 * the client's, because "we can't take cash to your pincode yet" and "cash
 * orders are paused today" want very different wording and only one of them
 * should ever suggest trying again later.
 *
 * `cap_reached` is deliberately indistinguishable from `disabled` in what it
 * lets the shopper do, but distinct in what it tells us: one is a policy, the
 * other is a limit we chose and may want to raise.
 */
export type CodUnavailableReason =
  | 'disabled'
  | 'no_destination'
  | 'pincode_not_allowed'
  | 'cart_below_min'
  | 'cart_above_max'
  | 'cart_below_token'
  | 'cap_reached'

export interface CodAvailability {
  available: boolean
  /** Paid now, through Razorpay. 0 when unavailable. */
  tokenInr: number
  /** Paid in cash at the door: `cartTotalInr − tokenInr`. 0 when unavailable. */
  dueOnDeliveryInr: number
  /** null exactly when `available`. */
  reason: CodUnavailableReason | null
}

export const COD_UNAVAILABLE = (reason: CodUnavailableReason): CodAvailability => ({
  available: false,
  tokenInr: 0,
  dueOnDeliveryInr: 0,
  reason,
})

export interface CodEligibilityInput {
  config: CodConfig
  /** The order total the shopper would owe — goods after coupon, plus delivery. */
  cartTotalInr: number
  /** Destination pincode; '' when the cart has no address yet. */
  destPincode: string
  /**
   * Confirmed COD orders already taken this calendar month. The caller counts
   * them; this only compares. Pass 0 where the count is genuinely unknown and
   * the cap is not being enforced on that path — never a guess.
   */
  codOrdersThisMonth: number
}

/**
 * The order of these gates is not cosmetic. The cheapest and most absolute
 * checks come first so that a switched-off feature never depends on a pincode
 * list being loaded correctly, and so the reason a shopper is shown is the most
 * fundamental one that applies rather than whichever happened to be tested
 * first.
 */
export function evaluateCod(input: CodEligibilityInput): CodAvailability {
  const { config, cartTotalInr, destPincode, codOrdersThisMonth } = input

  if (!config.enabled) return COD_UNAVAILABLE('disabled')

  // No address means no serviceability answer, and offering COD before we know
  // where it is going is an offer we may have to withdraw at the next step.
  if (!destPincode) return COD_UNAVAILABLE('no_destination')

  if (!pincodeAllowed(config.pincodes, destPincode)) {
    return COD_UNAVAILABLE('pincode_not_allowed')
  }

  if (codOrdersThisMonth >= config.monthlyOrderCap) return COD_UNAVAILABLE('cap_reached')

  if (config.minCartInr > 0 && cartTotalInr < config.minCartInr) {
    return COD_UNAVAILABLE('cart_below_min')
  }
  if (config.maxCartInr > 0 && cartTotalInr > config.maxCartInr) {
    return COD_UNAVAILABLE('cart_above_max')
  }

  // A token at or above the total is prepaid with extra steps — and at exactly
  // the total it produces a ₹0 balance, which the `payments_cod_mode_consistent`
  // CHECK would reject at insert time anyway. Refusing it here means the
  // shopper never gets offered something the database will not accept.
  if (cartTotalInr <= config.tokenInr) return COD_UNAVAILABLE('cart_below_token')

  return {
    available: true,
    tokenInr: config.tokenInr,
    dueOnDeliveryInr: cartTotalInr - config.tokenInr,
    reason: null,
  }
}

/**
 * Evaluate every COD gate that can be known before a shopper supplies a
 * destination. This powers the public PDP preview: it may advertise the live
 * token and tentative balance while saying that the pincode still has to be
 * checked, but it must stop advertising as soon as the master switch, monthly
 * cap, cart limits, or token rule refuse the order.
 *
 * Pincode policy is deliberately not accepted here. The policy stays private;
 * once a destination exists the caller must use {@link evaluateCod} instead.
 */
export function evaluateCodBeforeDestination(
  input: Omit<CodEligibilityInput, 'destPincode'>
): CodAvailability {
  const { config, cartTotalInr, codOrdersThisMonth } = input

  if (!config.enabled) return COD_UNAVAILABLE('disabled')
  if (codOrdersThisMonth >= config.monthlyOrderCap) return COD_UNAVAILABLE('cap_reached')
  if (config.minCartInr > 0 && cartTotalInr < config.minCartInr) {
    return COD_UNAVAILABLE('cart_below_min')
  }
  if (config.maxCartInr > 0 && cartTotalInr > config.maxCartInr) {
    return COD_UNAVAILABLE('cart_above_max')
  }
  if (cartTotalInr <= config.tokenInr) return COD_UNAVAILABLE('cart_below_token')

  return {
    available: true,
    tokenInr: config.tokenInr,
    dueOnDeliveryInr: cartTotalInr - config.tokenInr,
    reason: null,
  }
}

/**
 * Exact string match on the six-digit pincode. No prefix or range matching:
 * "all of 39xxxx" reads as a tidy shorthand right up to the day someone means
 * 390001–390009 and silently gets 390000–399999.
 */
function pincodeAllowed(policy: CodPincodePolicy, pincode: string): boolean {
  switch (policy.mode) {
    case 'all':
      return true
    case 'allow':
      return policy.list.includes(pincode)
    case 'block':
      return !policy.list.includes(pincode)
  }
}

/**
 * The split written onto the payment row, in paise.
 *
 * `codAmountPaise` is the only figure stored — `prepaid_amount_paise` is a
 * generated column (`amount_paise − cod_amount_paise`), so the token can never
 * drift from the balance. Callers pass the amount they are about to charge the
 * gateway straight from `prepaidAmountPaise` here.
 */
export interface CodSplit {
  codAmountPaise: number
  prepaidAmountPaise: number
}

export function codSplit(amountPaise: number, tokenInr: number): CodSplit {
  const prepaidAmountPaise = Math.round(tokenInr * 100)
  return { prepaidAmountPaise, codAmountPaise: amountPaise - prepaidAmountPaise }
}
