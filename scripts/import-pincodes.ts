#!/usr/bin/env tsx
/**
 * `npm run db:import-pincodes -- <file.csv> [--state Gujarat]` — load the
 * official India Post pincode directory into `pincodes`.
 *
 * Unlike the rate cards in `seed-shipping.ts`, this is NOT placeholder data and
 * NOT dev-only. It is the public India Post directory, it is the same in every
 * environment, and `zoneFor` returns `null` — not a fallback zone — for any
 * pincode missing from this table. A staging or production database without it
 * cannot quote a single delivery, so this script deliberately carries no
 * `assertDevOnly` guard.
 *
 * Expected header (the directory's own column names, case-insensitive):
 *
 *   officename,pincode,officeType,Deliverystatus,divisionname,regionname,
 *   circlename,Taluk,Districtname,statename,Telephone,RelatedSuboffice,
 *   RelatedHeadoffice
 *
 * **The dedupe rule is the whole point of this file.** `pincodes.pincode` is a
 * primary key, but the directory has ~155k rows and only ~19k pincodes: many
 * post offices share one. Worse, they do not always share a TALUK — 486 of
 * Gujarat's 1018 pincodes (48%) appear under more than one. Since Zone A is
 * defined as taluk equality, whichever taluk survives dedupe decides Zone A vs
 * Zone B for every quote against that pincode. Picking the first row seen would
 * make that decision by CSV ordering.
 *
 * So the winner is the MODE — the taluk the most post offices in that pincode
 * agree on — because the taluk most of a pincode's offices sit in is the one a
 * courier lane through it is most likely to actually be in. Ties break by
 * office rank (H.O > S.O > B.O; a head office is the better representative of
 * its pincode than a branch) and then alphabetically, so the import is
 * DETERMINISTIC: re-running it against the same file cannot silently reshuffle
 * which taluk a pincode reports, and therefore cannot silently reprice a lane.
 *
 * **Coordinates are preserved, never overwritten.** The directory ships no
 * lat/lng. Existing rows may have operator-supplied ones (see the seeds in
 * `seed-shipping.ts`), and those are used for the distance tie-break when
 * ranking candidates, so the upsert COALESCEs rather than nulling them.
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import fs from 'node:fs'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { pincodes, type NewPincodeRow } from '../src/db/schema.js'

/** Rows per INSERT. Postgres caps parameters at 65535; 6 columns × 2000 stays well under. */
const BATCH_SIZE = 2000

/**
 * Quote-aware CSV split. The directory embeds commas inside quoted office names
 * ("Dabhoi Ward No.2, Vadodara"), which a naive `split(',')` shears into the
 * wrong columns — 138 rows in the current file. Doubled quotes ("") are the
 * CSV escape for a literal quote.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields.map((f) => f.trim())
}

/** One directory row, reduced to the columns this table stores. */
interface DirectoryRow {
  pincode: string
  officeName: string
  officeType: string
  taluk: string
  district: string
  state: string
}

/**
 * Office rank for the dedupe tie-break. Higher wins: a Head Office represents
 * its pincode better than a Branch Office. Unknown types rank lowest rather
 * than throwing — the directory occasionally carries blanks.
 */
function officeRank(officeType: string): number {
  const type = officeType.trim().toUpperCase().replace(/\./g, '')
  if (type === 'HO') return 3
  if (type === 'SO') return 2
  if (type === 'BO') return 1
  return 0
}

/**
 * Collapse many directory rows into one row per pincode, by the mode-of-taluk
 * rule documented at the top of this file.
 */
export function dedupeByPincode(rows: DirectoryRow[]): NewPincodeRow[] {
  const byPincode = new Map<string, DirectoryRow[]>()
  for (const row of rows) {
    const list = byPincode.get(row.pincode)
    if (list) list.push(row)
    else byPincode.set(row.pincode, [row])
  }

  const result: NewPincodeRow[] = []
  for (const [pincode, group] of byPincode) {
    // How many offices vouch for each taluk. The mode wins.
    const talukCounts = new Map<string, number>()
    for (const row of group) {
      if (row.taluk === '') continue
      talukCounts.set(row.taluk, (talukCounts.get(row.taluk) ?? 0) + 1)
    }

    const best = group.slice().sort((a, b) => {
      const byMode = (talukCounts.get(b.taluk) ?? 0) - (talukCounts.get(a.taluk) ?? 0)
      if (byMode !== 0) return byMode
      const byRank = officeRank(b.officeType) - officeRank(a.officeType)
      if (byRank !== 0) return byRank
      return a.officeName.localeCompare(b.officeName)
    })[0]!

    result.push({
      pincode,
      officeName: best.officeName,
      taluk: best.taluk,
      district: best.district,
      state: best.state,
      lat: null,
      lng: null,
    })
  }
  return result
}

/** Read + filter the directory file into deduped rows ready to upsert. */
export function loadDirectory(filePath: string, stateFilter: string | null): NewPincodeRow[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) throw new Error(`${filePath}: no data rows`)

  const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase())
  const col = (name: string): number => {
    const index = header.indexOf(name.toLowerCase())
    if (index === -1) throw new Error(`${filePath}: missing required column "${name}"`)
    return index
  }
  const iPincode = col('pincode')
  const iOffice = col('officename')
  const iType = col('officeType')
  const iTaluk = col('Taluk')
  const iDistrict = col('Districtname')
  const iState = col('statename')

  const wanted = stateFilter?.trim().toLowerCase() ?? null
  const rows: DirectoryRow[] = []

  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]!)
    const pincode = (fields[iPincode] ?? '').trim()
    // The table has a `^[1-9][0-9]{5}$` check constraint; a malformed row would
    // abort the whole batch, so drop it here instead.
    if (!/^[1-9][0-9]{5}$/.test(pincode)) continue

    const state = (fields[iState] ?? '').trim()
    if (wanted !== null && state.toLowerCase() !== wanted) continue

    rows.push({
      pincode,
      officeName: (fields[iOffice] ?? '').trim(),
      officeType: (fields[iType] ?? '').trim(),
      taluk: (fields[iTaluk] ?? '').trim(),
      district: (fields[iDistrict] ?? '').trim(),
      state,
    })
  }

  return dedupeByPincode(rows)
}

export interface ImportSummary {
  parsed: number
  written: number
}

/**
 * Upsert every row. `officeName`/`taluk`/`district`/`state` come from India
 * Post and overwrite whatever was there — the directory is authoritative for
 * them. `lat`/`lng` are COALESCEd so an operator-supplied coordinate survives a
 * re-import that carries none.
 */
export async function importPincodes(db: Db, rows: NewPincodeRow[]): Promise<ImportSummary> {
  let written = 0
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE)
    await db
      .insert(pincodes)
      .values(batch)
      .onConflictDoUpdate({
        target: pincodes.pincode,
        set: {
          officeName: sql`excluded.office_name`,
          taluk: sql`excluded.taluk`,
          district: sql`excluded.district`,
          state: sql`excluded.state`,
          lat: sql`coalesce(${pincodes.lat}, excluded.lat)`,
          lng: sql`coalesce(${pincodes.lng}, excluded.lng)`,
        },
      })
    written += batch.length
  }
  return { parsed: rows.length, written }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const filePath = args.find((a) => !a.startsWith('--'))
  const stateIndex = args.indexOf('--state')
  const stateFilter = stateIndex !== -1 ? (args[stateIndex + 1] ?? null) : null

  if (!filePath) {
    console.error('usage: npm run db:import-pincodes -- <all-india-pincode.csv> [--state Gujarat]')
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:import-pincodes: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const rows = loadDirectory(filePath, stateFilter)
  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const summary = await importPincodes(db, rows)
    // eslint-disable-next-line no-console
    console.log(
      `db:import-pincodes: ${summary.written} pincode(s) upserted` +
        `${stateFilter ? ` (state filter: ${stateFilter})` : ''}.`
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
