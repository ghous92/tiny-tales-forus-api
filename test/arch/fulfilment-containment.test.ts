/**
 * Architectural guard: carrier vocabulary lives in ONE place.
 *
 * `docs/SPEC-LOGISTICS.md` §2 asserts that every carrier status string appears
 * in `lib/fulfilmentStatus.ts` and nowhere else. An assertion in a document is
 * not enforcement — the way this rule actually breaks is that someone needs
 * "is it delivered?" inside a route handler, writes
 * `status === 'Delivered'` because it is one line, and then the mapping table
 * and the handler disagree about a parcel that came back as `DL/DTO`.
 *
 * It is also what keeps FEASIBILITY-LOGISTICS §5.2's carrier-pluggability claim
 * honest: a second carrier is only "one new mapping table" for as long as the
 * first carrier's words have not leaked across the module.
 *
 * Same shape as `shipping-containment.test.ts`, deliberately — a new file
 * naming one of these is not automatically wrong, it just has to be a
 * deliberate addition to the allowlist rather than an accident.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Strings only the carrier's own vocabulary has any business containing.
 *
 * Matched on WORD BOUNDARIES, so our own `carrierStatusType` column does not
 * trip the rule that `StatusType` does — the guard is about reading the
 * carrier's words, not about the substring.
 */
const CARRIER_TOKENS = [
  'StatusType',
  'NSLCode',
  'Manifested',
  'Dispatched',
  'ShipmentData',
  'EOD-\\d+',
  'ST-108',
]

function mentions(source: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b`).test(source)
}

/** Files permitted to mention them, relative to `src/`. */
const ALLOWED = new Set([
  // The mapping table itself, and the HTTP adapter that parses their JSON.
  'lib/fulfilmentStatus.ts',
  'lib/delhivery.ts',
  // The webhook contract names their payload keys because that IS their
  // payload. It does no mapping — `routes/fulfilment.ts` is deliberately NOT
  // on this list, so a handler that starts comparing carrier strings instead
  // of delegating to `mapScan` fails this test.
  'contracts/fulfilment.ts',
  // Column documentation. `db/schema.ts` names the carrier fields each column
  // mirrors, exactly as it does for the courier rate formula in
  // shipping-containment.test.ts — it declares storage and maps nothing.
  'db/schema.ts',
])

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full, base)
    if (!full.endsWith('.ts')) return []
    return [full.slice(base.length + 1)]
  })
}

describe('carrier vocabulary containment', () => {
  it('keeps carrier status strings out of every file but the allowlisted ones', () => {
    const offenders: string[] = []

    for (const relative of walk('src')) {
      if (ALLOWED.has(relative)) continue
      const source = readFileSync(join('src', relative), 'utf8')
      const found = CARRIER_TOKENS.filter((token) => mentions(source, token))
      if (found.length > 0) offenders.push(`${relative}: ${found.join(', ')}`)
    }

    expect(offenders).toEqual([])
  })

  it('actually looks at the right files (guards against a vacuous pass)', () => {
    // If the walk or the token list silently stopped matching anything, the
    // test above would pass while enforcing nothing. Split by owner, because
    // the two allowlisted files legitimately name different halves of the
    // carrier's vocabulary: the mapper reads statuses, the adapter reads wire
    // keys (`NSLCode` is carried through for forensics and never mapped).
    const mapper = readFileSync('src/lib/fulfilmentStatus.ts', 'utf8')
    for (const token of ['StatusType', 'Manifested', 'Dispatched', 'EOD-\\d+', 'ST-108']) {
      expect(mentions(mapper, token), `${token} should appear in lib/fulfilmentStatus.ts`).toBe(
        true
      )
    }

    const adapter = readFileSync('src/lib/delhivery.ts', 'utf8')
    for (const token of ['NSLCode', 'ShipmentData', 'StatusType']) {
      expect(mentions(adapter, token), `${token} should appear in lib/delhivery.ts`).toBe(true)
    }

    expect(walk('src').length).toBeGreaterThan(20)
  })
})

describe('contract / lib status enum drift', () => {
  it('keeps the re-declared contract enum in step with the canonical list', () => {
    // ARCHITECTURE.md rule 4 forbids contracts importing anything but zod, so
    // `FulfilmentStatusSchema` re-declares the enum by hand. This is the guard
    // that stops the copy rotting — the same trade `contracts/shipping.ts`
    // makes for `Zone`.
    const lib = readFileSync('src/lib/fulfilmentStatus.ts', 'utf8')
    const contract = readFileSync('src/contracts/fulfilment.ts', 'utf8')

    const fromList = [
      ...(lib.match(/FULFILMENT_STATUSES[^=]*= \[[\s\S]*?\] as const/) ?? [''])[0].matchAll(
        /'([a-z_]+)'/g
      ),
    ]
      .map((m) => m[1])
      .sort()
    const fromSchema = [
      ...(contract.match(/FulfilmentStatusSchema = z\.enum\(\[[\s\S]*?\]\)/) ?? [''])[0].matchAll(
        /'([a-z_]+)'/g
      ),
    ]
      .map((m) => m[1])
      .sort()

    expect(fromList.length).toBeGreaterThan(5)
    expect(fromSchema).toEqual(fromList)
  })
})
