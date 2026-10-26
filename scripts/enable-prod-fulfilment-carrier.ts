#!/usr/bin/env tsx
/**
 * `npm run db:enable-prod-fulfilment-carrier` — flips prod `fulfilment.enabled`
 * to `true` and `fulfilment.mode` to `"carrier"`, now that Delhivery has
 * confirmed the prod webhook is enabled on their side ("ADIX AI B2C") and the
 * live Cloud Run job has carrier creds wired (`935ba34`, tag `v1.5.2`).
 *
 * Deliberately does NOT touch `fulfilment.autoManifest` (stays `false` —
 * manifesting still requires the admin sweep, not automatic at order-paid
 * time) or `fulfilment.pickupLocationName` (already `"AHM-01 SAMAN PRODUCTS"`,
 * set by a prior deliberate step — this script does not overwrite it).
 *
 * Goes through `upsertConfigEntry` so the change lands in `app_config_audit`
 * like `db:open-shipping-fence` does. `changedBy` left null to mark this as
 * script-driven rather than an admin UI action.
 *
 * Usage: `npm run db:enable-prod-fulfilment-carrier -- --dry-run` to preview,
 * or without the flag to write. Reads DATABASE_URL_DIRECT (preferred) or
 * DATABASE_URL.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { upsertConfigEntry } from '../src/services/config.js'

const WRITES: ReadonlyArray<{ key: string; value: unknown }> = [
  { key: 'fulfilment.enabled', value: true },
  { key: 'fulfilment.mode', value: 'carrier' },
]

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:enable-prod-fulfilment-carrier: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db

    /* eslint-disable no-console */
    console.log(`db:enable-prod-fulfilment-carrier: ${WRITES.length} key(s) to set${dryRun ? ' (DRY RUN)' : ''}`)
    for (const w of WRITES) {
      console.log(`  SET ${w.key} = ${JSON.stringify(w.value)}`)
    }

    if (dryRun) {
      console.log('db:enable-prod-fulfilment-carrier: dry run, nothing written')
      return
    }

    for (const w of WRITES) {
      const row = await upsertConfigEntry(db, w.key, { value: w.value }, undefined)
      console.log(`  OK  ${row.key} = ${JSON.stringify(row.value)}`)
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
