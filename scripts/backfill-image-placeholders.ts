#!/usr/bin/env tsx
/**
 * `npm run catalog:backfill-placeholders` — stamps a blur-up placeholder
 * (`images.main.lqip`, and each `images.gallery[].lqip`) onto every active
 * product that doesn't have one.
 *
 * WHY: the app's home grid used to have nothing to paint until a ~22KB JPEG
 * arrived over the network. On a slow connection that is seconds of empty
 * tiles, and on a cold offline install it is empty forever — the bundled
 * snapshot ships URLs, not pixels. A `lqip` is a ~24px WebP inlined as a
 * base64 `data:` URI, so it rides inside the catalog blob the app already has
 * cached and costs no request of its own. expo-image renders it as the
 * `placeholder` and cross-fades to the real image.
 *
 * HOW: the image worker already stores one master per image in R2 and derives
 * display sizes on request, so the placeholder is just another variant
 * (`/img/<key>/lqip`, added alongside `card`). This script fetches that variant
 * with `Accept: image/webp`, base64s the bytes, and writes them into the
 * `products.images` jsonb. No pixel decoding happens here or in the Worker —
 * neither runtime has an image decoder, which is why the placeholder is a tiny
 * real image rather than a ThumbHash/BlurHash.
 *
 * SAFETY: idempotent (skips images that already have a `lqip` unless --force);
 * transactional per product; bumps the catalog version ONCE at the end, and
 * only if something actually changed, so the app sees a single new ETag rather
 * than one per product. A placeholder that fails to fetch is logged and
 * skipped — a missing `lqip` is a degraded card, never a broken one.
 *
 * Flags:
 *   --force      re-fetch and overwrite placeholders that already exist
 *   --dry-run    report what would change, write nothing
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { products } from '../src/db/schema.js'

/** One photo's derived sizes, as stored in the `products.images` jsonb. */
interface ImageSet {
  thumb: string
  grid: string
  pdp: string
  zoom: string
  lqip?: string
}

interface ProductImages {
  main: ImageSet
  gallery: ImageSet[]
  hero?: ImageSet
}

/**
 * Refuse to inline anything larger than this. A 24px WebP is normally 300-500
 * bytes; base64 adds ~33%. If the worker ever hands back something big (a
 * misrouted full-size render, an HTML error page that happens to be bytes) we
 * must not weld it into the catalog blob every client downloads.
 */
const MAX_PLACEHOLDER_BYTES = 4 * 1024

/** Per-image fetch timeout. The whole run is bounded by this times the image count. */
const FETCH_TIMEOUT_MS = 15_000

export interface BackfillSummary {
  productsScanned: number
  productsUpdated: number
  placeholdersWritten: number
  skippedExisting: number
  failed: number
}

/**
 * Derive the `lqip` variant URL from a sibling variant URL. The worker's route
 * is `/img/<key>/<variant>`, so only the last path segment changes. Returns
 * null for a URL that isn't in that shape (an externally hosted image), which
 * the caller treats as "no placeholder available".
 */
export function lqipUrlFor(imageSet: ImageSet): string | null {
  // `pdp` is the variant every product is guaranteed to have populated.
  const source = imageSet.pdp || imageSet.grid || imageSet.thumb
  if (!source) return null
  const match = source.match(/^(https?:\/\/[^?#]*\/img\/[^/]+)\/[a-z]+$/)
  return match ? `${match[1]}/lqip` : null
}

/** Fetch the lqip variant and return it as a `data:` URI, or null on any failure. */
async function fetchPlaceholder(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // Explicit Accept: the worker content-negotiates, and WebP is the smallest
    // format every target (expo-image on iOS + Android, every browser) decodes.
    // Without this header it would hand back JPEG.
    const response = await fetch(url, {
      headers: { Accept: 'image/webp,image/*' },
      signal: controller.signal,
    })
    if (!response.ok) {
      console.error(`  ! ${url} -> HTTP ${response.status}`)
      return null
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) {
      console.error(`  ! ${url} -> non-image content-type "${contentType}"`)
      return null
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) {
      console.error(`  ! ${url} -> empty body`)
      return null
    }
    if (bytes.byteLength > MAX_PLACEHOLDER_BYTES) {
      console.error(
        `  ! ${url} -> ${bytes.byteLength} bytes exceeds the ${MAX_PLACEHOLDER_BYTES}-byte inline cap`
      )
      return null
    }

    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
  } catch (error) {
    console.error(`  ! ${url} -> ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Backfill placeholders across the active catalog. Returns a summary; throws
 * only on a database failure (image fetch failures are counted, not fatal).
 */
export async function backfillImagePlaceholders(
  db: Db,
  options: { force?: boolean; dryRun?: boolean } = {}
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    productsScanned: 0,
    productsUpdated: 0,
    placeholdersWritten: 0,
    skippedExisting: 0,
    failed: 0,
  }

  const rows = await db
    .select({ id: products.id, images: products.images })
    .from(products)
    .where(eq(products.active, true))

  /** Products whose `images` changed, applied together after the loop. */
  const pending: { id: string; images: ProductImages }[] = []

  for (const row of rows) {
    summary.productsScanned += 1
    const images = row.images as ProductImages
    if (!images?.main) continue

    // main + gallery + hero share one code path; `hero` is optional.
    const sets: ImageSet[] = [images.main, ...(images.gallery ?? [])]
    if (images.hero) sets.push(images.hero)

    let changed = false
    for (const set of sets) {
      if (set.lqip && !options.force) {
        summary.skippedExisting += 1
        continue
      }
      const url = lqipUrlFor(set)
      if (!url) {
        summary.failed += 1
        console.error(`  ! ${row.id}: no /img/<key>/<variant> URL to derive a placeholder from`)
        continue
      }
      const dataUri = await fetchPlaceholder(url)
      if (!dataUri) {
        summary.failed += 1
        continue
      }
      set.lqip = dataUri
      summary.placeholdersWritten += 1
      changed = true
    }

    if (!changed) continue
    summary.productsUpdated += 1
    console.error(`  + ${row.id}: ${sets.filter((s) => s.lqip).length} placeholder(s)`)

    if (options.dryRun) continue
    // Whole jsonb rewritten per product — the sets above are references into
    // the parsed `images` object, so mutating them mutated it in place.
    pending.push({ id: row.id, images })
  }

  // ONE transaction for the whole run, hence ONE version bump (the catalog
  // trigger counts per transaction): the app revalidates on a version change,
  // and a bump per product would make it re-download the blob once per product
  // for no reason. The writes are deferred to here rather than issued inside
  // the loop above so the transaction never stays open across the placeholder
  // HTTP fetches.
  if (pending.length > 0) {
    await db.transaction(async (tx) => {
      for (const p of pending) {
        await tx.update(products).set({ images: p.images }).where(eq(products.id, p.id))
      }
    })
  }

  return summary
}

// --- CLI wrapper (skipped when imported by tests) ----------------------------

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('backfill-image-placeholders: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const force = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')

  const pool = new pg.Pool({ connectionString })
  const db = drizzle(pool) as unknown as Db
  try {
    console.error(`backfill-image-placeholders${dryRun ? ' (dry run)' : ''}${force ? ' --force' : ''}`)
    const summary = await backfillImagePlaceholders(db, { force, dryRun })
    console.error(
      `done: ${summary.productsUpdated}/${summary.productsScanned} products updated, ` +
        `${summary.placeholdersWritten} placeholders written, ` +
        `${summary.skippedExisting} already present, ${summary.failed} failed`
    )
    if (summary.failed > 0) process.exitCode = 1
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
