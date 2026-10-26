/**
 * ITC-on-freight reporting (SPEC-GST.md §4, Phase 2.7).
 *
 * ## What this is, stated plainly, because the name overpromises
 *
 * Freight is an input service. The GST a courier charges on it is claimable as
 * input tax credit (CGST s.16; not blocked by s.17(5)), and it offsets the
 * output tax GSTR-1 declares. But **the claimable figure is the one on the
 * courier's own tax invoice**, reconciled against GSTR-2B — a document this
 * system has never seen. What this system knows is what it MODELLED the
 * courier would bill, from the rate card in `couriers`, frozen onto the order
 * at checkout.
 *
 * So this report is **the reconciliation input, not the claim**: "we expected
 * ₹X of freight tax this month, across these shipments". The CA compares it to
 * the courier's invoice and to GSTR-2B; a gap is a question to ask the courier,
 * not a number to file. Nothing here should ever be pasted into GSTR-3B Table 4
 * directly, and the report says so in its own header row.
 *
 * ## Three things it deliberately under-reports, and why they are not bugs
 *
 * 1. **RTO freight.** A returned parcel is billed a second time. `couriers`
 *    carries `rtoBps` for exactly this, but SPEC-SHIPPING keeps it out of the
 *    quoted cost, so no frozen snapshot contains it. Adding an estimate here
 *    would be inventing a figure the rest of the system does not stand behind.
 * 2. **Manual fulfilment.** A parcel a human carried to a counter has no rate
 *    card and no modelled tax.
 * 3. **Shipments whose courier changed after checkout.** The frozen cost priced
 *    a different carrier than the one that actually carried the parcel.
 *
 * None of the three is silently dropped: each is counted and reported back, the
 * same discipline `services/gstr1.ts` applies to a `docVersion: 1` invoice.
 *
 * ## Why the shipment, not the order, is the unit
 *
 * Freight is incurred when the parcel leaves, not when the money arrives. A
 * paid order that never manifested cost nothing to carry, and a period is
 * therefore anchored on `shipments.manifested_at` — never on `paid_at`.
 */

import { and, eq, gte, isNotNull, lt, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { ItcFreightExportQuery, ItcFreightReport } from '../contracts/itcFreight.js'
import type { Db } from '../db/client.js'
import { payments, shipments } from '../db/schema.js'
import { csvDocument } from '../lib/csv.js'
import {
  formatInvoiceDate,
  istDayAfter,
  istDayStart,
  istMonthBounds,
} from '../lib/invoiceFormat.js'
import { freightRateBps, type FreightCost } from '../lib/shipping.js'
import type { ShippingSnapshot } from './shipping.js'

/**
 * The banner every file opens with. A CSV that lands in an accountant's inbox
 * carries no other context, and the difference between "modelled" and
 * "claimable" is the whole point of this report.
 */
const DISCLAIMER =
  'Modelled from our own rate card — reconcile against the courier tax invoice and GSTR-2B before claiming. Not a GSTR-3B figure.'

/** One manifested parcel with whatever cost was frozen for it. */
interface FreightMovement {
  orderId: string
  awb: string
  /** The courier that actually carried it. */
  courierCode: string
  /** The courier the frozen cost was priced for. Differs after a re-manifest. */
  quotedCourierCode: string
  manifestedAt: Date
  status: string
  cost: FreightCost | undefined
  manual: boolean
}

/** Why a manifested shipment contributes no tax. Reported, never silently skipped. */
type Exclusion = 'manual' | 'no_frozen_cost' | 'courier_changed'

function exclusionFor(movement: FreightMovement): Exclusion | null {
  if (movement.manual) return 'manual'
  if (!movement.cost) return 'no_frozen_cost'
  if (movement.quotedCourierCode && movement.quotedCourierCode !== movement.courierCode) {
    return 'courier_changed'
  }
  return null
}

/** The resolved reporting window. Both bounds optional — absent means unbounded on that side. */
interface Period {
  start?: Date | undefined
  /** Exclusive, same half-open convention as the GSTR-1 feed. */
  end?: Date | undefined
}

export function resolvePeriod(query: ItcFreightExportQuery): Period {
  if (query.month) return istMonthBounds(query.month)
  return {
    start: query.from ? istDayStart(query.from) : undefined,
    end: query.to ? istDayAfter(query.to) : undefined,
  }
}

function periodWhere(column: PgColumn, period: Period): SQL | undefined {
  const clauses: SQL[] = [isNotNull(column)]
  if (period.start) clauses.push(gte(column, period.start))
  if (period.end) clauses.push(lt(column, period.end))
  return clauses.length === 1 ? clauses[0] : and(...clauses)
}

/**
 * Every parcel manifested in the window, with the freight cost frozen on its
 * order. Inner-joined to `payments` because the cost lives in that row's
 * `shipping_snapshot` — a shipment whose order vanished is impossible
 * (`onDelete: 'restrict'`), so the join drops nothing.
 */
export async function loadFreightMovements(db: Db, period: Period): Promise<FreightMovement[]> {
  const rows = await db
    .select({
      orderId: shipments.orderId,
      awb: shipments.awb,
      courierCode: shipments.courierCode,
      manifestedAt: shipments.manifestedAt,
      status: shipments.status,
      manualCourierName: shipments.manualCourierName,
      shippingSnapshot: payments.shippingSnapshot,
    })
    .from(shipments)
    .innerJoin(payments, eq(shipments.orderId, payments.orderId))
    .where(periodWhere(shipments.manifestedAt, period))
    .orderBy(shipments.manifestedAt)

  return rows.map((row) => {
    const snapshot = (row.shippingSnapshot ?? {}) as Partial<ShippingSnapshot>
    return {
      orderId: row.orderId,
      awb: row.awb ?? '',
      courierCode: row.courierCode,
      quotedCourierCode: snapshot.courierCode ?? '',
      // Non-null by the `isNotNull` in the predicate; the fallback is for the type.
      manifestedAt: row.manifestedAt ?? new Date(0),
      status: row.status,
      cost: snapshot.cost,
      manual: Boolean(row.manualCourierName),
    }
  })
}

/** Running totals for one (courier, rate) bucket. */
interface Accum {
  shipments: number
  preTaxInr: number
  gstInr: number
  totalInr: number
}

function emptyAccum(): Accum {
  return { shipments: 0, preTaxInr: 0, gstInr: 0, totalInr: 0 }
}

const SUMMARY_COLUMNS = [
  'Courier',
  'GST Rate',
  'Shipments',
  'Freight (Taxable Value)',
  'Freight GST (modelled ITC)',
  'Freight Total',
  'Note',
] as const

/**
 * Per courier × rate. The rate comes from the FROZEN cost split, not from the
 * live `couriers` row: a rate-card edit must not restate a period that has
 * already been reconciled.
 */
export function buildSummaryRows(movements: FreightMovement[]): (string | number)[][] {
  const buckets = new Map<string, Accum>()

  for (const movement of movements) {
    if (exclusionFor(movement) !== null || !movement.cost) continue
    const key = `${movement.courierCode}|${freightRateBps(movement.cost)}`
    const accum = buckets.get(key) ?? emptyAccum()
    accum.shipments += 1
    accum.preTaxInr += movement.cost.preTaxInr
    accum.gstInr += movement.cost.gstInr
    accum.totalInr += movement.cost.totalInr
    buckets.set(key, accum)
  }

  // Sorted on the PARSED key, not the composite string: `'1800' < '500'`
  // lexicographically, which would print 18% above 5% and read like a mistake.
  const rows: (string | number)[][] = [...buckets.entries()]
    .map(([key, accum]) => {
      const [courier = '', bps = '0'] = key.split('|')
      return { courier, bps: Number(bps), accum }
    })
    .sort((a, b) => a.courier.localeCompare(b.courier) || a.bps - b.bps)
    .map(({ courier, bps, accum }) => {
      return [
        courier,
        `${bps / 100}%`,
        accum.shipments,
        accum.preTaxInr,
        accum.gstInr,
        accum.totalInr,
        '',
      ]
    })

  // The banner rides in the data, not in a comment line: a comment line breaks
  // every CSV parser, and a file that reaches a CA without this sentence
  // invites a number being filed that should not be.
  rows.push(['', '', '', '', '', '', DISCLAIMER])
  return rows
}

const DETAIL_COLUMNS = [
  'Manifest Date',
  'Order No',
  'AWB',
  'Courier',
  'Status',
  'GST Rate',
  'Freight (Taxable Value)',
  'Freight GST (modelled ITC)',
  'Freight Total',
  'Excluded',
] as const

/**
 * One row per manifested parcel, INCLUDING the ones that contribute nothing —
 * with the reason in the last column. A summary that quietly covers 40 of 52
 * parcels is how a reconciliation gap gets blamed on the courier.
 */
export function buildDetailRows(movements: FreightMovement[]): (string | number)[][] {
  return movements.map((movement) => {
    const exclusion = exclusionFor(movement)
    const cost = exclusion === null ? movement.cost : undefined
    return [
      formatInvoiceDate(movement.manifestedAt),
      movement.orderId,
      movement.awb,
      movement.courierCode,
      movement.status,
      cost ? `${freightRateBps(cost) / 100}%` : '',
      cost ? cost.preTaxInr : '',
      cost ? cost.gstInr : '',
      cost ? cost.totalInr : '',
      exclusion ?? '',
    ]
  })
}

const REPORTS: Record<
  ItcFreightReport,
  { columns: readonly string[]; build: (movements: FreightMovement[]) => (string | number)[][] }
> = {
  summary: { columns: SUMMARY_COLUMNS, build: buildSummaryRows },
  detail: { columns: DETAIL_COLUMNS, build: buildDetailRows },
}

/** The rendered file plus the counts the route logs. */
export interface ItcFreightExport {
  csv: string
  report: ItcFreightReport
  /** Parcels manifested in the period. */
  shipments: number
  /** Of those, how many contributed no tax, by reason. */
  excluded: Record<Exclusion, number>
}

export async function exportItcFreightCsv(
  db: Db,
  query: ItcFreightExportQuery
): Promise<ItcFreightExport> {
  const report: ItcFreightReport = query.report ?? 'summary'
  const movements = await loadFreightMovements(db, resolvePeriod(query))
  const { columns, build } = REPORTS[report]

  const excluded: Record<Exclusion, number> = {
    manual: 0,
    no_frozen_cost: 0,
    courier_changed: 0,
  }
  for (const movement of movements) {
    const exclusion = exclusionFor(movement)
    if (exclusion) excluded[exclusion] += 1
  }

  return {
    csv: csvDocument(columns, build(movements)),
    report,
    shipments: movements.length,
    excluded,
  }
}
