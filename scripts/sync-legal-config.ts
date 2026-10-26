#!/usr/bin/env tsx
/**
 * `npm run db:sync-legal-config` — force-rewrites the config rows that decide
 * WHO SELLS and WHAT THE LEGAL DOCUMENTS SAY, from `CONFIG_DEFAULTS`.
 *
 * `db:seed-config` cannot do this: it only INSERTs missing keys and never
 * touches an existing row, so an environment can retain a superseded seller
 * choice indefinitely. `db:scrub-legal-pii` rewrites `legal.company` only. This rewrites
 * the whole set in one command. It does not use a single transaction across
 * the keys, so run it before sales and verify all three values afterwards.
 *
 * Prints a before/after diff per key and, unless `--yes` is passed, refuses to
 * write. Goes through `upsertConfigEntry`, so every change lands in
 * `app_config_audit` with a null `changedBy`, marking it script-driven rather
 * than an admin's — same convention as the other db: scripts.
 *
 * Usage:
 *   npm run db:sync-legal-config              # dry run, prints the diff
 *   npm run db:sync-legal-config -- --yes     # apply
 *
 * Reads DATABASE_URL_DIRECT (preferred) or DATABASE_URL.
 */

import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'
import { upsertConfigEntry } from '../src/services/config.js'
import { CONFIG_DEFAULTS } from './seed-config.js'

/**
 * The seller-of-record set. These must agree: `legal.company`
 * carries Adix's own GSTIN, `legal.manufacturer` carries the supplier's B2B
 * GSTIN, and the published Terms are
 * generated from the same facts.
 */
const KEYS = ['legal.company', 'legal.manufacturer', 'invoice.sellerOfRecord'] as const

function entryFor(key: string) {
  const entry = CONFIG_DEFAULTS.find((e) => e.key === key)
  if (!entry) throw new Error(`sync-legal-config: ${key} missing from CONFIG_DEFAULTS — seed-config.ts changed shape`)
  return entry
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:sync-legal-config: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const rows = await db.select().from(appConfig).where(inArray(appConfig.key, [...KEYS]))
    const before = new Map(rows.map((r) => [r.key, r.value]))

    let changed = 0
    for (const key of KEYS) {
      const entry = entryFor(key)
      const wasJson = JSON.stringify(before.get(key) ?? null)
      const willJson = JSON.stringify(entry.value)
      if (wasJson === willJson) {
        // eslint-disable-next-line no-console
        console.log(`  = ${key} (unchanged)`)
        continue
      }
      changed += 1
      // eslint-disable-next-line no-console
      console.log(`  ~ ${key}`)
      // eslint-disable-next-line no-console
      console.log(`      before: ${before.has(key) ? wasJson : '(row absent)'}`)
      // eslint-disable-next-line no-console
      console.log(`      after:  ${willJson}`)
    }

    if (changed === 0) {
      // eslint-disable-next-line no-console
      console.log('db:sync-legal-config: nothing to do')
      return
    }
    if (!apply) {
      // eslint-disable-next-line no-console
      console.log(`\ndb:sync-legal-config: DRY RUN — ${changed} key(s) would change. Re-run with -- --yes to apply.`)
      return
    }

    for (const key of KEYS) {
      const entry = entryFor(key)
      await upsertConfigEntry(db, key, { value: entry.value, description: entry.description }, undefined)
    }
    // eslint-disable-next-line no-console
    console.log(`\ndb:sync-legal-config: wrote ${KEYS.length} key(s).`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('db:sync-legal-config failed:', error)
  process.exit(1)
})
