/**
 * Cash on delivery — config load, the monthly cap count, and the one call the
 * rest of the app asks: "may THIS cart, going to THIS pincode, pay cash?"
 *
 * The rule itself is pure and lives in `lib/cod.ts`. This file is only the
 * database half: reading `app_config` through the sanctioned path and counting
 * the month's COD orders. Design decisions are in docs/SPEC-COD.md.
 */
import { and, count, eq, gte } from 'drizzle-orm'
import { z } from 'zod'

import type { CodHealth } from '../contracts/cod.js'
import type { Db } from '../db/client.js'
import { payments, shipments } from '../db/schema.js'
import {
  COD_CONFIG_DEFAULTS,
  evaluateCod,
  type CodAvailability,
  type CodConfig,
} from '../lib/cod.js'
import { codUnavailable } from '../lib/errors.js'
import type { FulfilmentStatus } from '../lib/fulfilmentStatus.js'
import { getConfigValues } from './config.js'

/** Every key the COD rule is assembled from. Read in ONE query. */
export const COD_CONFIG_KEYS = [
  'payments.cod.enabled',
  'payments.cod.tokenInr',
  'payments.cod.minCartInr',
  'payments.cod.maxCartInr',
  'payments.cod.pincodes',
  'payments.cod.monthlyOrderCap',
] as const

const nonNegInt = z.number().int().min(0)

/**
 * Validated, not coerced — and validated key by key rather than as one object,
 * because these keys are edited individually in the admin config screen. A
 * typo in the pincode list must not take the master switch down with it (which
 * would read as "COD is off" and be debugged as a policy decision); it should
 * fail closed on the pincode gate alone, which surfaces as "not available at
 * your pincode" and points straight at the key that is wrong.
 */
const CodConfigShape = {
  'payments.cod.enabled': z.boolean(),
  'payments.cod.tokenInr': z.number().int().positive(),
  'payments.cod.minCartInr': nonNegInt,
  'payments.cod.maxCartInr': nonNegInt,
  'payments.cod.pincodes': z.union([
    z.object({ mode: z.literal('all') }),
    z.object({ mode: z.literal('allow'), list: z.array(z.string().regex(/^\d{6}$/)) }),
    z.object({ mode: z.literal('block'), list: z.array(z.string().regex(/^\d{6}$/)) }),
  ]),
  'payments.cod.monthlyOrderCap': nonNegInt,
} as const

/**
 * Fail-closed per key: anything absent or malformed falls back to
 * {@link COD_CONFIG_DEFAULTS}, whose own default for `enabled` is `false`.
 * There is no configuration mistake that can turn COD ON.
 */
export function parseCodConfig(values: Map<string, unknown>): CodConfig {
  const read = <K extends keyof typeof CodConfigShape>(
    key: K,
    fallback: z.infer<(typeof CodConfigShape)[K]>
  ): z.infer<(typeof CodConfigShape)[K]> => {
    const parsed = CodConfigShape[key].safeParse(values.get(key))
    return parsed.success ? (parsed.data as z.infer<(typeof CodConfigShape)[K]>) : fallback
  }
  return {
    enabled: read('payments.cod.enabled', COD_CONFIG_DEFAULTS.enabled),
    tokenInr: read('payments.cod.tokenInr', COD_CONFIG_DEFAULTS.tokenInr),
    minCartInr: read('payments.cod.minCartInr', COD_CONFIG_DEFAULTS.minCartInr),
    maxCartInr: read('payments.cod.maxCartInr', COD_CONFIG_DEFAULTS.maxCartInr),
    pincodes: read('payments.cod.pincodes', COD_CONFIG_DEFAULTS.pincodes),
    monthlyOrderCap: read('payments.cod.monthlyOrderCap', COD_CONFIG_DEFAULTS.monthlyOrderCap),
  }
}

export async function loadCodConfig(db: Db): Promise<CodConfig> {
  return parseCodConfig(await getConfigValues(db, [...COD_CONFIG_KEYS]))
}

/**
 * COD orders taken so far this calendar month, IST.
 *
 * `status = 'paid'` — the token cleared — is what counts against the cap, not
 * `pending`. A pending row is an abandoned Razorpay sheet as often as it is an
 * order, and letting abandonment consume the cap would let a handful of
 * bounced checkouts close COD for everyone until the first of the month.
 *
 * The month boundary is IST because the cap is an operations budget (how much
 * cash the courier is asked to carry, how many RTOs ops can absorb) and
 * operations happen in IST. `created_at` is the clock, not `paid_at`: the cap
 * is about how many orders we accepted.
 */
export async function countCodOrdersThisMonth(db: Db, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(payments)
    .where(
      and(
        eq(payments.paymentMode, 'cod'),
        eq(payments.status, 'paid'),
        gte(payments.createdAt, istMonthStart(now))
      )
    )
  return row?.n ?? 0
}

/**
 * Midnight on the 1st, IST, as an instant. Computed from the IST calendar date
 * rather than by adding 5h30m to a UTC month start — those differ for the first
 * five and a half hours of every month, which is exactly the window where an
 * off-by-one on the cap would be least noticeable and most wrong.
 */
function istMonthStart(now: Date): Date {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  const y = ist.getUTCFullYear()
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  return new Date(`${y}-${m}-01T00:00:00+05:30`)
}

export interface CodAvailabilityInput {
  /** The order total the shopper would owe — goods after coupon, plus delivery. */
  cartTotalInr: number
  /** Destination pincode; '' when the cart has no address selected. */
  destPincode: string
}

/**
 * The single entry point. Two queries at most, and the count is skipped
 * entirely when the switch is off — the common case for as long as COD is
 * dark, and this runs on every cart read.
 */
export async function codAvailability(
  db: Db,
  input: CodAvailabilityInput,
  config?: CodConfig
): Promise<CodAvailability> {
  const cfg = config ?? (await loadCodConfig(db))
  if (!cfg.enabled || !input.destPincode) {
    return evaluateCod({ ...input, config: cfg, codOrdersThisMonth: 0 })
  }
  return evaluateCod({
    ...input,
    config: cfg,
    codOrdersThisMonth: await countCodOrdersThisMonth(db),
  })
}

/**
 * Guard for the order-create path: the client's COD selection is a REQUEST,
 * never a fact. Whatever the cart screen was told a moment ago, the answer that
 * binds is the one computed here against the address this order is actually
 * going to and the cap as it stands right now.
 */
export async function assertCodAllowed(
  db: Db,
  input: CodAvailabilityInput
): Promise<CodAvailability> {
  const availability = await codAvailability(db, input)
  if (!availability.available) throw codUnavailable()
  return availability
}

/* ────────────────────────────────────────────────────────────────────────────
 * P7.3 — the ops readout behind `GET /v1/admin/cod/health`.
 *
 * Everything below is read-only and admin-only. It answers one question —
 * "should COD stay switched on?" — and deliberately does not act on the answer.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Not part of {@link COD_CONFIG_KEYS}, and that separation is the point: this
 * key changes no eligibility decision. It is a threshold a human is judged
 * against, so it is loaded by the readout and by nothing on the hot path.
 */
export const COD_KILL_SWITCH_RTO_KEY = 'payments.cod.killSwitchRtoPct'

/** Code default, mirrored by scripts/seed-config.ts. */
export const COD_KILL_SWITCH_RTO_DEFAULT = 15

/**
 * Settled COD orders required before {@link CodRto.breached} can be true.
 *
 * With five settled orders a single refusal reads as 20% RTO and would trip a
 * 15% threshold — an operator who switches COD off on that has learned nothing
 * except that one person changed their mind. Twenty is the smallest sample
 * where the threshold is measuring the cohort rather than the noise, and it is
 * still reached inside the first month at the ₹100/month cap.
 *
 * It gates the BREACH flag only. `rtoPct` is always reported, so a genuinely
 * alarming three-out-of-four is visible immediately — it just is not labelled
 * as a decision.
 */
export const COD_RTO_MIN_SAMPLE = 20

/** Shipment statuses that count as "the shopper accepted the parcel". */
const SETTLED_DELIVERED: FulfilmentStatus = 'delivered'
/** …and as "the parcel came back". `rto_in_transit` is NOT settled — it can still be re-attempted. */
const SETTLED_RTO: FulfilmentStatus = 'rto_delivered'

export interface CodRtoStats {
  delivered: number
  rtoDelivered: number
  settled: number
  inFlight: number
  rtoPct: number | null
}

/**
 * RTO over every COD order we have ever shipped — not a rolling window.
 *
 * A window would be the right instrument at volume. At a hundred orders a
 * month it would mostly report on an empty set, and a kill switch that reads
 * "no data" for the first three weeks of every month is a kill switch nobody
 * looks at. Revisit when monthly settled volume passes the window length.
 *
 * Counted by DISTINCT ORDER, not by shipment row: a cancelled-and-re-manifested
 * order has two shipments, and RTO is a property of the order.
 */
export async function codRtoStats(db: Db): Promise<CodRtoStats> {
  const rows = await db
    .selectDistinct({ orderId: shipments.orderId, status: shipments.status })
    .from(shipments)
    .innerJoin(payments, eq(payments.orderId, shipments.orderId))
    .where(eq(payments.paymentMode, 'cod'))

  // Each ORDER lands in exactly one bucket. Summing per-status counts instead
  // would count an order that was returned and then re-shipped in both
  // `delivered` and `rtoDelivered`, inflating `settled` and diluting the very
  // rate this exists to raise the alarm on.
  //
  // Delivered wins over returned, because a re-attempt that finally reached the
  // shopper is an order that was accepted; the failed leg cost us a return we
  // see in the margin report, not a refusal to buy.
  const byOrder = new Map<string, 'delivered' | 'rto' | 'inFlight'>()
  for (const row of rows) {
    const current = byOrder.get(row.orderId)
    if (current === 'delivered') continue
    if (row.status === SETTLED_DELIVERED) byOrder.set(row.orderId, 'delivered')
    else if (row.status === SETTLED_RTO) byOrder.set(row.orderId, 'rto')
    // `cancelled` is neither: the parcel never reached a door, so it is evidence
    // of nothing about whether shoppers accept COD parcels. It also must not
    // overwrite a settled verdict already recorded for this order.
    else if (row.status !== 'cancelled' && current === undefined) {
      byOrder.set(row.orderId, 'inFlight')
    }
  }

  let delivered = 0
  let rtoDelivered = 0
  let inFlight = 0
  for (const verdict of byOrder.values()) {
    if (verdict === 'delivered') delivered += 1
    else if (verdict === 'rto') rtoDelivered += 1
    else inFlight += 1
  }

  const settled = delivered + rtoDelivered
  return {
    delivered,
    rtoDelivered,
    settled,
    inFlight,
    rtoPct: settled === 0 ? null : Math.round((rtoDelivered / settled) * 1000) / 10,
  }
}

/** 'YYYY-MM' for the IST calendar month containing `now`. */
export function istMonthLabel(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * The whole ops readout, in three queries.
 *
 * The month count is NOT skipped when the switch is off, unlike
 * {@link codAvailability} — this endpoint is read by a human deciding whether
 * to switch COD back on, and "how much of the cap did last month use" is one of
 * the things they are deciding with. It runs once per panel load, not per cart.
 */
export async function codHealth(db: Db, now = new Date()): Promise<CodHealth> {
  const [config, killSwitchValues, ordersTaken, rto] = await Promise.all([
    loadCodConfig(db),
    getConfigValues(db, [COD_KILL_SWITCH_RTO_KEY]),
    countCodOrdersThisMonth(db, now),
    codRtoStats(db),
  ])

  const parsedThreshold = z
    .number()
    .min(0)
    .max(100)
    .safeParse(killSwitchValues.get(COD_KILL_SWITCH_RTO_KEY))
  const killSwitchRtoPct = parsedThreshold.success
    ? parsedThreshold.data
    : COD_KILL_SWITCH_RTO_DEFAULT

  const sampleSufficient = rto.settled >= COD_RTO_MIN_SAMPLE

  return {
    enabled: config.enabled,
    tokenInr: config.tokenInr,
    minCartInr: config.minCartInr,
    maxCartInr: config.maxCartInr,
    pincodes: {
      mode: config.pincodes.mode,
      listSize: config.pincodes.mode === 'all' ? 0 : config.pincodes.list.length,
    },
    month: {
      month: istMonthLabel(now),
      ordersTaken,
      cap: config.monthlyOrderCap,
      remaining: Math.max(0, config.monthlyOrderCap - ordersTaken),
      capReached: ordersTaken >= config.monthlyOrderCap,
    },
    rto: {
      ...rto,
      killSwitchRtoPct,
      minSample: COD_RTO_MIN_SAMPLE,
      sampleSufficient,
      breached: sampleSufficient && rto.rtoPct !== null && rto.rtoPct >= killSwitchRtoPct,
    },
    killSwitchKey: 'payments.cod.enabled',
  }
}
