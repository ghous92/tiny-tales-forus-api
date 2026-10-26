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

import { eq, sql } from 'drizzle-orm'

import type { Profile, ProfileUpdate } from '../contracts/profile.js'
import type { Db } from '../db/client.js'
import { addresses, cartItems, users, type UserRow } from '../db/schema.js'
import { notFound } from '../lib/errors.js'

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
