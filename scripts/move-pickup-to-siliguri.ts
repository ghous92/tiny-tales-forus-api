#!/usr/bin/env tsx
/**
 * `npx tsx scripts/move-pickup-to-siliguri.ts` — moves dispatch to the Siliguri
 * warehouse: sets `fulfilment.pickupLocationName` to the registered Delhivery
 * name, adds the `SIL-01` pickup node, and deactivates every other active node
 * so quotes stop pricing from the old origin.
 *
 * Node rows are only deactivated, never deleted, so this can be undone by
 * flipping `is_active` back and restoring the printed previous name.
 *
 * Usage: add `--dry-run` to preview. Reads DATABASE_URL_DIRECT (preferred) or
 * DATABASE_URL.
 */

import { and, eq, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig, pickupNodes } from '../src/db/schema.js'
import { upsertConfigEntry } from '../src/services/config.js'

const PICKUP_KEY = 'fulfilment.pickupLocationName'
const PICKUP_NAME = 'Tiny Tales'

const NODE = {
  code: 'SIL-01',
  name: 'Tiny Tales',
  contactName: 'Tiny Tales',
  contactPhone: '+919018799997',
  houseNumber: "735/2, Umrao Singh Officers' Enclave",
  roadArea: '5133 ASC BN Gate',
  city: 'Siliguri',
  state: 'West Bengal',
  pincode: '734013',
  kind: 'warehouse',
  isActive: true,
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('move-pickup-to-siliguri: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db

    /* eslint-disable no-console */
    const [current] = await db.select().from(appConfig).where(eq(appConfig.key, PICKUP_KEY))
    const nodes = await db.select().from(pickupNodes)
    const toDeactivate = nodes.filter((n) => n.isActive && n.code !== NODE.code)
    const stockNodes = nodes.filter((n) => n.stockEnabled).map((n) => n.code)

    console.log(`${PICKUP_KEY}: ${JSON.stringify(current?.value)} -> ${JSON.stringify(PICKUP_NAME)}`)
    console.log(`SIL-01: ${nodes.some((n) => n.code === NODE.code) ? 'exists, update' : 'create'}`)
    console.log(`deactivate: ${toDeactivate.map((n) => n.code).join(', ') || '(none)'}`)
    console.log(`stock-enabled nodes (left as is): ${stockNodes.join(', ') || '(none)'}`)

    if (dryRun) {
      console.log('dry run, nothing written')
      return
    }

    await db
      .insert(pickupNodes)
      .values(NODE)
      .onConflictDoUpdate({ target: pickupNodes.code, set: NODE })
    await db
      .update(pickupNodes)
      .set({ isActive: false })
      .where(and(eq(pickupNodes.isActive, true), ne(pickupNodes.code, NODE.code)))
    const row = await upsertConfigEntry(db, PICKUP_KEY, { value: PICKUP_NAME }, undefined)
    console.log(`OK ${row.key} = ${JSON.stringify(row.value)}`)
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
