#!/usr/bin/env tsx
/**
 * `npm run db:backfill-pincode-coords -- [--state Gujarat] [--limit 200] [--dry-run]`
 * — fill `pincodes.lat` / `pincodes.lng` by forward-geocoding each pincode.
 *
 * **Why this exists.** `scripts/import-pincodes.ts` loads the official India
 * Post directory, and that directory ships no coordinates: every row it writes
 * has `lat = null`. The stock cascade (docs/SPEC-STOCK.md §3) ranks candidate
 * stores by great-circle distance from the SHOPPER, and the only thing a
 * shopper gives us before checkout is a pincode. With null coordinates that
 * ranking silently degenerates — every store ties, and "nearest store first"
 * becomes "whichever store the database happened to return first". So the
 * cascade cannot ship until this has run over the serviceable states.
 *
 * The same coordinate is the haversine tie-break `lib/shipping.ts` already
 * uses when two nodes quote the same price, which today falls back to node
 * priority for want of a destination point.
 *
 * ## Four rules this script will not bend
 *
 * 1. **Never overwrite.** Only rows with a null `lat` OR null `lng` are
 *    selected, and the UPDATE re-asserts that in its WHERE clause. Operator-
 *    supplied coordinates (the ones seeded in `seed-shipping.ts`) are more
 *    trustworthy than a geocoder's centroid and outrank it permanently.
 *    Re-running is therefore idempotent and cheap: it only ever picks up what
 *    is still missing.
 *
 * 2. **Billing is capped, not unbounded.** Google's Geocoding API bills per
 *    call beyond the free tier, and the directory holds ~19,000 pincodes.
 *    A naive full run is a five-figure call count. `--limit` defaults to
 *    {@link DEFAULT_LIMIT} and there is deliberately no `--all`: a big backfill
 *    is several deliberate invocations, each of which prints what remains.
 *
 * 3. **Committed per row, not per run.** Each successful geocode is written
 *    immediately. A run killed halfway (rate limit, Ctrl-C, a pod eviction)
 *    keeps everything it had already resolved, and the next run resumes from
 *    exactly there because rule 1 makes "still null" the work queue.
 *
 * 4. **A miss is recorded as a miss.** When Google returns nothing for a
 *    pincode the row is left null rather than filled with a district centroid.
 *    A null coordinate makes that store *unrankable* and the cascade falls
 *    back to hub-first, which is merely suboptimal. A wrong coordinate makes
 *    it confidently mis-ranked, and a shopper is quoted a store that is
 *    actually 200 km further away than the one we skipped.
 *
 * ## Query shape
 *
 * The query text is `"<pincode>, <district>, <state>, India"` rather than the
 * bare pincode. Bare six-digit numbers geocode poorly — Google will happily
 * read `380051` as a street number somewhere. District and state anchor it,
 * and `components: country:IN` in `forwardGeocode` fences the result to India.
 *
 * The returned point is a POSTAL-CODE CENTROID, not a building. That is the
 * correct precision for this use: it feeds a distance ranking measured in
 * kilometres between towns, never a courier pickup address.
 */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { pincodes } from '../src/db/schema.js'
import { forwardGeocode, type ReverseGeocodeDeps } from '../src/services/geocode.js'

/**
 * Rows resolved per invocation unless `--limit` says otherwise. Sized so a
 * default run stays comfortably inside a free-tier month even if someone runs
 * it daily, and so a mistake costs cents rather than a rent cheque.
 */
export const DEFAULT_LIMIT = 200

/** Hard ceiling on `--limit`. A number above this is a typo, not an intent. */
export const MAX_LIMIT = 2000

/**
 * Pause between upstream calls. Google's per-second quota is generous, but a
 * backfill is a background chore competing with live `/v1/geocode` traffic from
 * the app's address form — those requests are in front of a waiting human and
 * this one is not.
 */
export const THROTTLE_MS = 120

export interface BackfillOptions {
  /** Restrict to one `pincodes.state` value, e.g. "Gujarat". Omit for all states. */
  state?: string | undefined
  limit: number
  /** Resolve and report, write nothing. Still spends the upstream calls. */
  dryRun: boolean
}

export interface BackfillSummary {
  /** Rows the geocoder answered for and (unless dry-run) we wrote. */
  filled: number
  /** Rows the geocoder had no answer for. Left null on purpose — see rule 4. */
  missed: number
  /** Rows still lacking a coordinate after this run, within the same filter. */
  remaining: number
  /** Pincodes that missed, so an operator can resolve them by hand. */
  missedPincodes: string[]
}

export interface BackfillDeps extends ReverseGeocodeDeps {
  /** Test seam: injected sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Geocode up to `limit` coordinate-less pincodes and write what resolves.
 *
 * Ordered by pincode so successive runs walk the directory in a stable,
 * inspectable sequence rather than re-rolling a random sample each time.
 */
export async function backfillPincodeCoords(
  db: Db,
  options: BackfillOptions,
  deps: BackfillDeps
): Promise<BackfillSummary> {
  const missingCoords = or(isNull(pincodes.lat), isNull(pincodes.lng))
  const stateFilter = options.state ? eq(pincodes.state, options.state) : undefined
  const scope = stateFilter ? and(missingCoords, stateFilter) : missingCoords

  const targets = await db
    .select({
      pincode: pincodes.pincode,
      district: pincodes.district,
      state: pincodes.state,
    })
    .from(pincodes)
    .where(scope)
    .orderBy(asc(pincodes.pincode))
    .limit(options.limit)

  const sleep = deps.sleep ?? realSleep
  const missedPincodes: string[] = []
  let filled = 0

  for (const [index, target] of targets.entries()) {
    if (index > 0) await sleep(THROTTLE_MS)

    // District and state anchor the query; a bare six-digit number geocodes to
    // a street number as often as to a postal area.
    const query = [target.pincode, target.district, target.state, 'India']
      .filter((part) => part.trim() !== '')
      .join(', ')

    const hit = await forwardGeocode(query, deps)
    if (!hit) {
      missedPincodes.push(target.pincode)
      continue
    }

    filled += 1
    if (options.dryRun) continue

    // The null re-check is not redundant with the SELECT: a concurrent run or
    // an operator saving a coordinate in the admin UI between the two
    // statements must win, per rule 1.
    await db
      .update(pincodes)
      .set({ lat: hit.lat, lng: hit.lng })
      .where(and(eq(pincodes.pincode, target.pincode), missingCoords))
  }

  const [remainingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pincodes)
    .where(scope)

  return {
    filled,
    missed: missedPincodes.length,
    remaining: remainingRow?.count ?? 0,
    missedPincodes,
  }
}

/** Parse argv into options, rejecting a limit that is obviously a mistake. */
export function parseArgs(argv: readonly string[]): BackfillOptions {
  let state: string | undefined
  let limit = DEFAULT_LIMIT
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--state') {
      state = argv[i + 1]
      i += 1
    } else if (arg === '--limit') {
      const raw = Number(argv[i + 1])
      if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
        throw new Error(
          `--limit must be an integer between 1 and ${MAX_LIMIT}, got "${argv[i + 1]}"`
        )
      }
      limit = raw
      i += 1
    }
  }

  return { state, limit, dryRun }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:backfill-pincode-coords: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY
  if (!apiKey) {
    console.error(
      'db:backfill-pincode-coords: GOOGLE_MAPS_SERVER_KEY is not set. ' +
        'This script does nothing but call the Geocoding API.'
    )
    process.exit(1)
  }

  const options = parseArgs(process.argv.slice(2))
  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const summary = await backfillPincodeCoords(db, options, { apiKey })

    const scope = options.state ?? 'all states'
    // eslint-disable-next-line no-console
    console.log(
      `db:backfill-pincode-coords (${scope}${options.dryRun ? ', DRY RUN — nothing written' : ''}): ` +
        `${summary.filled} filled, ${summary.missed} missed, ${summary.remaining} still without a coordinate.`
    )
    if (summary.missedPincodes.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Left null on purpose (the geocoder had no answer; a guessed centroid would mis-rank ` +
          `stores rather than merely fail to rank them): ${summary.missedPincodes.join(', ')}`
      )
    }
    if (summary.remaining > 0) {
      // eslint-disable-next-line no-console
      console.log(`Run again to continue — each run resumes from what is still null.`)
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
