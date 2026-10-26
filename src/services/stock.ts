/**
 * The multi-location stock cascade (docs/SPEC-STOCK.md §3).
 *
 * One question, asked per sku: **given where this shopper is, can we get them
 * this item at all?** The answer walks outward — the nearest enabled shop, then
 * the next, then a central hub — and only says "out of stock" once all of those
 * have missed.
 *
 * ## Why a cascade rather than a sum
 *
 * The naive version adds every shelf's count together and calls anything above
 * zero "in stock". That is wrong in a way that only shows up after the sale:
 * a promise made on a total is a promise the nearest shelf cannot keep.
 * PAN India delivery can source a distant shelf; distance ranks origins but
 * no longer excludes them. The cascade answers with a specific origin in
 * mind, so "in stock" always means "in stock somewhere we will actually ship
 * from".
 *
 * ## The precedence ladder, and why `force_in` sits where it does
 *
 * 1. `policy.mode = 'force_out'` → OUT. An operator's kill switch outranks
 *    everything, including full shelves. Recalls and labelling problems are
 *    exactly the case where the shelves are full and must not be sold.
 * 2. `product_variants.in_stock = false` → OUT. The catalog's own flag.
 * 3. `policy.mode = 'force_in'` → IN.
 * 4. Otherwise compute.
 *
 * Steps 2 and 3 are the ordering that matters. `force_in` is deliberately
 * WEAKER than the catalog flag: it exists to cover a shelf we have not
 * finished counting, not to resurrect a discontinued sku. Ranked the other way,
 * a policy row an operator set months ago would keep selling a product the
 * catalog has since retired, and nobody would look at the stock panel to find
 * out why.
 *
 * ## Distance, and what happens without it
 *
 * Ranking is great-circle distance from the shopper's pincode centroid to the
 * node's coordinate, via `lib/shipping.ts`'s `haversineKm` — the same function
 * the shipping tie-break uses, not a second copy of the formula.
 *
 * Either coordinate can be missing. `pincodes.lat` is null for every row
 * `import-pincodes.ts` writes until `backfill-pincode-coords.ts` has run, and a
 * node's coordinate is null until an operator geocodes it. A candidate we
 * cannot measure is UNRANKABLE, and unrankable candidates sort last rather than
 * being dropped: a shop we cannot place is still a shop that has the item, and
 * refusing to sell from it would turn a missing coordinate into a lost order.
 * The legacy radius setting no longer restricts PAN India sales.
 *
 * ## Fail OPEN
 *
 * If this module throws, the caller shows availability rather than hiding it —
 * the opposite of the shipping module's fail-safe-to-OFF. The asymmetry is
 * deliberate: a wrong "in stock" is a message to a customer and, at this order
 * volume, a manual apology. A wrong "out of stock" is the entire catalog going
 * dark on a bad deploy, silently, with every product still on the shelf. The
 * route owns that decision (see `routes/stock.ts`); this module just does not
 * swallow its own errors.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'

import type { StockStatus } from '../contracts/stock.js'
import type { Db } from '../db/client.js'
import {
  pickupNodes,
  pincodes,
  productVariants,
  skuStockPolicy,
  storeStock,
  storeStockAudit,
} from '../db/schema.js'
import { haversineKm } from '../lib/shipping.js'

/**
 * What a sku with no `sku_stock_policy` row runs on.
 *
 * These are STARTING POINTS chosen from the current network's shape, not
 * measured optima, and the admin panel exposes every one of them per sku so an
 * operator can move them without a deploy:
 *
 * - `maxCascadeStores: 3` — with 12 partner shops, walking all of them would
 *   let a Kutch shelf answer a Surat shopper. Three is "the local cluster".
 * - `maxRadiusKm: 150` — legacy admin field, ignored for PAN India availability.
 * - `lowStockAt: 3` — low enough that the badge stays rare and therefore
 *   still means something.
 */
export const STOCK_DEFAULTS = {
  lowStockAt: 3,
  maxCascadeStores: 3,
  maxRadiusKm: 150,
  hubFallback: true,
} as const

/**
 * The delivery range shown alongside "in stock" (SPEC-STOCK.md §1.1b).
 *
 * A PLACEHOLDER, and marked as one. The real computation is courier
 * `slaDaysZoneA`/`slaDaysZoneB` for the winning origin plus the node's
 * `cutoffIst` — every input already exists in the schema, and none of it is
 * wired up yet. Until it is, this is the honest wide band rather than a
 * confident scalar, and the contract carries `{min, max}` so narrowing it later
 * is a service change and not an API break.
 */
export const PLACEHOLDER_ETA_DAYS = { min: 2, max: 4 } as const

export interface EffectivePolicy {
  mode: 'auto' | 'force_in' | 'force_out'
  lowStockAt: number
  maxCascadeStores: number
  maxRadiusKm: number
  hubFallback: boolean
}

/** A shelf holding the sku, joined to the node that owns it. */
export interface StockCandidate {
  nodeId: string
  nodeCode: string
  nodeName: string
  nodeKind: 'warehouse' | 'retail' | 'hub'
  qty: number
  tracked: boolean
  lat: number | null
  lng: number | null
}

/** A candidate with its distance resolved and its fate recorded. */
export interface RankedCandidate extends StockCandidate {
  /** Null = unrankable (a missing coordinate on either side). Sorts last, never dropped. */
  distanceKm: number | null
  chosen: boolean
  rejectedBecause: string | null
}

export interface CascadeResult {
  sku: string
  status: StockStatus
  etaDays: { min: number; max: number } | null
  /** Which rule settled it. Surfaced by the admin explain route, never publicly. */
  decidedBy: string
  /** The winning shelf, or null. Never leaves the server on a public response. */
  origin: StockCandidate | null
  policy: EffectivePolicy
  candidates: RankedCandidate[]
}

/** Everything the cascade needs, loaded once for a whole batch of skus. */
export interface StockContext {
  /** Shopper's coordinate. Null when the pincode has none — disables ranking, not the cascade. */
  destination: { lat: number; lng: number } | null
  /** sku -> the shelves holding it. Absent key = no shelf anywhere. */
  candidatesBySku: Map<string, StockCandidate[]>
  /** sku -> its policy row. Absent key = defaults. */
  policyBySku: Map<string, EffectivePolicy>
  /** skus the catalog has marked `in_stock = false`. */
  variantOutOfStock: Set<string>
}

/** Merge a policy row over the defaults; null limits mean "use the default", never "no limit". */
export function resolvePolicy(
  row: {
    mode: string
    lowStockAt: number | null
    maxCascadeStores: number | null
    maxRadiusKm: number | null
    hubFallback: boolean
  } | null
): EffectivePolicy {
  const mode = row?.mode
  return {
    mode: mode === 'force_in' || mode === 'force_out' ? mode : 'auto',
    lowStockAt: row?.lowStockAt ?? STOCK_DEFAULTS.lowStockAt,
    maxCascadeStores: row?.maxCascadeStores ?? STOCK_DEFAULTS.maxCascadeStores,
    maxRadiusKm: row?.maxRadiusKm ?? STOCK_DEFAULTS.maxRadiusKm,
    hubFallback: row?.hubFallback ?? STOCK_DEFAULTS.hubFallback,
  }
}

/**
 * One round trip per table, for the whole sku batch — not per sku.
 *
 * A cart-sized request is up to 50 skus (`MAX_AVAILABILITY_SKUS`). Per-sku
 * loading would make that 200 queries against an unauthenticated endpoint,
 * which is a denial-of-service surface dressed up as a feature.
 */
export async function loadStockContext(
  db: Db,
  destPincode: string,
  skus: readonly string[]
): Promise<StockContext> {
  const unique = [...new Set(skus)]
  if (unique.length === 0) {
    return {
      destination: null,
      candidatesBySku: new Map(),
      policyBySku: new Map(),
      variantOutOfStock: new Set(),
    }
  }

  const [destRows, shelfRows, policyRows, variantRows] = await Promise.all([
    db
      .select({ lat: pincodes.lat, lng: pincodes.lng })
      .from(pincodes)
      .where(eq(pincodes.pincode, destPincode))
      .limit(1),

    // `stock_enabled` AND `is_active`: the first says an operator trusts this
    // shelf's counts, the second says the node can hand a parcel to a courier.
    // Both must hold — see the column comments in schema.ts for why they are
    // not one flag.
    db
      .select({
        nodeId: storeStock.nodeId,
        nodeCode: pickupNodes.code,
        nodeName: pickupNodes.name,
        nodeKind: pickupNodes.kind,
        qty: storeStock.qty,
        tracked: storeStock.tracked,
        lat: pickupNodes.lat,
        lng: pickupNodes.lng,
        sku: storeStock.sku,
      })
      .from(storeStock)
      .innerJoin(pickupNodes, eq(pickupNodes.id, storeStock.nodeId))
      .where(
        and(
          inArray(storeStock.sku, unique),
          eq(pickupNodes.stockEnabled, true),
          eq(pickupNodes.isActive, true),
          // An untracked shelf is a candidate whatever its qty says — the
          // number is meaningless there, which is the point of `tracked`.
          sql`(${storeStock.qty} > 0 or ${storeStock.tracked} = false)`
        )
      ),

    db.select().from(skuStockPolicy).where(inArray(skuStockPolicy.sku, unique)),

    db
      .select({ sku: productVariants.sku, inStock: productVariants.inStock })
      .from(productVariants)
      .where(inArray(productVariants.sku, unique)),
  ])

  const destRow = destRows[0]
  const destination =
    destRow && destRow.lat !== null && destRow.lng !== null
      ? { lat: destRow.lat, lng: destRow.lng }
      : null

  const candidatesBySku = new Map<string, StockCandidate[]>()
  for (const row of shelfRows) {
    const kind =
      row.nodeKind === 'hub' || row.nodeKind === 'retail' ? row.nodeKind : ('warehouse' as const)
    const list = candidatesBySku.get(row.sku)
    const candidate: StockCandidate = {
      nodeId: row.nodeId,
      nodeCode: row.nodeCode,
      nodeName: row.nodeName,
      nodeKind: kind,
      qty: row.qty,
      tracked: row.tracked,
      lat: row.lat,
      lng: row.lng,
    }
    if (list) list.push(candidate)
    else candidatesBySku.set(row.sku, [candidate])
  }

  const policyBySku = new Map<string, EffectivePolicy>()
  for (const row of policyRows) policyBySku.set(row.sku, resolvePolicy(row))

  // A sku with no `product_variants` row is NOT treated as out of stock here.
  // Absence means "not a catalog variant" — a bad sku in the request, or an
  // item that lives only in `catalog_items` — and the cascade answers that with
  // "no shelves hold it" a step later, which is the same public answer by a
  // route that does not depend on a join succeeding.
  const variantOutOfStock = new Set<string>()
  for (const row of variantRows) if (!row.inStock) variantOutOfStock.add(row.sku)

  return { destination, candidatesBySku, policyBySku, variantOutOfStock }
}

/**
 * Distance from the shopper, or null when either side lacks a coordinate.
 * Null is "unrankable", never "far" and never "zero".
 */
function distanceFor(
  candidate: StockCandidate,
  destination: { lat: number; lng: number } | null
): number | null {
  if (!destination || candidate.lat === null || candidate.lng === null) return null
  return (
    Math.round(haversineKm(destination.lat, destination.lng, candidate.lat, candidate.lng) * 10) /
    10
  )
}

/** In stock, or low? Only a tracked count can claim scarcity. */
function statusFor(candidate: StockCandidate, policy: EffectivePolicy): StockStatus {
  if (candidate.tracked && candidate.qty <= policy.lowStockAt) return 'low_stock'
  return 'in_stock'
}

const OUT_OF_STOCK = (
  sku: string,
  decidedBy: string,
  policy: EffectivePolicy,
  candidates: RankedCandidate[] = []
): CascadeResult => ({
  sku,
  status: 'out_of_stock',
  etaDays: null,
  decidedBy,
  origin: null,
  policy,
  candidates,
})

/**
 * Run the cascade for one sku. Pure — every input comes from `StockContext`,
 * so the whole decision is testable without a database and the admin "explain"
 * view is the same code path the shopper gets, not a reimplementation of it.
 */
export function cascadeForSku(sku: string, context: StockContext): CascadeResult {
  const policy = context.policyBySku.get(sku) ?? resolvePolicy(null)

  // 1. Operator kill switch. Outranks full shelves — that is what it is for.
  if (policy.mode === 'force_out') return OUT_OF_STOCK(sku, 'policy_force_out', policy)

  // 2. The catalog's own flag, ABOVE force_in (see the module header).
  if (context.variantOutOfStock.has(sku)) {
    return OUT_OF_STOCK(sku, 'variant_out_of_stock', policy)
  }

  const shelves = context.candidatesBySku.get(sku) ?? []

  // 3. force_in: sell it even with nothing counted. No origin, so no shelf is
  //    implied and the decrement hook has nothing to take from — deliberate.
  if (policy.mode === 'force_in') {
    return {
      sku,
      status: 'in_stock',
      etaDays: { ...PLACEHOLDER_ETA_DAYS },
      decidedBy: 'policy_force_in',
      origin: null,
      policy,
      candidates: shelves.map((candidate) => ({
        ...candidate,
        distanceKm: distanceFor(candidate, context.destination),
        chosen: false,
        rejectedBecause: 'policy_force_in_bypasses_shelves',
      })),
    }
  }

  if (shelves.length === 0) return OUT_OF_STOCK(sku, 'no_candidates', policy)

  // 4-6. Rank retail shelves nearest-first and walk them.
  //
  // Unrankable candidates (null distance) sort LAST but stay in the list: a
  // shop we cannot place is still a shop that has the item. Ties break on
  // node code so the order is deterministic — an arbitrary but stable winner
  // beats one that changes between two identical requests.
  const retail = shelves.filter((candidate) => candidate.nodeKind !== 'hub')
  const hubs = shelves.filter((candidate) => candidate.nodeKind === 'hub')

  const ranked = retail
    .map((candidate) => ({ candidate, distanceKm: distanceFor(candidate, context.destination) }))
    .sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) {
        return a.candidate.nodeCode.localeCompare(b.candidate.nodeCode)
      }
      if (a.distanceKm === null) return 1
      if (b.distanceKm === null) return -1
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm
      return a.candidate.nodeCode.localeCompare(b.candidate.nodeCode)
    })

  const explained: RankedCandidate[] = []
  let winner: StockCandidate | null = null
  let decidedBy = 'no_candidates'
  let walked = 0

  for (const { candidate, distanceKm } of ranked) {
    if (winner) {
      explained.push({
        ...candidate,
        distanceKm,
        chosen: false,
        rejectedBecause: 'already_matched',
      })
      continue
    }

    // PAN India: distance affects origin ranking, never stock availability.
    if (walked >= policy.maxCascadeStores) {
      explained.push({
        ...candidate,
        distanceKm,
        chosen: false,
        rejectedBecause: `beyond_max_cascade_stores_${policy.maxCascadeStores}`,
      })
      continue
    }

    walked += 1
    winner = candidate
    decidedBy = 'retail_hit'
    explained.push({ ...candidate, distanceKm, chosen: true, rejectedBecause: null })
  }

  // 7. Hub fallback. NOT distance-ranked and NOT subject to
  //    `maxCascadeStores`: a hub is the backstop, and a backstop that can be
  //    filtered out is not one. Lowest node code wins for determinism.
  if (!winner && policy.hubFallback && hubs.length > 0) {
    const [hub] = [...hubs].sort((a, b) => a.nodeCode.localeCompare(b.nodeCode))
    if (hub) {
      winner = hub
      decidedBy = 'hub_fallback'
    }
  }

  for (const hub of hubs) {
    explained.push({
      ...hub,
      distanceKm: distanceFor(hub, context.destination),
      chosen: winner?.nodeId === hub.nodeId,
      rejectedBecause:
        winner?.nodeId === hub.nodeId
          ? null
          : policy.hubFallback
            ? 'retail_already_matched'
            : 'hub_fallback_disabled',
    })
  }

  // 8. Nothing anywhere.
  if (!winner) {
    return OUT_OF_STOCK(
      sku,
      hubs.length > 0 ? 'hub_fallback_disabled' : 'no_candidates',
      policy,
      explained
    )
  }

  return {
    sku,
    status: statusFor(winner, policy),
    etaDays: { ...PLACEHOLDER_ETA_DAYS },
    decidedBy,
    origin: winner,
    policy,
    candidates: explained,
  }
}

/** Batch entry point: load once, cascade per sku. */
export async function checkAvailability(
  db: Db,
  destPincode: string,
  skus: readonly string[]
): Promise<CascadeResult[]> {
  const context = await loadStockContext(db, destPincode, skus)
  return skus.map((sku) => cascadeForSku(sku, context))
}

// --- Writes ------------------------------------------------------------------

export interface StockWrite {
  nodeId: string
  sku: string
  qty: number
  tracked?: boolean | undefined
  reason: 'manual' | 'order_paid' | 'restock' | 'correction' | 'import'
  reference?: string | undefined
  changedBy: string
}

/**
 * Set a shelf's absolute count and write its audit row IN THE SAME
 * TRANSACTION — the invariant borrowed from `app_config`.
 *
 * Absolute, not a delta, so a retried request cannot double-apply. The audit
 * row still records the delta, computed here from the value actually replaced
 * rather than from anything the caller claimed, so the log cannot be made to
 * disagree with the shelf.
 *
 * The caller must supply the transaction. This function never opens one,
 * because its most important caller — the decrement inside `markOrderPaid` —
 * has to share that payment's transaction or the guarantee is worthless.
 */
export async function setStock(
  tx: Db,
  write: StockWrite
): Promise<{ oldQty: number | null; newQty: number }> {
  const [existing] = await tx
    .select({ qty: storeStock.qty, tracked: storeStock.tracked })
    .from(storeStock)
    .where(and(eq(storeStock.nodeId, write.nodeId), eq(storeStock.sku, write.sku)))
    .limit(1)

  const oldQty = existing?.qty ?? null
  const tracked = write.tracked ?? existing?.tracked ?? true

  await tx
    .insert(storeStock)
    .values({
      nodeId: write.nodeId,
      sku: write.sku,
      qty: write.qty,
      tracked,
      updatedBy: write.changedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [storeStock.nodeId, storeStock.sku],
      set: { qty: write.qty, tracked, updatedBy: write.changedBy, updatedAt: new Date() },
    })

  await tx.insert(storeStockAudit).values({
    nodeId: write.nodeId,
    sku: write.sku,
    oldQty,
    newQty: write.qty,
    delta: write.qty - (oldQty ?? 0),
    reason: write.reason,
    reference: write.reference ?? '',
    changedBy: write.changedBy,
  })

  return { oldQty, newQty: write.qty }
}

/**
 * Take `qty` units off a shelf for a paid order, audited, in the caller's
 * transaction.
 *
 * **This can drive a count negative, and that is the correct behaviour.** It
 * runs from `markOrderPaid`, after the money has been captured. Refusing the
 * decrement — a check constraint, a thrown error, a clamp at zero that then
 * fails a later reconciliation — would roll back a transition the payment
 * processor has already made, turning a stock discrepancy into a customer who
 * paid and has no order.
 *
 * So: an oversell writes a negative qty, the audit row records exactly what
 * happened, and the admin panel surfaces it for a human. A negative number on
 * a shelf is a question for the morning. A failed capture is a refund, a
 * support ticket, and a lost customer.
 *
 * Untracked shelves (`tracked = false`) are skipped: there is no count to take
 * from, and inventing one would be worse than leaving it alone.
 */
export async function decrementForOrder(
  tx: Db,
  nodeId: string,
  sku: string,
  qty: number,
  orderId: string
): Promise<{ applied: boolean; newQty: number | null }> {
  const [existing] = await tx
    .select({ qty: storeStock.qty, tracked: storeStock.tracked })
    .from(storeStock)
    .where(and(eq(storeStock.nodeId, nodeId), eq(storeStock.sku, sku)))
    .limit(1)

  if (!existing || !existing.tracked) return { applied: false, newQty: existing?.qty ?? null }

  const newQty = existing.qty - qty
  await tx
    .update(storeStock)
    .set({ qty: newQty, updatedBy: 'order_paid', updatedAt: new Date() })
    .where(and(eq(storeStock.nodeId, nodeId), eq(storeStock.sku, sku)))

  await tx.insert(storeStockAudit).values({
    nodeId,
    sku,
    oldQty: existing.qty,
    newQty,
    delta: -qty,
    reason: 'order_paid',
    reference: orderId,
    changedBy: 'system',
  })

  return { applied: true, newQty }
}
