#!/usr/bin/env tsx
/**
 * `npm run db:color-variants` — give every listed piece one variant per
 * filament colour (lib/filamentColors.ts), next to its as-photographed variant.
 *
 * The as-photographed variant (`color = null`) is the template: price, MRP,
 * pack and stock flag are copied from it, so re-running after a price change
 * brings every colour back in line. Its own row is never touched. Stable skus
 * (`TT-ELEDIYA-STD` → `TT-ELEDIYA-RED`) mean there is never a second copy.
 *
 * Custom figures and miniatures are left out: their colours are agreed per
 * order. So is the live-payment test sku.
 *
 * Each colour gets a `force_in` stock policy because it is printed to order:
 * there is no shelf to count, so the paid order has no stock origin and the
 * studio ships it by hand, as with custom figures.
 */

import { and, asc, eq, isNull, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { products, productVariants, skuStockPolicy } from '../src/db/schema.js'
import { CUSTOM_FIGURE_CATEGORY } from '../src/lib/customFigures.js'
import { FILAMENT_COLORS } from '../src/lib/filamentColors.js'
import { projectProduct } from '../src/services/catalogProjection.js'

const EXCLUDED_CATEGORIES = ['custom', CUSTOM_FIGURE_CATEGORY]
const EXCLUDED_PRODUCTS = ['zz-live-payment-test']

export function colorSku(baseSku: string, skuCode: string): string {
  return `${baseSku.replace(/-STD$/, '')}-${skuCode}`
}

export async function seedColorVariants(db: Db): Promise<{ products: number; variants: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          notInArray(products.category, EXCLUDED_CATEGORIES),
          notInArray(products.id, EXCLUDED_PRODUCTS)
        )
      )

    let seededProducts = 0
    let seededVariants = 0
    for (const { id } of rows) {
      const [base] = await tx
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.productId, id), isNull(productVariants.color)))
        .orderBy(asc(productVariants.sortOrder))
        .limit(1)
      if (!base) continue

      for (const [index, color] of FILAMENT_COLORS.entries()) {
        const sku = colorSku(base.sku, color.skuCode)
        const variant = {
          productId: id,
          size: base.size,
          sizeMl: base.sizeMl,
          color: color.slug,
          priceInr: base.priceInr,
          mrpInr: base.mrpInr,
          inStock: base.inStock,
          weightG: base.weightG,
          lengthCm: base.lengthCm,
          widthCm: base.widthCm,
          heightCm: base.heightCm,
          sortOrder: base.sortOrder + index + 1,
        }
        await tx
          .insert(productVariants)
          .values({ sku, ...variant })
          .onConflictDoUpdate({
            target: productVariants.sku,
            set: { ...variant, updatedAt: new Date() },
          })
        seededVariants += 1
      }

      await projectProduct(tx, id)

      for (const color of FILAMENT_COLORS) {
        const sku = colorSku(base.sku, color.skuCode)
        await tx
          .insert(skuStockPolicy)
          .values({
            sku,
            mode: 'force_in',
            note: 'Printed to order. Seeded by `npm run db:color-variants`.',
            updatedBy: 'seed-color-variants',
          })
          .onConflictDoUpdate({
            target: skuStockPolicy.sku,
            set: { mode: 'force_in', updatedBy: 'seed-color-variants', updatedAt: new Date() },
          })
      }
      seededProducts += 1
    }
    return { products: seededProducts, variants: seededVariants }
  })
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:color-variants: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const summary = await seedColorVariants(drizzle(pool) as unknown as Db)
    // eslint-disable-next-line no-console
    console.log(
      `db:color-variants: ${summary.variants} colour variants across ${summary.products} products.`
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
