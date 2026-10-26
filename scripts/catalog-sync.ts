#!/usr/bin/env tsx
/**
 * `npm run catalog:sync -- <path-or-url to catalog.v2.json>` — syncs
 * `catalog_items` from the laanya-shop generated catalog (SPEC-V2.md §3).
 * Upserts every variant by sku (product-level id/name/image, variant-level
 * size/price), then deactivates (never deletes) any db sku absent from the
 * file. Idempotent: running twice against the same file upserts everything
 * again but changes nothing observable, and deactivates nothing extra.
 *
 * Only the fields this sync consumes are Zod-validated — the file has many
 * more fields (bullets, highlights, description, …) we don't touch. Exits
 * non-zero on malformed input WITHOUT touching the database (parse fully
 * before any db call).
 *
 * The core logic (`syncCatalog`) takes a `Db` and already-parsed input, so
 * it's unit-testable against PGlite; this file's top-level code is just the
 * CLI wrapper: read the arg, load JSON (file path or http(s) URL), parse env,
 * connect, call it, print the summary.
 */

import { readFile } from 'node:fs/promises'

import { and, eq, notInArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { z } from 'zod'

import type { Db } from '../src/db/client.js'
import { catalogItems } from '../src/db/schema.js'

/** Only the fields catalog-sync consumes — see mobile/src/lib/types.ts for the full shape. */
const VariantSchema = z.object({
  sku: z.string().min(1),
  size: z.string().min(1),
  price_inr: z.number().int().min(0),
  /**
   * Packed weight in grams. The generated catalog file does not carry this
   * today; it is accepted so that if it ever does, the value flows through
   * instead of being silently dropped (docs/SPEC-SHIPPING.md §4.2 — this is
   * the SECOND writer of `catalog_items`, and it uses an explicit column list).
   */
  weight_g: z.number().int().min(0).max(50000).optional(),
})

const ProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  images: z.object({
    main: z.object({
      grid: z.string(),
    }),
  }),
  variants: z.array(VariantSchema),
})

export const CatalogFileSchema = z.object({
  products: z.array(ProductSchema),
})

export type CatalogFile = z.infer<typeof CatalogFileSchema>

export interface SyncSummary {
  upserted: number
  deactivated: number
}

/**
 * Upsert every variant by sku, then set `active = false` on any db sku not
 * present in this file's variant list. A single transaction: either the
 * whole sync lands or none of it does.
 */
export async function syncCatalog(db: Db, file: CatalogFile): Promise<SyncSummary> {
  const skusInFile: string[] = []
  const rows = file.products.flatMap((product) =>
    product.variants.map((variant) => {
      skusInFile.push(variant.sku)
      return {
        sku: variant.sku,
        productId: product.id,
        name: product.name,
        size: variant.size,
        priceInr: variant.price_inr,
        weightG: variant.weight_g,
        imageUrl: product.images.main.grid,
        active: true,
      }
    })
  )

  return db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(catalogItems)
        .values({ ...row, weightG: row.weightG ?? 0 })
        .onConflictDoUpdate({
          target: catalogItems.sku,
          set: {
            productId: row.productId,
            name: row.name,
            size: row.size,
            priceInr: row.priceInr,
            // Only overwrite the weight when the file actually carries one.
            // A file without weights must NOT reset a weight an operator
            // measured and entered through the admin catalog.
            ...(row.weightG !== undefined && { weightG: row.weightG }),
            imageUrl: row.imageUrl,
            active: true,
            updatedAt: new Date(),
          },
        })
    }

    // Only rows currently active count as "newly deactivated" — re-running
    // against the same file must report 0 deactivations, not the same rows
    // every time. `notInArray` with an empty list has no SQL-safe universal
    // form across drivers, so an empty file (no skus at all) targets every
    // active row instead — still "any db sku absent from the file", just the
    // whole table.
    const deactivated = await tx
      .update(catalogItems)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(catalogItems.active, true),
          skusInFile.length > 0 ? notInArray(catalogItems.sku, skusInFile) : sql`true`
        )
      )
      .returning({ sku: catalogItems.sku })

    return { upserted: rows.length, deactivated: deactivated.length }
  })
}

/** Loads and Zod-validates the catalog file from a local path or an http(s) URL. */
async function loadCatalogFile(pathOrUrl: string): Promise<CatalogFile> {
  const raw = /^https?:\/\//.test(pathOrUrl)
    ? await (await fetch(pathOrUrl)).text()
    : await readFile(pathOrUrl, 'utf8')

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`catalog-sync: "${pathOrUrl}" is not valid JSON: ${(err as Error).message}`)
  }

  const parsed = CatalogFileSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`catalog-sync: malformed catalog file:\n${issues}`)
  }
  return parsed.data
}

async function main(): Promise<void> {
  const pathOrUrl = process.argv[2]
  if (!pathOrUrl) {
    console.error('Usage: npm run catalog:sync -- <path-or-url to catalog.v2.json>')
    process.exit(1)
  }

  // Parse and validate BEFORE touching the db — malformed input must exit
  // non-zero without any db call.
  let file: CatalogFile
  try {
    file = await loadCatalogFile(pathOrUrl)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
    return
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('catalog-sync: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const summary = await syncCatalog(db, file)
    // eslint-disable-next-line no-console
    console.log(`catalog-sync: upserted ${summary.upserted}, deactivated ${summary.deactivated}`)
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
