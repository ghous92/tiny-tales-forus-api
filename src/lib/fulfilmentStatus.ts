/**
 * Carrier scan → canonical fulfilment status (docs/SPEC-LOGISTICS.md §4).
 *
 * Pure module, sibling of `lib/pricing.ts` and `lib/shipping.ts`: no DB
 * imports, no config imports, no I/O. **Every carrier status string in this
 * codebase lives here** — `test/arch/fulfilment-containment.test.ts` greps for
 * the tokens and fails if one leaks into a service or a route. The point is
 * that swapping Delhivery for Xpressbees is one new mapping table, not a
 * search-and-replace across the module.
 *
 * Three properties this file exists to guarantee, all of them learned from
 * Delhivery's own documentation rather than invented:
 *
 * 1. **Nothing is dropped.** Their docs say "consume all the scans which are
 *    pushed by Delhivery and not to put a hard check in the first place". An
 *    unrecognised pair maps to `exception` and keeps the carrier's own words —
 *    it never gets bucketed into a neighbouring state that reads as healthy.
 * 2. **NDR overrides the base table.** A failed delivery attempt arrives as an
 *    ordinary-looking `Pending`/`Dispatched` scan carrying an `EOD-*` status
 *    code. Read the pair alone and a customer who was not home looks like a
 *    parcel in transit. A failed *pickup* attempt (`FMPUR-*`/`FMEOD-*`) gets
 *    the same override, for the same reason — see {@link isPickupFailureCode}.
 * 3. **The flow is not hardcoded.** Their docs: "this is a happy flow diagram,
 *    kindly do not hardcode the flow or steps or stages on the shipment."
 *    {@link rankOf} exists for set-once milestone timestamps, NOT to gate which
 *    transitions are legal.
 */

/** Our vocabulary. Deliberately not the carrier's — see the module note. */
export type FulfilmentStatus =
  | 'pending_manifest'
  | 'manifested'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'ndr'
  | 'rto_in_transit'
  | 'delivered'
  | 'rto_delivered'
  | 'cancelled'
  | 'exception'

export const FULFILMENT_STATUSES: readonly FulfilmentStatus[] = [
  'pending_manifest',
  'manifested',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'ndr',
  'rto_in_transit',
  'delivered',
  'rto_delivered',
  'cancelled',
  'exception',
] as const

/**
 * Progress rank. Used ONLY to decide whether a milestone timestamp has been
 * reached — never to reject a transition. `exception` sits above the terminals
 * because it means "we do not know", not "we are finished": a later scan must
 * be able to resolve it in either direction.
 */
const RANK: Record<FulfilmentStatus, number> = {
  pending_manifest: 0,
  manifested: 1,
  picked_up: 2,
  in_transit: 3,
  out_for_delivery: 4,
  ndr: 5,
  rto_in_transit: 6,
  delivered: 7,
  rto_delivered: 7,
  cancelled: 7,
  exception: 8,
}

export function rankOf(status: FulfilmentStatus): number {
  return RANK[status]
}

/**
 * A shipment that has reached the end of its life. `exception` is NOT here:
 * an unknown scan must keep being reconciled until it resolves, which is
 * exactly the case where giving up would hide a lost parcel.
 */
const TERMINAL = new Set<FulfilmentStatus>(['delivered', 'rto_delivered', 'cancelled'])

export function isTerminal(status: FulfilmentStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * Delhivery status codes that their NDR action API will accept a
 * `DEFER_DLV` or `RE-ATTEMPT` against (union of both documented lists).
 *
 * The set is defined by **what we can act on**, which is why it is the same
 * set in both directions: a code in here means an ops action exists, and a
 * code not in here means there is nothing to offer the operator.
 */
export const NDR_STATUS_CODES: ReadonlySet<string> = new Set([
  'EOD-3',
  'EOD-6',
  'EOD-11',
  'EOD-15',
  'EOD-16',
  'EOD-43',
  'EOD-69',
  'EOD-74',
  'EOD-86',
  'EOD-104',
  'ST-108',
])

/** Codes the NDR API accepts for a deferred delivery date (narrower than re-attempt). */
export const NDR_DEFER_CODES: ReadonlySet<string> = new Set([
  'EOD-3',
  'EOD-6',
  'EOD-11',
  'EOD-15',
  'EOD-16',
  'EOD-74',
  'ST-108',
])

/**
 * First-mile pickup exception codes — the pickup-attempt analogue of
 * {@link NDR_STATUS_CODES}. A scan carrying one of these is a failed *pickup*
 * attempt (courier came, could not collect), not a failed delivery, so it is
 * kept as a separate family rather than folded into `NDR_STATUS_CODES`: their
 * NDR action API (`DEFER_DLV`/`RE-ATTEMPT`) does not accept these codes, a
 * pickup re-attempt goes through `createPickup` instead.
 *
 * Prefix-matched, not an exhaustive list: Delhivery mints many reason codes
 * under each family and only the family boundary is documented. `FMEOD-103`
 * ("Shipper unavailable") is confirmed live; the prefix match keeps a sibling
 * code from silently vanishing into `manifested`/`exception` the way this one
 * did before this was added.
 */
export function isPickupFailureCode(code: string): boolean {
  return code.startsWith('FMPUR-') || code.startsWith('FMEOD-')
}

/** The three actions Delhivery's asynchronous NDR API exposes. */
export type NdrAct = 'DEFER_DLV' | 'EDIT_DETAILS' | 'RE-ATTEMPT'

export const NDR_ACTS: readonly NdrAct[] = ['DEFER_DLV', 'EDIT_DETAILS', 'RE-ATTEMPT'] as const

export function isNdrAct(value: string): value is NdrAct {
  return (NDR_ACTS as readonly string[]).includes(value)
}

/**
 * One scan, normalised out of whatever shape the carrier used. The webhook and
 * the tracking pull produce different JSON; both are reduced to this before
 * anything in this file looks at them.
 */
export interface CarrierScan {
  /**
   * Delhivery `StatusType`: UD (undelivered/in-flight) · DL (delivered) · RT (return) · LT (lost).
   * "SM" for a Shree Maruti scan, whose `status` is then their `category`.
   */
  statusType: string
  /** Delhivery `Status`: "Manifested" · "In Transit" · "Dispatched" · "Delivered" · "RTO" … */
  status: string
  /** Granular code, e.g. "X-UCI". Carried through for forensics; not mapped. */
  nslCode?: string | undefined
  /** e.g. "EOD-74" — the NDR discriminator. */
  statusCode?: string | undefined
  scanLocation?: string | undefined
  instructions?: string | undefined
  /** The CARRIER's timestamp. The ordering key for everything — never arrival time. */
  scannedAt: Date
}

function norm(value: string | undefined): string {
  // Delhivery's own sample ships a soft hyphen inside "In­ Transit"; strip
  // anything that is not a letter or digit rather than trusting the bytes.
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * `${statusType}:${status}` → canonical, both sides normalised.
 * Sources: Delhivery "Pre-paid and COD shipments" and "Reverse Pickups" status
 * tables, plus the Cancel Order API's documented landing states.
 */
const MAP: Record<string, FulfilmentStatus> = {
  // ── Forward flow (StatusType UD) ──────────────────────────────────────
  'ud:manifested': 'manifested',
  'ud:notpicked': 'manifested', // soft data in, parcel still on our shelf
  'ud:open': 'manifested',
  'ud:scheduled': 'manifested',
  'ud:intransit': 'in_transit',
  'ud:pending': 'in_transit', // at destination DC, not yet out
  'ud:dispatched': 'out_for_delivery', // their word for OFD
  // ── Delivered (DL) ────────────────────────────────────────────────────
  'dl:delivered': 'delivered',
  'dl:rto': 'rto_delivered',
  'dl:dto': 'rto_delivered', // reverse leg completed back to us
  // ── Return leg (RT) ───────────────────────────────────────────────────
  'rt:intransit': 'rto_in_transit',
  'rt:pending': 'rto_in_transit',
  'rt:dispatched': 'rto_in_transit',
  'rt:rto': 'rto_delivered',
  // ── Cancellation. A cancelled PREPAID order lands as "Returned", not
  //    "Cancelled" — documented in their Cancel Order API and a genuine trap.
  'ud:canceled': 'cancelled',
  'ud:cancelled': 'cancelled',
  'ud:returned': 'cancelled',
  'cn:canceled': 'cancelled',
  'cn:cancelled': 'cancelled',
  'cn:returned': 'cancelled',
  // ── Lost / damaged ────────────────────────────────────────────────────
  'lt:lost': 'exception',
  'lt:damaged': 'exception',
  // ── Shree Maruti (`lib/shreeMaruti.ts`, statusType "SM"). Their `category`
  //    field, read off a live tracking payload (2026-10). Only categories seen
  //    live are listed; anything else (an undelivered attempt, a return) lands
  //    on `exception` with their words kept, per property 1 above, until a
  //    real payload shows what it is.
  'sm:orderconfirmed': 'manifested',
  'sm:readyfordispatch': 'manifested',
  'sm:intransit': 'in_transit',
  'sm:outfordelivery': 'out_for_delivery',
  'sm:delivered': 'delivered',
}

export interface MappedScan {
  status: FulfilmentStatus
  /** True when nothing in {@link MAP} matched — the caller must log it. */
  unmapped: boolean
  /** True when the NDR override fired. */
  isNdr: boolean
}

/**
 * The whole mapping decision, in one place.
 *
 * Order matters: the base table runs first, then the NDR override. A scan
 * carrying `EOD-74` is a failed delivery attempt whatever the pair says — and
 * the pair says `Pending`, which would otherwise read as "moving along nicely".
 * The override deliberately does NOT apply to `DL` scans: a delivered parcel
 * that once carried an NDR code is delivered.
 */
export function mapScan(scan: CarrierScan): MappedScan {
  const key = `${norm(scan.statusType)}:${norm(scan.status)}`
  const base = MAP[key]

  const code = (scan.statusCode ?? '').trim().toUpperCase()
  const isDelivered = norm(scan.statusType) === 'dl'
  if (!isDelivered && code !== '' && (NDR_STATUS_CODES.has(code) || isPickupFailureCode(code))) {
    return { status: 'ndr', unmapped: base === undefined, isNdr: true }
  }

  if (base === undefined) {
    // Never guess. `exception` plus the carrier's verbatim words is recoverable;
    // a wrong guess that reads as healthy is not.
    return { status: 'exception', unmapped: true, isNdr: false }
  }
  return { status: base, unmapped: false, isNdr: false }
}

/** Which set-once milestone (if any) this status establishes. */
export type Milestone =
  | 'manifestedAt'
  | 'pickedUpAt'
  | 'outForDeliveryAt'
  | 'deliveredAt'
  | 'rtoAt'
  | 'cancelledAt'

const MILESTONE: Partial<Record<FulfilmentStatus, Milestone>> = {
  manifested: 'manifestedAt',
  // A parcel that is moving has necessarily been collected — Delhivery emits no
  // distinct "picked up" status, so `In Transit` is the pickup evidence.
  in_transit: 'pickedUpAt',
  picked_up: 'pickedUpAt',
  out_for_delivery: 'outForDeliveryAt',
  delivered: 'deliveredAt',
  rto_in_transit: 'rtoAt',
  rto_delivered: 'rtoAt',
  cancelled: 'cancelledAt',
}

export function milestoneFor(status: FulfilmentStatus): Milestone | null {
  return MILESTONE[status] ?? null
}

/**
 * Shopper-facing copy. Kept beside the mapping so a new status cannot be added
 * without deciding what a customer is told about it.
 *
 * `exception` reads as a neutral "we're checking" rather than "lost" — the
 * customer-facing consequence of §4.2's refusal to guess is that we must not
 * alarm someone over a code we simply have not mapped yet.
 */
const LABEL: Record<FulfilmentStatus, string> = {
  pending_manifest: 'Preparing your order',
  manifested: 'Order packed, awaiting pickup',
  picked_up: 'Picked up by courier',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  ndr: 'Delivery attempted — we will try again',
  rto_in_transit: 'Returning to seller',
  delivered: 'Delivered',
  rto_delivered: 'Returned to seller',
  cancelled: 'Cancelled',
  exception: 'Checking with the courier',
}

export function labelFor(status: FulfilmentStatus): string {
  return LABEL[status]
}
