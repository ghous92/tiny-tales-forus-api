#!/usr/bin/env tsx
/**
 * `npm run db:reset-previews -- --phone +919000000000 [--keep-seeded] [--all-users] [--yes]`
 *
 * Resets the caricature-preview limits for a test number by deleting its rows in
 * `caricature_previews` (the ledger the per-photo and per-day limits count). This also removes
 * the shopper's saved "Your previews". With `--keep-seeded`, rows made by `db:test-previews`
 * (model = 'seeded-test') stay. Without `--yes` it only shows what it would delete.
 *
 * `--all-users` (instead of --phone) clears today's whole-site counter by deleting every row
 * created today (India time) that is not seeded. Use on staging only.
 *
 * Point it at an environment with DATABASE_URL_DIRECT (preferred) or DATABASE_URL.
 */

/* eslint-disable no-console -- operator script, output is the interface */
import pg from 'pg'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function fail(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const phone = arg('phone')
  const allUsers = flag('all-users')
  const keepSeeded = flag('keep-seeded')
  const yes = flag('yes')
  if (!phone && !allUsers) fail('pass --phone +91XXXXXXXXXX (or --all-users)')
  if (phone && !/^\+\d{8,15}$/.test(phone)) fail('phone must be E.164, e.g. +919000000000')

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) fail('set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')

  const where: string[] = []
  const params: string[] = []
  if (phone) {
    params.push(phone)
    where.push(`user_id = (select id from users where phone = $${params.length})`)
  } else {
    where.push(
      `created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`
    )
    // The whole-site counter never needs seeded rows removed.
    where.push(`model <> 'seeded-test'`)
  }
  if (keepSeeded) where.push(`model <> 'seeded-test'`)
  const clause = where.join(' and ')

  const host = new URL(connectionString).host
  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    if (phone) {
      const u = await pool.query('select id from users where phone = $1', [phone])
      if (u.rowCount === 0)
        fail(`no user with phone ${phone} on ${host}; log in once with it first`)
    }
    const found = await pool.query(
      `select status, count(*)::int as n from caricature_previews where ${clause} group by status order by status`,
      params
    )
    const total = found.rows.reduce((s, r) => s + r.n, 0)
    console.log(`database: ${host}`)
    console.log(`rows matched: ${total}`, found.rows.map((r) => `${r.status}=${r.n}`).join(' '))
    if (total === 0) return
    if (!yes) {
      console.log('dry run, nothing deleted. Add --yes to delete.')
      return
    }
    const del = await pool.query(`delete from caricature_previews where ${clause}`, params)
    console.log(`deleted ${del.rowCount} rows. Limits are reset.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
