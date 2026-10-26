/**
 * Address business rules. Routes hand this module validated input plus the
 * caller's user id; it owns every invariant the API promises:
 *
 * - At most {@link MAX_ADDRESSES_PER_USER} addresses per user (422 past it).
 * - Exactly one default while any addresses exist: the first address is
 *   forced default, setting a new default atomically unsets the old one,
 *   un-defaulting the current default is rejected, and deleting the default
 *   promotes the newest remaining address — all inside transactions, with the
 *   partial unique index (`addresses_one_default_per_user`) as the DB-level
 *   backstop.
 * - Cross-user access reads as 404, never 403 (don't confirm the id exists).
 * - Serialization: rows store E.164 phones (`+91…`) and timestamptz; the API
 *   serves bare 10-digit phones and ISO-8601 strings (see docs/CONTRACTS.md).
 */

import { and, count, desc, eq } from 'drizzle-orm'

import type { Address, AddressCreate, AddressUpdate } from '../contracts/address.js'
import type { Db } from '../db/client.js'
import { addresses, type AddressRow } from '../db/schema.js'
import { defaultRequired, limitExceeded, notFound } from '../lib/errors.js'

export const MAX_ADDRESSES_PER_USER = 50

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 10-digit input → E.164 storage form. Input is pre-validated (`^[6-9]\d{9}$`). */
function toE164(phone: string): string {
  return `+91${phone}`
}

/** DB row (E.164 phone, Date timestamps) → API resource (10-digit phone, ISO strings). */
export function toApiAddress(row: AddressRow): Address {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone.slice(-10),
    pincode: row.pincode,
    city: row.city,
    state: row.state,
    houseNumber: row.houseNumber,
    roadArea: row.roadArea,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Clear the user's current default (step one of any default hand-off). */
async function unsetCurrentDefault(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(addresses)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)))
}

/** The caller's addresses: default first, then newest to oldest. */
export async function listAddresses(db: Db, userId: string): Promise<Address[]> {
  const rows = await db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt))
  return rows.map(toApiAddress)
}

/** 200 with the resource, or 404 — including for another user's id. */
export async function getAddress(db: Db, userId: string, id: string): Promise<Address> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
    .limit(1)
  if (!row) throw notFound()
  return toApiAddress(row)
}

/**
 * Create an address. The user's first address is forced `isDefault: true`
 * regardless of the request; an explicit `isDefault: true` later atomically
 * takes over from the previous default.
 */
export async function createAddress(
  db: Db,
  userId: string,
  input: AddressCreate
): Promise<Address> {
  const row = await db.transaction(async (tx) => {
    const [counted] = await tx
      .select({ value: count() })
      .from(addresses)
      .where(eq(addresses.userId, userId))
    const existing = counted?.value ?? 0
    if (existing >= MAX_ADDRESSES_PER_USER) throw limitExceeded()

    const isDefault = existing === 0 ? true : input.isDefault
    if (isDefault) await unsetCurrentDefault(tx, userId)

    const [inserted] = await tx
      .insert(addresses)
      .values({
        userId,
        name: input.name,
        phone: toE164(input.phone),
        pincode: input.pincode,
        city: input.city,
        state: input.state,
        houseNumber: input.houseNumber,
        roadArea: input.roadArea,
        isDefault,
      })
      .returning()
    if (!inserted) throw new Error('address insert returned no row')
    return inserted
  })
  return toApiAddress(row)
}

/**
 * Partial update. `isDefault: true` swaps the default transactionally;
 * `isDefault: false` on the current default is rejected (422
 * `default_required`) — there must always be a default while addresses exist.
 */
export async function updateAddress(
  db: Db,
  userId: string,
  id: string,
  patch: AddressUpdate
): Promise<Address> {
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
      .limit(1)
    if (!existing) throw notFound()

    if (patch.isDefault === false && existing.isDefault) throw defaultRequired()
    if (patch.isDefault === true && !existing.isDefault) await unsetCurrentDefault(tx, userId)

    const set: Partial<AddressRow> = { updatedAt: new Date() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.phone !== undefined) set.phone = toE164(patch.phone)
    if (patch.pincode !== undefined) set.pincode = patch.pincode
    if (patch.city !== undefined) set.city = patch.city
    if (patch.state !== undefined) set.state = patch.state
    if (patch.houseNumber !== undefined) set.houseNumber = patch.houseNumber
    if (patch.roadArea !== undefined) set.roadArea = patch.roadArea
    if (patch.isDefault !== undefined) set.isDefault = patch.isDefault

    const [updated] = await tx
      .update(addresses)
      .set(set)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
      .returning()
    if (!updated) throw notFound()
    return updated
  })
  return toApiAddress(row)
}

/**
 * Delete (204). Deleting the default promotes the newest remaining address
 * in the same transaction, so the one-default invariant survives.
 */
export async function deleteAddress(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
      .returning({ isDefault: addresses.isDefault })
    if (!deleted) throw notFound()

    if (deleted.isDefault) {
      const [newest] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.userId, userId))
        .orderBy(desc(addresses.createdAt))
        .limit(1)
      if (newest) {
        await tx
          .update(addresses)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(addresses.id, newest.id))
      }
    }
  })
}
