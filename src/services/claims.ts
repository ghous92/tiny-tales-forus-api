/**
 * Damage claims (contracts/claims.ts). Owns `damage_claims`; reads the shared
 * `payments` read model to check the order is the caller's, paid, and actually
 * contained the sku. The delivery time comes in from the ROUTE, which asks the
 * fulfilment module (ARCHITECTURE.md rule 2: no cross-module service imports).
 */
import { randomInt } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'

import type { Claim, ClaimAdmin, ClaimAdminUpdate, ClaimCreate } from '../contracts/claims.js'
import type { Db } from '../db/client.js'
import { damageClaims, payments, type DamageClaimRow } from '../db/schema.js'
import { ID_PREFIX } from '../lib/brand.js'
import { conflict, notFound, validationFailed } from '../lib/errors.js'

/** Shopper-facing default when `returns.damageWindowHours` is unset. Owner to confirm. */
export const DEFAULT_DAMAGE_WINDOW_HOURS = 48

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_NUMBER_ATTEMPTS = 5
const CLOSED: ReadonlySet<string> = new Set(['approved_refund', 'approved_replacement', 'rejected'])

function claimNumber(now: Date): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += CHARSET[randomInt(CHARSET.length)]
  return `${ID_PREFIX}-DC-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${suffix}`
}

function toClaim(row: DamageClaimRow): Claim {
  return {
    claimNumber: row.claimNumber,
    orderId: row.orderId,
    sku: row.sku,
    qty: row.qty,
    description: row.description,
    photoKeys: row.photoKeys as string[],
    unboxingVideoUrl: row.unboxingVideoUrl,
    deliveredAt: row.deliveredAt.toISOString(),
    status: row.status as Claim['status'],
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }
}

interface SnapshotLine {
  sku?: unknown
  qty?: unknown
}

/** Postgres unique violation, as surfaced by both node-postgres and PGlite. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

export async function createClaim(
  db: Db,
  userId: string,
  input: ClaimCreate,
  ctx: {
    /** When the order's shipment was delivered, or null if no delivery is recorded. */
    deliveredAt: Date | null
    windowHours: number
    now?: Date
  }
): Promise<Claim> {
  const now = ctx.now ?? new Date()
  const [order] = await db
    .select({ status: payments.status, cartSnapshot: payments.cartSnapshot })
    .from(payments)
    .where(and(eq(payments.orderId, input.orderId), eq(payments.userId, userId)))
    .limit(1)
  // Someone else's order reads as absent, never 403 (do not leak existence).
  if (!order) throw notFound('Order not found')
  if (order.status !== 'paid') {
    throw validationFailed('Damage claims are for delivered, paid orders')
  }

  const lines = ((order.cartSnapshot as { items?: SnapshotLine[] })?.items ?? []).filter(
    (line) => line.sku === input.sku
  )
  const orderedQty = lines.reduce((n, line) => n + (typeof line.qty === 'number' ? line.qty : 0), 0)
  if (orderedQty === 0) throw validationFailed('That piece is not part of this order')
  const qty = input.qty ?? 1
  if (qty > orderedQty) throw validationFailed(`This order has ${orderedQty} of that piece`)

  if (!ctx.deliveredAt) {
    throw validationFailed('You can report damage once the order shows as delivered')
  }
  const deadline = ctx.deliveredAt.getTime() + ctx.windowHours * 3_600_000
  if (now.getTime() > deadline) {
    throw validationFailed(`Damage must be reported within ${ctx.windowHours} hours of delivery`)
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(damageClaims)
        .values({
          claimNumber: claimNumber(now),
          userId,
          orderId: input.orderId,
          sku: input.sku,
          qty,
          description: input.description,
          photoKeys: input.photoKeys,
          unboxingVideoUrl: input.unboxingVideoUrl ?? null,
          deliveredAt: ctx.deliveredAt,
        })
        .returning()
      return toClaim(row!)
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // Either the random number collided (retry) or this line already has a
      // live claim (stop): tell them apart by looking for the live claim.
      const [open] = await db
        .select({ claimNumber: damageClaims.claimNumber })
        .from(damageClaims)
        .where(and(eq(damageClaims.orderId, input.orderId), eq(damageClaims.sku, input.sku)))
        .orderBy(desc(damageClaims.createdAt))
        .limit(1)
      if (open) throw conflict(`A claim for this piece is already open (${open.claimNumber})`)
    }
  }
  throw new Error('could not allocate a unique claim number')
}

export async function listClaims(db: Db, userId: string): Promise<Claim[]> {
  const rows = await db
    .select()
    .from(damageClaims)
    .where(eq(damageClaims.userId, userId))
    .orderBy(desc(damageClaims.createdAt))
  return rows.map(toClaim)
}

export async function getClaim(db: Db, userId: string, claimNumberParam: string): Promise<Claim> {
  const [row] = await db
    .select()
    .from(damageClaims)
    .where(and(eq(damageClaims.claimNumber, claimNumberParam), eq(damageClaims.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Claim not found')
  return toClaim(row)
}

export async function listAllClaims(db: Db): Promise<ClaimAdmin[]> {
  const rows = await db.select().from(damageClaims).orderBy(desc(damageClaims.createdAt))
  return rows.map((row) => ({ ...toClaim(row), userId: row.userId }))
}

/**
 * Move a claim through review. A decided claim (approved or rejected) is
 * final: reopening one would let a refund and a replacement both go out.
 * The refund itself is issued through the existing refund / credit-note path.
 */
export async function updateClaimStatus(
  db: Db,
  claimNumberParam: string,
  input: ClaimAdminUpdate
): Promise<ClaimAdmin> {
  const [current] = await db
    .select()
    .from(damageClaims)
    .where(eq(damageClaims.claimNumber, claimNumberParam))
    .limit(1)
  if (!current) throw notFound('Claim not found')
  if (CLOSED.has(current.status)) throw conflict('This claim has already been decided')

  const decided = CLOSED.has(input.status)
  const [row] = await db
    .update(damageClaims)
    .set({
      status: input.status,
      ...(input.resolutionNote !== undefined && { resolutionNote: input.resolutionNote }),
      updatedAt: new Date(),
      resolvedAt: decided ? new Date() : null,
    })
    .where(eq(damageClaims.id, current.id))
    .returning()
  return { ...toClaim(row!), userId: row!.userId }
}
