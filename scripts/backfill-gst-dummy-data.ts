#!/usr/bin/env tsx
/**
 * `npm run db:backfill-gst-dummy-data` — apply the current product-category
 * HSN heading + GST rate and re-project them into `catalog_items`
 * so cart/payments can see them (docs plan `there-s-a-big-strategy-validated-
 * clover.md` §2.9). The tax engine (migration 0025, `lib/gstTax.ts`, invoice
 * docVersion 2) is meant to be fully built, testable, and demoable on DUMMY
 * data — `legal.company.gstRegistered` stays `false` until the real GSTIN
 * lands, so running this makes not one invoice retitle. This backfill is what
 * makes the otherwise-dormant engine actually exercisable before that day.
 *
 * Rates reflect Notification 09/2025-Central Tax (Rate), effective
 * 22 September 2025: hair oil and shampoo under heading 3305 are 5%; the
 * other chapter-33 preparations sold here remain at 18%. Four-digit HSN
 * headings are intentionally used: they are supported by the authoritative
 * rate schedule without guessing a product's eight-digit tariff item from its
 * marketing name.
 *
 * Unknown categories fail closed before any row is written. A tax migration
 * must never invent an HSN/rate for a future product.
 *
 * Idempotent: every product is upserted to the SAME target values, so a
 * second run changes nothing observable. Touches only `hsn_code`/
 * `gst_rate_pct` on `products` (and their `catalog_items` projection) —
 * never `manufacturer_licence` (Phase 3) and never any `app_config` row
 * (that is `scripts/seed-config.ts`'s job, `legal.company.gstin`).
 *
 * Usage: `npm run db:backfill-gst-dummy-data` (add `--dry-run` to list what
 * would change without writing anything).
 */

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { products } from '../src/db/schema.js'
import { projectProduct } from '../src/services/catalogProjection.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface GstClassification {
  hsnCode: string
  gstRatePct: number
}

const GST_BY_CATEGORY: Readonly<Record<string, GstClassification>> = {
  'hair oil': { hsnCode: '3305', gstRatePct: 5 },
  shampoo: { hsnCode: '3305', gstRatePct: 5 },
  'hair serum': { hsnCode: '3305', gstRatePct: 18 },
  pomade: { hsnCode: '3305', gstRatePct: 18 },
  cream: { hsnCode: '3304', gstRatePct: 18 },
}

export interface GstBackfillResult {
  scanned: number
  updated: number
  alreadyCorrect: number
}

/** Seed every product's hsn_code/gst_rate_pct and re-project the ones that changed. */
export async function backfillGstDummyData(
  db: Db,
  options: { dryRun?: boolean; log?: (message: string) => void } = {}
): Promise<GstBackfillResult> {
  const log = options.log ?? (() => {})
  const rows = await db.select().from(products)
  const result: GstBackfillResult = { scanned: rows.length, updated: 0, alreadyCorrect: 0 }

  const classified = rows.map((product) => {
    const tax = GST_BY_CATEGORY[product.category.trim().toLowerCase()]
    if (!tax) {
      throw new Error(
        `backfillGstDummyData: no verified GST classification for category "${product.category}" (product ${product.id})`
      )
    }
    return { product, ...tax }
  })

  for (const { product, hsnCode, gstRatePct } of classified) {
    if (product.hsnCode === hsnCode && product.gstRatePct === gstRatePct) {
      result.alreadyCorrect += 1
      continue
    }

    if (options.dryRun) {
      log(
        `would update ${product.id} (${product.category}): ` +
          `hsn "${product.hsnCode || '∅'}" → "${hsnCode}", rate ${product.gstRatePct}% → ${gstRatePct}%`
      )
      result.updated += 1
      continue
    }

    // Same transaction as every other admin-style catalog write
    // (services/catalogAdmin.ts): the products row and its catalog_items
    // projection must never observably disagree (ARCHITECTURE.md rule 6).
    await db.transaction(async (tx: Tx) => {
      await tx.update(products).set({ hsnCode, gstRatePct }).where(eq(products.id, product.id))
      await projectProduct(tx, product.id)
    })
    log(`updated ${product.id} (${product.category}): hsn → "${hsnCode}", rate → ${gstRatePct}%`)
    result.updated += 1
  }

  return result
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:backfill-gst-dummy-data: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }
  const dryRun = process.argv.includes('--dry-run')

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    // Fail fast if migration 0025 hasn't been applied yet.
    await db.execute(sql`select hsn_code, gst_rate_pct from products limit 1`)

    // eslint-disable-next-line no-console
    const log = (message: string): void => console.log(`  ${message}`)
    const result = await backfillGstDummyData(db, { dryRun, log })

    // eslint-disable-next-line no-console
    console.log(
      `db:backfill-gst-dummy-data${dryRun ? ' (dry run)' : ''}: scanned ${result.scanned}, ` +
        `updated ${result.updated}, already correct ${result.alreadyCorrect}`
    )
  } finally {
    await pool.end()
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
