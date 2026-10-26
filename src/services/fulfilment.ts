/**
 * Fulfilment business rules (docs/SPEC-LOGISTICS.md). The only file that writes
 * `shipments`, `shipment_events` and `ndr_actions`.
 *
 * What it is responsible for:
 *
 * - **Recording the intent to ship** inside the paid transaction, and nothing
 *   more (§6.1). The carrier call happens later, from a sweep.
 * - **Ingesting scans** from either channel through ONE function, so the
 *   webhook and the reconcile poll cannot diverge (§5.2).
 * - **Deciding what a scan means** — by delegating every carrier string to
 *   `lib/fulfilmentStatus.ts`. No carrier vocabulary appears in this file.
 *
 * What it is forbidden from doing: **writing `payments`.** The inbound channel
 * is an unsigned third-party webhook, so fulfilment state is quarantined from
 * money state (§1.1). `test/services/fulfilment.test.ts` holds that property.
 */

import { createHash, randomUUID } from 'node:crypto'

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { Db } from '../db/client.js'
import {
  ndrActions,
  payments,
  shipmentEvents,
  shipments,
  type NdrActionRow,
  type ShipmentRow,
} from '../db/schema.js'
import type { CarrierAdapter, ManifestRequest } from '../lib/delhivery.js'
import { conflict } from '../lib/errors.js'
import {
  isTerminal,
  mapScan,
  milestoneFor,
  type CarrierScan,
  type FulfilmentStatus,
  type NdrAct,
} from '../lib/fulfilmentStatus.js'
import {
  isShreeMarutiCourierName,
  SHREE_MARUTI_COURIER_CODE,
  shreeMarutiTrackingUrl,
  type CarrierTracker,
} from '../lib/shreeMaruti.js'
import { getConfigValues } from './config.js'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Runner = Db | Tx

/** 'carrier' — Delhivery moves the parcel. 'manual' — a human does (docs/SPEC-MANUAL-FULFILMENT.md §4B). */
export type FulfilmentMode = 'carrier' | 'manual'

/** Resolved fulfilment policy. The ROUTE reads config and hands this in as plain values. */
export interface FulfilmentRule {
  enabled: boolean
  carrier: string
  autoManifest: boolean
  /** Exact, case-sensitive registered warehouse name. Empty ⇒ manifesting is blocked. */
  pickupLocationName: string
  manifestMaxAttempts: number
  reconcileStaleMinutes: number
  reconcileBatchSize: number
  trackingUrlTemplate: string
  /**
   * Who moves the parcel. `manifestPending`/`reconcileStale` are no-ops in
   * `'manual'` mode regardless of `enabled` — this is the second, independent
   * gate SPEC-MANUAL-FULFILMENT.md §4B requires so "no Delhivery call can fire
   * by accident" even if `fulfilment.enabled` is ever switched on for an
   * unrelated reason (e.g. to keep recording shipment intents) while the
   * carrier itself still isn't ready.
   */
  mode: FulfilmentMode
}

/**
 * The safe default. Same posture as `SHIPPING_OFF` and `WHOLESALE_OFF`: a
 * malformed or missing key collapses the whole rule to off, because a
 * fulfilment policy that switches itself on would start handing parcels to a
 * carrier nobody configured. `mode: 'manual'` for the same reason —
 * FULFILMENT_OFF must never accidentally read as "carrier mode, just disabled".
 */
export const FULFILMENT_OFF: FulfilmentRule = {
  enabled: false,
  carrier: 'delhivery',
  autoManifest: false,
  pickupLocationName: '',
  manifestMaxAttempts: 5,
  reconcileStaleMinutes: 180,
  reconcileBatchSize: 100,
  trackingUrlTemplate: '',
  mode: 'manual',
}

export const FULFILMENT_CONFIG_KEYS = [
  'fulfilment.enabled',
  'fulfilment.carrier',
  'fulfilment.autoManifest',
  'fulfilment.pickupLocationName',
  'fulfilment.manifestMaxAttempts',
  'fulfilment.reconcileStaleMinutes',
  'fulfilment.reconcileBatchSize',
  'fulfilment.ndrAutoReattempt',
  'fulfilment.trackingUrlTemplate',
  'fulfilment.mode',
] as const

const RuleConfigSchema = z.object({
  'fulfilment.enabled': z.boolean(),
  'fulfilment.carrier': z.string().min(1),
  'fulfilment.autoManifest': z.boolean(),
  'fulfilment.pickupLocationName': z.string(),
  'fulfilment.manifestMaxAttempts': z.number().int().min(1).max(50),
  'fulfilment.reconcileStaleMinutes': z.number().int().min(5).max(10_080),
  // Bounded by Delhivery's tracking limit of 750 requests / 5 min / IP: one
  // shipment is one request, so a batch above that guarantees a throttle.
  'fulfilment.reconcileBatchSize': z.number().int().min(1).max(700),
  'fulfilment.trackingUrlTemplate': z.string(),
  // `.default('manual')` — NOT `.optional()` without a default — so an
  // environment that has never seeded this brand-new key still parses the
  // OTHER eight keys successfully and lands on the safe default, rather than
  // the whole rule collapsing to FULFILMENT_OFF the moment this file ships.
  'fulfilment.mode': z.enum(['carrier', 'manual']).default('manual'),
})

/**
 * Ten `app_config` keys become one {@link FulfilmentRule}.
 *
 * **Anything missing or malformed collapses to {@link FULFILMENT_OFF}** — the
 * same posture as `resolveShippingRule` and `resolveWholesaleRule`. A
 * half-parsed fulfilment policy is more dangerous than none: it would hand
 * parcels to a carrier under settings nobody chose.
 */
export function parseFulfilmentRule(values: Map<string, unknown>): FulfilmentRule {
  const parsed = RuleConfigSchema.safeParse(Object.fromEntries(values))
  if (!parsed.success) return FULFILMENT_OFF
  const v = parsed.data
  return {
    enabled: v['fulfilment.enabled'],
    carrier: v['fulfilment.carrier'],
    autoManifest: v['fulfilment.autoManifest'],
    pickupLocationName: v['fulfilment.pickupLocationName'].trim(),
    manifestMaxAttempts: v['fulfilment.manifestMaxAttempts'],
    reconcileStaleMinutes: v['fulfilment.reconcileStaleMinutes'],
    reconcileBatchSize: v['fulfilment.reconcileBatchSize'],
    trackingUrlTemplate: v['fulfilment.trackingUrlTemplate'],
    mode: v['fulfilment.mode'],
  }
}

export async function resolveFulfilmentRule(db: Db): Promise<FulfilmentRule> {
  return parseFulfilmentRule(await getConfigValues(db, [...FULFILMENT_CONFIG_KEYS]))
}

// ── Can the carrier sweeps do anything? ────────────────────────────────────
//
// Lives here, once, because TWO callers need the answer and they must never
// disagree: `routes/internalSweeps.ts` reports it to an operator as
// `blockedBy`, and the event-driven trigger uses it to decide whether to
// enqueue a Cloud Task at all. If they drifted, the trigger would happily buy
// a Neon compute window for a sweep that then answers `ran: false` — the exact
// spend docs/WIP-EVENT-DRIVEN-SWEEPS.md exists to remove.

/** Why the carrier sweeps cannot act. The values are `SweepSkipReason` members. */
export type CarrierSweepBlock =
  | 'fulfilment_disabled'
  | 'manual_mode'
  | 'carrier_unconfigured'
  | 'pickup_location_unset'

/**
 * The gates BOTH carrier sweeps share, evaluated in the order a human would fix
 * them so the answer names the first thing to go change.
 *
 * `mode === 'manual'` is checked independently of `enabled` on purpose
 * (SPEC-MANUAL-FULFILMENT §4B): neither alone can fire a carrier call, and
 * collapsing them into one reason would hide which is which.
 */
export function carrierSweepBlockedBy(
  rule: FulfilmentRule,
  hasAdapter: boolean
): Exclude<CarrierSweepBlock, 'pickup_location_unset'> | null {
  if (!rule.enabled) return 'fulfilment_disabled'
  if (rule.mode === 'manual') return 'manual_mode'
  if (!hasAdapter) return 'carrier_unconfigured'
  return null
}

/**
 * The manifest sweep's gates: the shared ones, plus a pickup location.
 *
 * The pickup check is separate and last because an EMPTY pickup location with
 * fulfilment otherwise fully on is the one combination that looks live and
 * rejects every single manifest at the carrier, one order at a time, with no
 * loud failure anywhere.
 */
export function manifestBlockedBy(
  rule: FulfilmentRule,
  hasAdapter: boolean
): CarrierSweepBlock | null {
  const shared = carrierSweepBlockedBy(rule, hasAdapter)
  if (shared !== null) return shared
  return rule.pickupLocationName === '' ? 'pickup_location_unset' : null
}

// ── Creating the shipment ──────────────────────────────────────────────────

export interface ShipmentIntent {
  orderId: string
  userId: string
  courierCode: string
  promisedEtaDays: number | null
  promisedDeliveryDate: string | null
}

/**
 * Insert the `pending_manifest` row. Called from the `OrderPaidHook`, INSIDE
 * the paid transaction and inside its `WHERE status = 'pending'` guard, so it
 * runs exactly once per order however many times webhook/verify/recover race.
 *
 * **Deliberately does no I/O beyond this insert.** The hook's own contract is
 * that it must not throw: by then the money is captured, and an exception
 * rolls back a transition Razorpay has already made. A carrier HTTP call is the
 * most likely thing in this system to throw, so it is not made here.
 *
 * `onConflictDoNothing` on `(orderId)` is not available (the column is
 * intentionally non-unique so a cancelled shipment can be re-manifested), so
 * the guard is an explicit existence check within the same transaction.
 */
export async function createShipmentIntent(
  tx: Runner,
  intent: ShipmentIntent
): Promise<string | null> {
  const existing = await tx
    .select({ id: shipments.id })
    .from(shipments)
    .where(eq(shipments.orderId, intent.orderId))
    .limit(1)
  if (existing.length > 0) return null

  const inserted = await tx
    .insert(shipments)
    .values({
      orderId: intent.orderId,
      userId: intent.userId,
      courierCode: intent.courierCode,
      referenceNo: intent.orderId,
      status: 'pending_manifest',
      promisedEtaDays: intent.promisedEtaDays,
      promisedDeliveryDate: intent.promisedDeliveryDate,
    })
    .returning({ id: shipments.id })

  return inserted[0]?.id ?? null
}

// ── Ingesting telemetry ────────────────────────────────────────────────────

export type ScanSource = 'webhook' | 'poll' | 'manual'

export interface IngestResult {
  /** False when the dedupe hash already existed — a replay, and a no-op. */
  stored: boolean
  /** False when no shipment carries this AWB: stored as an orphan (§5.4). */
  matched: boolean
  /** True when the scan was newer than everything seen and moved `status`. */
  advanced: boolean
  status: FulfilmentStatus | null
  /** Set when the carrier sent a pair we do not map — the caller must log it. */
  unmappedPair: string | null
  /**
   * The order this scan moved, or null for an orphan. Reported so the route
   * layer can react to a milestone (tell the shopper it shipped, schedule the
   * replenishment reminder on delivery) without re-reading the shipment it
   * just wrote — see `routes/customerNotifications.ts`.
   */
  orderId: string | null
  /** The AWB the shipment carries, for a tracking link. Null for an orphan. */
  awb: string | null
  /** The shipment's courier, for the shopper-facing "Courier:" line. */
  courierCode: string | null
}

/**
 * sha256 over the scan's identity. Two channels reporting the same physical
 * scan produce the same hash, which is what makes running webhook + poll
 * together safe rather than duplicative.
 */
export function dedupeHashFor(awb: string, scan: CarrierScan): string {
  return createHash('sha256')
    .update(
      [
        awb,
        scan.status ?? '',
        scan.statusType ?? '',
        scan.nslCode ?? '',
        scan.statusCode ?? '',
        scan.scannedAt.toISOString(),
      ].join('|')
    )
    .digest('hex')
}

/**
 * The single ingest path. Both the webhook and the reconcile sweep call this
 * and nothing else — if they had separate paths the two would drift, and the
 * one that drifted would be the one nobody was watching.
 */
export async function ingestScan(
  db: Db,
  awb: string,
  scan: CarrierScan,
  source: ScanSource,
  raw: unknown
): Promise<IngestResult> {
  const mapped = mapScan(scan)
  const hash = dedupeHashFor(awb, scan)

  return db.transaction(async (tx) => {
    const found = await tx.select().from(shipments).where(eq(shipments.awb, awb)).limit(1)
    const shipment = found[0]

    const inserted = await tx
      .insert(shipmentEvents)
      .values({
        shipmentId: shipment?.id ?? null,
        awb,
        source,
        carrierStatus: scan.status,
        carrierStatusType: scan.statusType,
        nslCode: scan.nslCode ?? null,
        statusCode: scan.statusCode ?? null,
        mappedStatus: mapped.status,
        scanLocation: scan.scanLocation ?? null,
        instructions: scan.instructions ?? null,
        scannedAt: scan.scannedAt,
        raw,
        dedupeHash: hash,
      })
      .onConflictDoNothing({ target: shipmentEvents.dedupeHash })
      .returning({ id: shipmentEvents.id })

    const stored = inserted.length > 0
    const unmappedPair = mapped.unmapped ? `${scan.statusType}:${scan.status}` : null

    if (shipment === undefined) {
      // Orphan. Answer honestly; the caller still owes the carrier a 200.
      return {
        stored,
        matched: false,
        advanced: false,
        status: null,
        unmappedPair,
        orderId: null,
        awb: null,
        courierCode: null,
      }
    }
    if (!stored) {
      return {
        stored: false,
        matched: true,
        advanced: false,
        status: shipment.status as FulfilmentStatus,
        unmappedPair,
        orderId: shipment.orderId,
        awb: shipment.awb,
        courierCode: shipment.courierCode,
      }
    }

    const advanced = await applyScanToShipment(tx, shipment, scan, mapped.status, mapped.isNdr)
    return {
      stored: true,
      matched: true,
      advanced,
      status: advanced ? mapped.status : (shipment.status as FulfilmentStatus),
      unmappedPair,
      orderId: shipment.orderId,
      awb: shipment.awb,
      courierCode: shipment.courierCode,
    }
  })
}

/**
 * Fold one scan into the shipment row (§4.3).
 *
 * The whole correctness of the status model is these few lines:
 *
 * - `status` follows the newest scan **by the carrier's clock**, not by arrival
 *   order. Delhivery's docs warn the flow is not linear, and a late `In
 *   Transit` arriving after `Delivered` must not un-deliver a parcel.
 * - Milestone timestamps are **set once**, via COALESCE, so a stale scan can
 *   still fill in a milestone nobody had recorded without disturbing `status`.
 * - `deliveryAttempts` counts NDR scans, which is what feeds the
 *   first-attempt-success measurement FEASIBILITY §3.4 defers to.
 */
async function applyScanToShipment(
  tx: Tx,
  shipment: ShipmentRow,
  scan: CarrierScan,
  status: FulfilmentStatus,
  isNdr: boolean
): Promise<boolean> {
  // Terminal statuses (cancelled/delivered/rto_delivered) are endpoints, and
  // both directions across that boundary need their own rule — plain clock
  // ordering gets each of them wrong.
  //
  // REACHING terminal always wins over a stale-looking carrier timestamp: it
  // is an endpoint a shipment has not yet reached, not a point on the timeline
  // a later-arriving-but-earlier-stamped scan could plausibly contest. Without
  // this, `status` silently freezes below while `cancelledAt`/`deliveredAt`
  // still get filled in via COALESCE.
  //
  // LEAVING terminal for a non-terminal status is never right, however new the
  // scan looks. Delhivery acknowledges a cancellation with a `Not Picked`
  // (X-PNP / DTUP-*) scan, which maps to `manifested` and lands a second or
  // two AFTER `cancelShipment` has already written `cancelled` — under strict
  // clock ordering that scan is genuinely newer, so it overwrote the
  // cancellation and left the row reading "cancelled" to ops (it has
  // `cancelledAt`) but "awaiting pickup" to the shopper. That is the exact
  // split-brain this guard exists to prevent, and it is also what kept the
  // tracking sweep polling AWBs for orders that were already refunded.
  //
  // Terminal → terminal keeps strict clock ordering: a stale duplicate must
  // not flip `delivered` back to `cancelled`.
  const currentTerminal = isTerminal(shipment.status as FulfilmentStatus)
  const nextTerminal = isTerminal(status)
  const clockNewer =
    shipment.lastScanAt === null || scan.scannedAt.getTime() > shipment.lastScanAt.getTime()
  const isNewer = currentTerminal ? nextTerminal && clockNewer : nextTerminal || clockNewer

  const milestone = milestoneFor(status)
  const patch: Record<string, unknown> = { updatedAt: sql`now()` }

  if (milestone !== null) {
    // Set-once. `sql` COALESCE rather than a read-then-write so concurrent
    // ingests of two different scans cannot clobber each other's milestone.
    patch[milestone] = sql`coalesce(${shipments[milestone]}, ${scan.scannedAt})`
  }

  if (isNdr) {
    patch.ndrReason = scan.instructions ?? scan.status
    patch.ndrRaisedAt = sql`coalesce(${shipments.ndrRaisedAt}, ${scan.scannedAt})`
    patch.deliveryAttempts = sql`${shipments.deliveryAttempts} + 1`
  }

  if (isNewer) {
    patch.status = status
    patch.statusDetail = scan.status
    patch.lastScanAt = scan.scannedAt
    if (scan.nslCode !== undefined) patch.nslCode = scan.nslCode
    // A shipment that has moved on from an NDR should stop advertising one.
    // Any strictly-newer non-NDR scan clears it, including a re-attempt going
    // back out for delivery — ranking `out_for_delivery` below `ndr` would
    // otherwise leave a stale "delivery failed" banner on a parcel that is
    // currently on a van.
    if (!isNdr && status !== 'ndr') patch.ndrReason = null
  }

  await tx.update(shipments).set(patch).where(eq(shipments.id, shipment.id))
  return isNewer
}

/**
 * Re-link scans that arrived before we knew the AWB, then replay them so the
 * shipment's status reflects them. Called right after a successful manifest.
 *
 * Without this, a carrier that scans faster than our sweep commits would leave
 * a permanently `manifested` shipment with its real scans sitting in orphan
 * rows — data present, status wrong.
 */
export async function adoptOrphanEvents(db: Db, shipmentId: string, awb: string): Promise<number> {
  return db.transaction(async (tx) => {
    const orphans = await tx
      .select()
      .from(shipmentEvents)
      .where(and(eq(shipmentEvents.awb, awb), isNull(shipmentEvents.shipmentId)))
      .orderBy(shipmentEvents.scannedAt)
    if (orphans.length === 0) return 0

    await tx
      .update(shipmentEvents)
      .set({ shipmentId })
      .where(
        inArray(
          shipmentEvents.id,
          orphans.map((row) => row.id)
        )
      )

    for (const row of orphans) {
      const current = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1)
      const shipment = current[0]
      if (shipment === undefined) break
      await applyScanToShipment(
        tx,
        shipment,
        {
          statusType: row.carrierStatusType ?? '',
          status: row.carrierStatus ?? '',
          nslCode: row.nslCode ?? undefined,
          statusCode: row.statusCode ?? undefined,
          scanLocation: row.scanLocation ?? undefined,
          instructions: row.instructions ?? undefined,
          scannedAt: row.scannedAt,
        },
        row.mappedStatus as FulfilmentStatus,
        row.mappedStatus === 'ndr'
      )
    }
    return orphans.length
  })
}

// ── Outbound sweeps ────────────────────────────────────────────────────────

/**
 * The statuses `reconcileStale` polls the carrier about — a parcel that is
 * in-flight and could still move. Named once and shared with
 * {@link fulfilmentBacklog} so the "how many are stale" number can never
 * describe a different set of rows than the sweep that drains them.
 */
const IN_FLIGHT_STATUSES = [
  'manifested',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'ndr',
  'rto_in_transit',
  'exception',
] as const

/** What is waiting for a sweep right now. See {@link fulfilmentBacklog}. */
export interface FulfilmentBacklog {
  /** `pending_manifest` and still under `manifestMaxAttempts` — the next sweep will try these. */
  pendingManifest: number
  /**
   * `pending_manifest` with the attempt budget spent. **No sweep will ever pick
   * these up again.** They are the rows that need a human, and the only reason
   * this number is reported separately: folded into `pendingManifest` it would
   * look like a backlog that is about to drain, when it is one that never will.
   */
  manifestExhausted: number
  /** In-flight shipments the carrier has gone quiet on past `reconcileStaleMinutes`. */
  staleTracking: number
  /** Age in hours of the oldest `pending_manifest` row, or null when there are none. */
  oldestPendingManifestHours: number | null
}

/**
 * Count what the sweeps would find, without doing any of the work or calling
 * the carrier. Feeds the readiness endpoint (`contracts/sweeps.ts`).
 *
 * Deliberately counts against the SAME predicates `manifestPending` and
 * `reconcileStale` select on, including the attempt cap and the stale cutoff —
 * a readiness number derived from a looser query would report a backlog the
 * sweeps cannot actually touch, which is worse than no number at all.
 */
export async function fulfilmentBacklog(
  db: Db,
  rule: FulfilmentRule,
  now: Date = new Date()
): Promise<FulfilmentBacklog> {
  const cutoff = new Date(now.getTime() - rule.reconcileStaleMinutes * 60_000)

  const [pending] = await db
    .select({
      under: sql<number>`count(*) filter (where ${shipments.manifestAttempts} < ${rule.manifestMaxAttempts})::int`,
      exhausted: sql<number>`count(*) filter (where ${shipments.manifestAttempts} >= ${rule.manifestMaxAttempts})::int`,
      oldest: sql<Date | null>`min(${shipments.createdAt})`,
    })
    .from(shipments)
    .where(eq(shipments.status, 'pending_manifest'))

  const [stale] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shipments)
    .where(
      and(
        inArray(shipments.status, [...IN_FLIGHT_STATUSES]),
        or(isNull(shipments.lastScanAt), lt(shipments.lastScanAt, cutoff))
      )
    )

  const oldest = pending?.oldest ?? null
  return {
    pendingManifest: pending?.under ?? 0,
    manifestExhausted: pending?.exhausted ?? 0,
    staleTracking: stale?.n ?? 0,
    oldestPendingManifestHours:
      oldest === null
        ? null
        : Math.round(((now.getTime() - new Date(oldest).getTime()) / 3_600_000) * 10) / 10,
  }
}

/**
 * How many parcels are still moving — anything in {@link IN_FLIGHT_STATUSES},
 * stale or not.
 *
 * Distinct from `fulfilmentBacklog().staleTracking` on purpose, and the
 * difference is load-bearing for the event-driven reconcile chain
 * (docs/WIP-EVENT-DRIVEN-SWEEPS.md): a reconcile run UPDATES `lastScanAt`, so
 * `staleTracking` is 0 the moment it finishes. Chaining off that would stop the
 * chain exactly when it succeeded, and a parcel whose webhook is broken would
 * never be polled again until the daily backstop. Chaining off "is anything
 * still in flight" keeps polling until the parcels actually land, and costs
 * nothing when none are.
 */
export async function countInFlightShipments(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shipments)
    .where(inArray(shipments.status, [...IN_FLIGHT_STATUSES]))
  return row?.n ?? 0
}

export interface SweepOutcome {
  scanned: number
  succeeded: number
  failed: number
  changed: number
}

/** Everything the manifest builder needs, resolved by the ROUTE from frozen snapshots. */
export interface ManifestSource {
  consigneeName: string
  consigneePhone: string
  address: string
  city: string
  state: string
  pincode: string
  declaredValueInr: number
  weightG: number
  lengthCm?: number | undefined
  widthCm?: number | undefined
  heightCm?: number | undefined
  productDescription: string
  /** PACKAGE count, not units. Delhivery bills freight per package. */
  quantity: number
  sellerGstTin?: string | undefined
  hsnCode?: string | undefined
  fragile?: boolean | undefined
  /**
   * Rupees the delivery agent must collect. 0 on a prepaid order.
   *
   * Comes off the ORDER ROW (`payments.cod_amount_paise`), not off a snapshot,
   * because it is how the order is being SETTLED rather than what it cost —
   * see docs/SPEC-COD.md. It is the balance after the token, never the total.
   */
  codAmountInr?: number | undefined
}

/**
 * Resolve one order's manifest inputs. Injected by the route rather than read
 * here, because it needs `payments` snapshots and ARCHITECTURE.md rule 2
 * forbids this service importing the payments service.
 *
 * Returning null means "this order cannot be shipped" and stops the attempt
 * without burning a retry.
 */
export type ManifestSourceResolver = (orderId: string) => Promise<ManifestSource | null>

/**
 * Manifest every `pending_manifest` shipment under the attempt cap (§6.2).
 *
 * A carrier failure is recorded on the row and retried; it never throws out of
 * the sweep, because one bad address must not stop the other forty parcels
 * from shipping.
 */
export async function manifestPending(
  db: Db,
  adapter: CarrierAdapter,
  rule: FulfilmentRule,
  resolve: ManifestSourceResolver,
  limit = 25
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { scanned: 0, succeeded: 0, failed: 0, changed: 0 }
  // `mode === 'manual'` is checked independently of `enabled` — see the note
  // on `FulfilmentRule.mode` — so a manual-mode deploy can never manifest a
  // shipment with the carrier by accident (SPEC-MANUAL-FULFILMENT.md §4B).
  if (!rule.enabled || rule.mode === 'manual' || rule.pickupLocationName === '') return outcome

  const pending = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.status, 'pending_manifest'),
        lt(shipments.manifestAttempts, rule.manifestMaxAttempts)
      )
    )
    .orderBy(shipments.createdAt)
    .limit(limit)

  for (const shipment of pending) {
    outcome.scanned += 1
    const source = await resolve(shipment.orderId)
    if (source === null) {
      outcome.failed += 1
      await db
        .update(shipments)
        .set({
          manifestError: 'Order snapshots are missing or incomplete; cannot build a manifest',
          // Not an attempt against the carrier — but it must not spin forever
          // either, so it burns the same budget.
          manifestAttempts: sql`${shipments.manifestAttempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(shipments.id, shipment.id))
      continue
    }

    const request: ManifestRequest = {
      referenceNo: shipment.referenceNo ?? shipment.orderId,
      pickupLocationName: rule.pickupLocationName,
      ...source,
    }

    let result
    try {
      result = await adapter.manifest(request)
    } catch (err) {
      outcome.failed += 1
      await db
        .update(shipments)
        .set({
          manifestError: err instanceof Error ? err.message : 'Carrier call failed',
          manifestAttempts: sql`${shipments.manifestAttempts} + 1`,
          manifestPayload: request,
          updatedAt: sql`now()`,
        })
        .where(eq(shipments.id, shipment.id))
      continue
    }

    if (!result.ok || result.awb === undefined) {
      outcome.failed += 1
      await db
        .update(shipments)
        .set({
          manifestError: result.remark ?? 'Carrier rejected the manifest without a reason',
          manifestAttempts: sql`${shipments.manifestAttempts} + 1`,
          manifestPayload: request,
          updatedAt: sql`now()`,
        })
        .where(eq(shipments.id, shipment.id))
      continue
    }

    await db
      .update(shipments)
      .set({
        awb: result.awb,
        status: 'manifested',
        manifestedAt: sql`coalesce(${shipments.manifestedAt}, now())`,
        manifestError: null,
        manifestAttempts: sql`${shipments.manifestAttempts} + 1`,
        manifestPayload: request,
        updatedAt: sql`now()`,
      })
      .where(eq(shipments.id, shipment.id))

    // Scans may already be waiting under this AWB (§5.4).
    await adoptOrphanEvents(db, shipment.id, result.awb)
    outcome.succeeded += 1
    outcome.changed += 1

    // Auto-request pickup right off the back of a successful manifest — this
    // is what used to require an operator to hit the `.../pickup` route by
    // hand for every shipment. Best-effort: a pickup failure must not undo
    // the manifest that already succeeded, so it's swallowed and left for the
    // manual `.../pickup` route as a fallback.
    try {
      const pickup = await adapter.createPickup({
        pickupLocationName: rule.pickupLocationName,
        pickupDate: istDate(new Date()),
        pickupTime: '14:00:00',
        expectedPackageCount: 1,
      })
      if (pickup.ok && pickup.pickupId !== undefined) {
        await db
          .update(shipments)
          .set({ pickupId: pickup.pickupId, updatedAt: sql`now()` })
          .where(eq(shipments.id, shipment.id))
      }
    } catch {
      // Carrier outage on the pickup leg — the shipment stays `manifested`
      // and ops can still request pickup by hand.
    }
  }

  return outcome
}

/** `YYYY-MM-DD` in IST — the carrier's calendar, not the server's. */
export function istDate(now: Date): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  return ist.toISOString().slice(0, 10)
}

/** The pincode the order ships to, from its frozen address; undefined when absent. */
async function orderDestinationPincode(db: Db, orderId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ pincode: sql<string | null>`${payments.addressSnapshot}->>'pincode'` })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .limit(1)
  return row?.pincode ?? undefined
}

/**
 * Pull tracking for shipments the webhook has gone quiet on (§5.2).
 *
 * This is what makes the unsigned webhook safe to rely on: losing it entirely
 * degrades the system to polling rather than to silence. Both channels share
 * `ingestScan`, so overlap is a dedupe-hash conflict, not a duplicate row.
 *
 * Each shipment is tracked by the carrier actually holding it: `trackers` is
 * keyed by `shipments.courier_code` (e.g. a hand-booked Shree Maruti parcel),
 * and anything without an entry goes to `adapter`, the configured carrier.
 */
export async function reconcileStale(
  db: Db,
  adapter: CarrierAdapter,
  rule: FulfilmentRule,
  now: Date = new Date(),
  onMilestone?: (result: IngestResult) => Promise<void>,
  trackers: Readonly<Record<string, CarrierTracker>> = {}
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { scanned: 0, succeeded: 0, failed: 0, changed: 0 }
  // Same independent gate as `manifestPending` — a manual-mode deploy never
  // polls the carrier for tracking either.
  if (!rule.enabled || rule.mode === 'manual') return outcome

  const cutoff = new Date(now.getTime() - rule.reconcileStaleMinutes * 60_000)
  const stale = await db
    .select()
    .from(shipments)
    .where(
      and(
        inArray(shipments.status, [...IN_FLIGHT_STATUSES]),
        or(isNull(shipments.lastScanAt), lt(shipments.lastScanAt, cutoff))
      )
    )
    .orderBy(shipments.updatedAt)
    .limit(rule.reconcileBatchSize)

  for (const shipment of stale) {
    if (shipment.awb === null) continue
    outcome.scanned += 1
    try {
      const tracker = trackers[shipment.courierCode]
      // A hand-booked carrier's AWB was typed by a person, so its parcel has to
      // prove it is ours — see `readShreeMarutiTrackingBody`.
      const { scans, expectedDeliveryDate } =
        tracker === undefined
          ? await adapter.track(shipment.awb)
          : await tracker.track(shipment.awb, {
              destinationPincode: await orderDestinationPincode(db, shipment.orderId),
            })
      for (const scan of scans) {
        const result = await ingestScan(db, shipment.awb, scan, 'poll', scan)
        if (result.stored) outcome.changed += 1
        if (result.advanced && result.orderId !== null) {
          await onMilestone?.(result)
        }
      }
      // Not a milestone — it moves as the carrier re-estimates, so it is
      // simply overwritten each poll rather than set-once like §4.3's dates.
      if (expectedDeliveryDate !== null) {
        await db
          .update(shipments)
          .set({ carrierEdd: expectedDeliveryDate, updatedAt: sql`now()` })
          .where(eq(shipments.id, shipment.id))
      }
      outcome.succeeded += 1
    } catch {
      // A carrier outage is expected and transient; the next tick retries. It
      // is not recorded on the row because it says nothing about the parcel.
      outcome.failed += 1
    }
  }

  return outcome
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface ShipmentWithEvents {
  shipment: ShipmentRow
  events: Array<{
    status: FulfilmentStatus
    location: string
    occurredAt: Date
  }>
}

/**
 * The shopper's view. Ownership is checked here (`userId`), and a shipment
 * belonging to someone else is reported as absent — never 403, per the repo's
 * "do not leak existence" rule.
 */
export async function getShipmentForUser(
  db: Db,
  userId: string,
  orderId: string
): Promise<ShipmentWithEvents | null> {
  const found = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), eq(shipments.userId, userId)))
    .orderBy(desc(shipments.createdAt))
    .limit(1)
  const shipment = found[0]
  if (shipment === undefined) return null

  const rows = await db
    .select({
      mappedStatus: shipmentEvents.mappedStatus,
      scanLocation: shipmentEvents.scanLocation,
      scannedAt: shipmentEvents.scannedAt,
    })
    .from(shipmentEvents)
    .where(eq(shipmentEvents.shipmentId, shipment.id))
    .orderBy(shipmentEvents.scannedAt)

  // Collapse consecutive same-status scans: a parcel crossing four hubs emits
  // four `in_transit` rows, and a customer timeline that repeats "In transit"
  // four times reads as a bug.
  const events: ShipmentWithEvents['events'] = []
  for (const row of rows) {
    const status = row.mappedStatus as FulfilmentStatus
    const previous = events[events.length - 1]
    if (previous !== undefined && previous.status === status) continue
    events.push({ status, location: row.scanLocation ?? '', occurredAt: row.scannedAt })
  }

  return { shipment, events }
}

export async function getShipmentById(db: Db, id: string): Promise<ShipmentRow | null> {
  const found = await db.select().from(shipments).where(eq(shipments.id, id)).limit(1)
  return found[0] ?? null
}

export async function listShipments(
  db: Db,
  filter: { status?: FulfilmentStatus | undefined; limit: number; offset: number }
): Promise<ShipmentRow[]> {
  const where = filter.status !== undefined ? eq(shipments.status, filter.status) : undefined
  return db
    .select()
    .from(shipments)
    .where(where)
    .orderBy(desc(shipments.createdAt))
    .limit(filter.limit)
    .offset(filter.offset)
}

// ── Gating a shopper's self-cancel ─────────────────────────────────────────

/**
 * Statuses in which a shopper may still cancel the ORDER themselves: the
 * parcel has not yet been handed to the courier. `manifested` (packed,
 * awaiting pickup) is included — it is still sitting on our shelf. `cancelled`
 * is here because a voided shipment leaves the order in the same position as
 * one that never had a shipment at all.
 */
const SELF_CANCELLABLE = new Set<FulfilmentStatus>(['pending_manifest', 'manifested', 'cancelled'])

/**
 * Why this order can no longer be self-cancelled, or null if it still can.
 *
 * **Reads fulfilment state, and only to REFUSE a money action — it never causes
 * one.** That direction matters: §1.1 quarantines fulfilment from money because
 * the inbound channel is an unsigned webhook, and a forged scan that can only
 * ever make us keep the customer's parcel moving (rather than issue a refund)
 * is not a payout an attacker can steer.
 *
 * Before this existed `cancelOrder` was shipment-blind, so a shopper could
 * refund in full while their parcel was on a Delhivery van. Ops must cancel the
 * shipment with the carrier first (or let it RTO), and only then refund.
 */
export async function shipmentCancelBlock(db: Db, orderId: string): Promise<string | null> {
  const rows = await db
    .select({ status: shipments.status, awb: shipments.awb })
    .from(shipments)
    .where(eq(shipments.orderId, orderId))

  for (const row of rows) {
    const status = row.status as FulfilmentStatus
    if (SELF_CANCELLABLE.has(status)) continue
    if (status === 'delivered' || status === 'rto_delivered') {
      return 'This order has already been delivered'
    }
    return 'This order has already been handed to the courier'
  }
  return null
}

/** What {@link cancelShipmentsForOrder} managed to do. */
export interface OrderShipmentCancelSweep {
  cancelled: number
  /** Shipments still live afterwards — a real label we could not recall. */
  unresolved: Array<{ shipmentId: string; awb: string | null; remark: string | null }>
}

/**
 * Cancel every live shipment of an order that has just been refunded.
 *
 * The refund path used to void only `pending_manifest` rows with no AWB, so the
 * manifest sweep would stop considering them. But a shopper may self-cancel
 * while the shipment is `manifested` (see {@link SELF_CANCELLABLE}) — packed,
 * labelled, still on our shelf. Those rows kept their `manifested` status after
 * the refund, so the order read "refunded" on the money side and "Order packed,
 * awaiting pickup" on the tracking side, and the label stayed live at the
 * carrier for a parcel nobody was going to send.
 *
 * Called only after the money has already moved, so it reports rather than
 * throws: a carrier refusal leaves the shipment for ops to chase, and never
 * turns a completed refund into a failed request.
 */
export async function cancelShipmentsForOrder(
  db: Db,
  orderId: string,
  adapter?: CarrierAdapter
): Promise<OrderShipmentCancelSweep> {
  const rows = await db.select().from(shipments).where(eq(shipments.orderId, orderId))

  const sweep: OrderShipmentCancelSweep = { cancelled: 0, unresolved: [] }
  for (const row of rows) {
    if (isTerminal(row.status as FulfilmentStatus)) continue
    const outcome = await cancelShipment(db, adapter, row)
    if (outcome.ok) sweep.cancelled += 1
    else sweep.unresolved.push({ shipmentId: row.id, awb: row.awb, remark: outcome.remark })
  }
  return sweep
}

// ── Carrier-facing actions on one shipment ─────────────────────────────────

export interface CancelOutcome {
  ok: boolean
  status: FulfilmentStatus
  remark: string | null
}

/**
 * Cancel with the carrier and record it.
 *
 * **Only fulfilment state moves.** Refunding the shopper is a payments
 * decision and is not made here — §1.1. A cancelled prepaid shipment comes
 * back from Delhivery as `Returned`, not `Cancelled`, which the mapping table
 * already accounts for; this function records our own intent regardless of
 * which word the carrier chooses.
 */
export async function cancelShipment(
  db: Db,
  adapter: CarrierAdapter | undefined,
  shipment: ShipmentRow
): Promise<CancelOutcome> {
  const status = shipment.status as FulfilmentStatus
  if (isTerminal(status)) {
    return { ok: false, status, remark: 'Shipment has already reached a final state' }
  }
  if (shipment.awb === null) {
    // Never manifested — cancelling is purely local and always succeeds.
    await db
      .update(shipments)
      .set({
        status: 'cancelled',
        cancelledAt: sql`coalesce(${shipments.cancelledAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(eq(shipments.id, shipment.id))
    return { ok: true, status: 'cancelled', remark: null }
  }

  // A manifested parcel exists at the carrier; without an adapter there is no
  // way to recall it, and marking it cancelled locally would tell the shopper
  // a lie about a label that is still live.
  if (adapter === undefined) {
    return { ok: false, status, remark: 'No carrier configured to cancel this shipment' }
  }

  const result = await adapter.cancel(shipment.awb)
  if (!result.ok) {
    return { ok: false, status, remark: result.remark ?? 'Carrier refused the cancellation' }
  }

  await db
    .update(shipments)
    .set({
      status: 'cancelled',
      statusDetail: result.remark ?? null,
      cancelledAt: sql`coalesce(${shipments.cancelledAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(eq(shipments.id, shipment.id))

  return { ok: true, status: 'cancelled', remark: result.remark ?? null }
}

export interface NdrRequestInput {
  act: NdrAct
  deferredDate?: string | undefined
  name?: string | undefined
  phone?: string | undefined
  address?: string | undefined
}

/**
 * Ask the carrier to do something about a failed delivery.
 *
 * The `ndr_actions` row is written **before** the call and updated after, so a
 * request that times out mid-flight still leaves evidence that we asked — the
 * alternative loses the audit trail exactly when an operator most needs it.
 */
export async function requestNdrAction(
  db: Db,
  adapter: CarrierAdapter,
  shipment: ShipmentRow,
  input: NdrRequestInput,
  requestedBy: string | null
): Promise<NdrActionRow> {
  if (shipment.awb === null) {
    throw new Error('Shipment has no AWB; there is nothing for the carrier to act on')
  }

  const payload = {
    ...(input.deferredDate !== undefined ? { deferred_date: input.deferredDate } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.address !== undefined ? { add: input.address } : {}),
  }

  const created = await db
    .insert(ndrActions)
    .values({
      shipmentId: shipment.id,
      awb: shipment.awb,
      act: input.act,
      payload,
      requestedBy,
      uplStatus: 'requested',
    })
    .returning()
  const row = created[0]
  if (row === undefined) throw new Error('Failed to record the NDR action')

  let result
  try {
    result = await adapter.ndrAction({
      waybill: shipment.awb,
      act: input.act,
      deferredDate: input.deferredDate,
      name: input.name,
      phone: input.phone,
      address: input.address,
    })
  } catch (err) {
    const updated = await db
      .update(ndrActions)
      .set({
        uplStatus: 'unknown',
        lastError: err instanceof Error ? err.message : 'Carrier call failed',
        updatedAt: sql`now()`,
      })
      .where(eq(ndrActions.id, row.id))
      .returning()
    return updated[0] ?? row
  }

  const updated = await db
    .update(ndrActions)
    .set({
      uplId: result.uplId ?? null,
      // `accepted` means "the carrier took the request", NOT "the parcel will
      // be re-attempted" — their API is asynchronous and answers with a
      // receipt. Conflating the two would report success we have not observed.
      uplStatus: result.ok ? 'accepted' : 'rejected',
      lastError: result.ok ? null : (result.remark ?? 'Carrier rejected the NDR action'),
      updatedAt: sql`now()`,
    })
    .where(eq(ndrActions.id, row.id))
    .returning()

  return updated[0] ?? row
}

/**
 * Tracking deep link for the shopper; '' when there is nothing to track yet.
 *
 * `manualTrackingUrl` — set by `POST …/shipments/:id/dispatch` in manual mode
 * — WINS over the carrier template whenever it is present
 * (docs/SPEC-MANUAL-FULFILMENT.md §4B "customer side needs no work" note): a
 * manually-dispatched parcel has no Delhivery AWB for the template to
 * interpolate, and even when an operator also typed one in, the manual link
 * is the one that was actually verified to work for this parcel.
 */
export function trackingUrlFor(
  template: string,
  awb: string | null,
  manualTrackingUrl?: string | null
): string {
  if (manualTrackingUrl !== undefined && manualTrackingUrl !== null && manualTrackingUrl !== '') {
    return manualTrackingUrl
  }
  if (awb === null || awb === '' || template === '') return ''
  return template.replace('{awb}', encodeURIComponent(awb))
}

// ── Manual fulfilment (docs/SPEC-MANUAL-FULFILMENT.md §4B) ─────────────────

/** Postgres `unique_violation` — same detection `plugins/auth.ts` uses for the `users.phone` race. */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && 'code' in v && (v as { code: unknown }).code === '23505'
  return hasCode(err) || (err instanceof Error && hasCode(err.cause))
}

export interface ManualEventInput {
  status: FulfilmentStatus
  note?: string | undefined
  location?: string | undefined
  occurredAt: Date
  actorId: string | null
}

/**
 * Write one manual `shipment_events` row and fold it through the SAME
 * `applyScanToShipment` every carrier scan goes through — no parallel status
 * path, per SPEC-MANUAL-FULFILMENT.md §2's whole point.
 *
 * Two traps this exists to avoid (§4B):
 *
 * 1. **Dedupe-hash collision.** `dedupeHashFor` keys on the carrier tuple,
 *    which a manual entry doesn't have — two operator entries in the same
 *    second against the same status would hash identically and the second
 *    would be silently swallowed by `onConflictDoNothing`. A manual event
 *    hashes a per-event nonce (`manual:<uuid>`) instead, so it can never
 *    collide with another manual entry OR a real carrier scan.
 * 2. **`shipment_events.awb` is NOT NULL** even though a manual event on a
 *    still-`pending_manifest` shipment has no AWB yet — `shipment.awb ?? ''`
 *    is the sentinel. Safe: `adoptOrphanEvents` only ever looks at rows with
 *    `shipment_id IS NULL`, and a manual event always carries its concrete
 *    `shipmentId`, so it is never mistaken for an orphan to re-link.
 */
async function foldManualEvent(
  tx: Tx,
  shipment: ShipmentRow,
  input: ManualEventInput
): Promise<boolean> {
  const scan: CarrierScan = {
    statusType: 'manual',
    status: input.status,
    scannedAt: input.occurredAt,
    instructions: input.note,
    scanLocation: input.location,
  }

  await tx.insert(shipmentEvents).values({
    shipmentId: shipment.id,
    awb: shipment.awb ?? '',
    source: 'manual',
    carrierStatus: input.status,
    carrierStatusType: 'manual',
    mappedStatus: input.status,
    scanLocation: input.location ?? null,
    instructions: input.note ?? null,
    scannedAt: input.occurredAt,
    raw: { manual: true, actorId: input.actorId, note: input.note ?? null },
    dedupeHash: `manual:${randomUUID()}`,
    actorId: input.actorId,
    note: input.note ?? null,
  })

  return applyScanToShipment(tx, shipment, scan, input.status, input.status === 'ndr')
}

export interface ManualStatusResult {
  shipment: ShipmentRow
  advanced: boolean
}

/**
 * `POST …/shipments/:id/status` — validate against `FULFILMENT_STATUSES` (the
 * caller's zod schema does this), write a manual event, fold it. Returns null
 * for an unknown shipment id.
 */
export async function applyManualStatus(
  db: Db,
  shipmentId: string,
  input: {
    status: FulfilmentStatus
    note?: string | undefined
    location?: string | undefined
    occurredAt?: Date | undefined
    actorId: string | null
  }
): Promise<ManualStatusResult | null> {
  return db.transaction(async (tx) => {
    const found = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1)
    const shipment = found[0]
    if (shipment === undefined) return null

    const advanced = await foldManualEvent(tx, shipment, {
      status: input.status,
      note: input.note,
      location: input.location,
      occurredAt: input.occurredAt ?? new Date(),
      actorId: input.actorId,
    })

    const after = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1)
    return { shipment: after[0] ?? shipment, advanced }
  })
}

/**
 * `POST …/shipments/:id/ack` — "a human has seen this." Set-once via COALESCE
 * (same pattern as the milestone timestamps): a second ack does not overwrite
 * who acknowledged first. Returns null for an unknown shipment id.
 */
export async function acknowledgeShipment(
  db: Db,
  shipmentId: string,
  actorId: string
): Promise<ShipmentRow | null> {
  const updated = await db
    .update(shipments)
    .set({
      acknowledgedAt: sql`coalesce(${shipments.acknowledgedAt}, now())`,
      acknowledgedBy: sql`coalesce(${shipments.acknowledgedBy}, ${actorId})`,
      updatedAt: sql`now()`,
    })
    .where(eq(shipments.id, shipmentId))
    .returning()
  return updated[0] ?? null
}

export interface ManualDispatchInput {
  courierName: string
  awb?: string | undefined
  trackingUrl?: string | undefined
  weightG?: number | undefined
  actorId: string | null
}

/**
 * `POST …/shipments/:id/dispatch` — "records who is carrying it, then folds a
 * manual `manifested` event" (§4B). Both writes happen in one transaction:
 * the manual-courier columns and the status fold succeed or fail together.
 *
 * **AWB uniqueness (§4B trap #2).** `shipments_awb_idx` is a unique index.
 * An operator typing an AWB that already exists elsewhere must get a 409, not
 * a raw constraint violation surfacing as a 500 — `isUniqueViolation` is what
 * turns that into `conflict()`.
 *
 * Returns null for an unknown shipment id.
 */
export async function recordManualDispatch(
  db: Db,
  shipmentId: string,
  input: ManualDispatchInput
): Promise<ManualStatusResult | null> {
  try {
    return await db.transaction(async (tx) => {
      const found = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1)
      const shipment = found[0]
      if (shipment === undefined) return null

      // A courier we can track gets its own `courier_code`, which is what
      // routes the parcel to that carrier's tracker in `reconcileStale` and
      // what the freight report reads as the courier that actually carried it.
      // Its public tracking page stands in for an operator-typed link.
      const shreeMaruti = isShreeMarutiCourierName(input.courierName)
      const trackingUrl =
        input.trackingUrl ??
        (shreeMaruti && input.awb !== undefined ? shreeMarutiTrackingUrl(input.awb) : undefined)

      await tx
        .update(shipments)
        .set({
          manualCourierName: input.courierName,
          ...(shreeMaruti ? { courierCode: SHREE_MARUTI_COURIER_CODE } : {}),
          ...(trackingUrl !== undefined ? { manualTrackingUrl: trackingUrl } : {}),
          ...(input.awb !== undefined ? { awb: input.awb } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(shipments.id, shipmentId))

      const refreshed = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1)
      const current = refreshed[0]
      if (current === undefined) return null

      const note = [
        `Manual dispatch — courier: ${input.courierName}`,
        input.awb !== undefined ? `AWB: ${input.awb}` : null,
        input.weightG !== undefined ? `${input.weightG} g` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')

      const advanced = await foldManualEvent(tx, current, {
        status: 'manifested',
        note,
        occurredAt: new Date(),
        actorId: input.actorId,
      })

      const after = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1)
      return { shipment: after[0] ?? current, advanced }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('That AWB is already assigned to another shipment')
    throw err
  }
}
