#!/usr/bin/env tsx
/**
 * `npm run db:scrub-legal-pii` — rewrites the `legal.company` config row to
 * the PII-free shape (no grievance officer / nodal contact name, email or
 * phone — see mobile/src/data/legal.ts and CONFIG_DEFAULTS in seed-config.ts).
 *
 * `db:seed-config` cannot do this: it only INSERTs missing keys and never
 * overwrites one that already exists, so an environment whose `legal.company`
 * row predates the scrub keeps serving the old personal details forever
 * unless something explicitly rewrites it. This is that something.
 *
 * Idempotent (rewriting the already-clean value is a no-op in substance,
 * though it does add one audit row) and goes through `upsertConfigEntry` so
 * the change lands in `app_config_audit` like any other config write —
 * `changedBy` is left null, same as `db:seed-config`'s inserts, to mark it as
 * a script-driven change rather than an admin's.
 *
 * Usage: `npm run db:scrub-legal-pii` (reads DATABASE_URL_DIRECT, preferred,
 * or DATABASE_URL — same convention as every other db: script in this repo).
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'
import { upsertConfigEntry } from '../src/services/config.js'
import { CONFIG_DEFAULTS, type ConfigDefault } from './seed-config.js'

const CLEAN_LEGAL_COMPANY: ConfigDefault = (() => {
  const entry = CONFIG_DEFAULTS.find((e) => e.key === 'legal.company')
  if (!entry) {
    throw new Error('scrub-legal-pii: legal.company missing from CONFIG_DEFAULTS — seed-config.ts changed shape')
  }
  return entry
})()

const PII_FIELDS = [
  'grievanceOfficer',
  'grievanceEmail',
  'grievancePhone',
  'nodalContactName',
  'nodalContactEmail',
  'nodalContactPhone',
] as const

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:scrub-legal-pii: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const [before] = await db.select().from(appConfig).where(eq(appConfig.key, 'legal.company')).limit(1)
    const beforeValue = (before?.value ?? {}) as Record<string, unknown>
    const hadPii = PII_FIELDS.filter((f) => f in beforeValue)

    await upsertConfigEntry(
      db,
      'legal.company',
      { value: CLEAN_LEGAL_COMPANY.value, description: CLEAN_LEGAL_COMPANY.description },
      undefined
    )

    if (hadPii.length === 0) {
      // eslint-disable-next-line no-console
      console.log('db:scrub-legal-pii: legal.company already clean, nothing to remove (row rewritten anyway)')
    } else {
      // eslint-disable-next-line no-console
      console.log(`db:scrub-legal-pii: removed PII field(s): ${hadPii.join(', ')}`)
    }
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
