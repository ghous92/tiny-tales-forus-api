/**
 * Consistency check for the catalog's second invariant: `catalog_items` — the
 * sku-keyed read model that cart, payments and shipping treat as the price and
 * weight authority — must agree with the rich catalog (`products` ×
 * `product_variants`) it is projected from.
 *
 * Why this exists as a script rather than a constraint. The catalog has two
 * invariants that a write outside `services/catalogAdmin.ts` can break:
 *
 *   1. the `catalog_version` counter (the `GET /v1/catalog` ETag) must move
 *   2. `catalog_items` must be re-projected
 *
 * (1) is now enforced by a database trigger (migration 0017) — nothing can
 * bypass it. (2) cannot be: the projection applies `lib/pricing.ts`'s seasonal
 * discount, and reimplementing that formula in SQL would split the "display
 * price == charged price" rule across two languages — the exact thing
 * `test/arch/shipping-containment.test.ts` exists to prevent for shipping. So
 * this invariant is DETECTED rather than enforced, and the failure it detects
 * is the expensive one: a hand-edited price that the storefront shows but the
 * cart does not charge.
 *
 *   npm run catalog:doctor          # report drift, exit 1 if any
 *   npm run catalog:doctor -- --fix # re-project the affected products
 *
 * `--fix` is safe to run at any time: `catalog_items` is derived data, so
 * re-projecting only ever restores it to what the catalog already says. It
 * runs in one transaction, so the version bumps once.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { catalogItems, products, productVariants } from '../src/db/schema.js'
import { effectivePriceInr } from '../src/lib/pricing.js'
import { isPurchasable, projectProduct } from '../src/services/catalogProjection.js'

/** One disagreement between the catalog and its projection. */
export interface Drift {
  sku: string
  productId: string
  /** `missing` — no catalog_items row at all; cart cannot resolve the sku. */
  kind: 'missing' | 'stale_field' | 'orphan_still_active'
  field?: string
  expected?: unknown
  actual?: unknown
}

export interface DoctorReport {
  variantsChecked: number
  itemsChecked: number
  drift: Drift[]
  /** Product ids needing a re-projection — the input to `--fix`. */
  affectedProductIds: string[]
}

/** product.images.main.grid, or '' — mirrors catalogProjection.ts. */
function gridUrl(images: unknown): string {
  return (images as { main?: { grid?: string } } | null)?.main?.grid ?? ''
}

/**
 * Compare every live variant against its `catalog_items` row, and every
 * `catalog_items` row against the variants that still exist. Read-only.
 */
export async function diagnoseCatalog(db: Db): Promise<DoctorReport> {
  const [productRows, variantRows, itemRows] = await Promise.all([
    db.select().from(products),
    db.select().from(productVariants),
    db.select().from(catalogItems),
  ])

  const productById = new Map(productRows.map((p) => [p.id, p]))
  const itemBySku = new Map(itemRows.map((i) => [i.sku, i]))
  const liveSkus = new Set(variantRows.map((v) => v.sku))

  const drift: Drift[] = []
  const affected = new Set<string>()

  for (const v of variantRows) {
    const product = productById.get(v.productId)
    // A variant whose product is gone is an FK violation, not projection
    // drift — the schema already forbids it; nothing to diagnose here.
    if (!product) continue

    const item = itemBySku.get(v.sku)
    if (!item) {
      drift.push({ sku: v.sku, productId: v.productId, kind: 'missing' })
      affected.add(v.productId)
      continue
    }

    // The full projected tuple, derived exactly as catalogProjection.ts does.
    const expected: Record<string, unknown> = {
      productId: product.id,
      name: product.name,
      size: v.size,
      priceInr: effectivePriceInr(v.priceInr ?? 0, product.seasonalDiscountPct),
      weightG: v.weightG,
      lengthCm: v.lengthCm,
      widthCm: v.widthCm,
      heightCm: v.heightCm,
      imageUrl: gridUrl(product.images),
      active: isPurchasable(product, v),
    }

    for (const [field, want] of Object.entries(expected)) {
      const got = (item as unknown as Record<string, unknown>)[field]
      if (got !== want) {
        drift.push({
          sku: v.sku,
          productId: v.productId,
          kind: 'stale_field',
          field,
          expected: want,
          actual: got,
        })
        affected.add(v.productId)
      }
    }
  }

  for (const item of itemRows) {
    // A sku whose variant was deleted keeps its row (cart lines must still
    // resolve) but must be inactive, or it stays purchasable forever.
    if (!liveSkus.has(item.sku) && item.active) {
      drift.push({ sku: item.sku, productId: item.productId, kind: 'orphan_still_active' })
      affected.add(item.productId)
    }
  }

  return {
    variantsChecked: variantRows.length,
    itemsChecked: itemRows.length,
    drift,
    affectedProductIds: [...affected].sort(),
  }
}

/**
 * Re-project the drifted products in ONE transaction — so the catalog version
 * bumps once and every client revalidates a single time.
 */
export async function repairCatalog(db: Db, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return
  await db.transaction(async (tx) => {
    for (const id of productIds) {
      await projectProduct(tx, id)
    }
  })
}

/** Human-readable drift line. */
function formatDrift(d: Drift): string {
  switch (d.kind) {
    case 'missing':
      return `  ! ${d.sku} (${d.productId}): no catalog_items row — cart cannot resolve this sku`
    case 'orphan_still_active':
      return `  ! ${d.sku} (${d.productId}): variant deleted but catalog_items row still active`
    case 'stale_field':
      return `  ! ${d.sku} (${d.productId}): ${d.field} is ${JSON.stringify(d.actual)}, catalog says ${JSON.stringify(d.expected)}`
  }
}

// --- CLI wrapper (skipped when imported by tests) ----------------------------

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix')
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('catalog-doctor: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString })
  const db = drizzle(pool) as unknown as Db
  try {
    const report = await diagnoseCatalog(db)
    console.error(
      `catalog-doctor: checked ${report.variantsChecked} variants against ${report.itemsChecked} catalog_items rows`
    )

    if (report.drift.length === 0) {
      console.error('catalog-doctor: no drift — catalog_items agrees with the catalog')
      return
    }

    for (const d of report.drift) console.error(formatDrift(d))
    console.error(
      `catalog-doctor: ${report.drift.length} problem(s) across ${report.affectedProductIds.length} product(s)`
    )

    if (!fix) {
      console.error('catalog-doctor: re-run with --fix to re-project the affected products')
      process.exitCode = 1
      return
    }

    await repairCatalog(db, report.affectedProductIds)
    const after = await diagnoseCatalog(db)
    if (after.drift.length > 0) {
      // Re-projection is total, so anything left is a bug in the projection
      // itself (or a concurrent write) — do not report success.
      console.error(`catalog-doctor: ${after.drift.length} problem(s) SURVIVED --fix`)
      for (const d of after.drift) console.error(formatDrift(d))
      process.exitCode = 1
      return
    }
    console.error(
      `catalog-doctor: re-projected ${report.affectedProductIds.length} product(s) — clean`
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
