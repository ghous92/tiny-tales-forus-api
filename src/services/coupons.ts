/**
 * Coupon business rules. A `coupons` row is looked up by its UPPERCASE code
 * (the table's primary key); every write/lookup normalizes the caller's
 * string with {@link normalizeCode} first, so "direct15" / " DIRECT15 " /
 * "DIRECT15" all resolve to the same row.
 *
 * Cross-module rule (docs/ARCHITECTURE.md): this module owns the `coupons`
 * table and is the ONLY place that queries it directly. It is NEVER imported
 * by `services/cart.ts` (same rule `services/config.ts` follows) — the ROUTE
 * layer calls {@link getCouponRuleByCode} and hands the cart/payments
 * services a plain `CouponLookup` value (see `resolveCouponRule` in
 * routes/cart.ts and routes/payments.ts).
 *
 * Validation errors this module raises directly (never a raw DB check
 * violation): duplicate code on create, and — because coupon rows are
 * PATCHed one field at a time — the percent 1..90 / flat > 0 rule is
 * re-checked against the EFFECTIVE (merged) discountType/discountValue on
 * every write, not just when both are present in a single payload (the
 * contract-level refinement in contracts/coupon.ts only catches the
 * both-present case; this is the backstop for the rest).
 */

import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm'

import type {
  Coupon,
  CouponCreate,
  CouponUpdate,
  CouponValidateResponse,
  PublicCoupon,
} from '../contracts/coupon.js'
import type { Db } from '../db/client.js'
import { couponRedemptions, coupons, type CouponRow } from '../db/schema.js'
import {
  COUPON_NONE,
  isCouponValidNow,
  resolveCouponDiscount,
  type CouponDiscountType,
  type CouponLookup,
  type CouponRule,
  type CouponUsage,
} from '../lib/coupons.js'
import { notFound, validationFailed } from '../lib/errors.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Sane fallback for `GET /v1/coupons` when `coupons.autoSuggestCount` is absent/malformed. */
export const DEFAULT_AUTO_SUGGEST_COUNT = 3

/** Trim + uppercase — the one normalization every coupon code write/lookup goes through. */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase()
}

function toRule(row: CouponRow): CouponRule {
  return {
    code: row.code,
    label: row.label,
    description: row.description,
    discountType: row.discountType as CouponDiscountType,
    discountValue: row.discountValue,
    minCartInr: row.minCartInr,
    maxDiscountInr: row.maxDiscountInr,
    active: row.active,
    validFrom: row.validFrom,
    validTo: row.validTo,
    usageLimit: row.usageLimit,
    perUserLimit: row.perUserLimit,
    waivesShipping: row.waivesShipping,
  }
}

function toPublicCoupon(row: CouponRow): PublicCoupon {
  return {
    code: row.code,
    label: row.label,
    description: row.description,
    discountType: row.discountType as CouponDiscountType,
    discountValue: row.discountValue,
    minCartInr: row.minCartInr,
    maxDiscountInr: row.maxDiscountInr,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    validTo: row.validTo ? row.validTo.toISOString() : null,
    waivesShipping: row.waivesShipping,
  }
}

function toAdminCoupon(row: CouponRow, redemptionCount: number): Coupon {
  return {
    code: row.code,
    label: row.label,
    description: row.description,
    discountType: row.discountType as CouponDiscountType,
    discountValue: row.discountValue,
    minCartInr: row.minCartInr,
    maxDiscountInr: row.maxDiscountInr,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    validTo: row.validTo ? row.validTo.toISOString() : null,
    active: row.active,
    sortOrder: row.sortOrder,
    usageLimit: row.usageLimit,
    perUserLimit: row.perUserLimit,
    waivesShipping: row.waivesShipping,
    redemptionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** percent 1..90 / flat > 0 — checked against the EFFECTIVE (merged) values on every write. */
function assertPricingValid(discountType: CouponDiscountType, discountValue: number): void {
  if (discountType === 'percent') {
    if (discountValue < 1 || discountValue > 90) {
      throw validationFailed('A percent coupon must have a discountValue between 1 and 90')
    }
  } else if (discountValue <= 0) {
    throw validationFailed('A flat coupon must have a positive discountValue')
  }
}

/** valid_from <= valid_to, when both are set. */
function assertWindowValid(validFrom: Date | null, validTo: Date | null): void {
  if (validFrom && validTo && validFrom.getTime() > validTo.getTime()) {
    throw validationFailed('validFrom must be on or before validTo')
  }
}

// --- Redemption ledger -------------------------------------------------------

/**
 * Live (unrevoked) redemption counts for one code. `userId` absent ⇒ `byUser`
 * is 0 and only the all-shoppers total is meaningful (the public validate and
 * offers-strip paths have no shopper to count against).
 *
 * One round trip, not two: the per-user count is a filtered aggregate over the
 * same scan.
 */
export async function getCouponUsage(
  db: Db,
  code: string,
  userId?: string | undefined
): Promise<CouponUsage> {
  const [row] = await db
    .select({
      total: count(),
      byUser: userId
        ? sql<number>`count(*) filter (where ${couponRedemptions.userId} = ${userId})`.mapWith(
            Number
          )
        : sql<number>`0`.mapWith(Number),
    })
    .from(couponRedemptions)
    .where(and(eq(couponRedemptions.code, code), isNull(couponRedemptions.revokedAt)))
  return { total: row?.total ?? 0, byUser: row?.byUser ?? 0 }
}

/** Live redemption totals for several codes at once — the admin list's count column. */
async function countRedemptionsByCode(db: Db, codes: string[]): Promise<Map<string, number>> {
  if (codes.length === 0) return new Map()
  const rows = await db
    .select({ code: couponRedemptions.code, total: count() })
    .from(couponRedemptions)
    .where(and(inArray(couponRedemptions.code, codes), isNull(couponRedemptions.revokedAt)))
    .groupBy(couponRedemptions.code)
  return new Map(rows.map((r) => [r.code, r.total]))
}

/**
 * Record that a PAID order redeemed a coupon. Called from the `onOrderPaid`
 * hook wired in `routes/payments.ts`, inside the transition's own transaction.
 *
 * Idempotent by primary key: verify, the webhook and the recover sweep can all
 * race on the same capture, and only one of them may burn a slot.
 *
 * The insert runs in a NESTED transaction — a SAVEPOINT, since the caller
 * always passes a live transaction handle — so that a failure rolls back to the
 * savepoint instead of aborting the enclosing `paid` transition. Catching the
 * error in the hook is not sufficient on its own: Postgres aborts the whole
 * transaction on a failed statement, so without the savepoint the hook's catch
 * would swallow the error and the transition would still die on its next
 * statement. The money is already captured by the time this runs.
 */
export async function recordRedemption(
  tx: Tx,
  input: { orderId: string; code: string; userId: string; discountInr: number }
): Promise<void> {
  await tx.transaction(async (t: Tx) => {
    await t
      .insert(couponRedemptions)
      .values({
        orderId: input.orderId,
        code: normalizeCode(input.code),
        userId: input.userId,
        discountInr: input.discountInr,
      })
      .onConflictDoNothing({ target: couponRedemptions.orderId })
  })
}

/**
 * Release the slot a refunded order was holding. The row stays — the ledger
 * must still show the redemption happened — but stops counting against the
 * limits (see the column note on `coupon_redemptions.revoked_at`).
 *
 * A no-op for an order that redeemed nothing, or that was already revoked; the
 * `revoked_at is null` predicate keeps a replayed refund from re-stamping a
 * later timestamp over the original. Savepoint-wrapped for the same reason
 * {@link recordRedemption} is — the refund has already happened upstream.
 */
export async function revokeRedemption(tx: Tx, orderId: string): Promise<void> {
  await tx.transaction(async (t: Tx) => {
    await t
      .update(couponRedemptions)
      .set({ revokedAt: new Date() })
      .where(and(eq(couponRedemptions.orderId, orderId), isNull(couponRedemptions.revokedAt)))
  })
}

// --- Public reads --------------------------------------------------------------

/**
 * GET /v1/coupons — active AND currently time-valid coupons, sorted by
 * `sortOrder` then `code`, capped to `limit` (the route resolves
 * `coupons.autoSuggestCount` and passes it in). `now` is a test seam.
 *
 * A code whose `usageLimit` is spent is dropped from the strip: offering a
 * card that reads `usage_exceeded` the moment it is tapped is worse than
 * showing one card fewer. `perUserLimit` is NOT applied here — this endpoint
 * is public and has no shopper to count against, so a personally-exhausted
 * code still shows and reports `user_limit_exceeded` on the cart.
 */
export async function listPublicCoupons(
  db: Db,
  limit: number = DEFAULT_AUTO_SUGGEST_COUNT,
  now: Date = new Date()
): Promise<PublicCoupon[]> {
  const rows = await db
    .select()
    .from(coupons)
    .where(eq(coupons.active, true))
    .orderBy(asc(coupons.sortOrder), asc(coupons.code))
  const timeValid = rows.filter((row) => isCouponValidNow(row.active, row.validFrom, row.validTo, now))
  // Only limited coupons need counting; the unlimited ones (today, all of them)
  // cost no query at all.
  const limited = timeValid.filter((row) => row.usageLimit !== null)
  const redeemed = await countRedemptionsByCode(db, limited.map((row) => row.code))
  const eligible = timeValid.filter(
    (row) => row.usageLimit === null || (redeemed.get(row.code) ?? 0) < row.usageLimit
  )
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_AUTO_SUGGEST_COUNT
  return eligible.slice(0, cap).map(toPublicCoupon)
}

/**
 * POST /v1/coupons/validate — stateless: uppercases `rawCode`, looks it up,
 * checks active + time-validity + `minCartInr` against the CLIENT-supplied
 * `cartTotalInr`, and returns the computed discount. Never authoritative for
 * a charge (see designDecisions.mobileCartCaveat) — display only.
 */
export async function validateCoupon(
  db: Db,
  rawCode: string,
  cartTotalInr: number,
  now: Date = new Date()
): Promise<CouponValidateResponse> {
  const lookup = await getCouponRuleByCode(db, rawCode)
  const result = resolveCouponDiscount(cartTotalInr, lookup, now)
  return { ...result, subtotalInr: cartTotalInr }
}

/**
 * Resolve a client-supplied code into a {@link CouponLookup} — the plain
 * value `services/cart.ts`'s coupon folding (and payments' order-create)
 * takes. Blank/absent input resolves to {@link COUPON_NONE} (no coupon
 * requested); an unknown code resolves to a lookup whose `rule` is null (so
 * `resolveCouponDiscount` reports `reason: 'invalid'`). Never throws — an
 * unknown/expired/inactive code is a normal, valid lookup result, never a 4xx
 * (see designDecisions.criteriaBrokenBehavior).
 *
 * `userId`, when given, attaches live redemption counts so the usage limits
 * are enforced for this lookup (see `CouponLookup.usage`). Omitting it — the
 * stateless `POST /v1/coupons/validate` path — leaves the limits unenforced
 * rather than guessed at. The count query only runs for a coupon that actually
 * carries a limit.
 */
export async function getCouponRuleByCode(
  db: Db,
  rawCode: string | undefined | null,
  userId?: string | undefined
): Promise<CouponLookup> {
  if (!rawCode || rawCode.trim().length === 0) return COUPON_NONE
  const code = normalizeCode(rawCode)
  const [row] = await db.select().from(coupons).where(eq(coupons.code, code)).limit(1)
  if (!row) return { code, rule: null }
  const rule = toRule(row)
  const limited = rule.usageLimit !== null || rule.perUserLimit !== null
  if (!userId || !limited) return { code, rule }
  return { code, rule, usage: await getCouponUsage(db, code, userId) }
}

// --- Admin reads -----------------------------------------------------------

/** Every coupon, admin view (incl. inactive/expired), ordered `sortOrder` then `code`. */
export async function listAdminCoupons(db: Db): Promise<Coupon[]> {
  const rows = await db.select().from(coupons).orderBy(asc(coupons.sortOrder), asc(coupons.code))
  const redeemed = await countRedemptionsByCode(db, rows.map((row) => row.code))
  return rows.map((row) => toAdminCoupon(row, redeemed.get(row.code) ?? 0))
}

/** One coupon (incl. inactive), 404 if absent. `rawCode` is normalized before lookup. */
export async function getAdminCoupon(db: Db, rawCode: string): Promise<Coupon> {
  const code = normalizeCode(rawCode)
  const [row] = await db.select().from(coupons).where(eq(coupons.code, code)).limit(1)
  if (!row) throw notFound(`Coupon "${code}" not found`)
  const { total } = await getCouponUsage(db, code)
  return toAdminCoupon(row, total)
}

// --- Admin writes ------------------------------------------------------------

/** Create a coupon. Normalizes `code`, rejects a duplicate (422 `validation_failed`). */
export async function createCoupon(
  db: Db,
  input: CouponCreate,
  createdBy: string | undefined
): Promise<Coupon> {
  const code = normalizeCode(input.code)
  const validFrom = input.validFrom ? new Date(input.validFrom) : null
  const validTo = input.validTo ? new Date(input.validTo) : null
  assertPricingValid(input.discountType, input.discountValue)
  assertWindowValid(validFrom, validTo)

  const row = await db.transaction(async (tx: Tx) => {
    const [existing] = await tx
      .select({ code: coupons.code })
      .from(coupons)
      .where(eq(coupons.code, code))
      .limit(1)
    if (existing) throw validationFailed(`Coupon "${code}" already exists`)

    const [created] = await tx
      .insert(coupons)
      .values({
        code,
        label: input.label,
        description: input.description ?? '',
        discountType: input.discountType,
        discountValue: input.discountValue,
        minCartInr: input.minCartInr ?? 0,
        maxDiscountInr: input.maxDiscountInr ?? null,
        validFrom,
        validTo,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        usageLimit: input.usageLimit ?? null,
        perUserLimit: input.perUserLimit ?? null,
        waivesShipping: input.waivesShipping ?? false,
        createdBy: createdBy ?? null,
        updatedBy: createdBy ?? null,
      })
      .returning()
    if (!created) throw new Error('coupon insert returned no row')
    return created
  })
  // A coupon that did not exist a moment ago has no redemptions — no count query.
  return toAdminCoupon(row, 0)
}

/** PUT /v1/admin/coupons/:code — partial patch. `code` is immutable (path only). 404 if absent. */
export async function updateCoupon(
  db: Db,
  rawCode: string,
  input: CouponUpdate,
  updatedBy: string | undefined
): Promise<Coupon> {
  const code = normalizeCode(rawCode)

  const row = await db.transaction(async (tx: Tx) => {
    const [existing] = await tx.select().from(coupons).where(eq(coupons.code, code)).limit(1)
    if (!existing) throw notFound(`Coupon "${code}" not found`)

    // Validate the EFFECTIVE (merged) pricing/window, not just what's in this
    // patch — a lone `discountValue` patch must still be checked against the
    // (unpatched) existing discountType, and vice versa.
    const effectiveDiscountType = input.discountType ?? (existing.discountType as CouponDiscountType)
    const effectiveDiscountValue = input.discountValue ?? existing.discountValue
    assertPricingValid(effectiveDiscountType, effectiveDiscountValue)

    const validFrom =
      input.validFrom !== undefined ? (input.validFrom ? new Date(input.validFrom) : null) : existing.validFrom
    const validTo =
      input.validTo !== undefined ? (input.validTo ? new Date(input.validTo) : null) : existing.validTo
    assertWindowValid(validFrom, validTo)

    const [updated] = await tx
      .update(coupons)
      .set({
        ...(input.label !== undefined && { label: input.label }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.discountType !== undefined && { discountType: input.discountType }),
        ...(input.discountValue !== undefined && { discountValue: input.discountValue }),
        ...(input.minCartInr !== undefined && { minCartInr: input.minCartInr }),
        ...(input.maxDiscountInr !== undefined && { maxDiscountInr: input.maxDiscountInr }),
        ...(input.validFrom !== undefined && { validFrom }),
        ...(input.validTo !== undefined && { validTo }),
        ...(input.active !== undefined && { active: input.active }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        // Nullable on the contract: an explicit null is "make it unlimited",
        // which is why these test `!== undefined` rather than truthiness.
        ...(input.usageLimit !== undefined && { usageLimit: input.usageLimit ?? null }),
        ...(input.perUserLimit !== undefined && { perUserLimit: input.perUserLimit ?? null }),
        ...(input.waivesShipping !== undefined && { waivesShipping: input.waivesShipping }),
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(coupons.code, code))
      .returning()
    if (!updated) throw new Error('coupon update returned no row')
    return updated
  })
  const { total } = await getCouponUsage(db, code)
  return toAdminCoupon(row, total)
}

/**
 * Hard-delete a coupon (204 no matter what a client holding it does next —
 * there is no `cart_coupons` FK, coupon selection is client-held state, so a
 * stale held code simply reads `reason: 'invalid'` on its next lookup). 404
 * if absent.
 *
 * A code that has been REDEEMED cannot be deleted: `coupon_redemptions.code`
 * references this row with no cascade, because the ledger is what a finance
 * question ("what did we actually give away under DIRECT15?") is answered
 * from. The pre-check exists only so the admin sees that sentence instead of
 * a foreign-key violation — deactivating the coupon does everything deleting
 * it would, and keeps the trail.
 */
export async function deleteCoupon(db: Db, rawCode: string): Promise<void> {
  const code = normalizeCode(rawCode)
  const [redemption] = await db
    .select({ orderId: couponRedemptions.orderId })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.code, code))
    .limit(1)
  if (redemption) {
    throw validationFailed(
      `Coupon "${code}" has been redeemed and cannot be deleted — set active to false instead`
    )
  }

  const [deleted] = await db
    .delete(coupons)
    .where(eq(coupons.code, code))
    .returning({ code: coupons.code })
  if (!deleted) throw notFound(`Coupon "${code}" not found`)
}
