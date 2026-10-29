#!/usr/bin/env tsx
/**
 * `npm run db:seed-shipping` — placeholder courier rate cards, one pickup node,
 * and a starter set of Gujarat pincodes, so the shipping engine and the admin
 * simulator are exercisable the moment the migration lands.
 *
 * **Delhivery's slab rows are real** (pulled from the prod Kinko rate API,
 * see the comment on `SLAB_SEEDS`) — every other courier's numbers are still
 * placeholder mid-range public figures. None of this is a substitute for the
 * admin courier editor: real or not, these seeds exist so that
 * `POST /v1/admin/shipping/simulate` has something to compute against, not so
 * that anyone ships against them. Replace/verify from the admin courier
 * editor before `shipping.enabled` is ever flipped on, same as before.
 *
 * The same goes for `pincodes`: this seeds a couple of dozen Gujarat rows to
 * make the zone logic real. The production dataset is India Post's public
 * pincode file (~155k rows, columns `OfficeName / Taluk / DistrictName /
 * StateName`), imported separately — Zone A is derived from TALUK equality, so
 * a district-only import would quietly over-count Zone A across the rural parts
 * of the Ahmedabad and Surat districts.
 *
 * Idempotent: every insert is `onConflictDoNothing`, so re-running adds only
 * what is missing and never overwrites an operator's edits.
 *
 * DEV ONLY — guarded by `assertDevOnly`. Staging and production get their rate
 * cards from the admin surface, entered from signed carrier contracts. There is
 * no path by which a researched public rate becomes a charged rate.
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import {
  courierRateSlabs,
  courierServiceAreas,
  couriers,
  pickupNodes,
  pincodes,
  type NewCourierRateSlabRow,
  type NewCourierRow,
  type NewPincodeRow,
} from '../src/db/schema.js'
import { assertDevOnly } from './dev-only.js'

/** PLACEHOLDER — public mid-range surface rates, not negotiated ones. */
export const COURIER_SEEDS: NewCourierRow[] = [
  {
    code: 'delhivery',
    name: 'Delhivery Surface',
    fuelBps: 1100,
    gstBps: 1800,
    docketFeeInr: 5,
    volumetricDivisor: 5000,
    minChargeableG: 500,
    // Delhivery's published surface COD charge: 1.5% of the collectable
    // amount or ₹35, whichever is higher — max(codFlatInr, value×codBps)
    // is exactly that formula (lib/shipping.ts). PLACEHOLDER, same as the
    // fuel/GST/docket figures above: their real negotiated COD card may
    // differ. Verify from the admin courier editor before shipping.enabled.
    codFlatInr: 35,
    codBps: 150,
    slaDaysZoneA: 2,
    slaDaysZoneB: 4,
    reliabilityScore: 75,
    priority: 0,
  },
  {
    code: 'xpressbees',
    name: 'Xpressbees Surface',
    fuelBps: 1000,
    gstBps: 1800,
    docketFeeInr: 0,
    volumetricDivisor: 5000,
    minChargeableG: 500,
    // Same public-rate placeholder pattern as Delhivery above — not this
    // courier's negotiated card.
    codFlatInr: 35,
    codBps: 150,
    slaDaysZoneA: 2,
    slaDaysZoneB: 4,
    reliabilityScore: 65,
    priority: 1,
  },
  {
    code: 'shadowfax',
    name: 'Shadowfax Surface',
    fuelBps: 1200,
    gstBps: 1800,
    docketFeeInr: 0,
    // Bulkier billing: a 4000 divisor charges MORE volumetric weight for the
    // same carton than a 5000 one. This is exactly the divergence the engine
    // computes chargeable weight per candidate for.
    volumetricDivisor: 4000,
    minChargeableG: 500,
    // Same public-rate placeholder pattern as Delhivery above — not this
    // courier's negotiated card.
    codFlatInr: 35,
    codBps: 150,
    slaDaysZoneA: 1,
    slaDaysZoneB: 3,
    reliabilityScore: 60,
    priority: 2,
  },
]

/**
 * Base freight (pre-fuel, pre-GST) in whole rupees.
 *
 * Delhivery rows are REAL, not placeholder — pulled from the prod Kinko rate
 * API (`GET /api/kinko/v1/invoice/charges/.json`, `charge_DL` field, which is
 * exactly this table's `rateInr`: pre-fuel/pre-GST base freight) against the
 * live account, origin 380055 (Ahmedabad, the seeded pickup node), 2026-08-19.
 * Zone A dest 380001 (intra-city), zone B dest 395007 (Surat, same state).
 * `addlRateInr` on the top row is the observed slope 5000→9000 g (₹22/kg zone
 * A, ₹24/kg zone B); Delhivery's own curve goes non-linear past ~9.5 kg
 * (verified, not a typo) but the schema can only carry one linear rate above
 * the top slab, so this is the best local fit for the common case.
 *
 * Other couriers (Xpressbees, Shadowfax) remain PLACEHOLDER — no rate-API
 * access for them yet.
 */
export const SLAB_SEEDS: NewCourierRateSlabRow[] = [
  // Delhivery — REAL, from prod Kinko API (see comment above)
  { courierCode: 'delhivery', zone: 'A', uptoG: 500, rateInr: 30, addlPerG: 1000, addlRateInr: 0 },
  { courierCode: 'delhivery', zone: 'A', uptoG: 1000, rateInr: 59, addlPerG: 1000, addlRateInr: 0 },
  { courierCode: 'delhivery', zone: 'A', uptoG: 2000, rateInr: 92, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'delhivery',
    zone: 'A',
    uptoG: 5000,
    rateInr: 159,
    addlPerG: 1000,
    addlRateInr: 22,
  },
  { courierCode: 'delhivery', zone: 'B', uptoG: 500, rateInr: 33, addlPerG: 1000, addlRateInr: 0 },
  { courierCode: 'delhivery', zone: 'B', uptoG: 1000, rateInr: 65, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'delhivery',
    zone: 'B',
    uptoG: 2000,
    rateInr: 102,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'delhivery',
    zone: 'B',
    uptoG: 5000,
    rateInr: 170,
    addlPerG: 1000,
    addlRateInr: 24,
  },
  // Xpressbees — cheaper on light parcels, dearer once they get heavy.
  { courierCode: 'xpressbees', zone: 'A', uptoG: 500, rateInr: 28, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'xpressbees',
    zone: 'A',
    uptoG: 1000,
    rateInr: 58,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'xpressbees',
    zone: 'A',
    uptoG: 2000,
    rateInr: 112,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'xpressbees',
    zone: 'A',
    uptoG: 5000,
    rateInr: 255,
    addlPerG: 1000,
    addlRateInr: 48,
  },
  { courierCode: 'xpressbees', zone: 'B', uptoG: 500, rateInr: 35, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'xpressbees',
    zone: 'B',
    uptoG: 1000,
    rateInr: 78,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'xpressbees',
    zone: 'B',
    uptoG: 2000,
    rateInr: 146,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'xpressbees',
    zone: 'B',
    uptoG: 5000,
    rateInr: 325,
    addlPerG: 1000,
    addlRateInr: 62,
  },
  // Shadowfax — faster, and priced for it.
  { courierCode: 'shadowfax', zone: 'A', uptoG: 500, rateInr: 34, addlPerG: 1000, addlRateInr: 0 },
  { courierCode: 'shadowfax', zone: 'A', uptoG: 1000, rateInr: 64, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'shadowfax',
    zone: 'A',
    uptoG: 2000,
    rateInr: 110,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'shadowfax',
    zone: 'A',
    uptoG: 5000,
    rateInr: 248,
    addlPerG: 1000,
    addlRateInr: 46,
  },
  { courierCode: 'shadowfax', zone: 'B', uptoG: 500, rateInr: 42, addlPerG: 1000, addlRateInr: 0 },
  { courierCode: 'shadowfax', zone: 'B', uptoG: 1000, rateInr: 86, addlPerG: 1000, addlRateInr: 0 },
  {
    courierCode: 'shadowfax',
    zone: 'B',
    uptoG: 2000,
    rateInr: 150,
    addlPerG: 1000,
    addlRateInr: 0,
  },
  {
    courierCode: 'shadowfax',
    zone: 'B',
    uptoG: 5000,
    rateInr: 330,
    addlPerG: 1000,
    addlRateInr: 64,
  },
]

/**
 * PLACEHOLDER coverage: the whole Gujarat pincode band per courier.
 *
 * Ranges alone will mis-classify in BOTH directions — real carrier coverage is
 * non-contiguous and republished regularly. The per-pincode truth belongs in
 * `courier_service_exceptions`, loaded from each carrier's own file. Note the
 * band's upper end (396xxx) also covers Daman & Diu and Dadra & Nagar Haveli;
 * those are excluded by the STATE fence in `shipping.serviceableStates`, never
 * by the pincode prefix.
 */
export const SERVICE_AREA_SEEDS = COURIER_SEEDS.map((courier) => ({
  courierCode: courier.code,
  fromPincode: '360001',
  toPincode: '396999',
  prepaid: true,
  cod: false,
  isActive: true,
}))

/**
 * The one pickup node: Tiny Tales' own dispatch point in Siliguri (owner,
 * 2026-10-28). This seed only keeps dev from being empty and only inserts when
 * `AHM-01` is absent; the live node list is admin-owned (Shipping > Pickup
 * nodes), so staging/prod are changed there, not by re-running this.
 *
 * The code `AHM-01` is kept so existing orders, SKU allowlists and tests that
 * reference it do not break; it is only a handle, the name and address are what
 * the courier sees.
 *
 * `lat`/`lng` are null on purpose: an operator resolves and confirms the pin in
 * the admin portal, and coordinates are only a ranking tie-break, never a price
 * input.
 */
export const NODE_SEED = {
  code: 'AHM-01',
  name: 'Tiny Tales — Siliguri',
  contactName: '',
  contactPhone: '+919018799997',
  houseNumber: '735/2',
  roadArea: "Umrao Singh Officers' Enclave, 5133 ASC BN Gate",
  city: 'Siliguri',
  state: 'West Bengal',
  pincode: '734013',
  lat: null,
  lng: null,
  isActive: true,
  priority: 0,
}

/**
 * Starter pincode reference data. Taluk values follow India Post's `Taluk`
 * column, because Zone A is same-taluk. Coordinates are district/city
 * centroids, used only for the distance tie-break.
 */
export const PINCODE_SEEDS: NewPincodeRow[] = [
  // The ORIGIN. `zoneFor` looks the pickup node's own pincode up in this index
  // and returns null — not a fallback zone — when it is missing, so every quote
  // in dev depends on this row existing.
  // Siliguri origin. Office name and taluk are approximations for dev only;
  // `npm run db:import-pincodes` loads the authoritative India Post row, which
  // is what staging/prod use.
  {
    pincode: '734013',
    officeName: 'Siliguri',
    taluk: 'Siliguri',
    district: 'Darjeeling',
    state: 'West Bengal',
    lat: 26.7271,
    lng: 88.3953,
  },
  {
    pincode: '380055',
    officeName: 'Juhapura',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.000357,
    lng: 72.5305072,
  },
  {
    pincode: '380001',
    officeName: 'Ahmedabad GPO',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.0225,
    lng: 72.5714,
  },
  {
    pincode: '380006',
    officeName: 'Navrangpura',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.0362,
    lng: 72.5615,
  },
  {
    pincode: '380015',
    officeName: 'Satellite',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.0121,
    lng: 72.5136,
  },
  {
    pincode: '380054',
    officeName: 'Thaltej',
    taluk: 'Ahmadabad City',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.0465,
    lng: 72.5089,
  },
  {
    pincode: '382210',
    officeName: 'Bavla',
    taluk: 'Bavla',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 22.8333,
    lng: 72.3667,
  },
  {
    pincode: '382330',
    officeName: 'Naroda',
    taluk: 'Daskroi',
    district: 'Ahmadabad',
    state: 'Gujarat',
    lat: 23.0705,
    lng: 72.657,
  },
  {
    pincode: '390001',
    officeName: 'Vadodara HO',
    taluk: 'Vadodara',
    district: 'Vadodara',
    state: 'Gujarat',
    lat: 22.3072,
    lng: 73.1812,
  },
  {
    pincode: '390019',
    officeName: 'Makarpura',
    taluk: 'Vadodara',
    district: 'Vadodara',
    state: 'Gujarat',
    lat: 22.2587,
    lng: 73.19,
  },
  {
    pincode: '395003',
    officeName: 'Surat Nanpura',
    taluk: 'Surat City',
    district: 'Surat',
    state: 'Gujarat',
    lat: 21.1859,
    lng: 72.8281,
  },
  {
    pincode: '395007',
    officeName: 'Adajan',
    taluk: 'Surat City',
    district: 'Surat',
    state: 'Gujarat',
    lat: 21.194,
    lng: 72.793,
  },
  {
    pincode: '394210',
    officeName: 'Hazira',
    taluk: 'Choryasi',
    district: 'Surat',
    state: 'Gujarat',
    lat: 21.115,
    lng: 72.65,
  },
  {
    pincode: '360001',
    officeName: 'Rajkot HO',
    taluk: 'Rajkot',
    district: 'Rajkot',
    state: 'Gujarat',
    lat: 22.3039,
    lng: 70.8022,
  },
  // The DESTINATION lane the operator nominated (a Rajkot pharmacy stocking the
  // cold cream). Ahmadabad City -> Rajkot is a different taluk in the same
  // state, so it prices as Zone B — which is the ₹60 cell the whole decoy is
  // anchored on, and therefore the lane worth exercising by hand in dev.
  {
    pincode: '360002',
    officeName: 'Bhaktinagar',
    taluk: 'Rajkot',
    district: 'Rajkot',
    state: 'Gujarat',
    lat: 22.2614013,
    lng: 70.7694817,
  },
  {
    pincode: '360005',
    officeName: 'Rajkot University',
    taluk: 'Rajkot',
    district: 'Rajkot',
    state: 'Gujarat',
    lat: 22.2913,
    lng: 70.742,
  },
  {
    pincode: '361001',
    officeName: 'Jamnagar HO',
    taluk: 'Jamnagar',
    district: 'Jamnagar',
    state: 'Gujarat',
    lat: 22.4707,
    lng: 70.0577,
  },
  {
    pincode: '364001',
    officeName: 'Bhavnagar HO',
    taluk: 'Bhavnagar',
    district: 'Bhavnagar',
    state: 'Gujarat',
    lat: 21.7645,
    lng: 72.1519,
  },
  {
    pincode: '370001',
    officeName: 'Bhuj HO',
    taluk: 'Bhuj',
    district: 'Kachchh',
    state: 'Gujarat',
    lat: 23.2419,
    lng: 69.6669,
  },
  {
    pincode: '388001',
    officeName: 'Anand HO',
    taluk: 'Anand',
    district: 'Anand',
    state: 'Gujarat',
    lat: 22.5645,
    lng: 72.9289,
  },
  {
    pincode: '387001',
    officeName: 'Nadiad HO',
    taluk: 'Nadiad',
    district: 'Kheda',
    state: 'Gujarat',
    lat: 22.6939,
    lng: 72.8618,
  },
  {
    pincode: '384001',
    officeName: 'Mehsana HO',
    taluk: 'Mehsana',
    district: 'Mehsana',
    state: 'Gujarat',
    lat: 23.588,
    lng: 72.3693,
  },
  {
    pincode: '385001',
    officeName: 'Palanpur HO',
    taluk: 'Palanpur',
    district: 'Banas Kantha',
    state: 'Gujarat',
    lat: 24.1722,
    lng: 72.4381,
  },
  {
    pincode: '396001',
    officeName: 'Valsad HO',
    taluk: 'Valsad',
    district: 'Valsad',
    state: 'Gujarat',
    lat: 20.5992,
    lng: 72.9342,
  },
  // Deliberately included and deliberately NOT Gujarat: the state fence, not
  // the pincode prefix, is what excludes these — 396xxx spans both.
  {
    pincode: '396210',
    officeName: 'Daman',
    taluk: 'Daman',
    district: 'Daman',
    state: 'Daman and Diu',
    lat: 20.3974,
    lng: 72.8328,
  },
  {
    pincode: '396230',
    officeName: 'Silvassa',
    taluk: 'Silvassa',
    district: 'Dadra and Nagar Haveli',
    state: 'Dadra and Nagar Haveli',
    lat: 20.2738,
    lng: 73.014,
  },
]

export interface ShippingSeedSummary {
  couriers: number
  slabs: number
  serviceAreas: number
  nodes: number
  pincodes: number
}

/** Insert every seed whose key is absent; leave existing rows untouched. */
export async function seedShipping(db: Db): Promise<ShippingSeedSummary> {
  const courierRows = await db
    .insert(couriers)
    .values(COURIER_SEEDS)
    .onConflictDoNothing({ target: couriers.code })
    .returning({ code: couriers.code })

  const slabRows = await db
    .insert(courierRateSlabs)
    .values(SLAB_SEEDS)
    .onConflictDoNothing({
      target: [courierRateSlabs.courierCode, courierRateSlabs.zone, courierRateSlabs.uptoG],
    })
    .returning({ zone: courierRateSlabs.zone })

  // No natural key on service areas, so only seed them when the table is empty
  // — otherwise re-running would stack duplicate ranges.
  const [existingAreas] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(courierServiceAreas)
  const areaRows =
    (existingAreas?.value ?? 0) > 0
      ? []
      : await db.insert(courierServiceAreas).values(SERVICE_AREA_SEEDS).returning({
          id: courierServiceAreas.id,
        })

  const nodeRows = await db
    .insert(pickupNodes)
    .values(NODE_SEED)
    .onConflictDoNothing({ target: pickupNodes.code })
    .returning({ code: pickupNodes.code })

  const pincodeRows = await db
    .insert(pincodes)
    .values(PINCODE_SEEDS)
    .onConflictDoNothing({ target: pincodes.pincode })
    .returning({ pincode: pincodes.pincode })

  return {
    couriers: courierRows.length,
    slabs: slabRows.length,
    serviceAreas: areaRows.length,
    nodes: nodeRows.length,
    pincodes: pincodeRows.length,
  }
}

async function main(): Promise<void> {
  assertDevOnly('db:seed-shipping')

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-shipping: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    await db.execute(sql`select 1 from couriers limit 1`)
    const summary = await seedShipping(db)
    // eslint-disable-next-line no-console
    console.log(
      `db:seed-shipping: ${summary.couriers} courier(s), ${summary.slabs} slab(s), ${summary.serviceAreas} area(s), ${summary.nodes} node(s), ${summary.pincodes} pincode(s) inserted.\n` +
        'REMINDER: every rate above is a PLACEHOLDER. Replace them with negotiated rates and validate against POST /v1/admin/shipping/simulate before enabling shipping.'
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
