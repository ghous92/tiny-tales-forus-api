/**
 * Propose `courier_rate_slabs` rows from Delhivery's live rate-check ("Kinko
 * invoice/charges") API (docs/SPEC-LOGISTICS.md §6.4).
 *
 * **Read-only against Delhivery, and never on the cart read path.** ADR D3
 * (SPEC-LOGISTICS.md §6.4) says the quote engine reads DB rows, not a live
 * carrier API — this script is what feeds those rows without putting a third
 * party in front of checkout. `lib/delhivery.ts`'s `invoiceCharges()` exists
 * only for this script to call.
 *
 * Delhivery documents this endpoint's output as *approximate*, not the real
 * negotiated card, and caps it at 40 req/min — both reasons it stays an
 * offline sync, never a request-time lookup.
 *
 * For each (zone, weight breakpoint) pair, queries a representative
 * (origin pickup node pincode → sample destination pincode) lane and reads
 * back `charge_DL` (pre-fuel, pre-GST base freight) as the proposed
 * `rate_inr`. `addl_per_g`/`addl_rate_inr` (the linear extrapolation above the
 * top slab) are NOT set by this script — Delhivery's own curve goes
 * non-linear above the top slab (see `scripts/seed-shipping.ts`'s
 * `SLAB_SEEDS` comment), so that number needs a human reading the curve, not
 * an automated fit. Existing `addl_*` values on a row are left untouched.
 *
 * **Prints a diff and requires `--apply`.** It never silently rewrites the
 * money table.
 *
 * Usage:
 *   DELHIVERY_API_TOKEN=… DELHIVERY_BASE_URL=… \
 *     npx tsx scripts/sync-delhivery-rates.ts \
 *       --origin 380055 \
 *       --lane D:781001 --lane E:781001 \
 *       [--courier delhivery] [--apply]
 *
 * `--lane <ZONE>:<destPincode>` may be repeated, one representative
 * destination per zone you want priced. Standard weight breakpoints
 * (`courier_rate_slabs.upto_g`: 500/1000/2000/5000/10000 g) are queried for
 * every lane given. Without `--apply` the script only reports the diff.
 */

/* eslint-disable no-console -- this is a CLI reporting tool; its output IS its interface */

import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { courierRateSlabs, type CourierRateSlabRow } from '../src/db/schema.js'
import { createDelhiveryAdapter, modeFromBaseUrl } from '../src/lib/delhivery.js'

/** Same breakpoints `courier_rate_slabs.upto_g` is seeded at (see seed-shipping.ts). */
const WEIGHT_BREAKPOINTS_G = [500, 1000, 2000, 5000, 10000]
/** Kinko is documented at 40 req/min — 1500ms between calls stays comfortably under it. */
const REQUEST_DELAY_MS = 1500
const VALID_ZONES = new Set(['A', 'B', 'C', 'D', 'E', 'F'])

interface Lane {
  zone: string
  destPincode: string
}

interface Args {
  origin: string
  courierCode: string
  lanes: Lane[]
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  const origin = argv[argv.indexOf('--origin') + 1]
  const courierIdx = argv.indexOf('--courier')
  const courierCode = courierIdx !== -1 ? argv[courierIdx + 1] : 'delhivery'

  const lanes: Lane[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--lane') continue
    const raw = argv[i + 1]
    const [zone, destPincode] = (raw ?? '').split(':')
    if (!zone || !destPincode || !VALID_ZONES.has(zone.toUpperCase())) {
      console.error(`--lane must be <ZONE>:<destPincode> with ZONE in A-F, got "${raw ?? ''}"`)
      process.exit(1)
    }
    lanes.push({ zone: zone.toUpperCase(), destPincode })
  }

  if (!origin) {
    console.error('--origin <pincode> is required (the pickup node quoting from)')
    process.exit(1)
  }
  if (lanes.length === 0) {
    console.error('at least one --lane <ZONE>:<destPincode> is required')
    process.exit(1)
  }

  return { origin, courierCode: courierCode ?? 'delhivery', lanes, apply: argv.includes('--apply') }
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
    const zones = [...new Set(args.lanes.map((l) => l.zone))]
    const existingRows = await db
      .select()
      .from(courierRateSlabs)
      .where(
        and(
          eq(courierRateSlabs.courierCode, args.courierCode),
          inArray(courierRateSlabs.zone, zones)
        )
      )
    const existing = new Map<string, CourierRateSlabRow>(
      existingRows.map((row) => [`${row.zone}:${row.uptoG}`, row])
    )

    console.log(
      `[${mode}] pricing ${args.lanes.length} lane(s) × ${WEIGHT_BREAKPOINTS_G.length} weight ` +
        `breakpoints against Delhivery${args.apply ? '' : ' (dry run — pass --apply to write)'}`
    )

    interface Proposal {
      zone: string
      uptoG: number
      chargeInr: number
      currentInr: number | undefined
    }
    const proposals: Proposal[] = []
    let unreachable = 0

    for (const lane of args.lanes) {
      for (const weightG of WEIGHT_BREAKPOINTS_G) {
        let result
        try {
          result = await adapter.invoiceCharges({
            originPincode: args.origin,
            destPincode: lane.destPincode,
            weightG,
            isCod: false,
          })
        } catch (err) {
          unreachable += 1
          console.warn(
            `  ${lane.zone} ${weightG}g (${args.origin}→${lane.destPincode}): lookup failed ` +
              `(${(err as Error).message}) — skipped`
          )
          continue
        }
        if (result.chargeInr === null) {
          // Not evidence of "free" or "no such slab" — just "could not price this leg
          // right now." Leaving the existing row untouched is the safe default.
          console.warn(
            `  ${lane.zone} ${weightG}g (${args.origin}→${lane.destPincode}): no charge_DL in response — skipped`
          )
          continue
        }
        const current = existing.get(`${lane.zone}:${weightG}`)
        proposals.push({
          zone: lane.zone,
          uptoG: weightG,
          chargeInr: Math.round(result.chargeInr),
          currentInr: current?.rateInr,
        })
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS))
      }
    }

    const changes = proposals.filter((p) => p.currentInr !== p.chargeInr)
    console.log(
      `\npriced ${proposals.length}/${args.lanes.length * WEIGHT_BREAKPOINTS_G.length} · ` +
        `unreachable ${unreachable} · changes ${changes.length}`
    )
    for (const c of changes) {
      console.log(
        `  ${c.zone} upto ${c.uptoG}g: ${c.currentInr !== undefined ? `₹${c.currentInr}` : '(none)'} → ₹${c.chargeInr}`
      )
    }

    if (!args.apply) {
      console.log('\nDry run. Re-run with --apply to write these rows.')
      return
    }
    if (changes.length === 0) {
      console.log('\nNothing to write.')
      return
    }

    for (const c of changes) {
      await db
        .insert(courierRateSlabs)
        .values({
          courierCode: args.courierCode,
          zone: c.zone,
          uptoG: c.uptoG,
          rateInr: c.chargeInr,
        })
        .onConflictDoUpdate({
          target: [courierRateSlabs.courierCode, courierRateSlabs.zone, courierRateSlabs.uptoG],
          set: { rateInr: c.chargeInr },
        })
    }
    console.log(`\nWrote ${changes.length} slab row(s). addl_per_g/addl_rate_inr left untouched.`)
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
