/**
 * Service-rule tests against a substituted db layer (in-memory PGlite with
 * the real migrations) — the business invariants proved here are independent
 * of HTTP: limits, default hand-off transactionality, delete-promotion, and
 * the DB-level partial-unique-index backstop.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AddressCreate } from '../../src/contracts/address.js'
import type { Db } from '../../src/db/client.js'
import { addresses, users } from '../../src/db/schema.js'
import { ApiError } from '../../src/lib/errors.js'
import {
  createAddress,
  deleteAddress,
  listAddresses,
  MAX_ADDRESSES_PER_USER,
  toApiAddress,
  updateAddress,
} from '../../src/services/addresses.js'
import { createTestDb, validAddress } from '../helpers/app.js'

let db: Db
let userId: string

async function insertUser(phone: string, uid: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ firebaseUid: uid, phone })
    .returning({ id: users.id })
  if (!row) throw new Error('user insert failed')
  return row.id
}

function input(overrides: Record<string, unknown> = {}): AddressCreate {
  return validAddress(overrides) as unknown as AddressCreate
}

/** Rows with is_default=true for the user, straight from the DB. */
async function defaultRows(forUser: string) {
  const rows = await db.select().from(addresses).where(eq(addresses.userId, forUser))
  return rows.filter((row) => row.isDefault)
}

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
  userId = await insertUser('+919876543210', 'firebase-uid-a')
})

describe('createAddress', () => {
  it('forces the first address to be the default, even when isDefault=false', async () => {
    const created = await createAddress(db, userId, input({ isDefault: false }))
    expect(created.isDefault).toBe(true)
  })

  it('stores the phone as E.164 and serves it back as 10 digits', async () => {
    const created = await createAddress(db, userId, input({ phone: '9876543210' }))
    expect(created.phone).toBe('9876543210')
    const [row] = await db.select().from(addresses).where(eq(addresses.id, created.id))
    expect(row?.phone).toBe('+919876543210')
  })

  it('creating with isDefault=true hands the default over atomically', async () => {
    const first = await createAddress(db, userId, input())
    const second = await createAddress(db, userId, input({ isDefault: true }))

    const defaults = await defaultRows(userId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(second.id)
    expect((await defaultRows(userId))[0]?.id).not.toBe(first.id)
  })

  it(`rejects address #${MAX_ADDRESSES_PER_USER + 1} with limit_exceeded`, async () => {
    for (let i = 0; i < MAX_ADDRESSES_PER_USER; i++) {
      await createAddress(db, userId, input())
    }
    const attempt = createAddress(db, userId, input())
    await expect(attempt).rejects.toBeInstanceOf(ApiError)
    await expect(attempt).rejects.toMatchObject({ statusCode: 422, code: 'limit_exceeded' })
  })

  it('a rejected over-limit create with isDefault=true leaves the existing default untouched', async () => {
    const first = await createAddress(db, userId, input())
    for (let i = 1; i < MAX_ADDRESSES_PER_USER; i++) {
      await createAddress(db, userId, input())
    }
    await expect(createAddress(db, userId, input({ isDefault: true }))).rejects.toMatchObject({
      code: 'limit_exceeded',
    })

    const defaults = await defaultRows(userId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(first.id)
  })
})

describe('updateAddress', () => {
  it('swaps the default transactionally — exactly one default row afterwards', async () => {
    const first = await createAddress(db, userId, input())
    const second = await createAddress(db, userId, input())
    expect(second.isDefault).toBe(false)

    const updated = await updateAddress(db, userId, second.id, { isDefault: true })
    expect(updated.isDefault).toBe(true)

    const defaults = await defaultRows(userId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(second.id)
    expect(defaults[0]?.id).not.toBe(first.id)
  })

  it('rejects isDefault=false on the current default (default_required)', async () => {
    const only = await createAddress(db, userId, input())
    await expect(updateAddress(db, userId, only.id, { isDefault: false })).rejects.toMatchObject({
      statusCode: 422,
      code: 'default_required',
    })
    expect(await defaultRows(userId)).toHaveLength(1)
  })

  it('allows isDefault=false on a non-default address (no-op)', async () => {
    await createAddress(db, userId, input())
    const second = await createAddress(db, userId, input())
    const updated = await updateAddress(db, userId, second.id, { isDefault: false })
    expect(updated.isDefault).toBe(false)
  })

  it('404s for an id owned by another user', async () => {
    const otherUser = await insertUser('+919123456780', 'firebase-uid-b')
    const theirs = await createAddress(db, otherUser, input({ phone: '9123456780' }))
    await expect(updateAddress(db, userId, theirs.id, { city: 'Mysuru' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })
})

describe('deleteAddress', () => {
  it('promotes the newest remaining address when the default is deleted', async () => {
    const first = await createAddress(db, userId, input()) // default
    await createAddress(db, userId, input()) // middle
    const newest = await createAddress(db, userId, input())

    await deleteAddress(db, userId, first.id)

    const defaults = await defaultRows(userId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(newest.id)
  })

  it('leaves the default alone when a non-default address is deleted', async () => {
    const first = await createAddress(db, userId, input()) // default
    const second = await createAddress(db, userId, input())

    await deleteAddress(db, userId, second.id)

    const defaults = await defaultRows(userId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(first.id)
  })

  it('deleting the last address leaves zero defaults (vacuously satisfied invariant)', async () => {
    const only = await createAddress(db, userId, input())
    await deleteAddress(db, userId, only.id)
    expect(await listAddresses(db, userId)).toHaveLength(0)
  })

  it('404s for an id owned by another user without deleting it', async () => {
    const otherUser = await insertUser('+919123456780', 'firebase-uid-b')
    const theirs = await createAddress(db, otherUser, input({ phone: '9123456780' }))
    await expect(deleteAddress(db, userId, theirs.id)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(await listAddresses(db, otherUser)).toHaveLength(1)
  })
})

describe('one-default invariant — DB backstop', () => {
  it('the partial unique index rejects a second default written around the service layer', async () => {
    await createAddress(db, userId, input()) // default
    const second = await createAddress(db, userId, input())

    // Bypass the service on purpose: the index itself must refuse this.
    // (drizzle wraps the driver error, so match on the whole cause chain)
    const failure = await db
      .update(addresses)
      .set({ isDefault: true })
      .where(eq(addresses.id, second.id))
      .then(() => undefined)
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    const chain = []
    for (let err = failure; err instanceof Error; err = err.cause) chain.push(err.message)
    expect(chain.join(' | ')).toMatch(/addresses_one_default_per_user|duplicate key/)
  })
})

describe('toApiAddress', () => {
  it('serializes a DB row to the API shape (camelCase, 10-digit phone, ISO dates)', () => {
    const now = new Date('2026-07-13T05:30:00.000Z')
    const api = toApiAddress({
      id: '4f9c2f6a-1c8e-4b8e-9f3a-2b1d5c7e8a90',
      userId: 'ignored',
      name: 'Asha Rao',
      phone: '+919876543210',
      pincode: '560001',
      city: '',
      state: '',
      houseNumber: '12B',
      roadArea: 'MG Road',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })
    expect(api).toEqual({
      id: '4f9c2f6a-1c8e-4b8e-9f3a-2b1d5c7e8a90',
      name: 'Asha Rao',
      phone: '9876543210',
      pincode: '560001',
      city: '',
      state: '',
      houseNumber: '12B',
      roadArea: 'MG Road',
      isDefault: true,
      createdAt: '2026-07-13T05:30:00.000Z',
      updatedAt: '2026-07-13T05:30:00.000Z',
    })
    expect('userId' in api).toBe(false)
  })
})
