#!/usr/bin/env tsx
/**
 * `npm run db:live-test-sku -- --up` / `-- --down` — create (and retire) a
 * ₹1 product used to exercise a REAL payment end to end in Razorpay LIVE mode.
 *
 * Why this exists: UPI QR cannot be settled in Razorpay test mode. Scanning a
 * test-mode QR with a real UPI app does nothing, so the only way to prove the
 * QR flow works — QR renders, shopper pays, webhook fires, order flips to
 * `paid` — is to move real money once. This script makes that cost ₹1 of goods
 * instead of a full cart.
 *
 * **This writes to the LIVE catalog.** Unlike `seed-dev-dimensions.ts` there is
 * no dev-only guard, because running it anywhere else defeats the purpose. The
 * exposure it creates is real and is the reason `--up`/`--down` are separate
 * commands: while the product is active it is in `GET /v1/catalog` and any
 * shopper can add it to a cart. `products.active` is what gates the projection
 * into `catalog_items` (cart's price authority), so there is no way to have it
 * purchasable-by-you and invisible-to-everyone at the same time. Keep the
 * window to the length of the test and run `--down` immediately after.
 *
 * What `--up` does, in one transaction:
 *   1. upserts the product + its single variant into the DB-owned catalog
 *   2. re-projects into `catalog_items` via the normal `projectProduct` path,
 *      so price/weight/dims/HSN land exactly as an admin catalog save would
 *   3. writes a `sku_stock_policy` row with `mode = 'force_in'`, so the sku
 *      sells without a `store_stock` shelf and without touching real counts.
 *      Consequence (services/stock.ts §3): the cascade returns NO origin, so
 *      the paid-order decrement has nothing to take — deliberate — and the
 *      order has no pickup node. Do NOT run fulfilment against this order;
 *      refund it instead.
 *
 * `--down` deactivates the product, re-projects (which deactivates the sku in
 * `catalog_items`), and drops the policy row. Nothing is deleted: a cart line
 * or a payment snapshot referencing the sku must still resolve, same rule the
 * projection follows for a withdrawn variant.
 *
 * The charge is NOT ₹1. Shipping and GST are computed normally on top, so
 * expect a total in the tens of rupees. Refunding returns all of it; Razorpay's
 * fee on the round trip is not refunded, which is the actual cost of the test.
 *
 * Full procedure: docs/RUNBOOK-LIVE-PAYMENT-TEST.md.
 */

import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { categories, products, productVariants, skuStockPolicy } from '../src/db/schema.js'
import { projectProduct } from '../src/services/catalogProjection.js'

/** Stable ids — re-running `--up` corrects drift instead of creating a second one. */
const PRODUCT_ID = 'zz-live-payment-test'
const SLUG = 'live-payment-test'
const SKU = 'ZZ-LIVE-TEST-1'

/**
 * Sorted last on every surface, and named so nobody mistakes it for
 * merchandise if it is seen during the few minutes it is live.
 */
const NAME = 'TEST ITEM — NOT FOR SALE'
const SORT_ORDER = 99_999

/**
 * Manufacturer/packer/licence are left EMPTY on purpose. A blank manufacturer
 * makes the product inherit the store-wide legal entity in
 * `lib/invoiceDocument.ts`, which is truthful; inventing a licence number for
 * a throwaway sku would put a fabricated statutory declaration on a real tax
 * invoice (this order does generate one).
 */
const HSN_CODE = '3304'
const GST_RATE_PCT = 18

/** Dims must be > 0 — `catalog_items_dimensions_positive` refuses an unmeasured sku. */
const PACK = { weightG: 100, lengthCm: 10, widthCm: 10, heightCm: 10 } as const

/**
 * The category is an FK to `categories.slug`, so the sku has to live in one
 * that already exists. Lowest-sorted active category unless `--category` says
 * otherwise — the choice is cosmetic (this product is retired within minutes)
 * but it is printed so it is never a surprise.
 */
async function resolveCategory(db: Db, requested: string | undefined): Promise<string> {
  if (requested) {
    const [row] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(eq(categories.slug, requested))
      .limit(1)
    if (!row) throw new Error(`no such category: ${requested}`)
    return row.slug
  }

  const [row] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.active, true))
    .orderBy(asc(categories.sortOrder), asc(categories.slug))
    .limit(1)
  if (!row) throw new Error('no active category to attach the test product to')
  return row.slug
}

export async function bringUp(
  db: Db,
  opts: { category?: string | undefined; priceInr: number }
): Promise<{ sku: string; slug: string; category: string; priceInr: number }> {
  const category = await resolveCategory(db, opts.category)

  await db.transaction(async (tx) => {
    await tx
      .insert(products)
      .values({
        id: PRODUCT_ID,
        slug: SLUG,
        name: NAME,
        category,
        description: 'Internal payment-flow test item. Not a product. Do not order.',
        active: true,
        sortOrder: SORT_ORDER,
        hsnCode: HSN_CODE,
        gstRatePct: GST_RATE_PCT,
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          slug: SLUG,
          name: NAME,
          category,
          active: true,
          sortOrder: SORT_ORDER,
          hsnCode: HSN_CODE,
          gstRatePct: GST_RATE_PCT,
          updatedAt: new Date(),
        },
      })

    await tx
      .insert(productVariants)
      .values({
        sku: SKU,
        productId: PRODUCT_ID,
        size: '1 unit',
        priceInr: opts.priceInr,
        mrpInr: opts.priceInr,
        inStock: true,
        ...PACK,
      })
      .onConflictDoUpdate({
        target: productVariants.sku,
        set: {
          productId: PRODUCT_ID,
          size: '1 unit',
          priceInr: opts.priceInr,
          mrpInr: opts.priceInr,
          inStock: true,
          ...PACK,
          updatedAt: new Date(),
        },
      })

    // Same projection the admin catalog editor runs — price/weight/dims/HSN
    // reach cart through exactly one code path, never a hand-written insert.
    await projectProduct(tx, PRODUCT_ID)

    // force_in: sells with no shelf anywhere, so the test never disturbs a real
    // count. Weaker than `in_stock = false` by design, which is why the variant
    // above is explicitly in stock.
    await tx
      .insert(skuStockPolicy)
      .values({
        sku: SKU,
        mode: 'force_in',
        note: 'Live payment-flow test sku. Retire with `npm run db:live-test-sku -- --down`.',
        updatedBy: 'seed-live-test-sku',
      })
      .onConflictDoUpdate({
        target: skuStockPolicy.sku,
        set: { mode: 'force_in', updatedBy: 'seed-live-test-sku', updatedAt: new Date() },
      })
  })

  return { sku: SKU, slug: SLUG, category, priceInr: opts.priceInr }
}

export async function takeDown(db: Db): Promise<{ found: boolean }> {
  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, PRODUCT_ID))
    .limit(1)
  if (!existing) return { found: false }

  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(products.id, PRODUCT_ID))
    // Deactivates the sku in catalog_items. Rows stay — a cart line or a
    // payment cart_snapshot referencing the sku must still resolve.
    await projectProduct(tx, PRODUCT_ID)
    await tx.delete(skuStockPolicy).where(eq(skuStockPolicy.sku, SKU))
  })

  return { found: true }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const up = argv.includes('--up')
  const down = argv.includes('--down')
  if (up === down) {
    console.error(
      'db:live-test-sku: pass exactly one of --up | --down [--category <slug>] [--price <inr>]'
    )
    process.exit(1)
  }

  const priceRaw = flagValue(argv, '--price') ?? '1'
  const priceInr = Number(priceRaw)
  if (!Number.isInteger(priceInr) || priceInr < 1) {
    // Razorpay rejects anything under ₹1, and prices are whole rupees here.
    console.error(`db:live-test-sku: --price must be a whole rupee amount >= 1 (got ${priceRaw})`)
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:live-test-sku: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    if (up) {
      const r = await bringUp(db, { category: flagValue(argv, '--category'), priceInr })
      // eslint-disable-next-line no-console
      console.log(
        `db:live-test-sku: sku ${r.sku} LIVE at ₹${r.priceInr} in category "${r.category}" (/products/${r.slug}).\n` +
          'It is in the public catalog right now. Shipping + GST are charged on top, so the order total is not ₹1.\n' +
          'Do not fulfil this order — it has no stock origin. Refund it via POST /payments/orders/:orderId/cancel,\n' +
          'then run: npm run db:live-test-sku -- --down'
      )
    } else {
      const r = await takeDown(db)
      // eslint-disable-next-line no-console
      console.log(
        r.found
          ? `db:live-test-sku: ${SKU} deactivated and its force_in policy removed. Rows kept for cart/payment references.`
          : 'db:live-test-sku: nothing to retire — the test product does not exist.'
      )
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
