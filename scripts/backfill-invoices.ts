#!/usr/bin/env tsx
/**
 * `npm run db:backfill-invoices` — issue invoices for orders that were paid
 * before the invoice system existed, and for any order whose live issuance
 * failed (the paid-order hook swallows its errors so a payment can never be
 * rolled back by one).
 *
 * Two properties make this safe to run whenever, including against production:
 *
 * 1. **Idempotent.** `issueInvoiceForOrder` returns the existing invoice for an
 *    order that already has one, and consumes no number doing so. A second run
 *    inserts nothing.
 * 2. **Chronological.** Orders are processed oldest-first (`paidAt`, then
 *    `createdAt`), so the retroactive numbers run in the same direction as the
 *    sales they describe. A register whose numbers zig-zag through time is the
 *    first thing an auditor questions.
 *
 * Backfilled invoices are marked `skipped_backfill` and are **never emailed**:
 * a shopper receiving an invoice for a months-old order reads it as a fresh
 * charge. They are fully visible and printable in the admin panel, which is
 * what they exist for.
 *
 * Each order is issued in its OWN transaction, so one bad row cannot take the
 * whole run — or anyone else's sequence numbers — down with it.
 *
 * Usage: `npm run db:backfill-invoices` (add `--dry-run` to list what would be
 * issued without writing anything).
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { issueInvoiceForOrder, resolveInvoiceContext } from '../src/routes/invoices.js'
import { getInvoiceByOrderId } from '../src/services/invoices.js'
import { listOrdersForInvoiceBackfill } from '../src/services/payments.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface BackfillResult {
  scanned: number
  issued: number
  alreadyIssued: number
  failed: number
}

/**
 * Issue an invoice for every `paid`/`refunded` order that lacks one.
 *
 * `issuedAt` is the order's own `paidAt` (falling back to `createdAt`), NOT
 * today: an invoice dated months after the sale it records would put the
 * document in the wrong financial year, and its number in the wrong series.
 */
export async function backfillInvoices(
  db: Db,
  options: { dryRun?: boolean; log?: (message: string) => void } = {}
): Promise<BackfillResult> {
  const log = options.log ?? (() => {})
  // Resolved once for the whole run rather than per order — it is the same
  // config for all of them, and this is the only read that would otherwise
  // repeat thousands of times.
  const context = await resolveInvoiceContext(db)
  const orders = await listOrdersForInvoiceBackfill(db)

  const result: BackfillResult = { scanned: orders.length, issued: 0, alreadyIssued: 0, failed: 0 }

  for (const order of orders) {
    const existing = await getInvoiceByOrderId(db, order.orderId)
    if (existing) {
      result.alreadyIssued += 1
      continue
    }

    const issuedAt = order.paidAt ?? order.createdAt
    if (options.dryRun) {
      log(`would issue: ${order.orderId} (${issuedAt.toISOString()}, ₹${order.totalInr})`)
      result.issued += 1
      continue
    }

    try {
      const row = await db.transaction((tx: Tx) =>
        issueInvoiceForOrder(tx, order, { issuedAt, backfill: true, context })
      )
      log(`issued ${row.invoiceNumber} for ${order.orderId}`)
      result.issued += 1
    } catch (err) {
      // Per-order isolation: log and keep going. A single malformed snapshot
      // must not stop the other 900 orders from getting their documents.
      log(`FAILED ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`)
      result.failed += 1
    }
  }

  return result
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:backfill-invoices: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }
  const dryRun = process.argv.includes('--dry-run')

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    // Fail fast if migration 0021 hasn't been applied yet.
    await db.execute(sql`select 1 from invoices limit 1`)

    // eslint-disable-next-line no-console
    const log = (message: string): void => console.log(`  ${message}`)
    const result = await backfillInvoices(db, { dryRun, log })

    // eslint-disable-next-line no-console
    console.log(
      `db:backfill-invoices${dryRun ? ' (dry run)' : ''}: scanned ${result.scanned}, ` +
        `issued ${result.issued}, already had one ${result.alreadyIssued}, failed ${result.failed}`
    )
    if (result.failed > 0) process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
