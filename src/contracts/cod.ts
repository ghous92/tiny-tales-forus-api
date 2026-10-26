/**
 * Contracts for the COD ops surface (`/v1/admin/cod`). Admin-only — nothing
 * here is ever sent to a shopper.
 *
 * The shopper-facing side of COD is `CartCodSchema` in contracts/cart.ts, which
 * carries a single boolean and a reason. This file is its opposite: it exists
 * so a human can decide whether COD should stay switched on, so it reports the
 * inputs to that decision rather than its outcome.
 *
 * Design: docs/SPEC-COD.md §2 (config) and P7.3 (this readout).
 */
import { z } from 'zod'

/**
 * The pincode policy, WITHOUT the list.
 *
 * SPEC-COD D7 keeps the list off the client because it publishes where we think
 * fraud lives. This endpoint is admin-only, so the reason to send a size rather
 * than the list is different and narrower: an operator watching a kill-switch
 * panel needs to know a list is loaded and roughly how big, not to read 40
 * pincodes. The list itself is edited in the config screen, which is the one
 * place it belongs.
 */
export const CodPincodePolicySummarySchema = z.object({
  mode: z.enum(['all', 'allow', 'block']),
  /** 0 for `all`. */
  listSize: z.number().int().min(0),
})

/** The month-to-date usage of `payments.cod.monthlyOrderCap`. */
export const CodMonthUsageSchema = z.object({
  /** The IST calendar month being counted, 'YYYY-MM'. */
  month: z.string(),
  /** Confirmed (token paid) COD orders taken this month. */
  ordersTaken: z.number().int().min(0),
  cap: z.number().int().min(0),
  /** `cap − ordersTaken`, floored at 0. Zero ⇒ COD is refusing new orders. */
  remaining: z.number().int().min(0),
  /** True when the cap alone is currently withholding COD. */
  capReached: z.boolean(),
})

/**
 * The RTO readout — the number the kill switch is judged against.
 *
 * `settled` is the denominator on purpose: a COD parcel is not evidence either
 * way until it has been accepted or refused. Dividing returns by *all* COD
 * orders would report a reassuring near-zero for as long as most parcels are
 * still in transit, which is precisely the window in which a bad cohort is
 * still recoverable.
 */
export const CodRtoSchema = z.object({
  /** COD orders delivered — the shopper paid the balance. */
  delivered: z.number().int().min(0),
  /** COD orders that came back to us. */
  rtoDelivered: z.number().int().min(0),
  /** `delivered + rtoDelivered`. The denominator. */
  settled: z.number().int().min(0),
  /** COD orders shipped and not yet settled. Context, never a denominator. */
  inFlight: z.number().int().min(0),
  /** `rtoDelivered / settled`, 0–100, rounded to one decimal. Null when `settled` is 0. */
  rtoPct: z.number().nullable(),
  /** The configured `payments.cod.killSwitchRtoPct`. */
  killSwitchRtoPct: z.number(),
  /** How many settled orders this readout wants before it will call a breach. */
  minSample: z.number().int().min(0),
  /** `settled >= minSample`. */
  sampleSufficient: z.boolean(),
  /**
   * `sampleSufficient && rtoPct >= killSwitchRtoPct`. Advisory: nothing in the
   * system acts on it. SPEC-COD §2 makes the kill a human's call deliberately.
   */
  breached: z.boolean(),
})

export const CodHealthSchema = z.object({
  enabled: z.boolean(),
  tokenInr: z.number().int(),
  minCartInr: z.number().int(),
  maxCartInr: z.number().int(),
  pincodes: CodPincodePolicySummarySchema,
  month: CodMonthUsageSchema,
  rto: CodRtoSchema,
  /**
   * Where the operator flips the switch. Spelled out because the kill path is
   * the existing generic config route, not a bespoke endpoint — see
   * routes/codAdmin.ts for why.
   */
  killSwitchKey: z.literal('payments.cod.enabled'),
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type CodHealth = z.infer<typeof CodHealthSchema>
export type CodMonthUsage = z.infer<typeof CodMonthUsageSchema>
export type CodRto = z.infer<typeof CodRtoSchema>
