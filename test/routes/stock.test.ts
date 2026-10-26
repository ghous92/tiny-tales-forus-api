/**
 * Integration tests for the stock surfaces, end to end through the real app.
 *
 * `test/services/stock.test.ts` proves the cascade's decision rules against a
 * pure function. These prove the things only the wiring can get wrong:
 *
 * 1. **The public response leaks nothing.** The cascade knows which shop won,
 *    how far it is and how many units it holds; the public payload must carry
 *    the sku, a status and an ETA range and NOTHING else. This is the test that
 *    fails when someone adds a helpful field to `CascadeResult`.
 * 2. **`stock_enabled` and `is_active` are both required**, and are genuinely
 *    two different flags rather than one overloaded one.
 * 3. **The admin surface is admin-only**, and is where the store-by-store
 *    detail the public route refuses actually lives.
 * 4. **Every write lands an audit row in the same transaction**, with a delta
 *    computed server-side from the value that was actually replaced.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  catalogItems,
  categories,
  pickupNodes,
  pincodes,
  productVariants,
  products,
  storeStock,
} from '../../src/db/schema.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

const SKU = 'DAN-CREAM-100'
/** Shopper in Ahmedabad. */
const AHMEDABAD = '380001'
/** ~200 km away, so the radius rules are exercised on a real Gujarat lane. */
const RAJKOT = '360001'

let ctx: TestContext
let nearNodeId: string
let farNodeId: string
let hubNodeId: string

/**
 * A three-node world: a shop in Ahmedabad, a shop in Rajkot, and a hub. All
 * three carry coordinates, and the destination pincodes do too, so distance
 * ranking is live rather than silently degenerate.
 */
async function seedStockWorld(): Promise<void> {
  await ctx.db.insert(pincodes).values([
    {
      pincode: AHMEDABAD,
      taluk: 'Ahmadabad City',
      district: 'Ahmadabad',
      state: 'Gujarat',
      lat: 23.0225,
      lng: 72.5714,
    },
    {
      pincode: RAJKOT,
      taluk: 'Rajkot',
      district: 'Rajkot',
      state: 'Gujarat',
      lat: 22.2996,
      lng: 70.8042,
    },
  ])

  const nodes = await ctx.db
    .insert(pickupNodes)
    .values([
      {
        code: 'AHM-NEAR',
        name: 'Near Shop',
        pincode: AHMEDABAD,
        city: 'Ahmedabad',
        state: 'Gujarat',
        lat: 23.0059,
        lng: 72.5313,
        kind: 'retail',
        stockEnabled: true,
        isActive: true,
      },
      {
        code: 'RJT-FAR',
        name: 'Far Shop',
        pincode: RAJKOT,
        city: 'Rajkot',
        state: 'Gujarat',
        lat: 22.2996,
        lng: 70.8042,
        kind: 'retail',
        stockEnabled: true,
        isActive: true,
      },
      {
        code: 'AHM-HUB',
        name: 'Central Hub',
        pincode: AHMEDABAD,
        city: 'Ahmedabad',
        state: 'Gujarat',
        lat: 23.0242,
        lng: 72.5847,
        kind: 'hub',
        stockEnabled: true,
        isActive: true,
      },
    ])
    .returning({ id: pickupNodes.id, code: pickupNodes.code })

  nearNodeId = nodes.find((n) => n.code === 'AHM-NEAR')!.id
  farNodeId = nodes.find((n) => n.code === 'RJT-FAR')!.id
  hubNodeId = nodes.find((n) => n.code === 'AHM-HUB')!.id

  // store_stock.sku FKs to catalog_items.sku — a shelf can only carry a
  // catalogued sku. Tests write store_stock rows for SKU directly, so it
  // must exist here.
  await ctx.db.insert(catalogItems).values({
    sku: SKU,
    productId: 'dan-cream',
    name: 'Daniya Cold Cream',
    size: '100ml',
    priceInr: 119,
    active: true,
  })
}

// A fresh PGlite with all 18 migrations applied, per test. That is ~25-35s of
// setup under parallel load, so this file needs more than the 60s default
// hookTimeout in vitest.config.ts — the isolation is worth the wall clock,
// since these tests assert on cross-request state (audit rows, policy edits)
// that a shared database would let leak between cases.
beforeEach(async () => {
  ctx = await createTestApp()
  await seedStockWorld()
}, 180_000)

describe('POST /v1/stock/availability', () => {
  it('says out of stock when no shelf anywhere holds the sku', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().items).toEqual([{ sku: SKU, status: 'out_of_stock', etaDays: null }])
  })

  it('answers with the sku, a status and an ETA RANGE — and nothing that identifies a store', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 40 })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    const [item] = response.json().items
    expect(item).toEqual({ sku: SKU, status: 'in_stock', etaDays: { min: 2, max: 4 } })

    // The whole-payload assertion is the point: a new field on `CascadeResult`
    // must not be able to reach a shopper by being forwarded accidentally.
    const body = response.body
    expect(body).not.toContain('AHM-NEAR')
    expect(body).not.toContain('Near Shop')
    expect(body).not.toContain(nearNodeId)
    expect(body).not.toContain('40')
    expect(Object.keys(item).sort()).toEqual(['etaDays', 'sku', 'status'])
  })

  it('does not source from a node with stock_enabled = false, however full its shelf', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 999 })
    await ctx.db.update(pickupNodes).set({ stockEnabled: false })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.json().items[0].status).toBe('out_of_stock')
  })

  it('does not source from an inactive node either — the two flags are independent', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 999 })
    // stock_enabled stays TRUE. Only the courier-pickup flag is off.
    await ctx.db.update(pickupNodes).set({ isActive: false })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.json().items[0].status).toBe('out_of_stock')
  })

  it('respects the catalog flag', async () => {
    await ctx.db.insert(categories).values({ slug: 'body cream', label: 'Body Cream' })
    await ctx.db.insert(products).values({
      id: 'dan-body-cream',
      slug: 'daniya-body-cream',
      name: 'Daniya Body Cream',
      category: 'body cream',
    })
    await ctx.db.insert(productVariants).values({
      sku: SKU,
      productId: 'dan-body-cream',
      size: '100ml',
      priceInr: 119,
      inStock: false,
    })
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 40 })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.json().items[0].status).toBe('out_of_stock')
  })

  it('caches privately and sets no stock-keyed ETag — a cheap poll must not read counts', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 40 })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.headers['cache-control']).toBe('private, max-age=60')
    expect(response.headers.etag).toBeUndefined()
  })

  it('rejects a sku list above the cap rather than letting one request price the catalogue', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: Array.from({ length: 51 }, (_, i) => `SKU-${i}`) },
    })

    // Schema rejections surface as 422 through the zod type provider's error
    // handler, not 400 — the cap is enforced in the contract, not the handler.
    expect(response.statusCode).toBe(422)
  })

  it('needs no authentication — availability is asked before anyone commits', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.statusCode).toBe(200)
  })
})

describe('the hub fallback, end to end', () => {
  it('can source a retail shelf beyond the legacy distance limit', async () => {
    await ctx.db.insert(storeStock).values([
      { nodeId: farNodeId, sku: SKU, qty: 40 },
      { nodeId: hubNodeId, sku: SKU, qty: 5 },
    ])

    // Default radius is 150 km; Ahmedabad→Rajkot is ~200.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })

    expect(response.json().items[0].status).not.toBe('out_of_stock')

    // The public answer does not say "hub", so confirm the routing through the
    // admin explainer, which is where that detail is allowed to exist.
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    const explain = await ctx.app.inject({
      method: 'GET',
      url: `/v1/admin/stock/explain?sku=${SKU}&pincode=${AHMEDABAD}`,
      headers: auth(USER_ADMIN.token),
    })

    expect(explain.json().decidedBy).toBe('retail_hit')
  })
})

describe('/v1/admin/stock', () => {
  beforeEach(async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  })

  it('refuses a non-admin — this is exactly the detail the public route withholds', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/stock',
      headers: auth(USER_A.token),
    })

    expect(response.statusCode).toBe(403)
  })

  it('refuses an anonymous caller', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/admin/stock' })
    expect(response.statusCode).toBe(401)
  })

  it('sets an absolute count and audits it with a server-computed delta', async () => {
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/admin/stock/${nearNodeId}/${SKU}`,
      headers: auth(USER_ADMIN.token),
      payload: { qty: 12, reason: 'restock' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().qty).toBe(12)

    const second = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/admin/stock/${nearNodeId}/${SKU}`,
      headers: auth(USER_ADMIN.token),
      payload: { qty: 7, reason: 'correction' },
    })
    expect(second.json().qty).toBe(7)

    const audit = await ctx.app.inject({
      method: 'GET',
      url: `/v1/admin/stock/audit?sku=${SKU}`,
      headers: auth(USER_ADMIN.token),
    })
    const entries = audit.json().entries

    expect(entries).toHaveLength(2)
    // Newest first.
    expect(entries[0]).toMatchObject({ oldQty: 12, newQty: 7, delta: -5, reason: 'correction' })
    expect(entries[1]).toMatchObject({ oldQty: null, newQty: 12, delta: 12, reason: 'restock' })
  })

  it('is idempotent on a repeated absolute write — a retry cannot double-apply', async () => {
    const payload = { qty: 20, reason: 'manual' as const }
    for (let i = 0; i < 3; i += 1) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/v1/admin/stock/${nearNodeId}/${SKU}`,
        headers: auth(USER_ADMIN.token),
        payload,
      })
    }

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/v1/admin/stock?sku=${SKU}`,
      headers: auth(USER_ADMIN.token),
    })

    expect(list.json().rows).toHaveLength(1)
    expect(list.json().rows[0].qty).toBe(20)
  })

  it('will not let an operator stamp a change as order_paid', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/admin/stock/${nearNodeId}/${SKU}`,
      headers: auth(USER_ADMIN.token),
      payload: { qty: 5, reason: 'order_paid' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('force_out takes a full shelf off sale immediately', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 100 })

    const before = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })
    expect(before.json().items[0].status).toBe('in_stock')

    await ctx.app.inject({
      method: 'PUT',
      url: `/v1/admin/stock/policy/${SKU}`,
      headers: auth(USER_ADMIN.token),
      payload: { mode: 'force_out', note: 'batch pulled for testing' },
    })

    const after = await ctx.app.inject({
      method: 'POST',
      url: '/v1/stock/availability',
      payload: { pincode: AHMEDABAD, skus: [SKU] },
    })
    expect(after.json().items[0].status).toBe('out_of_stock')
  })

  it('explains a decision, including the candidates it rejected and why', async () => {
    await ctx.db.insert(storeStock).values([
      { nodeId: nearNodeId, sku: SKU, qty: 40 },
      { nodeId: farNodeId, sku: SKU, qty: 40 },
    ])

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/admin/stock/explain?sku=${SKU}&pincode=${AHMEDABAD}`,
      headers: auth(USER_ADMIN.token),
    })

    const body = response.json()
    expect(body.decidedBy).toBe('retail_hit')
    expect(
      body.candidates.find((c: { nodeCode: string }) => c.nodeCode === 'AHM-NEAR').chosen
    ).toBe(true)
    expect(body.destinationCoords).toEqual({ lat: 23.0225, lng: 72.5714 })
    expect(body.effectivePolicy.maxCascadeStores).toBe(3)
  })

  it('surfaces a shelf that a paid order drove negative', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: -3 })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/stock/oversells',
      headers: auth(USER_ADMIN.token),
    })

    expect(response.json().rows).toHaveLength(1)
    expect(response.json().rows[0].qty).toBe(-3)
  })

  it('flags a node with no coordinate, because it can never be ranked', async () => {
    await ctx.db.update(pickupNodes).set({ lat: null, lng: null })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/stock/nodes',
      headers: auth(USER_ADMIN.token),
    })

    expect(response.json().nodes.every((n: { hasCoords: boolean }) => !n.hasCoords)).toBe(true)
  })
})

describe('the public config surface', () => {
  it('carries no stock keys — stock keeps its own tables, and the snapshot allowlist excludes them regardless', async () => {
    await ctx.db.insert(storeStock).values({ nodeId: nearNodeId, sku: SKU, qty: 40 })

    const response = await ctx.app.inject({ method: 'GET', url: '/v1/config' })
    const body = response.body

    expect(body).not.toContain('store_stock')
    expect(body).not.toContain('stock.')
    expect(body).not.toContain(nearNodeId)
  })
})
