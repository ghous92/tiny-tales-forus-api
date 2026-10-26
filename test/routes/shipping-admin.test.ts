/**
 * Route tests: /v1/admin/shipping/* — the data-in half of the delivery engine.
 *
 * The CRUD assertions here are ordinary. Three groups are not, and they are the
 * reason this file exists:
 *
 * 1. **Cache invalidation.** `services/shipping.ts` caches nodes, couriers and
 *    the parsed rule for 60 s, and caches pincode rows FOREVER. An operator who
 *    fixes a rate card and immediately opens the simulator must see the table
 *    they just saved, not the one they replaced — that stale number is exactly
 *    the number they are checking. So every write path is asserted through the
 *    PUBLIC read surface, immediately after the write.
 *
 * 2. **Imports refuse loudly.** A CSV that half-parses silently is worse than
 *    one that fails outright: the operator believes the carrier file is loaded,
 *    and every row that did not parse becomes "not serviceable" for a real
 *    customer. Line numbers, counts, and the blank-taluk rejection are all
 *    asserted, because the blank-taluk case silently promotes a whole district
 *    to the same-taluk price.
 *
 * 3. **Auth.** Forward geocode in particular is admin-only on purpose — it
 *    turns arbitrary text into coordinates on our Google quota.
 */

import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appConfig,
  courierRateSlabs,
  courierServiceAreas,
  courierServiceExceptions,
  pickupNodes,
  pincodes,
} from '../../src/db/schema.js'
import { clearShippingRateLimits } from '../../src/routes/shipping.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

const AHMEDABAD = '380001'
/** Same taluk as the pickup node → Zone A. */
const AHMEDABAD_SATELLITE = '380015'
/** Same state, different taluk → Zone B. */
const SURAT = '395003'

let ctx: TestContext

const A = () => auth(USER_ADMIN.token)

/** Promote USER_ADMIN — the first authed request creates the row, then flip the role. */
async function makeAdmin(): Promise<void> {
  await ctx.app.inject({ method: 'GET', url: '/v1/admin/shipping/nodes', headers: A() })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
}

/** A pickup node body with every default left to the schema. */
function nodeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 'AHM-01', name: 'Ahmedabad Warehouse', pincode: AHMEDABAD, ...over }
}

function courierBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 'delhivery', name: 'Delhivery Surface', ...over }
}

const SLABS = [
  { zone: 'A' as const, uptoG: 500, rateInr: 30, addlPerG: 1000, addlRateInr: 0 },
  { zone: 'A' as const, uptoG: 2000, rateInr: 105, addlPerG: 1000, addlRateInr: 45 },
  { zone: 'B' as const, uptoG: 500, rateInr: 37, addlPerG: 1000, addlRateInr: 0 },
  { zone: 'B' as const, uptoG: 2000, rateInr: 140, addlPerG: 1000, addlRateInr: 60 },
]

/** Reference rows + a live rule, so the PUBLIC endpoints can actually answer. */
async function seedReadWorld(): Promise<void> {
  await ctx.db.insert(pincodes).values([
    {
      pincode: AHMEDABAD,
      officeName: 'Ahmedabad GPO',
      taluk: 'Ahmadabad City',
      district: 'Ahmadabad',
      state: 'Gujarat',
      lat: 23.02,
      lng: 72.57,
    },
    {
      pincode: AHMEDABAD_SATELLITE,
      officeName: 'Satellite',
      taluk: 'Ahmadabad City',
      district: 'Ahmadabad',
      state: 'Gujarat',
      lat: 23.01,
      lng: 72.51,
    },
    {
      pincode: SURAT,
      officeName: 'Nanpura',
      taluk: 'Surat City',
      district: 'Surat',
      state: 'Gujarat',
      lat: 21.18,
      lng: 72.82,
    },
  ])

  await ctx.db.insert(appConfig).values([
    { key: 'shipping.enabled', value: true, description: '' },
    {
      key: 'shipping.freeAboveTiers',
      value: [{ uptoG: 2000, freeAboveInr: 249 }],
      description: '',
    },
    { key: 'shipping.thresholdBasis', value: 'preCoupon', description: '' },
    { key: 'shipping.marginBps', value: 1000, description: '' },
    { key: 'shipping.packagingTareG', value: 60, description: '' },
    { key: 'shipping.serviceableStates', value: ['Gujarat'], description: '' },
  ])
}

/** Build a full, quotable world through the ADMIN routes — the operator's real path. */
async function seedViaAdmin(): Promise<void> {
  await seedReadWorld()

  let res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/shipping/nodes',
    headers: A(),
    payload: nodeBody(),
  })
  expect(res.statusCode).toBe(201)

  res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/shipping/couriers',
    headers: A(),
    payload: courierBody(),
  })
  expect(res.statusCode).toBe(201)

  res = await ctx.app.inject({
    method: 'PUT',
    url: '/v1/admin/shipping/couriers/delhivery/slabs',
    headers: A(),
    payload: { slabs: SLABS },
  })
  expect(res.statusCode).toBe(200)

  res = await ctx.app.inject({
    method: 'PUT',
    url: '/v1/admin/shipping/couriers/delhivery/service-areas',
    headers: A(),
    payload: { serviceAreas: [{ fromPincode: '360001', toPincode: '396999' }] },
  })
  expect(res.statusCode).toBe(200)
}

/** The public answer for a destination — what a shopper would be told, right now. */
async function serviceability(pincode: string): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/v1/shipping/serviceability?pincode=${pincode}`,
  })
  expect(res.statusCode).toBe(200)
  return res.json() as Record<string, unknown>
}

beforeEach(async () => {
  clearShippingRateLimits()
  ctx = await createTestApp()
  await makeAdmin()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx.app.close()
})

describe('auth', () => {
  it('refuses an anonymous caller', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/admin/shipping/nodes' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a signed-in shopper', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/shipping/nodes',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('keeps forward geocode off the public surface', async () => {
    // Unlike GET /v1/geocode/reverse. Reverse needs a coordinate the caller
    // already has; forward turns arbitrary text into coordinates on our quota.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/geocode/forward',
      headers: auth(USER_A.token),
      payload: { address: 'Sarkhej Road, Ahmedabad' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('pickup nodes', () => {
  it('creates one with the schema defaults and no coordinates', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody(),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      code: 'AHM-01',
      name: 'Ahmedabad Warehouse',
      contactName: '',
      contactPhone: '',
      houseNumber: '',
      roadArea: '',
      city: '',
      state: '',
      pincode: AHMEDABAD,
      // Null until an operator resolves the geocode and confirms it on a map.
      lat: null,
      lng: null,
      isActive: true,
      priority: 0,
      cutoffIst: '15:00',
    })
  })

  it('rejects a duplicate code', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody(),
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ name: 'Other' }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('AHM-01')
  })

  it('rejects a malformed cutoff time', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ cutoffIst: '3pm' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('lists by priority, then code', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ code: 'SUR-01', priority: 5 }),
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ code: 'AHM-02' }),
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ code: 'AHM-01' }),
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
    })
    expect(res.json().nodes.map((n: { code: string }) => n.code)).toEqual([
      'AHM-01',
      'AHM-02',
      'SUR-01',
    ])
  })

  it('leaves the pin alone when only the name changes', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ lat: 23.000357, lng: 72.5305072 }),
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/nodes/AHM-01',
      headers: A(),
      payload: { name: 'Ahmedabad Warehouse (Sarkhej)' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Ahmedabad Warehouse (Sarkhej)',
      lat: 23.000357,
      lng: 72.5305072,
    })
  })

  it('patches only what was sent, leaving the rest of the address intact', async () => {
    // Zod 4's `.partial()` does NOT strip `.default()`: an absent key still
    // materialises its default, so a create-schema-derived update schema turns
    // every PUT into a full row overwrite. Renaming a node would have blanked
    // its street address and silently re-enabled it.
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({
        houseNumber: 'Plot 42',
        roadArea: 'Sarkhej Road',
        city: 'Ahmedabad',
        state: 'Gujarat',
        contactPhone: '+919000000002',
        cutoffIst: '17:30',
        priority: 3,
        isActive: false,
      }),
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/nodes/AHM-01',
      headers: A(),
      payload: { name: 'Ahmedabad Warehouse (Sarkhej)' },
    })

    expect(res.json()).toMatchObject({
      name: 'Ahmedabad Warehouse (Sarkhej)',
      houseNumber: 'Plot 42',
      roadArea: 'Sarkhej Road',
      city: 'Ahmedabad',
      state: 'Gujarat',
      contactPhone: '+919000000002',
      cutoffIst: '17:30',
      priority: 3,
      isActive: false,
    })
  })

  it('clears the pin when the address moves without new coordinates', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ lat: 23.000357, lng: 72.5305072 }),
    })

    // A node whose address changed but whose pin did not is a node that now
    // prices every order from the wrong origin, quietly. Force the operator
    // back through resolve-and-confirm.
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/nodes/AHM-01',
      headers: A(),
      payload: { city: 'Surat', pincode: SURAT },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ city: 'Surat', pincode: SURAT, lat: null, lng: null })
  })

  it('keeps coordinates supplied alongside the address change', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody(),
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/nodes/AHM-01',
      headers: A(),
      payload: { city: 'Surat', pincode: SURAT, lat: 21.18, lng: 72.82 },
    })

    expect(res.json()).toMatchObject({ lat: 21.18, lng: 72.82 })
  })

  it('404s on an unknown code, for both update and delete', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/nodes/NOPE',
      headers: A(),
      payload: { name: 'x' },
    })
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/shipping/nodes/NOPE',
      headers: A(),
    })
    expect(put.statusCode).toBe(404)
    expect(del.statusCode).toBe(404)
  })

  it('deletes', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody(),
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/shipping/nodes/AHM-01',
      headers: A(),
    })
    expect(res.statusCode).toBe(204)

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
    })
    expect(list.json().nodes).toEqual([])
  })
})

describe('couriers', () => {
  it('creates one with the cost-formula defaults', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody(),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      code: 'delhivery',
      name: 'Delhivery Surface',
      isActive: true,
      mode: 'surface',
      rateModel: 'weight',
      volumetricDivisor: 5000,
      minChargeableG: 500,
      fuelBps: 0,
      gstBps: 1800,
      docketFeeInr: 0,
      riskBps: 0,
      riskMinInr: 0,
      codFlatInr: 0,
      codBps: 0,
      rtoBps: 0,
      slaDaysZoneA: 2,
      slaDaysZoneB: 4,
      reliabilityScore: 50,
      priority: 0,
      slabs: [],
      serviceAreas: [],
      exceptionCount: 0,
    })
  })

  it('rejects an uppercase code — handles end up in URLs and ops tooling', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody({ code: 'Delhivery' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects a duplicate code', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody(),
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody({ name: 'Other' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('404s reading a courier that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/shipping/couriers/nope',
      headers: A(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('patches one formula field without resetting the rest of the formula', async () => {
    // The money version of the node-patch bug: nudging the fuel surcharge must
    // not quietly restore gstBps/minChargeableG/reliabilityScore to their
    // defaults, which would be a rate card nobody entered.
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody({
        gstBps: 500,
        minChargeableG: 250,
        docketFeeInr: 5,
        reliabilityScore: 91,
        slaDaysZoneB: 6,
        priority: 2,
        isActive: false,
      }),
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery',
      headers: A(),
      payload: { fuelBps: 1100 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      fuelBps: 1100,
      gstBps: 500,
      minChargeableG: 250,
      docketFeeInr: 5,
      reliabilityScore: 91,
      slaDaysZoneB: 6,
      priority: 2,
      isActive: false,
      name: 'Delhivery Surface',
    })
  })

  it('takes the whole rate card with it on delete', async () => {
    await seedViaAdmin()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers/delhivery/exceptions',
      headers: A(),
      payload: { csv: '380001,yes' },
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/shipping/couriers/delhivery',
      headers: A(),
    })
    expect(res.statusCode).toBe(204)

    // Orphan rate rows are invisible until someone re-creates the same code and
    // silently inherits a price list they never entered.
    expect(await ctx.db.select().from(courierRateSlabs)).toEqual([])
    expect(await ctx.db.select().from(courierServiceAreas)).toEqual([])
    expect(await ctx.db.select().from(courierServiceExceptions)).toEqual([])
  })
})

describe('rate cards', () => {
  beforeEach(async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody(),
    })
  })

  it('replaces the card wholesale rather than merging into it', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/slabs',
      headers: A(),
      payload: { slabs: SLABS },
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/slabs',
      headers: A(),
      payload: { slabs: [{ zone: 'A', uptoG: 500, rateInr: 33, addlPerG: 1000, addlRateInr: 0 }] },
    })

    // Yesterday's zone-B rows are gone. A merge would leave them priced from a
    // contract nobody signed.
    expect(res.json().slabs).toEqual([
      { zone: 'A', uptoG: 500, rateInr: 33, addlPerG: 1000, addlRateInr: 0 },
    ])
  })

  it('names a duplicate slab instead of leaking a primary-key violation', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/slabs',
      headers: A(),
      payload: {
        slabs: [
          { zone: 'B', uptoG: 500, rateInr: 37, addlPerG: 1000, addlRateInr: 0 },
          { zone: 'B', uptoG: 500, rateInr: 41, addlPerG: 1000, addlRateInr: 0 },
        ],
      },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toBe('Duplicate slab for zone B at 500 g')
  })

  it('accepts an empty card — a carrier being onboarded quotes nothing, not free', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/slabs',
      headers: A(),
      payload: { slabs: SLABS },
    })

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/slabs',
      headers: A(),
      payload: { slabs: [] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().slabs).toEqual([])
  })

  it('404s for an unknown courier and writes nothing', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/nope/slabs',
      headers: A(),
      payload: { slabs: SLABS },
    })

    expect(res.statusCode).toBe(404)
    expect(await ctx.db.select().from(courierRateSlabs)).toEqual([])
  })

  it('rejects an inverted service-area range', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/service-areas',
      headers: A(),
      payload: { serviceAreas: [{ fromPincode: '396999', toPincode: '360001' }] },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('inverted')
  })

  it('applies the prepaid/cod defaults to a service area', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/admin/shipping/couriers/delhivery/service-areas',
      headers: A(),
      payload: { serviceAreas: [{ fromPincode: '360001', toPincode: '396999' }] },
    })

    // COD is off by default — the whole engine is prepaid-only at v1.
    expect(res.json().serviceAreas).toEqual([
      { fromPincode: '360001', toPincode: '396999', prepaid: true, cod: false, isActive: true },
    ])
  })
})

describe('cache invalidation', () => {
  it('clears the quote on courier deletion while keeping PAN India sales coverage', async () => {
    await seedViaAdmin()
    expect(await serviceability(SURAT)).toMatchObject({ serviceable: true, zone: 'B' })

    await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/shipping/couriers/delhivery',
      headers: A(),
    })

    expect(await serviceability(SURAT)).toMatchObject({
      serviceable: true,
      zone: null,
      reason: 'not_serviceable',
    })
  })

  it('picks up a newly imported pincode, which is cached without expiry', async () => {
    await seedViaAdmin()
    const RAJKOT = '360002'

    // Caches the miss. Pincode rows are reference data, so this negative entry
    // has no TTL to save us — only the explicit reset does.
    expect(await serviceability(RAJKOT)).toMatchObject({ serviceable: true, estimated: true })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/pincodes/import',
      headers: A(),
      payload: { csv: '360002,Bhaktinagar,Rajkot,Rajkot,Gujarat,22.2614013,70.7694817' },
    })
    expect(res.json()).toMatchObject({ parsed: 1, inserted: 1, skipped: 0 })

    expect(await serviceability(RAJKOT)).toMatchObject({
      serviceable: true,
      estimated: false,
      zone: 'B',
    })
  })

  it('applies a freshly imported serviceability exception', async () => {
    await seedViaAdmin()
    expect(await serviceability(SURAT)).toMatchObject({ serviceable: true })

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers/delhivery/exceptions',
      headers: A(),
      payload: { csv: `${SURAT},no` },
    })

    // A missing courier lane switches to a distance estimate, never a sales block.
    expect(await serviceability(SURAT)).toMatchObject({ serviceable: true, estimated: true })
  })
})

describe('serviceability CSV import', () => {
  beforeEach(async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers',
      headers: A(),
      payload: courierBody(),
    })
  })

  async function importCsv(csv: string, replace = false): Promise<Record<string, unknown>> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers/delhivery/exceptions',
      headers: A(),
      payload: { csv, replace },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as Record<string, unknown>
  }

  it('skips the header row and counts the rest', async () => {
    const result = await importCsv('Pincode,Serviceable\n380001,Y\n395003,N\n360002,yes')
    expect(result).toMatchObject({
      parsed: 3,
      inserted: 3,
      updated: 0,
      skipped: 0,
      errors: [],
      errorsTruncated: false,
    })
  })

  it('treats a missing second column as serviceable', async () => {
    // Carriers publish lists of what they DO cover far more often than mixed files.
    await importCsv('380001\n395003')
    const rows = await ctx.db.select().from(courierServiceExceptions)
    expect(rows.every((row) => row.serviceable)).toBe(true)
  })

  it('counts a re-import as an update, not an insert', async () => {
    await importCsv('380001,Y')
    expect(await importCsv('380001,N')).toMatchObject({ parsed: 1, inserted: 0, updated: 1 })

    const [row] = await ctx.db.select().from(courierServiceExceptions)
    expect(row?.serviceable).toBe(false)
  })

  it('reports the line number of a malformed pincode', async () => {
    const result = await importCsv('Pincode,Serviceable\n380001,Y\n38001,Y\n395003,Y')
    expect(result).toMatchObject({ parsed: 3, inserted: 2, skipped: 1 })
    expect(result.errors).toEqual([{ line: 3, message: '"38001" is not a 6-digit pincode' }])
  })

  it('refuses an unparseable yes/no rather than defaulting it', async () => {
    // Guessing here turns one typo into a silently unserviceable postcode.
    const result = await importCsv('380001,maybe')
    expect(result).toMatchObject({ parsed: 1, inserted: 0, skipped: 1 })
    expect(result.errors).toEqual([{ line: 1, message: '"maybe" is not a yes/no value' }])
  })

  it('says so when the file contradicts itself, and keeps the last row', async () => {
    const result = await importCsv('380001,Y\n380001,N')
    expect(result).toMatchObject({ parsed: 2, inserted: 1, skipped: 1 })
    expect((result.errors as { message: string }[])[0]?.message).toContain('conflicting')

    const [row] = await ctx.db.select().from(courierServiceExceptions)
    expect(row?.serviceable).toBe(false)
  })

  it('wipes the courier’s existing exceptions when asked to replace', async () => {
    await importCsv('380001,Y\n395003,Y')
    await importCsv('360002,Y', true)

    const rows = await ctx.db.select().from(courierServiceExceptions)
    expect(rows.map((row) => row.pincode)).toEqual(['360002'])
  })

  it('404s for an unknown courier', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/couriers/nope/exceptions',
      headers: A(),
      payload: { csv: '380001,Y' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('pincode CSV import', () => {
  async function importCsv(csv: string): Promise<Record<string, unknown>> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/pincodes/import',
      headers: A(),
      payload: { csv },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as Record<string, unknown>
  }

  it('imports the India Post columns, coordinates optional', async () => {
    const result = await importCsv(
      'Pincode,OfficeName,Taluk,District,State,Lat,Lng\n' +
        '380001,Ahmedabad GPO,Ahmadabad City,Ahmadabad,Gujarat,23.02,72.57\n' +
        '395003,Nanpura,Surat City,Surat,Gujarat'
    )

    expect(result).toMatchObject({ parsed: 2, inserted: 2, updated: 0, skipped: 0 })
    const rows = await ctx.db.select().from(pincodes)
    expect(rows.find((row) => row.pincode === '395003')).toMatchObject({
      taluk: 'Surat City',
      lat: null,
      lng: null,
    })
  })

  it('upserts on re-import', async () => {
    await importCsv('380001,Ahmedabad GPO,Ahmadabad City,Ahmadabad,Gujarat')
    expect(await importCsv('380001,Ahmedabad HO,Ahmadabad City,Ahmadabad,Gujarat')).toMatchObject({
      inserted: 0,
      updated: 1,
    })

    const [row] = await ctx.db.select().from(pincodes)
    expect(row?.officeName).toBe('Ahmedabad HO')
  })

  it('rejects a blank taluk and says why', async () => {
    // The failure this catches: a file loaded with the District column in the
    // Taluk position promotes an entire district to the same-taluk price. A
    // blank taluk is the same mistake one column earlier.
    const result = await importCsv('380001,Ahmedabad GPO,,Ahmadabad,Gujarat')

    expect(result).toMatchObject({ parsed: 1, inserted: 0, skipped: 1 })
    expect((result.errors as { message: string }[])[0]?.message).toContain(
      'Zone A is derived from taluk'
    )
    expect(await ctx.db.select().from(pincodes)).toEqual([])
  })

  it('rejects a blank state — the serviceable-state fence reads that column', async () => {
    const result = await importCsv('380001,Ahmedabad GPO,Ahmadabad City,Ahmadabad,')
    expect(result).toMatchObject({ skipped: 1 })
    expect((result.errors as { message: string }[])[0]?.message).toContain(
      'serviceable-state fence'
    )
  })

  it('caps the reported errors and flags the truncation', async () => {
    // "imported 154,997 of 155,000" with no line numbers is not an answer
    // anyone can act on; neither is 155,000 error objects.
    const rows = Array.from({ length: 51 }, (_, i) => `${360001 + i},Office,,District,Gujarat`)
    const result = await importCsv(['Pincode,OfficeName,Taluk,District,State', ...rows].join('\n'))

    expect(result).toMatchObject({ parsed: 51, inserted: 0, skipped: 51, errorsTruncated: true })
    expect((result.errors as unknown[]).length).toBe(50)
  })
})

describe('readiness', () => {
  async function readiness(): Promise<{ ready: boolean; problems: string[] }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/shipping/readiness',
      headers: A(),
    })
    expect(res.statusCode).toBe(200)
    return res.json() as { ready: boolean; problems: string[] }
  }

  it('names everything missing on an empty database', async () => {
    const result = await readiness()
    expect(result.ready).toBe(false)
    expect(result.problems).toEqual([
      'No active pickup node.',
      'No active courier.',
      'No courier rate slabs.',
    ])
  })

  it('does not require an individual reference row for every pickup pincode', async () => {
    await seedViaAdmin()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody({ code: 'RAJ-01', pincode: '360002' }),
    })

    const result = await readiness()
    expect(result).toEqual({ ready: true, problems: [] })
  })

  it('passes once the world is seeded', async () => {
    await seedViaAdmin()
    expect(await readiness()).toEqual({ ready: true, problems: [] })
  })
})

describe('forward geocode', () => {
  function stubGoogle(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => body }) as Response)
    )
  }

  const GOOGLE_OK = {
    status: 'OK',
    results: [
      {
        formatted_address: 'Sarkhej Rd, Juhapura, Ahmedabad, Gujarat 380055, India',
        geometry: { location: { lat: 23.000357, lng: 72.5305072 } },
        address_components: [{ long_name: '380055', types: ['postal_code'] }],
      },
    ],
  }

  async function forward(
    address = 'Saman Product Company, Ahmedabad'
  ): Promise<LightMyRequestResponse> {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/geocode/forward',
      headers: A(),
      payload: { address },
    })
  }

  it('degrades to 503 when no Maps key is configured', async () => {
    const res = await forward()
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('geocoding_disabled')
  })

  it('resolves an address to a coordinate and a pincode', async () => {
    await ctx.app.close()
    stubGoogle(GOOGLE_OK)
    ctx = await createTestApp({ googleMapsServerKey: 'test-key' })
    await makeAdmin()

    const res = await forward()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      lat: 23.000357,
      lng: 72.5305072,
      pincode: '380055',
      formattedAddress: 'Sarkhej Rd, Juhapura, Ahmedabad, Gujarat 380055, India',
    })
  })

  it('404s when Google has no answer — a lookup miss is not an outage', async () => {
    await ctx.app.close()
    stubGoogle({ status: 'ZERO_RESULTS', results: [] })
    ctx = await createTestApp({ googleMapsServerKey: 'test-key' })
    await makeAdmin()

    const res = await forward('nowhere at all')
    expect(res.statusCode).toBe(404)
  })

  it('never saves what it resolved', async () => {
    await ctx.app.close()
    stubGoogle(GOOGLE_OK)
    ctx = await createTestApp({ googleMapsServerKey: 'test-key' })
    await makeAdmin()
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/shipping/nodes',
      headers: A(),
      payload: nodeBody(),
    })

    await forward()

    // A silently-geocoded origin mis-prices every order from that node and
    // gives no sign it has done so. The operator looks, then saves.
    const [node] = await ctx.db.select().from(pickupNodes)
    expect(node).toMatchObject({ lat: null, lng: null })
  })
})
