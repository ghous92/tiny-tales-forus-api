/**
 * The cascade's decision rules (docs/SPEC-STOCK.md §3).
 *
 * `cascadeForSku` is pure — every input arrives in a `StockContext` — so the
 * ordering rules can be pinned exactly, with no database and no fixtures. That
 * matters more here than in most modules: the precedence ladder is the part of
 * this feature most likely to be "simplified" by a later reader who does not
 * know why `force_in` sits BELOW the catalog flag, and these tests are the
 * record of why.
 */

import { describe, expect, it } from 'vitest'

import {
  cascadeForSku,
  resolvePolicy,
  STOCK_DEFAULTS,
  type StockCandidate,
  type StockContext,
} from '../../src/services/stock.js'

/** Ahmedabad-ish, so the fixture distances read as plausible Gujarat lanes. */
const AHMEDABAD = { lat: 23.0225, lng: 72.5714 }

function candidate(overrides: Partial<StockCandidate> & { nodeCode: string }): StockCandidate {
  return {
    nodeId: `id-${overrides.nodeCode}`,
    nodeName: `Shop ${overrides.nodeCode}`,
    nodeKind: 'retail',
    qty: 10,
    tracked: true,
    lat: AHMEDABAD.lat,
    lng: AHMEDABAD.lng,
    ...overrides,
  }
}

function context(
  candidates: StockCandidate[],
  overrides: Partial<StockContext> = {}
): StockContext {
  return {
    destination: AHMEDABAD,
    candidatesBySku: new Map([['SKU-1', candidates]]),
    policyBySku: new Map(),
    variantOutOfStock: new Set(),
    ...overrides,
  }
}

describe('the precedence ladder', () => {
  it('force_out beats a full shelf — a recall must not sell stock we still hold', () => {
    const ctx = context([candidate({ nodeCode: 'A', qty: 500 })], {
      policyBySku: new Map([['SKU-1', resolvePolicy({ mode: 'force_out', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: null, hubFallback: true })]]),
    })

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('out_of_stock')
    expect(result.decidedBy).toBe('policy_force_out')
    expect(result.origin).toBeNull()
  })

  it('the catalog flag beats force_in — a stale policy row must not resurrect a retired sku', () => {
    const ctx = context([candidate({ nodeCode: 'A' })], {
      policyBySku: new Map([['SKU-1', resolvePolicy({ mode: 'force_in', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: null, hubFallback: true })]]),
      variantOutOfStock: new Set(['SKU-1']),
    })

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('out_of_stock')
    expect(result.decidedBy).toBe('variant_out_of_stock')
  })

  it('force_in sells with no shelf at all, and stamps no origin to decrement', () => {
    const ctx = context([], {
      candidatesBySku: new Map(),
      policyBySku: new Map([['SKU-1', resolvePolicy({ mode: 'force_in', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: null, hubFallback: true })]]),
    })

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('in_stock')
    expect(result.decidedBy).toBe('policy_force_in')
    expect(result.origin).toBeNull()
  })
})

describe('nearest-first ranking', () => {
  it('picks the nearest enabled shop, not the first row the database returned', () => {
    // Rajkot is ~200 km from Ahmedabad; Vejalpur is inside it. Listed
    // far-first so passing by accident is impossible.
    const ctx = context([
      candidate({ nodeCode: 'RJT', lat: 22.2996, lng: 70.8042 }),
      candidate({ nodeCode: 'AHM', lat: 23.0059, lng: 72.5313 }),
    ], {
      policyBySku: new Map([
        ['SKU-1', resolvePolicy({ mode: 'auto', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: 5_000, hubFallback: true })],
      ]),
    })

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.origin?.nodeCode).toBe('AHM')
    expect(result.decidedBy).toBe('retail_hit')
  })

  it('accepts a stocked shop beyond the legacy radius for PAN India delivery', () => {
    const ctx = context(
      [
        candidate({ nodeCode: 'RJT', lat: 22.2996, lng: 70.8042 }),
        candidate({ nodeCode: 'HUB', nodeKind: 'hub' }),
      ],
      {
        policyBySku: new Map([
          [
            'SKU-1',
            resolvePolicy({
              mode: 'auto',
              lowStockAt: null,
              maxCascadeStores: null,
              maxRadiusKm: 50,
              hubFallback: true,
            }),
          ],
        ]),
      }
    )

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.origin?.nodeCode).toBe('RJT')
    expect(result.decidedBy).toBe('retail_hit')
    expect(result.candidates.find((c) => c.nodeCode === 'RJT')?.rejectedBecause).toBeNull()
  })

  it('an unrankable shop sorts last but is never dropped — a missing coordinate is not a missing shop', () => {
    const ctx = context([candidate({ nodeCode: 'NOCOORD', lat: null, lng: null })], {
      policyBySku: new Map([
        ['SKU-1', resolvePolicy({ mode: 'auto', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: 1, hubFallback: false })],
      ]),
    })

    const result = cascadeForSku('SKU-1', ctx)

    // maxRadiusKm is 1 km, and this shop would fail it if an unknown distance
    // counted as "too far". It must not.
    expect(result.status).toBe('in_stock')
    expect(result.origin?.nodeCode).toBe('NOCOORD')
    expect(result.candidates[0]?.distanceKm).toBeNull()
  })

  it('ranks nothing when the shopper pincode has no coordinate, but still sells', () => {
    const ctx = context(
      [candidate({ nodeCode: 'B' }), candidate({ nodeCode: 'A' })],
      { destination: null }
    )

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('in_stock')
    // Ties break on node code, so the winner is deterministic rather than
    // whatever order the rows arrived in.
    expect(result.origin?.nodeCode).toBe('A')
  })
})

describe('the hub fallback', () => {
  it('can use the hub beyond the legacy radius when retail inventory is empty', () => {
    const ctx = context(
      [candidate({ nodeCode: 'HUB', nodeKind: 'hub', lat: 22.2996, lng: 70.8042 })],
      {
        policyBySku: new Map([
          [
            'SKU-1',
            resolvePolicy({
              mode: 'auto',
              lowStockAt: null,
              maxCascadeStores: 1,
              maxRadiusKm: 10,
              hubFallback: true,
            }),
          ],
        ]),
      }
    )

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.decidedBy).toBe('hub_fallback')
    expect(result.origin?.nodeCode).toBe('HUB')
  })

  it('is skipped when the sku turns it off, and the answer is then out of stock', () => {
    const ctx = context([candidate({ nodeCode: 'HUB', nodeKind: 'hub' })], {
      policyBySku: new Map([
        ['SKU-1', resolvePolicy({ mode: 'auto', lowStockAt: null, maxCascadeStores: null, maxRadiusKm: null, hubFallback: false })],
      ]),
    })

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('out_of_stock')
    expect(result.decidedBy).toBe('hub_fallback_disabled')
  })
})

describe('low stock', () => {
  it('reports low_stock at or under the threshold', () => {
    const ctx = context([candidate({ nodeCode: 'A', qty: STOCK_DEFAULTS.lowStockAt })])
    expect(cascadeForSku('SKU-1', ctx).status).toBe('low_stock')
  })

  it('never claims scarcity for an untracked shelf — we cannot substantiate the count', () => {
    const ctx = context([candidate({ nodeCode: 'A', qty: 0, tracked: false })])

    const result = cascadeForSku('SKU-1', ctx)

    expect(result.status).toBe('in_stock')
    expect(result.origin?.nodeCode).toBe('A')
  })
})

describe('resolvePolicy', () => {
  it('treats a null limit as the service default, never as "no limit"', () => {
    const policy = resolvePolicy({
      mode: 'auto',
      lowStockAt: null,
      maxCascadeStores: null,
      maxRadiusKm: null,
      hubFallback: true,
    })

    expect(policy.maxCascadeStores).toBe(STOCK_DEFAULTS.maxCascadeStores)
    expect(policy.maxRadiusKm).toBe(STOCK_DEFAULTS.maxRadiusKm)
    expect(policy.lowStockAt).toBe(STOCK_DEFAULTS.lowStockAt)
  })

  it('falls back to auto for an unrecognised mode rather than trusting the string', () => {
    expect(
      resolvePolicy({
        mode: 'nonsense',
        lowStockAt: null,
        maxCascadeStores: null,
        maxRadiusKm: null,
        hubFallback: true,
      }).mode
    ).toBe('auto')
  })
})

describe('no candidates', () => {
  it('is out of stock, with no origin', () => {
    const result = cascadeForSku('SKU-1', context([], { candidatesBySku: new Map() }))

    expect(result.status).toBe('out_of_stock')
    expect(result.decidedBy).toBe('no_candidates')
    expect(result.origin).toBeNull()
    expect(result.etaDays).toBeNull()
  })
})
