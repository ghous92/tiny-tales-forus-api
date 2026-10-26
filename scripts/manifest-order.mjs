#!/usr/bin/env node
/**
 * `node scripts/manifest-order.mjs <order_id>` — manifest ONE order with
 * Delhivery, skipping every other `pending_manifest` shipment.
 *
 * Why this exists: `POST /v1/admin/fulfilment/manifest` (the only manifest
 * route) is a bulk sweep — it always ships every `pending_manifest` row under
 * the attempt cap, with no order filter. When ops wants exactly one order
 * shipped (e.g. verifying a single fresh order end-to-end) without touching
 * older pending orders that are intentionally on hold, this script parks
 * every OTHER pending shipment's `manifestAttempts` at the cap right before
 * calling the real `manifestPending()` (same function the route calls, so the
 * carrier logic is identical — not reimplemented), then restores their
 * original attempt counts in a `finally`, success or failure.
 *
 * Requires (env):
 *   PROD_DB                 — postgres connection string
 *   DELHIVERY_API_TOKEN, DELHIVERY_BASE_URL, DELHIVERY_CLIENT_NAME
 *
 * Needs a fresh `npm run build` first — imports from `dist/`, not `src/`.
 */
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, and, ne } from 'drizzle-orm'
import { shipments } from '../dist/db/schema.js'
import { manifestPending, resolveFulfilmentRule } from '../dist/services/fulfilment.js'
import { makeManifestSourceResolver } from '../dist/routes/fulfilmentAdmin.js'
import { createDelhiveryAdapter, modeFromBaseUrl } from '../dist/lib/delhivery.js'

const targetOrder = process.argv[2]
if (!targetOrder) {
  console.error('usage: node scripts/manifest-order.mjs <order_id>')
  process.exit(1)
}
for (const name of ['PROD_DB', 'DELHIVERY_API_TOKEN', 'DELHIVERY_BASE_URL']) {
  if (!process.env[name]) {
    console.error(`manifest-order: missing env ${name}`)
    process.exit(1)
  }
}

const client = new pg.Client({
  connectionString: process.env.PROD_DB,
  ssl: { rejectUnauthorized: false },
})
await client.connect()
const db = drizzle(client)

const rule = await resolveFulfilmentRule(db)

const target = await db.select().from(shipments).where(eq(shipments.orderId, targetOrder))
if (target.length === 0) {
  console.error(`manifest-order: no shipment found for ${targetOrder}`)
  await client.end()
  process.exit(1)
}
if (target[0].status !== 'pending_manifest') {
  console.error(
    `manifest-order: ${targetOrder} is '${target[0].status}', not 'pending_manifest' — nothing to do`
  )
  await client.end()
  process.exit(1)
}

// Snapshot + park every OTHER pending shipment above the attempt cap.
const others = await db
  .select({ orderId: shipments.orderId, manifestAttempts: shipments.manifestAttempts })
  .from(shipments)
  .where(and(eq(shipments.status, 'pending_manifest'), ne(shipments.orderId, targetOrder)))

for (const row of others) {
  await db
    .update(shipments)
    .set({ manifestAttempts: rule.manifestMaxAttempts })
    .where(eq(shipments.orderId, row.orderId))
}
console.log(
  `parked ${others.length} other pending order(s): ${others.map((o) => o.orderId).join(', ') || '(none)'}`
)

const adapter = createDelhiveryAdapter({
  apiToken: process.env.DELHIVERY_API_TOKEN,
  baseUrl: process.env.DELHIVERY_BASE_URL,
  clientName: process.env.DELHIVERY_CLIENT_NAME ?? '',
  mode: modeFromBaseUrl(process.env.DELHIVERY_BASE_URL),
})
const resolver = makeManifestSourceResolver(db, {})

try {
  const outcome = await manifestPending(db, adapter, rule, resolver, 25)
  console.log('sweep outcome', JSON.stringify(outcome))
} finally {
  for (const row of others) {
    await db
      .update(shipments)
      .set({ manifestAttempts: row.manifestAttempts })
      .where(eq(shipments.orderId, row.orderId))
  }
  console.log('restored parked orders to their original attempt counts')
}

const result = await db.select().from(shipments).where(eq(shipments.orderId, targetOrder))
console.log('result', JSON.stringify(result[0]))
await client.end()
