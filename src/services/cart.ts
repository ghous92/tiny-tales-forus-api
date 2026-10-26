/**
 * Cart business rules (SPEC-V2.md §4). Routes hand this module validated
 * input plus the caller's user id; it owns every invariant the API promises:
 *
 * - PUT is an idempotent SET of qty, not an increment.
 * - Unknown sku -> 404 `not_found`; inactive sku -> 422 `validation_failed`.
 * - New line past {@link MAX_LINES} -> 422 `limit_exceeded`; existing lines
 *   are never evicted to make room.
 * - Every line write refreshes `price_inr_snapshot` from the live catalog
 *   price (the snapshot is an audit/orders record; display always uses the
 *   live catalog price, joined at read time).
 * - `updated_at` is bumped via `now()` on every line write.
 * - Merge (login-time absorption of a guest cart): per item, unknown/inactive
 *   skus are skipped (reported); `qty = max(existing, incoming)` clamped to
 *   {@link MAX_QTY_PER_LINE} (so re-merging the same payload is a no-op);
 *   lines that would push the cart past {@link MAX_LINES} are skipped
 *   (reported) and existing lines are always kept; the whole merge runs in a
 *   single transaction; `skipped` in the response lists skus in payload
 *   order, deduped.
 *
 * - Wholesale: a cart whose RETAIL subtotal reaches the rule's threshold is
 *   billed at wholesale rates — every active line's `priceInr` becomes the
 *   wholesale price, so `totalInr` (Σ qty × priceInr) is always the amount due
 *   and the client never re-derives a discount. It is a property of the CART,
 *   not the user: fall below the threshold and retail pricing returns.
 *
 * - Coupon: an ORDER-LEVEL discount computed on `couponSubtotalInr` — the
 *   post-wholesale, post-seasonal Σ(qty × priceInr) over active lines, i.e.
 *   what `totalInr` used to be before coupons existed. Unlike wholesale, a
 *   coupon is a CODE THE CLIENT HOLDS (never a server-side cart_coupons row):
 *   the ROUTE resolves it fresh on every request into a {@link CouponLookup}
 *   and passes it in, defaulting to {@link COUPON_NONE}. Line prices are
 *   NEVER touched by a coupon — it is an explicit subtraction from the
 *   subtotal, so the wholesale per-line invariant
 *   Σ(qty × priceInr) === coupon.subtotalInr still holds exactly, and the new
 *   invariant `totalInr === coupon.subtotalInr − coupon.discountInr` holds
 *   (discountInr = 0, so totalInr === subtotalInr, when no coupon applies —
 *   fully backward compatible).
 *
 * - Shipping: a DELIVERY FEE added AFTER the coupon discount, so the full
 *   identity becomes `totalInr === coupon.subtotalInr − coupon.discountInr +
 *   shipping.feeInr`. It is the one component that is not part of
 *   `coupon.subtotalInr` (you do not discount freight), and it is 0 whenever
 *   shipping is switched off — which is why enabling this module changed no
 *   existing total. Like wholesale, the fee is a property of the CART plus a
 *   DESTINATION: the route resolves both the rule and the rate data and passes
 *   them in as plain values.
 *
 * Cross-module rule (docs/ARCHITECTURE.md): cart consumes `services/catalog.ts`
 * (the shared read model) and its own table only — it never touches
 * `app_config` or another module's service (including `services/coupons.ts`).
 * The wholesale knobs live in config and the coupon code is client-supplied,
 * so the ROUTE layer resolves both and passes plain values in; this module
 * takes them as-is and never imports the config or coupons service. Shipping
 * follows the same shape: `lib/shipping.ts` is pure math (fair game, exactly
 * like `lib/pricing.ts`), and everything that needs a query or a secret is
 * resolved by the route into a {@link CartShippingResolver}.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'

import type {
  Cart,
  CartLine,
  CartMergeItem,
  CartCod,
  CartMergeResponse,
  CartShipping,
} from '../contracts/cart.js'
import { COD_NONE, MAX_LINES, MAX_QTY_PER_LINE, SHIPPING_NONE } from '../contracts/cart.js'
import type { Db } from '../db/client.js'
import { cartItems, type CartItemRow } from '../db/schema.js'
import { COUPON_NONE, resolveCouponDiscount, type CouponLookup } from '../lib/coupons.js'
import { limitExceeded, notFound, validationFailed } from '../lib/errors.js'
import {
  qualifiesForWholesale,
  wholesalePriceInr,
  WHOLESALE_OFF,
  type WholesaleRule,
} from '../lib/pricing.js'
import type { ShippingLine } from '../lib/shipping.js'
import { getItemBySku, getItemsBySkus, type CatalogItem } from './catalog.js'

/** Epoch ISO string — the `updatedAt` an empty cart reports (mirrors the config snapshot convention). */
const EPOCH = new Date(0).toISOString()

/**
 * How this module asks for a delivery quote without importing the shipping
 * service. The ROUTE binds the already-loaded rule + rate data + signing key
 * into one function; this module hands it the priced cart's shippable lines
 * and the two subtotals the free-delivery threshold can be measured against.
 *
 * Defaulting to "no resolver" is what keeps every existing caller — and every
 * test written before shipping existed — returning byte-identical totals.
 */
export type CartShippingResolver = (input: {
  lines: ShippingLine[]
  preCouponInr: number
  postCouponInr: number
  /** The applied coupon waives delivery outright (`coupons.waives_shipping`). */
  couponWaivesShipping: boolean
  cartUpdatedAt: string
}) => CartShipping

/**
 * How this module asks whether the cart may be paid cash on delivery, without
 * importing the COD service. Same shape and same reason as
 * {@link CartShippingResolver}: the ROUTE loads the config, the destination and
 * the month's COD count, and binds them into one plain function.
 *
 * It takes `totalInr` because eligibility is decided on the amount the shopper
 * would actually owe — after wholesale, after the coupon, INCLUDING delivery —
 * which is the last number this file computes and the only one the cap and the
 * ceiling should be measured against.
 *
 * Defaulting to "no resolver" keeps every caller written before COD existed
 * returning {@link COD_NONE}, which is exactly "cash orders are off".
 */
export type CartCodResolver = (input: { totalInr: number }) => CartCod

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Join a cart row with its live catalog row into the API line shape. */
function toCartLine(row: CartItemRow, catalogItem: CatalogItem): CartLine {
  return {
    sku: row.sku,
    productId: catalogItem.productId,
    name: catalogItem.name,
    size: catalogItem.size,
    qty: row.qty,
    priceInr: catalogItem.priceInr,
    imageUrl: catalogItem.imageUrl,
    active: catalogItem.active,
  }
}

/**
 * Assemble the API `Cart` from raw line rows plus their live catalog join.
 * `count` sums ACTIVE lines; `updatedAt` is the max line `updatedAt` (epoch
 * ISO when there are no lines at all — including when every line is
 * inactive-and-thus-excluded, the cart can still be non-empty). Items are
 * sorted newest-first by `createdAt`.
 *
 * Three stages, each pricing on the output of the last: first total the
 * ACTIVE lines at retail, then — if that subtotal qualifies — rebuild every
 * active line at its wholesale price (`couponSubtotalInr`), then fold in an
 * order-level coupon discount on TOP of that subtotal (line prices are
 * unchanged by the coupon). Inactive lines are excluded from every subtotal
 * and are never re-priced (they cannot be bought). Rounding is per line for
 * wholesale and a single `Math.round` for the coupon (see lib/coupons.ts), so
 * `coupon.subtotalInr === Σ(qty × priceInr)` holds exactly and
 * `totalInr === coupon.subtotalInr − coupon.discountInr`.
 */
function toCart(
  rows: CartItemRow[],
  catalogItems: CatalogItem[],
  rule: WholesaleRule,
  coupon: CouponLookup = COUPON_NONE,
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Cart {
  const bySku = new Map(catalogItems.map((item) => [item.sku, item]))

  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const retailLines: CartLine[] = []
  let count = 0
  let retailTotalInr = 0
  let maxUpdatedAt: Date | undefined

  for (const row of sorted) {
    const catalogItem = bySku.get(row.sku)
    // FK guarantees the catalog row exists (catalog-sync only deactivates, never deletes).
    if (!catalogItem) continue
    const line = toCartLine(row, catalogItem)
    retailLines.push(line)
    if (line.active) {
      count += line.qty
      retailTotalInr += line.qty * line.priceInr
    }
    if (!maxUpdatedAt || row.updatedAt > maxUpdatedAt) maxUpdatedAt = row.updatedAt
  }

  const applied = qualifiesForWholesale(retailTotalInr, rule)

  // Re-price active lines at wholesale when the cart qualifies; the line price
  // on the wire is always the price actually charged for that line.
  const items = applied
    ? retailLines.map((line) =>
        line.active ? { ...line, priceInr: wholesalePriceInr(line.priceInr, rule) } : line
      )
    : retailLines

  // The post-wholesale, post-seasonal subtotal — what totalInr used to be
  // before coupons existed, and what a coupon's min-cart / percent math is
  // computed against.
  const couponSubtotalInr = applied
    ? items.reduce((sum, line) => (line.active ? sum + line.qty * line.priceInr : sum), 0)
    : retailTotalInr

  const couponResult = resolveCouponDiscount(couponSubtotalInr, coupon)
  const postCouponInr = couponSubtotalInr - couponResult.discountInr
  const updatedAt = maxUpdatedAt ? maxUpdatedAt.toISOString() : EPOCH

  // Only ACTIVE lines ship: an inactive sku is excluded from every subtotal, so
  // it must not add weight to a parcel that will never contain it.
  const shipping = resolveShipping
    ? resolveShipping({
        lines: items
          .filter((line) => line.active)
          .map((line) => {
            const item = bySku.get(line.sku)
            return {
              sku: line.sku,
              qty: line.qty,
              weightG: item?.weightG ?? 0,
              lengthCm: item?.lengthCm ?? 0,
              widthCm: item?.widthCm ?? 0,
              heightCm: item?.heightCm ?? 0,
            }
          }),
        preCouponInr: couponSubtotalInr,
        postCouponInr,
        // Read off the PRICING RESULT, not the rule: `resolveCouponDiscount`
        // has already gated it on the coupon actually applying, so a code that
        // is expired, exhausted or below its minimum waives nothing here.
        couponWaivesShipping: couponResult.waivesShipping,
        cartUpdatedAt: updatedAt,
      })
    : SHIPPING_NONE

  // Delivery is added AFTER the discount — freight is not discountable.
  const totalInr = postCouponInr + shipping.feeInr

  // Decided on the FINAL total, which is why it is resolved here rather than
  // alongside `shipping` above: the COD ceiling and the token both apply to
  // what the shopper actually owes, delivery included.
  const cod = resolveCod ? resolveCod({ totalInr }) : COD_NONE

  return {
    items,
    count,
    totalInr,
    wholesale: {
      applied,
      enabled: rule.enabled,
      thresholdInr: rule.thresholdInr,
      discountPct: rule.discountPct,
      retailTotalInr,
      remainingInr: applied || !rule.enabled ? 0 : Math.max(0, rule.thresholdInr - retailTotalInr),
      savedInr: applied ? retailTotalInr - couponSubtotalInr : 0,
    },
    coupon: { ...couponResult, subtotalInr: couponSubtotalInr },
    shipping,
    cod,
    updatedAt,
  }
}

/**
 * Load every line for a user plus the catalog rows needed to render them.
 * `skus`, when given, restricts the priced cart to just those lines (order
 * count/total/wholesale qualification/coupon subtotal only over the subset)
 * — the rest of the user's lines still exist in `cart_items`, just excluded
 * from this view.
 */
async function loadCart(
  db: Db | Tx,
  userId: string,
  rule: WholesaleRule,
  coupon: CouponLookup = COUPON_NONE,
  skus?: string[],
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Promise<Cart> {
  const allRows = await db.select().from(cartItems).where(eq(cartItems.userId, userId))
  const rows = skus ? allRows.filter((row) => skus.includes(row.sku)) : allRows
  const catalog = await getItemsBySkus(
    db as Db,
    rows.map((row) => row.sku)
  )
  return toCart(rows, catalog, rule, coupon, resolveShipping, resolveCod)
}

/**
 * GET /v1/cart — the caller's full cart. `rule` carries the wholesale knobs the
 * route resolved from config; it defaults to off so a caller that doesn't care
 * about wholesale (and every existing test) gets plain retail pricing. `skus`
 * restricts the priced view to a subset of lines (payments order-create uses
 * this for a cart-screen selection; every other caller omits it). `coupon` is
 * the route-resolved {@link CouponLookup} for a client-supplied code
 * (`?coupon=CODE` / order-create's `couponCode`); it defaults to
 * {@link COUPON_NONE} so every other caller gets a cart with no coupon
 * requested.
 */
export async function getCart(
  db: Db,
  userId: string,
  rule: WholesaleRule = WHOLESALE_OFF,
  skus?: string[],
  coupon: CouponLookup = COUPON_NONE,
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Promise<Cart> {
  return loadCart(db, userId, rule, coupon, skus, resolveShipping, resolveCod)
}

/**
 * PUT /v1/cart/items/:sku — idempotent SET of qty (not an increment). Unknown
 * sku -> 404; inactive sku -> 422 `validation_failed`; a brand-new line past
 * {@link MAX_LINES} -> 422 `limit_exceeded`. Refreshes `price_inr_snapshot`
 * from the live catalog price on every write.
 */
export async function putCartLine(
  db: Db,
  userId: string,
  sku: string,
  qty: number,
  rule: WholesaleRule = WHOLESALE_OFF,
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Promise<Cart> {
  await db.transaction(async (tx: Tx) => {
    const catalogItem = await getItemBySku(tx as Db, sku)
    if (!catalogItem) throw notFound(`Sku "${sku}" not found`)
    if (!catalogItem.active) throw validationFailed('This item is no longer available')

    const [existing] = await tx
      .select({ sku: cartItems.sku })
      .from(cartItems)
      .where(and(eq(cartItems.userId, userId), eq(cartItems.sku, sku)))
      .limit(1)

    if (!existing) {
      const [counted] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(cartItems)
        .where(eq(cartItems.userId, userId))
      const lineCount = counted?.value ?? 0
      if (lineCount >= MAX_LINES) {
        throw limitExceeded(`Cart line limit reached (max ${MAX_LINES} lines)`)
      }
    }

    await tx
      .insert(cartItems)
      .values({ userId, sku, qty, priceInrSnapshot: catalogItem.priceInr })
      .onConflictDoUpdate({
        target: [cartItems.userId, cartItems.sku],
        set: { qty, priceInrSnapshot: catalogItem.priceInr, updatedAt: sql`now()` },
      })
  })
  return loadCart(db, userId, rule, COUPON_NONE, undefined, resolveShipping, resolveCod)
}

/** DELETE /v1/cart/items/:sku — remove one line; missing line -> 404. */
export async function deleteCartLine(
  db: Db,
  userId: string,
  sku: string,
  rule: WholesaleRule = WHOLESALE_OFF,
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Promise<Cart> {
  const [deleted] = await db
    .delete(cartItems)
    .where(and(eq(cartItems.userId, userId), eq(cartItems.sku, sku)))
    .returning({ sku: cartItems.sku })
  if (!deleted) throw notFound(`Cart line "${sku}" not found`)
  return loadCart(db, userId, rule, COUPON_NONE, undefined, resolveShipping, resolveCod)
}

/** DELETE /v1/cart — clear every line for the user. */
export async function clearCart(db: Db, userId: string): Promise<void> {
  await db.delete(cartItems).where(eq(cartItems.userId, userId))
}

/**
 * POST /v1/cart/merge — login-time absorption of the caller's local (guest)
 * cart. Per item: unknown/inactive sku is skipped (reported); otherwise
 * `qty = max(existing, incoming)` clamped to {@link MAX_QTY_PER_LINE} — so
 * merging the same payload twice is a no-op. Lines that would push the cart
 * past {@link MAX_LINES} are skipped (reported); existing lines are always
 * kept (never evicted to make room for a merge). Runs as a single
 * transaction. `skipped` lists skus in payload order, deduped.
 */
export async function mergeCart(
  db: Db,
  userId: string,
  items: CartMergeItem[],
  rule: WholesaleRule = WHOLESALE_OFF,
  resolveShipping?: CartShippingResolver,
  resolveCod?: CartCodResolver
): Promise<CartMergeResponse> {
  const cart = await db.transaction(async (tx: Tx) => {
    const skus = items.map((item) => item.sku)
    const catalog = await getItemsBySkus(tx as Db, skus)
    const catalogBySku = new Map(catalog.map((item) => [item.sku, item]))

    const existingRows = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.userId, userId), inArray(cartItems.sku, skus)))
    const existingBySku = new Map(existingRows.map((row) => [row.sku, row]))

    const [counted] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(cartItems)
      .where(eq(cartItems.userId, userId))
    let lineCount = counted?.value ?? 0

    const skippedSet = new Set<string>()
    for (const item of items) {
      const catalogItem = catalogBySku.get(item.sku)
      if (!catalogItem || !catalogItem.active) {
        skippedSet.add(item.sku)
        continue
      }

      const existing = existingBySku.get(item.sku)
      if (!existing && lineCount >= MAX_LINES) {
        skippedSet.add(item.sku)
        continue
      }

      const qty = Math.min(Math.max(existing?.qty ?? 0, item.qty), MAX_QTY_PER_LINE)

      await tx
        .insert(cartItems)
        .values({ userId, sku: item.sku, qty, priceInrSnapshot: catalogItem.priceInr })
        .onConflictDoUpdate({
          target: [cartItems.userId, cartItems.sku],
          set: { qty, priceInrSnapshot: catalogItem.priceInr, updatedAt: sql`now()` },
        })

      if (!existing) lineCount += 1
    }

    const skipped = [...new Set(items.map((item) => item.sku).filter((sku) => skippedSet.has(sku)))]
    return {
      cart: await loadCart(
        tx as Db,
        userId,
        rule,
        COUPON_NONE,
        undefined,
        resolveShipping,
        resolveCod
      ),
      skipped,
    }
  })
  return cart
}
