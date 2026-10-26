/**
 * Database client factory — a `pg` Pool against the Neon POOLED endpoint,
 * wrapped in a Drizzle instance. Created once at boot (`index.ts`) and passed
 * down through `buildApp()`; nothing in this module reads env directly, so
 * tests can substitute an in-memory database at the same seam.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema.js'

/**
 * The database handle the app is written against. Route/service code only
 * uses the query-builder + transaction surface, which is identical across
 * drizzle's Postgres drivers — tests satisfy this type with PGlite.
 */
export type Db = NodePgDatabase<typeof schema>

export interface DbClient {
  db: Db
  pool: pg.Pool
}

/**
 * Per-instance connection ceiling (`DATABASE_POOL_MAX`).
 *
 * Cloud Run runs this at 80 concurrent requests per instance (the default —
 * `deploy.yml` sets no `--concurrency`), so 10 left 8 requests queueing per
 * connection during a burst, each waiting up to `connectionTimeoutMillis`
 * before failing. 20 doubles the headroom.
 *
 * This is cost-neutral, and the reason is `idleTimeoutMillis` below: idle
 * connections are closed after 30s, so the pool drains to ZERO between bursts.
 * `max` sets a peak that is only ever reached under load — when the Neon
 * compute is awake and billing regardless. It creates no idle connection, and
 * an idle connection is what bills a Neon compute for doing nothing (the same
 * finding that put `min_size=0` on the SOAR pool sharing this branch).
 *
 * Do NOT set a pool `min`. That would hold connections open through idle
 * periods and defeat Neon's 5-minute scale-to-zero — the single largest line
 * on the bill.
 *
 * Higher is not better past this point: the real ceiling is Neon's compute
 * size and the pooled endpoint's server-side pool, not our client. Raising
 * `max` further just moves the queue from this process into PgBouncer.
 */
const DEFAULT_POOL_MAX = 20

export interface CreateDbOptions {
  /** Overrides {@link DEFAULT_POOL_MAX}. Read from env by `index.ts`. */
  poolMax?: number
}

/** Build the pool + drizzle pair for the given (pooled) connection string. */
export function createDb(connectionString: string, options: CreateDbOptions = {}): DbClient {
  const pool = new pg.Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Neon closes idle connections server-side; keep client timeouts tighter.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  const db = drizzle(pool, { schema })
  return { db, pool }
}
