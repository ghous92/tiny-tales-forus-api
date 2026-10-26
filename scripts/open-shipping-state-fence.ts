#!/usr/bin/env tsx
/**
 * `npm run db:open-shipping-fence` — rewrites the `shipping.serviceableStates`
 * config row to the PAN-India list now baked into `CONFIG_DEFAULTS` in
 * seed-config.ts (2026-08-14: GST/legal clearance for PAN-India sale
 * confirmed, so the state fence no longer needs to stay Gujarat-only).
 *
 * `db:seed-config` cannot do this: it only INSERTs missing keys and never
 * overwrites one that already exists, so an environment seeded before this
 * change keeps enforcing the old Gujarat-only fence forever unless something
 * explicitly rewrites it. This is that something. Mirrors
 * `db:scrub-legal-pii`'s shape exactly.
 *
 * NOTE — this only lifts the LEGAL/GST fence (`checkOrderDestination` in
 * services/shipping.ts + the `serviceableStates` check inside `zoneFor` in
 * lib/shipping.ts). It does NOT make non-Gujarat orders actually deliverable:
 * `pincodes` is still Gujarat-only (PAN-India import is Phase 4, deferred —
 * see lib/gstStates.ts) and courier `service_areas`/rate slabs only cover
 * Zones A/B. A non-Gujarat destination will still come back `not_serviceable`
 * from `zoneFor` until that data is loaded — that's a logistics gap, not the
 * fence this script removes.
 *
 * Idempotent (rewriting the already-open value is a no-op in substance,
 * though it does add one audit row) and goes through `upsertConfigEntry` so
 * the change lands in `app_config_audit` like any other config write —
 * `changedBy` is left null, same as `db:seed-config`'s inserts, to mark it as
 * a script-driven change rather than an admin's.
 *
 * Usage: `npm run db:open-shipping-fence` (reads DATABASE_URL_DIRECT,
 * preferred, or DATABASE_URL — same convention as every other db: script in
 * this repo).
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'
import { upsertConfigEntry } from '../src/services/config.js'
import { CONFIG_DEFAULTS, type ConfigDefault } from './seed-config.js'

const OPEN_FENCE: ConfigDefault = (() => {
  const entry = CONFIG_DEFAULTS.find((e) => e.key === 'shipping.serviceableStates')
  if (!entry) {
    throw new Error(
      'db:open-shipping-fence: shipping.serviceableStates missing from CONFIG_DEFAULTS — seed-config.ts changed shape'
    )
  }
  return entry
})()

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:open-shipping-fence: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const [before] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, 'shipping.serviceableStates'))
      .limit(1)
    const beforeStates = Array.isArray(before?.value) ? (before.value as unknown[]) : []

    await upsertConfigEntry(
      db,
      'shipping.serviceableStates',
      { value: OPEN_FENCE.value, description: OPEN_FENCE.description },
      undefined
    )

    // eslint-disable-next-line no-console
    console.log(
      `db:open-shipping-fence: serviceableStates ${JSON.stringify(beforeStates)} -> ${JSON.stringify(OPEN_FENCE.value)}`
    )
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
