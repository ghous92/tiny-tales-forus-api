/**
 * Migration runner: applies the committed SQL migrations in `drizzle/` using
 * drizzle-orm's migrator. Prefers the Neon DIRECT (unpooled) endpoint —
 * `DATABASE_URL_DIRECT` — because DDL through a pooled connection (pgbouncer)
 * can misbehave; falls back to `DATABASE_URL` when no direct URL is set.
 *
 * Run via `npm run db:migrate` (loads `.env` when present; in CI/CD the URL
 * comes from the workflow's secrets instead).
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
if (!connectionString) {
  console.error('db:migrate: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString, max: 1 })

try {
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
  // eslint-disable-next-line no-console
  console.log('db:migrate: migrations applied')
} finally {
  await pool.end()
}
