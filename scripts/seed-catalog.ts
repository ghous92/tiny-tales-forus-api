#!/usr/bin/env tsx
/**
 * `npm run catalog:seed -- <path-or-url to catalog.v2.json>` — one-time import
 * of the rich mobile catalog (schema v2) into the DB-owned catalog tables
 * (`categories`, `products`, `product_variants`). This is the INVERSION of the
 * old flow: the catalog used to live only in the app bundle and get synced
 * into the thin `catalog_items` read model; now the DB is the source and the
 * app fetches `GET /v1/catalog`.
 *
 * Idempotent: every row is upserted by primary key, so re-running against the
 * same file changes nothing observable. It never deletes — unpublishing is a
 * separate admin action (`active = false`). Categories are derived from the
 * product set, with labels/order supplied by CATEGORY_DEFS (mirrors
 * mobile/src/lib/categories.ts). The catalog version is bumped once at the end.
 *
 * The core (`seedCatalog`) takes a `Db` and already-parsed input so it's
 * unit-testable against PGlite; the top-level code is just the CLI wrapper.
 * Exits non-zero on malformed input WITHOUT touching the database (parse fully
 * before any db call), matching scripts/catalog-sync.ts.
 */

import { readFile } from 'node:fs/promises'

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { z } from 'zod'

import type { Db } from '../src/db/client.js'
import { projectProduct } from '../src/services/catalogProjection.js'
import { categories, products, productVariants } from '../src/db/schema.js'

/**
 * Category display metadata, in storefront order: the three Tiny Tales
 * collections. Any product category not listed here still gets a category
 * row, labelled from its slug.
 */
export const CATEGORY_DEFS: { slug: string; label: string }[] = [
  { slug: 'devotional', label: 'Devotional' },
  { slug: 'characters', label: 'Characters' },
  { slug: 'custom', label: 'Custom miniatures' },
]

// --- Input validation (the full v2 shape this importer consumes) -------------

const ImageSetSchema = z.object({
  thumb: z.string(),
  grid: z.string(),
  pdp: z.string(),
  zoom: z.string(),
})

const VariantSchema = z.object({
  sku: z.string().min(1),
  asin: z.string().default(''),
  size: z.string().min(1),
  size_ml: z.number().int().min(0).default(0),
  color: z.string().min(1).nullish(),
  /** Omitted or null ⇒ unpriced ("Coming soon"). Never invent a price. */
  price_inr: z.number().int().min(0).nullish(),
  mrp_inr: z.number().int().min(0).default(0),
  in_stock: z.boolean().default(true),
  /** Legal Metrology "best before" — see src/db/schema.ts productVariants doc. */
  best_before_mode: z.enum(['date', 'printed_on_pack']).default('printed_on_pack'),
  best_before_date: z.string().nullish(),
})

const HighlightSchema = z.object({
  icon: z.string(),
  label: z.string(),
  value: z.string(),
})

const ProductSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().default(''),
  bullets: z.array(z.string()).default([]),
  highlights: z.array(HighlightSchema).default([]),
  images: z.object({
    main: ImageSetSchema,
    gallery: z.array(ImageSetSchema).default([]),
    hero: ImageSetSchema.optional(),
  }),
  variants: z.array(VariantSchema).min(1),
  in_stock: z.boolean().default(true),
  new_until: z.string().optional(),
  // Merchandising — optional in the file; default applied in the row mapping so
  // a file (or test literal) may omit them and older catalog files still parse.
  is_best_seller: z.boolean().optional(),
  is_recommended: z.boolean().optional(),
  seasonal_discount_pct: z.number().int().min(0).max(90).optional(),
  // Legal Metrology mandatory PDP disclosures — optional here (older/partial
  // catalog files still import) but the ADMIN UI blocks publishing a product
  // active with these still blank (see services/catalogAdmin.ts).
  manufacturer_name: z.string().default(''),
  manufacturer_address: z.string().default(''),
  country_of_origin: z.string().default('India'),
  consumer_care_contact: z.string().default(''),
})

export const CatalogFileSchema = z.object({
  products: z.array(ProductSchema).min(1),
})

export type CatalogFile = z.infer<typeof CatalogFileSchema>

export interface SeedSummary {
  categories: number
  products: number
  variants: number
}

/**
 * Import categories, products, and variants in one transaction. Categories are
 * the union of CATEGORY_DEFS and every distinct `product.category` in the file
 * (an unlisted category is labelled from its slug, title-cased). `sortOrder`
 * follows CATEGORY_DEFS order; products keep file order; variants sort by
 * size_ml. Everything upserts by primary key — idempotent, never deletes.
 */
export async function seedCatalog(db: Db, file: CatalogFile): Promise<SeedSummary> {
  // Derive the full category set: defs first (for label + order), then any
  // extra category a product references that the defs didn't list.
  const defBySlug = new Map(CATEGORY_DEFS.map((d, i) => [d.slug, { ...d, order: i }]))
  const catSlugs = new Set(file.products.map((p) => p.category))
  const catRows = [...catSlugs].map((slug) => {
    const def = defBySlug.get(slug)
    return {
      slug,
      label: def?.label ?? titleCase(slug),
      sortOrder: def?.order ?? 100,
    }
  })

  const productRows = file.products.map((p, index) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    description: p.description,
    bullets: p.bullets,
    highlights: p.highlights,
    images: p.images,
    isBestSeller: p.is_best_seller ?? false,
    isRecommended: p.is_recommended ?? false,
    seasonalDiscountPct: p.seasonal_discount_pct ?? 0,
    sortOrder: index,
    newUntil: p.new_until ? new Date(p.new_until) : null,
    active: true,
    manufacturerName: p.manufacturer_name,
    manufacturerAddress: p.manufacturer_address,
    countryOfOrigin: p.country_of_origin,
    consumerCareContact: p.consumer_care_contact,
  }))

  const variantRows = file.products.flatMap((p) =>
    [...p.variants]
      .sort((a, b) => a.size_ml - b.size_ml)
      .map((v, index) => ({
        sku: v.sku,
        productId: p.id,
        asin: v.asin,
        size: v.size,
        sizeMl: v.size_ml,
        color: v.color ?? null,
        priceInr: v.price_inr ?? null,
        mrpInr: v.mrp_inr,
        inStock: v.in_stock,
        sortOrder: index,
        bestBeforeMode: v.best_before_mode,
        bestBeforeDate: v.best_before_date ? new Date(v.best_before_date) : null,
      }))
  )

  await db.transaction(async (tx) => {
    for (const row of catRows) {
      await tx
        .insert(categories)
        .values(row)
        .onConflictDoUpdate({
          target: categories.slug,
          set: { label: row.label, sortOrder: row.sortOrder, updatedAt: new Date() },
        })
    }
    for (const row of productRows) {
      await tx
        .insert(products)
        .values(row)
        .onConflictDoUpdate({
          target: products.id,
          set: {
            slug: row.slug,
            name: row.name,
            category: row.category,
            description: row.description,
            bullets: row.bullets,
            highlights: row.highlights,
            images: row.images,
            isBestSeller: row.isBestSeller,
            isRecommended: row.isRecommended,
            seasonalDiscountPct: row.seasonalDiscountPct,
            sortOrder: row.sortOrder,
            newUntil: row.newUntil,
            active: true,
            manufacturerName: row.manufacturerName,
            manufacturerAddress: row.manufacturerAddress,
            countryOfOrigin: row.countryOfOrigin,
            consumerCareContact: row.consumerCareContact,
            updatedAt: new Date(),
          },
        })
    }
    for (const row of variantRows) {
      await tx
        .insert(productVariants)
        .values(row)
        .onConflictDoUpdate({
          target: productVariants.sku,
          set: {
            productId: row.productId,
            asin: row.asin,
            size: row.size,
            sizeMl: row.sizeMl,
            color: row.color,
            priceInr: row.priceInr,
            mrpInr: row.mrpInr,
            inStock: row.inStock,
            sortOrder: row.sortOrder,
            bestBeforeMode: row.bestBeforeMode,
            bestBeforeDate: row.bestBeforeDate,
            updatedAt: new Date(),
          },
        })
    }
    // Project each product into catalog_items (cart's price authority) so a
    // fresh seed leaves the read model self-consistent without a separate sync.
    for (const p of productRows) {
      await projectProduct(tx, p.id)
    }
  })

  return { categories: catRows.length, products: productRows.length, variants: variantRows.length }
}

/** "hair oil" -> "Hair Oil". Only used for categories absent from CATEGORY_DEFS. */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
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
    throw new Error(`catalog:seed: input is not valid JSON: ${(err as Error).message}`)
  }

  const parsed = CatalogFileSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`catalog:seed: input failed validation:\n${issues}`)
  }
  return parsed.data
}

// --- CLI wrapper (skipped when imported by tests) ----------------------------

async function main(): Promise<void> {
  const pathOrUrl = process.argv[2]
  if (!pathOrUrl) {
    console.error('Usage: npm run catalog:seed -- <path-or-url to catalog.v2.json>')
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('catalog:seed: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const file = await loadCatalogFile(pathOrUrl)

  const pool = new pg.Pool({ connectionString })
  const db = drizzle(pool) as unknown as Db
  try {
    const summary = await seedCatalog(db, file)
    // eslint-disable-next-line no-console
    console.log(
      `catalog:seed: ${summary.categories} categories, ${summary.products} products, ${summary.variants} variants`
    )
  } finally {
    await pool.end()
  }
}

// Only run the CLI when executed directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
