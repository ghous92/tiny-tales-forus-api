#!/usr/bin/env tsx
/**
 * `npm run db:seed-fulfilment-config` — seeds ONLY the fulfilment key set plus
 * `ops.notifyNumbers`, leaving every other `app_config` key alone.
 *
 * Why this exists rather than `db:seed-config`: `CONFIG_DEFAULTS` carries 52
 * keys, and a sparse environment gets all of the missing ones inserted in a
 * single run. Against production that is a large, unreviewed write landing on
 * money paths (`payments.enabled`, 15 × `shipping.*`, `invoice.emailEnabled`)
 * as a side effect of a task that was only ever about fulfilment. Worse, the
 * values come from whatever `CONFIG_DEFAULTS` says in the working tree at that
 * moment — `scripts/open-shipping-state-fence.ts` exists precisely because a
 * `CONFIG_DEFAULTS` edit (`shipping.serviceableStates` → PAN-India) is a
 * deliberate decision that must be made on its own, not ridden in on someone
 * else's seed run. This script's filter is what keeps those decisions separate.
 *
 * **Insert-only.** It delegates to `seedConfigDefaults`, which is
 * `onConflictDoNothing` — an existing row is never overwritten, so a value an
 * operator has already tuned survives a re-run untouched. That is also why the
 * two keys that carry real meaning are deliberately NOT set here:
 *
 *   - `fulfilment.pickupLocationName` — must match the registered Delhivery
 *     warehouse EXACTLY and case-sensitively, and Delhivery exposes no
 *     read-back and no delete. A wrong string is a rejected manifest per order
 *     rather than one loud failure. It gets typed once, by a human, in the
 *     admin UI, behind `ConfirmProdWrite`, with an audit row naming who did it.
 *   - `ops.notifyNumbers` — same reasoning, plus the value is a real person's
 *     phone number.
 *
 * Both are seeded here at their SAFE EMPTY defaults (`''` and `[]`), which
 * block manifesting and block notification enqueue respectively. Filling them
 * is a separate, deliberate step.
 *
 * Safe to run against a live environment: every seeded value equals the code
 * default in `FULFILMENT_OFF`, with one intentional exception noted on
 * `trackingUrlTemplate` below, so a successful run changes no behaviour. It
 * only moves fulfilment config from "absent, so `parseFulfilmentRule` collapses
 * to `FULFILMENT_OFF`" to "present and explicitly off" — the difference is
 * visibility in the admin config screen, not conduct.
 *
 * Usage:
 *   npm run db:seed-fulfilment-config -- --dry-run   # print the plan, write nothing
 *   npm run db:seed-fulfilment-config                # insert missing keys
 *
 * Reads DATABASE_URL_DIRECT (preferred) or DATABASE_URL, same convention as
 * every other `db:` script here.
 */

import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'
import { FULFILMENT_CONFIG_KEYS } from '../src/services/fulfilment.js'
import { CONFIG_DEFAULTS, seedConfigDefaults, type ConfigDefault } from './seed-config.js'

/**
 * The key set this script is allowed to touch.
 *
 * `FULFILMENT_CONFIG_KEYS` is imported from the parser rather than restated so
 * the two cannot drift: `parseFulfilmentRule` is all-or-nothing, and a key it
 * requires but this script forgets would leave the rule collapsing to
 * `FULFILMENT_OFF` forever with every individual row looking correct.
 */
const TARGET_KEYS: readonly string[] = [
  ...FULFILMENT_CONFIG_KEYS,
  'ops.notifyNumbers',
  // Template identity for the ops fan-out. Seeded empty, which means "fall
  // back to the deployed env var" — see the entries in seed-config.ts.
  'notify.orderPaidTemplate',
  'notify.orderPaidLocale',
  // The cancellation pair. Seeded empty like the rest, but empty means SILENT
  // here rather than "use the env var" — these kinds have no env fallback by
  // design (see their entries in seed-config.ts).
  'notify.orderCancelledTemplate',
  'notify.orderCancelledLocale',
  'notify.shipmentCancelFailedTemplate',
  'notify.shipmentCancelFailedLocale',
]

/**
 * Resolve each target key to its `CONFIG_DEFAULTS` entry, failing loudly on a
 * miss. A silent skip here would produce a partial seed, and a partial fulfilment
 * key set parses as `FULFILMENT_OFF` — indistinguishable from success unless you
 * already knew what to look for.
 */
function resolveTargets(): ConfigDefault[] {
  const missing: string[] = []
  const resolved: ConfigDefault[] = []
  for (const key of TARGET_KEYS) {
    const entry = CONFIG_DEFAULTS.find((e) => e.key === key)
    if (entry === undefined) missing.push(key)
    else resolved.push(entry)
  }
  if (missing.length > 0) {
    throw new Error(
      `db:seed-fulfilment-config: ${missing.join(', ')} missing from CONFIG_DEFAULTS — seed-config.ts changed shape`
    )
  }
  return resolved
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-fulfilment-config: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const targets = resolveTargets()
  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db

    const existing = await db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(inArray(appConfig.key, [...TARGET_KEYS]))
    const existingByKey = new Map(existing.map((row) => [row.key, row.value]))

    /* eslint-disable no-console */
    console.log(`db:seed-fulfilment-config: ${targets.length} keys in scope${dryRun ? ' (DRY RUN)' : ''}`)
    for (const entry of targets) {
      const current = existingByKey.get(entry.key)
      console.log(
        existingByKey.has(entry.key)
          ? `  KEEP    ${entry.key} = ${JSON.stringify(current)} (exists — never overwritten)`
          : `  INSERT  ${entry.key} = ${JSON.stringify(entry.value)}`
      )
    }

    if (dryRun) {
      console.log('db:seed-fulfilment-config: dry run, nothing written')
      return
    }

    const inserted = await seedConfigDefaults(db, targets)
    console.log(
      inserted.length === 0
        ? 'db:seed-fulfilment-config: nothing inserted — every key already existed'
        : `db:seed-fulfilment-config: inserted ${inserted.length} key(s): ${inserted.join(', ')}`
    )

    // The two that still need a human. Printed unconditionally, because a run
    // that "succeeded" while these stay empty is exactly the state that looks
    // finished and manifests nothing.
    const pickup = inserted.includes('fulfilment.pickupLocationName')
      ? ''
      : (existingByKey.get('fulfilment.pickupLocationName') as string | undefined)
    if (!pickup) {
      console.log(
        '  NEXT: fulfilment.pickupLocationName is empty — manifesting stays blocked until it is set (admin UI)'
      )
    }
    const numbers = existingByKey.get('ops.notifyNumbers')
    if (!Array.isArray(numbers) || numbers.length === 0) {
      console.log('  NEXT: ops.notifyNumbers is empty — no ops notification is enqueued (admin UI)')
    }
    /* eslint-enable no-console */
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
