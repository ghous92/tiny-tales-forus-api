/**
 * Config business rules (SPEC-V2.md §2). Routes hand this module validated
 * input; it owns every invariant the API promises:
 *
 * - The public snapshot (`getSnapshot`) serves ONLY {@link PUBLIC_CONFIG_KEYS}.
 *   `app_config` is an operational table — carrier tuning, the cost model, the
 *   on-call notify list — and `GET /v1/config` is unauthenticated, so the
 *   snapshot is an allowlist and nothing else.
 * - The public snapshot is deterministic: `version` is the first 16 hex chars
 *   of sha256 over the canonical JSON (sorted keys) of the `values` record, so
 *   an unchanged config always yields the same ETag.
 * - At most {@link MAX_CONFIG_KEYS} keys total → `limit_exceeded` on create
 *   past the cap (updates to an existing key never count against it).
 * - Every upsert/delete writes exactly one audit row, in the SAME transaction
 *   as the table write — the audit trail can never disagree with the table.
 * - `getConfigValue` is the ONLY sanctioned way for other modules to read
 *   config (docs/ARCHITECTURE.md module rules) — never query `app_config`
 *   directly from cart/payments/etc.
 */

import { createHash } from 'node:crypto'

import { asc, count, eq, inArray } from 'drizzle-orm'

import type { ConfigEntry, ConfigSnapshot, ConfigUpsert } from '../contracts/config.js'
import type { Db } from '../db/client.js'
import { appConfig, appConfigAudit, type AppConfigRow } from '../db/schema.js'
import { limitExceeded, notFound } from '../lib/errors.js'
import { canonicalJson } from '../lib/canonical-json.js'

export const MAX_CONFIG_KEYS = 500

/**
 * The only keys `GET /v1/config` (public, unauthenticated) will serve.
 *
 * Fail-closed, exactly like `shipping.serviceableStates`: a key absent from
 * this list is private, and a key added to `app_config` later is private until
 * someone deliberately adds it here. A denylist would fail the other way —
 * every new operational key would be world-readable until remembered.
 *
 * This list is the *public* surface, NOT the set of keys the backend itself
 * reads. Server-side modules go through `getConfigValue`/`getConfigValues`,
 * which read rows directly and are unaffected by this allowlist.
 *
 * Each entry must have a named public consumer:
 * - `legal.company`        — tiny-tales-forus `src/lib/legalConfig.ts` and
 *                            `mobile/src/lib/legalConfig.ts`, so a GSTIN or
 *                            registered-address change reaches the published
 *                            Terms/Privacy pages without a redeploy.
 * - `orders.cancelReasons` — tiny-tales-forus `mobile/src/lib/orders.ts`, the
 *                            cancellation reason picker.
 *
 * Before adding a key, check it is safe to print on a public page: no
 * personal names/emails/phones (`ops.notifyNumbers`), no operational
 * addresses (`fulfilment.pickupLocationName`), no cost model
 * (`shipping.marginBps`, `wholesale.*`), no carrier tuning.
 */
export const PUBLIC_CONFIG_KEYS = [
  'legal.company',
  'orders.cancelReasons',
  // The storefront states the damage-reporting window on the returns page and
  // the claim form, so it must read the same number the API enforces.
  'returns.damageWindowHours',
] as const

/**
 * Fields stripped from a public key before it leaves the API. The GSTIN is
 * printed on every tax invoice (CGST Rule 46 requires it there), so it stays in
 * `legal.company` for the invoice generator, but the owner does not want it on
 * the website (2026-10-28) and `/v1/config` is readable by anyone. The
 * storefront needs only `gstRegistered` to word its Terms.
 */
const PUBLIC_REDACTED_FIELDS: Partial<Record<string, readonly string[]>> = {
  'legal.company': ['gstin'],
}

function publicValue(key: string, value: unknown): unknown {
  const fields = PUBLIC_REDACTED_FIELDS[key]
  if (!fields || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const copy = { ...(value as Record<string, unknown>) }
  for (const f of fields) delete copy[f]
  return copy
}

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Epoch ISO string — the `updatedAt` an empty snapshot/table reports. */
const EPOCH = new Date(0).toISOString()

/** DB row → admin-facing API resource (camelCase, ISO timestamps). */
export function toApiConfigEntry(row: AppConfigRow): ConfigEntry {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** sha256 over the canonical JSON of `values`, first 16 hex chars. */
export function computeVersion(values: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(values)).digest('hex').slice(0, 16)
}

/**
 * Public snapshot, {@link PUBLIC_CONFIG_KEYS} only: `{ version, updatedAt,
 * values }`. No allowlisted key present (or an empty table) reports
 * `updatedAt: <epoch ISO>` rather than `now()` so the response is fully
 * deterministic (and cacheable) even with nothing configured yet.
 *
 * The filter runs in the query, not over the result, so `version` and
 * `updatedAt` are derived from public rows alone: editing a private key
 * neither busts every client's ETag nor leaks the fact that something
 * changed.
 */
export async function getSnapshot(db: Db): Promise<ConfigSnapshot> {
  const rows = await db
    .select()
    .from(appConfig)
    .where(inArray(appConfig.key, [...PUBLIC_CONFIG_KEYS]))

  const values: Record<string, unknown> = {}
  let latest: Date | undefined
  for (const row of rows) {
    values[row.key] = publicValue(row.key, row.value)
    if (!latest || row.updatedAt > latest) latest = row.updatedAt
  }

  return {
    version: computeVersion(values),
    updatedAt: latest ? latest.toISOString() : EPOCH,
    values,
  }
}

/** Every config entry, admin view, key-sorted. */
export async function listConfigEntries(db: Db): Promise<ConfigEntry[]> {
  const rows = await db.select().from(appConfig).orderBy(asc(appConfig.key))
  return rows.map(toApiConfigEntry)
}

/**
 * Upsert a single key. Writes one audit row in the same transaction
 * (`old_value` null on create). Same-value writes still audit — cheap, and
 * keeps the history honest about every write attempt. Creating past
 * {@link MAX_CONFIG_KEYS} total keys is rejected; updating an existing key
 * never counts against the cap.
 */
export async function upsertConfigEntry(
  db: Db,
  key: string,
  input: ConfigUpsert,
  changedBy: string | undefined
): Promise<ConfigEntry> {
  const row = await db.transaction(async (tx: Tx) => {
    const [existing] = await tx.select().from(appConfig).where(eq(appConfig.key, key)).limit(1)

    if (!existing) {
      const [counted] = await tx.select({ value: count() }).from(appConfig)
      const total = counted?.value ?? 0
      if (total >= MAX_CONFIG_KEYS) {
        throw limitExceeded(`Config key limit reached (max ${MAX_CONFIG_KEYS} keys)`)
      }
    }

    const [upserted] = await tx
      .insert(appConfig)
      .values({
        key,
        value: input.value,
        description: input.description ?? '',
        updatedBy: changedBy,
      })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: {
          value: input.value,
          description: input.description ?? '',
          updatedBy: changedBy,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (!upserted) throw new Error('config upsert returned no row')

    await tx.insert(appConfigAudit).values({
      key,
      oldValue: existing?.value ?? null,
      newValue: upserted.value,
      changedBy,
    })

    return upserted
  })
  return toApiConfigEntry(row)
}

/** Delete a key (404 if absent). Writes an audit row with `new_value` null in the same transaction. */
export async function deleteConfigEntry(
  db: Db,
  key: string,
  changedBy: string | undefined
): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const [deleted] = await tx.delete(appConfig).where(eq(appConfig.key, key)).returning()
    if (!deleted) throw notFound(`Config key "${key}" not found`)

    await tx.insert(appConfigAudit).values({
      key,
      oldValue: deleted.value,
      newValue: null,
      changedBy,
    })
  })
}

/**
 * The sanctioned read path for OTHER modules (cart/payments/etc.) — never
 * query `app_config` directly outside this file. Returns `undefined` when
 * the key is absent so callers can fall back to a code default.
 */
export async function getConfigValue<T = unknown>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .limit(1)
  return row?.value as T | undefined
}

/**
 * Batch read — one query for many keys, same sanctioned read path as
 * {@link getConfigValue}. Absent keys are simply missing from the returned map,
 * so callers keep falling back to their code defaults.
 *
 * This exists because `getConfigValue` is one SELECT per key with no
 * memoisation, and rules that read a dozen keys run on EVERY cart request.
 * Wholesale's three keys were already three round trips; shipping's fifteen
 * would have made sixteen, and under Neon's autosuspend a cold cart read pays
 * for each one. Prefer this whenever a caller needs more than one key.
 */
export async function getConfigValues(db: Db, keys: string[]): Promise<Map<string, unknown>> {
  if (keys.length === 0) return new Map()
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys))
  return new Map(rows.map((row) => [row.key, row.value]))
}
