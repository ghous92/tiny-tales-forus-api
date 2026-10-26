/**
 * Catalog version counter — the single source for the `GET /v1/catalog` ETag.
 * A one-row table (`catalog_version`, id pinned to `CATALOG_VERSION_ID`) holds
 * a monotonic integer. The app and the CDN edge use its value for
 * If-None-Match / 304 and cache invalidation, mirroring the app_config
 * snapshot pattern.
 *
 * This module is READ-ONLY on purpose. The counter is maintained by a database
 * trigger (`bump_catalog_version()`, migration 0017) on `categories`,
 * `products` and `product_variants`, which increments it once per transaction
 * that touches any of them. Nothing in TypeScript bumps it, and nothing should:
 * an explicit bump alongside the trigger would double-count, and — the reason
 * the trigger exists — application-level bumping cannot cover psql, the Neon
 * console, or a one-off script. A catalog edited without a bump serves a stale
 * ETag, so `GET /v1/catalog` answers 304 to clients whose cached copy is
 * genuinely out of date; no client-side cache clear can fix that.
 *
 * Read exclusively through this module; other code never touches the table.
 */

import type { Db } from '../db/client.js'
import { catalogVersion } from '../db/schema.js'

/** The pinned primary key guaranteeing a single counter row. */
export const CATALOG_VERSION_ID = 'catalog'

/**
 * A `Db` or a transaction handle — both expose the query builder this module
 * uses. Callers inside a transaction pass `tx` to read the value their own
 * (trigger-applied) bump just produced.
 */
type Executor = Pick<Db, 'select'>

/**
 * Current catalog version, or 0 if nothing has ever bumped it (empty catalog).
 * 0 is a valid ETag value meaning "no catalog yet".
 */
export async function getCatalogVersion(db: Executor): Promise<number> {
  const [row] = await db
    .select({ version: catalogVersion.version })
    .from(catalogVersion)
    .limit(1)
  return row?.version ?? 0
}
