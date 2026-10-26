/**
 * Admin-side stock operations (docs/SPEC-STOCK.md §5). Business rules for the
 * panel; the HTTP layer is `routes/stockAdmin.ts`.
 *
 * The public cascade lives in `services/stock.ts` and this module reuses its
 * `setStock` rather than writing shelves itself, so there is exactly one code
 * path that can change a count and exactly one that writes the audit row. A
 * second writer is how audit logs end up with holes in them.
 *
 * Everything here is admin-only and says so in its shape: node identity,
 * exact quantities, the full audit trail, and the cascade explainer. That is
 * the deliberate inverse of the public contract, which refuses all of it.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type {
  AdminStockExplain,
  AdminStockPolicy,
  AdminStockRow,
  StockChangeReason,
} from '../contracts/stock.js'
import type { Db } from '../db/client.js'
import {
  catalogItems,
  pickupNodes,
  skuStockPolicy,
  storeStock,
  storeStockAudit,
} from '../db/schema.js'
import { notFound, validationFailed } from '../lib/errors.js'
import {
  cascadeForSku,
  loadStockContext,
  resolvePolicy,
  setStock,
  STOCK_DEFAULTS,
  type StockWrite,
} from './stock.js'

function nodeKindOf(kind: string): 'warehouse' | 'retail' | 'hub' {
  return kind === 'retail' || kind === 'hub' ? kind : 'warehouse'
}

/**
 * Same contract as the node check in {@link upsertStock}: a sku that does not
 * exist must fail as a 404 the operator can read, not as a foreign-key
 * violation in the logs. `store_stock.sku` and `sku_stock_policy.sku` both
 * reference `catalog_items.sku`, so without this the constraint is the only
 * thing catching a typo and it does so unreadably.
 *
 * Deliberately checks existence, not `active`: a discontinued sku still has
 * units on shelves that must be countable and writable down.
 */
async function assertSkuExists(db: Db, sku: string): Promise<void> {
  const [item] = await db
    .select({ sku: catalogItems.sku })
    .from(catalogItems)
    .where(eq(catalogItems.sku, sku))
    .limit(1)
  if (!item) throw notFound(`No catalog item with sku "${sku}"`)
}

/**
 * Every shelf row, optionally filtered to one sku or one node.
 *
 * Joined to the node so the panel can show `stockEnabled` beside the count.
 * Without it an operator reads "40 units at Rajkot" and reasonably concludes
 * the item is buyable there, when a disabled node makes that count inert — the
 * single most likely misreading of this screen, so the flag travels with the
 * number rather than living on a different tab.
 */
export async function listStock(
  db: Db,
  filter: { sku?: string | undefined; nodeId?: string | undefined }
): Promise<{ rows: AdminStockRow[] }> {
  const conditions = []
  if (filter.sku) conditions.push(eq(storeStock.sku, filter.sku))
  if (filter.nodeId) conditions.push(eq(storeStock.nodeId, filter.nodeId))

  const query = db
    .select({
      nodeId: storeStock.nodeId,
      nodeCode: pickupNodes.code,
      nodeName: pickupNodes.name,
      nodeKind: pickupNodes.kind,
      stockEnabled: pickupNodes.stockEnabled,
      sku: storeStock.sku,
      qty: storeStock.qty,
      tracked: storeStock.tracked,
      updatedAt: storeStock.updatedAt,
      updatedBy: storeStock.updatedBy,
    })
    .from(storeStock)
    .innerJoin(pickupNodes, eq(pickupNodes.id, storeStock.nodeId))

  const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query).orderBy(
    storeStock.sku,
    pickupNodes.code
  )

  return {
    rows: rows.map((row) => ({
      nodeId: row.nodeId,
      nodeCode: row.nodeCode,
      nodeName: row.nodeName,
      nodeKind: nodeKindOf(row.nodeKind),
      stockEnabled: row.stockEnabled,
      sku: row.sku,
      qty: row.qty,
      tracked: row.tracked,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    })),
  }
}

/**
 * Set one shelf's absolute count, audited, in a transaction.
 *
 * The node is checked to exist first so a typo'd id fails as a 400 the operator
 * can read, rather than as a foreign-key violation in the logs.
 */
export async function upsertStock(
  db: Db,
  nodeId: string,
  sku: string,
  input: {
    qty: number
    tracked?: boolean | undefined
    reason: 'manual' | 'restock' | 'correction' | 'import'
    reference?: string | undefined
  },
  changedBy: string
): Promise<AdminStockRow> {
  const [node] = await db
    .select({ id: pickupNodes.id })
    .from(pickupNodes)
    .where(eq(pickupNodes.id, nodeId))
    .limit(1)
  if (!node) throw notFound(`No pickup node with id "${nodeId}"`)
  await assertSkuExists(db, sku)

  const write: StockWrite = {
    nodeId,
    sku,
    qty: input.qty,
    tracked: input.tracked,
    reason: input.reason,
    reference: input.reference,
    changedBy,
  }

  await db.transaction(async (tx) => {
    await setStock(tx as unknown as Db, write)
  })

  const { rows } = await listStock(db, { nodeId, sku })
  const row = rows[0]
  if (!row)
    throw validationFailed(`Stock row for "${sku}" at node "${nodeId}" vanished after write`)
  return row
}

/** Delete a shelf row entirely — "this shop no longer carries this sku at all". */
export async function deleteStock(
  db: Db,
  nodeId: string,
  sku: string,
  changedBy: string
): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ qty: storeStock.qty })
      .from(storeStock)
      .where(and(eq(storeStock.nodeId, nodeId), eq(storeStock.sku, sku)))
      .limit(1)
    if (!existing) return { deleted: false }

    await tx.delete(storeStock).where(and(eq(storeStock.nodeId, nodeId), eq(storeStock.sku, sku)))

    // Audited as a correction to zero. Deleting the row without a trace would
    // make units disappear from the ledger with nothing to reconcile against —
    // and on consignment stock, "where did 40 units go" is a conversation with
    // a retailer that needs a record behind it.
    await tx.insert(storeStockAudit).values({
      nodeId,
      sku,
      oldQty: existing.qty,
      newQty: 0,
      delta: -existing.qty,
      reason: 'correction',
      reference: 'shelf row deleted',
      changedBy,
    })

    return { deleted: true }
  })
}

/** Every policy row, plus the defaults an unlisted sku runs on. */
export async function listPolicies(db: Db): Promise<{
  policies: AdminStockPolicy[]
  defaults: { lowStockAt: number; maxCascadeStores: number; maxRadiusKm: number }
}> {
  const rows = await db.select().from(skuStockPolicy).orderBy(skuStockPolicy.sku)
  return {
    policies: rows.map((row) => ({
      sku: row.sku,
      mode: row.mode === 'force_in' || row.mode === 'force_out' ? row.mode : ('auto' as const),
      lowStockAt: row.lowStockAt,
      maxCascadeStores: row.maxCascadeStores,
      maxRadiusKm: row.maxRadiusKm,
      hubFallback: row.hubFallback,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    })),
    defaults: {
      lowStockAt: STOCK_DEFAULTS.lowStockAt,
      maxCascadeStores: STOCK_DEFAULTS.maxCascadeStores,
      maxRadiusKm: STOCK_DEFAULTS.maxRadiusKm,
    },
  }
}

/**
 * Create or replace a sku's policy.
 *
 * A full replace, not a patch: an operator setting `force_out` for a recall
 * must not have a limit left over from a previous edit silently still applying.
 * Omitted limits become null, which resolves to the service default — "clear
 * the field" means "back to normal", never "no limit at all".
 */
export async function upsertPolicy(
  db: Db,
  sku: string,
  input: {
    mode: 'auto' | 'force_in' | 'force_out'
    lowStockAt?: number | null | undefined
    maxCascadeStores?: number | null | undefined
    maxRadiusKm?: number | null | undefined
    hubFallback?: boolean | undefined
    note?: string | undefined
  },
  changedBy: string
): Promise<AdminStockPolicy> {
  await assertSkuExists(db, sku)

  const values = {
    sku,
    mode: input.mode,
    lowStockAt: input.lowStockAt ?? null,
    maxCascadeStores: input.maxCascadeStores ?? null,
    maxRadiusKm: input.maxRadiusKm ?? null,
    hubFallback: input.hubFallback ?? true,
    note: input.note ?? '',
    updatedBy: changedBy,
    updatedAt: new Date(),
  }

  const [row] = await db
    .insert(skuStockPolicy)
    .values(values)
    .onConflictDoUpdate({ target: skuStockPolicy.sku, set: values })
    .returning()

  if (!row) throw validationFailed(`Failed to save policy for "${sku}"`)

  return {
    sku: row.sku,
    mode: row.mode === 'force_in' || row.mode === 'force_out' ? row.mode : 'auto',
    lowStockAt: row.lowStockAt,
    maxCascadeStores: row.maxCascadeStores,
    maxRadiusKm: row.maxRadiusKm,
    hubFallback: row.hubFallback,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  }
}

/** Drop a policy row — the sku goes back to `auto` on service defaults. */
export async function deletePolicy(db: Db, sku: string): Promise<{ deleted: boolean }> {
  const deleted = await db
    .delete(skuStockPolicy)
    .where(eq(skuStockPolicy.sku, sku))
    .returning({ sku: skuStockPolicy.sku })
  return { deleted: deleted.length > 0 }
}

export interface AuditEntry {
  id: string
  nodeId: string
  sku: string
  oldQty: number | null
  newQty: number
  delta: number
  reason: StockChangeReason
  reference: string
  changedBy: string
  changedAt: string
}

/** Recent audit entries, newest first, optionally filtered. */
export async function listAudit(
  db: Db,
  filter: { sku?: string | undefined; nodeId?: string | undefined; limit?: number | undefined }
): Promise<{ entries: AuditEntry[] }> {
  const conditions = []
  if (filter.sku) conditions.push(eq(storeStockAudit.sku, filter.sku))
  if (filter.nodeId) conditions.push(eq(storeStockAudit.nodeId, filter.nodeId))

  const query = db.select().from(storeStockAudit)
  const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(storeStockAudit.changedAt))
    .limit(filter.limit ?? 50)

  return {
    entries: rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      sku: row.sku,
      oldQty: row.oldQty,
      newQty: row.newQty,
      delta: row.delta,
      reason: row.reason as StockChangeReason,
      reference: row.reference,
      changedBy: row.changedBy,
      changedAt: row.changedAt.toISOString(),
    })),
  }
}

/**
 * Replay the cascade for one (sku, pincode) and show every step.
 *
 * The panel's most valuable screen, and the reason it exists is worth stating:
 * the cascade picks one shop out of many by a rule the operator cannot see. An
 * operator looking at "Out of Stock" for a sku that is sitting on three shelves
 * otherwise has no way to distinguish a `force_out` policy from a node with
 * `stock_enabled = false` from a pincode with no coordinate. Each of those is a
 * different fix and they are indistinguishable from the outside.
 *
 * It calls `cascadeForSku` — the SAME function the shopper's request runs — so
 * the explanation cannot drift from the behaviour. An explainer that
 * reimplements the rule eventually explains a rule the system no longer
 * follows, which is worse than having no explainer at all.
 */
export async function explainCascade(
  db: Db,
  sku: string,
  pincode: string
): Promise<AdminStockExplain> {
  const context = await loadStockContext(db, pincode, [sku])
  const result = cascadeForSku(sku, context)

  return {
    sku: result.sku,
    pincode,
    status: result.status,
    etaDays: result.etaDays,
    decidedBy: result.decidedBy,
    destinationCoords: context.destination,
    effectivePolicy: {
      mode: result.policy.mode,
      lowStockAt: result.policy.lowStockAt,
      maxCascadeStores: result.policy.maxCascadeStores,
      maxRadiusKm: result.policy.maxRadiusKm,
      hubFallback: result.policy.hubFallback,
    },
    candidates: result.candidates.map((candidate) => ({
      nodeId: candidate.nodeId,
      nodeCode: candidate.nodeCode,
      nodeName: candidate.nodeName,
      nodeKind: candidate.nodeKind,
      qty: candidate.qty,
      tracked: candidate.tracked,
      distanceKm: candidate.distanceKm,
      chosen: candidate.chosen,
      rejectedBecause: candidate.rejectedBecause,
    })),
  }
}

/**
 * Shelves whose count has gone NEGATIVE — an oversell that
 * `decrementForOrder` deliberately allowed rather than failing a captured
 * payment (SPEC-STOCK.md §9). Every one of these is a real order that shipped
 * against stock we did not have, so the panel surfaces them as work rather than
 * leaving them for someone to notice.
 */
export async function listOversells(db: Db): Promise<{ rows: AdminStockRow[] }> {
  const rows = await db
    .select({
      nodeId: storeStock.nodeId,
      nodeCode: pickupNodes.code,
      nodeName: pickupNodes.name,
      nodeKind: pickupNodes.kind,
      stockEnabled: pickupNodes.stockEnabled,
      sku: storeStock.sku,
      qty: storeStock.qty,
      tracked: storeStock.tracked,
      updatedAt: storeStock.updatedAt,
      updatedBy: storeStock.updatedBy,
    })
    .from(storeStock)
    .innerJoin(pickupNodes, eq(pickupNodes.id, storeStock.nodeId))
    .where(sql`${storeStock.qty} < 0`)
    .orderBy(storeStock.qty)

  return {
    rows: rows.map((row) => ({
      nodeId: row.nodeId,
      nodeCode: row.nodeCode,
      nodeName: row.nodeName,
      nodeKind: nodeKindOf(row.nodeKind),
      stockEnabled: row.stockEnabled,
      sku: row.sku,
      qty: row.qty,
      tracked: row.tracked,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    })),
  }
}

/**
 * The nodes an operator may assign stock to, with their flags. Feeds the
 * panel's node picker — `stock_enabled` is shown there because assigning a
 * count to a disabled node is legal but inert, and the operator should see that
 * before they type a number rather than after.
 */
export async function listStockNodes(db: Db): Promise<{
  nodes: Array<{
    id: string
    code: string
    name: string
    kind: 'warehouse' | 'retail' | 'hub'
    stockEnabled: boolean
    isActive: boolean
    hasCoords: boolean
    city: string
    pincode: string
  }>
}> {
  const rows = await db
    .select({
      id: pickupNodes.id,
      code: pickupNodes.code,
      name: pickupNodes.name,
      kind: pickupNodes.kind,
      stockEnabled: pickupNodes.stockEnabled,
      isActive: pickupNodes.isActive,
      lat: pickupNodes.lat,
      lng: pickupNodes.lng,
      city: pickupNodes.city,
      pincode: pickupNodes.pincode,
    })
    .from(pickupNodes)
    .orderBy(pickupNodes.code)

  return {
    nodes: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      kind: nodeKindOf(row.kind),
      stockEnabled: row.stockEnabled,
      isActive: row.isActive,
      // Surfaced because a node without coordinates is UNRANKABLE: it can only
      // ever win the cascade after every placeable shop has missed.
      hasCoords: row.lat !== null && row.lng !== null,
      city: row.city,
      pincode: row.pincode,
    })),
  }
}

/**
 * Flip a node's cascade participation. Separate from the shipping admin's node
 * editor on purpose: `stock_enabled` answers "may we sell from this shelf?"
 * while `is_active` answers "may a courier collect here?", and the panel that
 * owns stock should own the first without being able to touch the second.
 */
export async function setNodeStockEnabled(
  db: Db,
  nodeId: string,
  enabled: boolean
): Promise<{ id: string; stockEnabled: boolean }> {
  const [row] = await db
    .update(pickupNodes)
    .set({ stockEnabled: enabled, updatedAt: new Date() })
    .where(eq(pickupNodes.id, nodeId))
    .returning({ id: pickupNodes.id, stockEnabled: pickupNodes.stockEnabled })

  if (!row) throw notFound(`No pickup node with id "${nodeId}"`)
  return row
}

/** Every sku that has at least one shelf row — the panel's sku list. */
export async function listStockedSkus(db: Db): Promise<{ skus: string[] }> {
  const rows = await db
    .selectDistinct({ sku: storeStock.sku })
    .from(storeStock)
    .orderBy(storeStock.sku)
  return { skus: rows.map((row) => row.sku) }
}

/** Resolve the effective policy for a sku without touching the cascade. */
export async function effectivePolicyFor(
  db: Db,
  sku: string
): Promise<ReturnType<typeof resolvePolicy>> {
  const [row] = await db
    .select()
    .from(skuStockPolicy)
    .where(inArray(skuStockPolicy.sku, [sku]))
    .limit(1)
  return resolvePolicy(row ?? null)
}
