/**
 * Import Delhivery's per-pincode serviceability into `courier_service_exceptions`
 * (docs/SPEC-LOGISTICS.md §6.4).
 *
 * This is the concrete answer to "evaluate service coverage" in the logistics
 * brief: rather than trusting a PDF or a prefix range, we hold the carrier's own
 * per-pincode truth in our table and re-run this on a schedule.
 *
 * Why it writes the EXCEPTION table and not the range table: carrier
 * serviceability is per-pincode and non-contiguous. SPEC-SHIPPING §4.6 already
 * settled this — ranges are the coarse default, exceptions are the truth, and
 * `serviceable()` lets an exception row win.
 *
 * **Read-only against Delhivery, and never on the cart read path.** ADR D3 says
 * the quote engine reads DB rows, not a live carrier API. This script is what
 * keeps those rows honest without putting a third party in front of checkout.
 *
 * Usage:
 *   DELHIVERY_API_TOKEN=… DELHIVERY_BASE_URL=… \
 *     npx tsx scripts/sync-delhivery-serviceability.ts --state Gujarat
 *   …add --apply to write. Without it the script only reports the diff.
 */

/* eslint-disable no-console -- this is a CLI reporting tool; its output IS its interface */

import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { courierServiceExceptions, pincodes } from '../src/db/schema.js'
import { createDelhiveryAdapter, modeFromBaseUrl } from '../src/lib/delhivery.js'

const COURIER_CODE = 'delhivery'
/** Their pincode API is not documented with a published rate limit; be a good citizen. */
const REQUEST_DELAY_MS = 250

interface Args {
  state: string
  apply: boolean
  limit: number
}

function parseArgs(argv: string[]): Args {
  const state = argv[argv.indexOf('--state') + 1]
  const limitRaw = argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : undefined
  return {
    state: argv.includes('--state') && state !== undefined ? state : 'Gujarat',
    apply: argv.includes('--apply'),
    limit: limitRaw !== undefined ? Number(limitRaw) : Number.POSITIVE_INFINITY,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiToken = process.env.DELHIVERY_API_TOKEN
  const baseUrl = process.env.DELHIVERY_BASE_URL

  if (!apiToken || !baseUrl) {
    console.error(
      'DELHIVERY_API_TOKEN and DELHIVERY_BASE_URL are required.\n' +
        '  UAT:  https://staging-express.delhivery.com\n' +
        '  Prod: https://track.delhivery.com'
    )
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const mode = modeFromBaseUrl(baseUrl)
  const adapter = createDelhiveryAdapter({ baseUrl, apiToken, clientName: '', mode })
  const pool = new pg.Pool({ connectionString, max: 1 })
  const db = drizzle(pool) as unknown as Db

  try {
    // Only pincodes we actually know about — the `pincodes` reference table is
    // what `zoneFor` resolves against, so a serviceability row for a pincode
    // outside it could never be reached anyway.
    const known = await db
      .select({ pincode: pincodes.pincode })
      .from(pincodes)
      .where(eq(pincodes.state, args.state))

    if (known.length === 0) {
      console.error(
        `No pincodes seeded for state "${args.state}". Run db:import-pincodes first — ` +
          'this script deliberately does not invent coverage for pincodes we cannot zone.'
      )
      process.exit(1)
    }

    const targets = known.slice(0, args.limit).map((row) => row.pincode)
    console.log(
      `[${mode}] checking ${targets.length} ${args.state} pincodes against Delhivery` +
        `${args.apply ? '' : ' (dry run — pass --apply to write)'}`
    )

    const existing = new Map(
      (
        await db
          .select({
            pincode: courierServiceExceptions.pincode,
            serviceable: courierServiceExceptions.serviceable,
          })
          .from(courierServiceExceptions)
          .where(
            and(
              eq(courierServiceExceptions.courierCode, COURIER_CODE),
              inArray(courierServiceExceptions.pincode, targets)
            )
          )
      ).map((row) => [row.pincode, row.serviceable])
    )

    let checked = 0
    let unreachable = 0
    const changes: Array<{ pincode: string; from: boolean | undefined; to: boolean }> = []

    for (const pincode of targets) {
      let rows
      try {
        rows = await adapter.serviceability(pincode)
      } catch (err) {
        // A failed lookup is NOT evidence of non-serviceability. Recording it as
        // `false` would silently switch off a live pincode on a transient error.
        unreachable += 1
        console.warn(`  ${pincode}: lookup failed (${(err as Error).message}) — left unchanged`)
        continue
      }
      checked += 1

      // We are prepaid-only (SPEC-SHIPPING D6), so prepaid is the flag that decides it.
      const serviceable = rows.some((row) => row.pincode === pincode && row.prepaid)
      const current = existing.get(pincode)
      if (current !== serviceable) changes.push({ pincode, from: current, to: serviceable })

      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS))
    }

    const newlyServiceable = changes.filter((c) => c.to).length
    const newlyBlocked = changes.filter((c) => !c.to).length
    console.log(
      `\nchecked ${checked}/${targets.length} · unreachable ${unreachable} · ` +
        `changes ${changes.length} (+${newlyServiceable} serviceable, -${newlyBlocked})`
    )
    for (const change of changes.slice(0, 40)) {
      console.log(`  ${change.pincode}: ${String(change.from ?? '(none)')} → ${String(change.to)}`)
    }
    if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`)

    if (!args.apply) {
      console.log('\nDry run. Re-run with --apply to write these rows.')
      return
    }
    if (changes.length === 0) {
      console.log('\nNothing to write.')
      return
    }

    for (const change of changes) {
      await db
        .insert(courierServiceExceptions)
        .values({
          courierCode: COURIER_CODE,
          pincode: change.pincode,
          serviceable: change.to,
        })
        .onConflictDoUpdate({
          target: [courierServiceExceptions.courierCode, courierServiceExceptions.pincode],
          set: { serviceable: change.to },
        })
    }
    console.log(`\nWrote ${changes.length} exception rows.`)
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
