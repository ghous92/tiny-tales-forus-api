/**
 * Profile business rules — the caller's own `users` row, nothing else. The
 * auth plugin has already upserted that row by the time any of this runs, so a
 * missing row here means the record vanished mid-request (deleted account);
 * that reads as 404, never a 500.
 *
 * Serialization matches the address module: rows store E.164 phones (`+91…`)
 * and timestamptz, the API serves bare 10-digit phones and ISO-8601 strings
 * (docs/CONTRACTS.md).
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm'

import type { Profile, ProfileUpdate } from '../contracts/profile.js'
import type { Db } from '../db/client.js'
import {
  addresses,
  caricaturePreviews,
  cartItems,
  customRequests,
  customUploads,
  payments,
  shipments,
  users,
  wishlistItems,
  type UserRow,
} from '../db/schema.js'
import { conflict, notFound } from '../lib/errors.js'

/** DB row → API resource. */
export function toApiProfile(row: UserRow): Profile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    // Cast is safe: the column only ever receives a value through the
    // contract's `genderEnum`-validated PATCH body.
    gender: row.gender as Profile['gender'],
    dob: row.dob,
    phone: row.phone.slice(-10),
    marketingWhatsappOptIn: row.marketingWhatsappOptIn,
    adAudienceOptIn: row.adAudienceOptIn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The caller's profile. */
export async function getProfile(db: Db, userId: string): Promise<Profile> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!row) throw notFound('Profile not found')
  return toApiProfile(row)
}

/**
 * Refuse every ID token issued so far. Floored to the second because a token's
 * `iat` is in seconds: a new sign-in right after this must still pass.
 */
export async function revokeTokens(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ tokensValidAfter: new Date(Math.floor(Date.now() / 1000) * 1000) })
    .where(eq(users.id, userId))
}

/**
 * Photos are what a custom piece is made from, and a request is not linked to
 * its order, so an account with a paid custom piece not yet delivered cannot be
 * deleted: it would destroy the photos of an order we still owe.
 */
export async function assertNoCustomPieceInProgress(db: Db, userId: string): Promise<void> {
  const paid = await db
    .select({ orderId: payments.orderId, cartSnapshot: payments.cartSnapshot })
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.status, 'paid')))
  const custom = paid.filter((order) =>
    (order.cartSnapshot as { items?: { sku?: string }[] }).items?.some((item) =>
      item.sku?.startsWith('TT-CUSTOM-')
    )
  )
  if (custom.length === 0) return

  const delivered = await db
    .select({ orderId: shipments.orderId })
    .from(shipments)
    .where(and(eq(shipments.userId, userId), eq(shipments.status, 'delivered')))
  const deliveredIds = new Set(delivered.map((shipment) => shipment.orderId))
  if (custom.some((order) => !deliveredIds.has(order.orderId))) {
    throw conflict(
      'Your custom piece is still being made, and we need your photos to finish it. You can delete your account once it is delivered, or write to us.'
    )
  }
}

/**
 * Every image-intake file to delete with this account: uploads from the ledger
 * and previews the server rendered, never keys sent by the browser.
 */
export async function listAccountImageKeys(db: Db, userId: string): Promise<string[]> {
  const uploads = await db
    .select({ key: customUploads.key })
    .from(customUploads)
    .where(eq(customUploads.userId, userId))
  const previews = await db
    .select({ key: caricaturePreviews.previewKey })
    .from(caricaturePreviews)
    .where(and(eq(caricaturePreviews.userId, userId), isNotNull(caricaturePreviews.previewKey)))
  return [...new Set([...uploads, ...previews].map(({ key }) => key!))]
}

/** What the route needs back to finish deleting the account. */
export interface AccountDeletionResult {
  /** The Firebase uid the row had before anonymization — the route revokes THIS uid. */
  firebaseUid: string
}

/**
 * Anonymize the caller's account (Apple Guideline 5.1.1(v) — in-app account
 * deletion). NOT a hard delete: `payments` rows reference `users.id` and are
 * the only order/tax record in the system (SPEC-PAYMENTS.md), and bookkeeping
 * retention rules mean those rows must survive — so the `users` row is
 * scrubbed IN PLACE (same id, so every `payments.userId` FK stays intact)
 * rather than deleted. `addresses` and `cart_items` are NOT tax-required
 * (every `payments` row already froze its own address/cart snapshot at order
 * time) and are deleted outright.
 *
 * `phone`/`firebase_uid` are both NOT NULL UNIQUE, so they are overwritten
 * with a tombstone value scoped to this row's own id — never left as the
 * real E.164 phone. That matters beyond privacy: `plugins/auth.ts`'s
 * re-link-by-phone path would otherwise silently revive this "deleted" row
 * (with its stale role/history) the moment someone re-verifies the same
 * phone number, since a matching `phone` is exactly what that path looks for.
 */
export async function deleteAccount(db: Db, userId: string): Promise<AccountDeletionResult> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!row) throw notFound('Profile not found')

  const tombstone = `deleted-${row.id}`
  await db.transaction(async (tx) => {
    await tx.delete(cartItems).where(eq(cartItems.userId, userId))
    await tx.delete(addresses).where(eq(addresses.userId, userId))
    await tx.delete(wishlistItems).where(eq(wishlistItems.userId, userId))
    // Photos, previews and character pictures, including the bytes kept in the row.
    await tx.delete(customRequests).where(eq(customRequests.userId, userId))
    await tx.delete(caricaturePreviews).where(eq(caricaturePreviews.userId, userId))
    await tx.delete(customUploads).where(eq(customUploads.userId, userId))
    await tx
      .update(users)
      .set({
        name: null,
        email: null,
        gender: null,
        dob: null,
        phone: tombstone,
        firebaseUid: tombstone,
        role: 'customer',
        // Deleting the account withdraws marketing consent. The phone is
        // tombstoned above so no send could resolve a target anyway, but a
        // scrubbed row left reading `true` would be a stored consent belonging
        // to nobody — and `false` is the honest terminal state.
        marketingWhatsappOptIn: false,
        marketingWhatsappOptInAt: sql`now()`,
        // Same reasoning for ad-audience consent: the next export must not
        // find a `true` here.
        adAudienceOptIn: false,
        adAudienceOptInAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId))
  })

  return { firebaseUid: row.firebaseUid }
}

/**
 * Patch any subset of name/email/gender/dob/marketingWhatsappOptIn/
 * adAudienceOptIn. Input is
 * pre-validated and already trimmed by the contract, and at least one field is
 * guaranteed present, so this is a single UPDATE … RETURNING with no
 * read-modify-write race.
 *
 * `marketingWhatsappOptInAt` is stamped in the same statement as the flag it
 * describes, never in a follow-up write: a consent record whose timestamp can
 * disagree with its value is not a record. Both directions stamp — a
 * withdrawal needs a date at least as much as a grant does.
 */
export async function updateProfile(
  db: Db,
  userId: string,
  input: ProfileUpdate
): Promise<Profile> {
  const [row] = await db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.dob !== undefined ? { dob: input.dob } : {}),
      ...(input.marketingWhatsappOptIn !== undefined
        ? {
            marketingWhatsappOptIn: input.marketingWhatsappOptIn,
            marketingWhatsappOptInAt: new Date(),
          }
        : {}),
      ...(input.adAudienceOptIn !== undefined
        ? { adAudienceOptIn: input.adAudienceOptIn, adAudienceOptInAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning()
  if (!row) throw notFound('Profile not found')
  return toApiProfile(row)
}
