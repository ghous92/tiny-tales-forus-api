/**
 * Architectural guard: shipping arithmetic lives in ONE file.
 *
 * `docs/SPEC-SHIPPING.md` asserts that all of it is contained in
 * `lib/shipping.ts`. An assertion in a document is not enforcement — the way
 * this rule actually breaks is that someone needs a fee inside a route handler,
 * inlines `base * 1.18` because it is two lines, and six months later the cart
 * and the order screen disagree by a rupee and nobody can say which is right.
 * The same reasoning already protects `lib/pricing.ts`'s display == charge
 * invariant; this test makes it mechanical rather than cultural.
 *
 * The check greps for the cost-formula identifiers. Where they legitimately
 * appear:
 *   - `lib/shipping.ts`      — the arithmetic itself
 *   - `services/shipping.ts` — mapping DB rows into the lib's input shapes
 *   - `db/schema.ts`         — the column definitions
 *   - `contracts/shipping.ts`— none today, but a rate-card admin contract will
 *
 * A new file needing one of these names is not automatically wrong; it just has
 * to be a deliberate addition to the allowlist rather than an accident.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/** Identifiers that only the shipping cost formula has any business naming. */
const COST_FORMULA_TOKENS = [
  'fuelBps',
  'gstBps',
  'docketFeeInr',
  'riskBps',
  'riskMinInr',
  'volumetricDivisor',
  'minChargeableG',
]

/** Files permitted to mention them, relative to `src/`. */
const ALLOWED = new Set([
  'lib/shipping.ts',
  'services/shipping.ts',
  'db/schema.ts',
  'contracts/shipping.ts',
  // Phase 2 data-in. The rate-card EDITOR necessarily names every field of the
  // cost formula — that is what it edits. It is on this list because it maps
  // rows and DTOs and does no arithmetic: note that `routes/shippingAdmin.ts`
  // is deliberately NOT here, so a handler that starts computing a fee instead
  // of delegating to the service fails this test.
  'contracts/shippingAdmin.ts',
  'services/shippingAdmin.ts',
])

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full, base)
    if (!full.endsWith('.ts')) return []
    return [full.slice(base.length + 1)]
  })
}

describe('shipping arithmetic containment', () => {
  it('keeps the courier cost formula out of every file but the allowlisted ones', () => {
    const offenders: string[] = []

    for (const relative of walk('src')) {
      if (ALLOWED.has(relative)) continue
      const source = readFileSync(join('src', relative), 'utf8')
      const found = COST_FORMULA_TOKENS.filter((token) => source.includes(token))
      if (found.length > 0) offenders.push(`${relative}: ${found.join(', ')}`)
    }

    expect(offenders).toEqual([])
  })

  it('actually looks at the right files (guards against a vacuous pass)', () => {
    // If the walk or the token list silently stopped matching anything, the
    // test above would pass while enforcing nothing.
    const lib = readFileSync('src/lib/shipping.ts', 'utf8')
    for (const token of COST_FORMULA_TOKENS) expect(lib).toContain(token)
    expect(walk('src').length).toBeGreaterThan(20)
  })
})
