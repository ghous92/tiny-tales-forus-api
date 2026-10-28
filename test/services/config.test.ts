/**
 * Service-rule tests against PGlite — the invariants proved here are
 * independent of HTTP: deterministic ETag/version, empty-table epoch
 * timestamp, upsert+audit-in-one-transaction, the 500-key cap, and
 * same-value writes still auditing.
 */

import { asc, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { CONFIG_KEY } from '../../src/contracts/config.js'
import type { Db } from '../../src/db/client.js'
import { appConfig, appConfigAudit, users } from '../../src/db/schema.js'
import { ApiError } from '../../src/lib/errors.js'
import {
  computeVersion,
  deleteConfigEntry,
  getConfigValue,
  getSnapshot,
  listConfigEntries,
  MAX_CONFIG_KEYS,
  PUBLIC_CONFIG_KEYS,
  upsertConfigEntry,
} from '../../src/services/config.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let adminId: string

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
  const [row] = await db
    .insert(users)
    .values({ firebaseUid: 'admin-uid', phone: '+919876543210', role: 'admin' })
    .returning({ id: users.id })
  if (!row) throw new Error('admin insert failed')
  adminId = row.id
})

describe('getSnapshot', () => {
  it('never serves the GSTIN publicly, but keeps the GST status', async () => {
    await upsertConfigEntry(
      db,
      'legal.company',
      { value: { legalName: 'Adix AI', gstRegistered: true, gstin: '20AAAAA0000A1Z5' } },
      adminId
    )
    const snapshot = await getSnapshot(db)
    expect(snapshot.values['legal.company']).toEqual({ legalName: 'Adix AI', gstRegistered: true })
    expect(JSON.stringify(snapshot)).not.toContain('20AAAAA0000A1Z5')
  })

  it('reports the epoch timestamp and a stable version when the table is empty', async () => {
    const snapshot = await getSnapshot(db)
    expect(snapshot.values).toEqual({})
    expect(snapshot.updatedAt).toBe(new Date(0).toISOString())
    expect(snapshot.version).toBe(computeVersion({}))
  })

  it('version is deterministic regardless of insertion order (sorted-key canonical JSON)', async () => {
    await upsertConfigEntry(db, 'orders.cancelReasons', { value: ['b'] }, adminId)
    await upsertConfigEntry(db, 'legal.company', { value: { name: 'a' } }, adminId)
    const snapshotA = await getSnapshot(db)

    // Fresh db, no users row — pass changedBy: undefined (audit allows a null changed_by).
    const ctx2 = await createTestDb()
    await upsertConfigEntry(ctx2.db, 'legal.company', { value: { name: 'a' } }, undefined)
    await upsertConfigEntry(ctx2.db, 'orders.cancelReasons', { value: ['b'] }, undefined)
    const snapshotB = await getSnapshot(ctx2.db)

    expect(snapshotA.version).toBe(snapshotB.version)
  })

  it('version changes when a value changes', async () => {
    await upsertConfigEntry(db, 'legal.company', { value: { gstRegistered: false } }, adminId)
    const before = await getSnapshot(db)
    await upsertConfigEntry(db, 'legal.company', { value: { gstRegistered: true } }, adminId)
    const after = await getSnapshot(db)
    expect(before.version).not.toBe(after.version)
  })

  it('round-trips JSON-lookalike string values without type mutation', async () => {
    // Regression for the jsonb double-decode (see `jsonbSafe` in
    // src/db/schema.ts): a stored JSON *string* that itself parses as JSON
    // ("919999999999", "true", "null") must come back as a string, not a
    // number/boolean/null. Asserted on both read paths — the snapshot
    // (allowlisted key) and getConfigValue (any key).
    await upsertConfigEntry(db, 'legal.company', { value: '919999999999' }, adminId)
    await upsertConfigEntry(db, 'checkout.whatsappNumber', { value: '919999999999' }, adminId)
    await upsertConfigEntry(db, 'weird.true', { value: 'true' }, adminId)
    await upsertConfigEntry(db, 'weird.null', { value: 'null' }, adminId)

    const snapshot = await getSnapshot(db)
    expect(snapshot.values['legal.company']).toBe('919999999999')
    expect(await getConfigValue(db, 'checkout.whatsappNumber')).toBe('919999999999')
    expect(await getConfigValue(db, 'weird.true')).toBe('true')
    expect(await getConfigValue(db, 'weird.null')).toBe('null')
  })

  it('updatedAt is the max line updated_at across the allowlisted keys', async () => {
    await upsertConfigEntry(db, 'legal.company', { value: { name: 'a' } }, adminId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await upsertConfigEntry(db, 'orders.cancelReasons', { value: ['b'] }, adminId)
    const snapshot = await getSnapshot(db)
    const rows = await db
      .select()
      .from(appConfig)
      .where(inArray(appConfig.key, [...PUBLIC_CONFIG_KEYS]))
    const maxUpdatedAt = Math.max(...rows.map((r) => r.updatedAt.getTime()))
    expect(Date.parse(snapshot.updatedAt)).toBe(maxUpdatedAt)
  })

  it('excludes every key that is not allowlisted', async () => {
    await upsertConfigEntry(db, 'legal.company', { value: { name: 'ADIX AI' } }, adminId)
    await upsertConfigEntry(db, 'ops.notifyNumbers', { value: ['919876543210'] }, adminId)
    await upsertConfigEntry(db, 'fulfilment.pickupLocationName', { value: 'AHM-01' }, adminId)

    const snapshot = await getSnapshot(db)
    expect(Object.keys(snapshot.values)).toEqual(['legal.company'])
    // Still readable server-side — the allowlist is the public surface only.
    expect(await getConfigValue(db, 'ops.notifyNumbers')).toEqual(['919876543210'])
  })

  it('a private-key write moves neither version nor updatedAt', async () => {
    await upsertConfigEntry(db, 'legal.company', { value: { name: 'ADIX AI' } }, adminId)
    const before = await getSnapshot(db)

    await new Promise((resolve) => setTimeout(resolve, 10))
    await upsertConfigEntry(db, 'ops.notifyNumbers', { value: ['919876543210'] }, adminId)
    const after = await getSnapshot(db)

    expect(after.version).toBe(before.version)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('reports the epoch timestamp when only private keys exist', async () => {
    await upsertConfigEntry(db, 'ops.notifyNumbers', { value: ['919876543210'] }, adminId)
    const snapshot = await getSnapshot(db)
    expect(snapshot.values).toEqual({})
    expect(snapshot.updatedAt).toBe(new Date(0).toISOString())
    expect(snapshot.version).toBe(computeVersion({}))
  })

  it('every allowlisted key has a config-key-shaped name', () => {
    for (const key of PUBLIC_CONFIG_KEYS) expect(key).toMatch(CONFIG_KEY)
  })
})

describe('upsertConfigEntry', () => {
  it('creates a new key with old_value null in the audit row', async () => {
    const entry = await upsertConfigEntry(db, 'checkout.mode', { value: 'whatsapp' }, adminId)
    expect(entry.value).toBe('whatsapp')
    expect(entry.description).toBe('')

    const auditRows = await db
      .select()
      .from(appConfigAudit)
      .where(eq(appConfigAudit.key, 'checkout.mode'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.oldValue).toBeNull()
    expect(auditRows[0]?.newValue).toBe('whatsapp')
    expect(auditRows[0]?.changedBy).toBe(adminId)
  })

  it('updates an existing key and records old_value in the audit row', async () => {
    await upsertConfigEntry(db, 'checkout.mode', { value: 'whatsapp' }, adminId)
    await upsertConfigEntry(db, 'checkout.mode', { value: 'in-app' }, adminId)

    const rows = await db.select().from(appConfig).where(eq(appConfig.key, 'checkout.mode'))
    expect(rows[0]?.value).toBe('in-app')

    const auditRows = await db
      .select()
      .from(appConfigAudit)
      .where(eq(appConfigAudit.key, 'checkout.mode'))
      .orderBy(asc(appConfigAudit.changedAt))
    expect(auditRows).toHaveLength(2)
    expect(auditRows[1]?.oldValue).toBe('whatsapp')
    expect(auditRows[1]?.newValue).toBe('in-app')
  })

  it('writing the same value again still writes an audit row (idempotent, but audited)', async () => {
    await upsertConfigEntry(db, 'checkout.mode', { value: 'whatsapp' }, adminId)
    await upsertConfigEntry(db, 'checkout.mode', { value: 'whatsapp' }, adminId)

    const auditRows = await db
      .select()
      .from(appConfigAudit)
      .where(eq(appConfigAudit.key, 'checkout.mode'))
    expect(auditRows).toHaveLength(2)
  })

  it(`rejects the ${MAX_CONFIG_KEYS + 1}th distinct key with limit_exceeded`, async () => {
    for (let i = 0; i < MAX_CONFIG_KEYS; i++) {
      await upsertConfigEntry(db, `key${i}`, { value: i }, adminId)
    }
    const attempt = upsertConfigEntry(db, 'oneMore', { value: 'x' }, adminId)
    await expect(attempt).rejects.toBeInstanceOf(ApiError)
    await expect(attempt).rejects.toMatchObject({ statusCode: 422, code: 'limit_exceeded' })
  })

  it('updating an existing key never counts against the cap', async () => {
    for (let i = 0; i < MAX_CONFIG_KEYS; i++) {
      await upsertConfigEntry(db, `key${i}`, { value: i }, adminId)
    }
    // Updating key0 (already exists) must succeed even though the table is at the cap.
    const updated = await upsertConfigEntry(db, 'key0', { value: 'updated' }, adminId)
    expect(updated.value).toBe('updated')
  })
})

describe('deleteConfigEntry', () => {
  it('deletes the row and writes an audit row with new_value null', async () => {
    await upsertConfigEntry(db, 'checkout.mode', { value: 'whatsapp' }, adminId)
    await deleteConfigEntry(db, 'checkout.mode', adminId)

    const rows = await db.select().from(appConfig).where(eq(appConfig.key, 'checkout.mode'))
    expect(rows).toHaveLength(0)

    const auditRows = await db
      .select()
      .from(appConfigAudit)
      .where(eq(appConfigAudit.key, 'checkout.mode'))
      .orderBy(asc(appConfigAudit.changedAt))
    expect(auditRows[1]?.oldValue).toBe('whatsapp')
    expect(auditRows[1]?.newValue).toBeNull()
  })

  it('404s for a missing key', async () => {
    await expect(deleteConfigEntry(db, 'nope', adminId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })
})

describe('listConfigEntries', () => {
  it('returns entries key-sorted', async () => {
    await upsertConfigEntry(db, 'z.key', { value: 1 }, adminId)
    await upsertConfigEntry(db, 'a.key', { value: 2 }, adminId)
    const entries = await listConfigEntries(db)
    expect(entries.map((e) => e.key)).toEqual(['a.key', 'z.key'])
  })
})

describe('getConfigValue', () => {
  it('returns the value for an existing key', async () => {
    await upsertConfigEntry(db, 'cart.maxLines', { value: 50 }, adminId)
    expect(await getConfigValue(db, 'cart.maxLines')).toBe(50)
  })

  it('returns undefined for an absent key', async () => {
    expect(await getConfigValue(db, 'nope')).toBeUndefined()
  })
})
