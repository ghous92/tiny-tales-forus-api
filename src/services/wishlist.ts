/**
 * Wishlist rules. Writes are idempotent so a client can safely retry them, and
 * the cap is checked per request rather than under a lock: a race can only
 * overshoot it by a few rows of ids.
 */

import { and, asc, count, eq } from 'drizzle-orm'

import { MAX_WISHLIST_ITEMS, type Wishlist } from '../contracts/wishlist.js'
import type { Db } from '../db/client.js'
import { wishlistItems } from '../db/schema.js'
import { limitExceeded } from '../lib/errors.js'

const LIMIT_MESSAGE = `Wishlist limit reached (max ${MAX_WISHLIST_ITEMS} products)`

/** The caller's list, oldest first. */
export async function getWishlist(db: Db, userId: string): Promise<Wishlist> {
  const rows = await db
    .select({ productId: wishlistItems.productId })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId))
    .orderBy(asc(wishlistItems.createdAt), asc(wishlistItems.productId))
  return { productIds: rows.map((row) => row.productId) }
}

async function itemCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId))
  return row?.value ?? 0
}

export async function addWishlistItem(db: Db, userId: string, productId: string): Promise<void> {
  if ((await itemCount(db, userId)) >= MAX_WISHLIST_ITEMS) throw limitExceeded(LIMIT_MESSAGE)
  await db.insert(wishlistItems).values({ userId, productId }).onConflictDoNothing()
}

export async function removeWishlistItem(db: Db, userId: string, productId: string): Promise<void> {
  await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)))
}

/** Union a device's list into the account's. Past the cap, the surplus is dropped. */
export async function mergeWishlist(
  db: Db,
  userId: string,
  productIds: readonly string[]
): Promise<Wishlist> {
  const room = MAX_WISHLIST_ITEMS - (await itemCount(db, userId))
  const incoming = [...new Set(productIds)].slice(0, Math.max(room, 0))
  if (incoming.length > 0) {
    await db
      .insert(wishlistItems)
      .values(incoming.map((productId) => ({ userId, productId })))
      .onConflictDoNothing()
  }
  return getWishlist(db, userId)
}
