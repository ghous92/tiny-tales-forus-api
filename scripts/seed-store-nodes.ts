#!/usr/bin/env tsx
/**
 * `npm run db:seed-store-nodes` — register the 12 Gujarat partner retailers as
 * pickup nodes, so the shipping engine can quote and cost a shipment that
 * originates at a shop rather than at the Ahmedabad warehouse.
 *
 * The retailer list is mirrored from the mobile app's
 * `mobile/src/data/stores.ts`, which remains the source of truth for anything
 * customer-facing (the PDP's "Buy in Store" tab). When that file changes, this
 * one has to be updated by hand — the two repos share no package. Both should
 * move behind an admin-managed `/v1/stores` eventually; see
 * `mobile/docs/BUY-IN-STORE.md`.
 *
 * **Why this materially changes pricing.** Zone is the (origin, destination)
 * pincode PAIR, and Zone A is same-taluk. With only the Ahmedabad warehouse,
 * every destination outside Ahmadabad City taluk priced as Zone B. Adding a
 * Rajkot node puts all of Rajkot taluk into Zone A against that node; the same
 * goes for Surat City, Idar, Himatnagar, Jasdan and Nakhatrana. `selectShipment`
 * prices every (node, courier) pairing and keeps the cheapest, so these nodes
 * can only lower a quote, never raise one — but they do change which lane an
 * order actually ships on, and therefore who has to hand a parcel to a courier.
 *
 * **No SKU allowlist rows are written, which means every node stocks
 * everything** (see `pickupNodeSkus` — a node with zero rows is the
 * stocks-everything case). That reflects the operator's position that stocking
 * is handled per shop. The moment that stops being true, the fix is rows in
 * `pickup_node_skus`, not a change here: a node that cannot fill a line must
 * fail as `no_single_node` rather than quietly quoting a lane it cannot ship.
 *
 * **What is deliberately still blank.** `contactName`/`contactPhone` are empty
 * for every retailer because none were supplied, and four shops have no street
 * address. A courier pickup needs a gate and a phone number, so these must be
 * filled from the admin surface before anyone books a real pickup against one
 * of these nodes. A blank field reads as "not entered yet"; a plausible
 * invented one does not.
 *
 * Idempotent: upserts on `code`, so re-running corrects drift without
 * duplicating nodes, and an operator's admin edits to contact details survive
 * because this script never writes those fields as non-empty.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { pickupNodes } from '../src/db/schema.js'

/**
 * One partner retailer as a pickup node.
 *
 * `approxCoords` mirrors `centerApprox` in the mobile store data: true means
 * the coordinate is a town/area centroid, not the shop's own pin. Coordinates
 * are ONLY the haversine ranking tie-break and never a price input, so an
 * approximate one cannot mis-price a quote — but it cannot direct a courier
 * either, which is why the flag is carried through rather than dropped.
 */
export interface StoreNodeSeed {
  code: string
  name: string
  roadArea: string
  city: string
  state: string
  pincode: string
  lat: number
  lng: number
  approxCoords: boolean
  priority: number
}

/**
 * The two nodes that act as CENTRAL HUBS for the stock cascade — the owner's
 * own Hanafiya shops, decided 2026-08-01 (docs/SPEC-STOCK.md §1).
 *
 * A hub is the cascade's last resort: when no retail shelf within range holds a
 * sku, it falls back to a hub before it will say "out of stock"
 * (SPEC-STOCK.md §3 step 7). That fallback is deliberately NOT distance-ranked
 * and is not subject to `max_cascade_stores`, so a hub mislabelled 'retail'
 * gets ranked and possibly skipped — and a sku that only the hub holds
 * disappears from sale.
 *
 * They are hubs because they are ours: stock we hold ourselves is stock we can
 * count, correct and dispatch on our own schedule, which is what makes it a
 * safe backstop for a shelf we do not control.
 */
export const HUB_NODE_CODES: ReadonlySet<string> = new Set(['AHM-S01', 'AHM-S02'])

/** Every seeded node is a shop, so it is a hub or it is retail — never 'warehouse'. */
export function kindForCode(code: string): 'hub' | 'retail' {
  return HUB_NODE_CODES.has(code) ? 'hub' : 'retail'
}

/** The 12 retailers, ordered warehouse-outward: Ahmedabad, then the districts. */
export const STORE_NODE_SEEDS: StoreNodeSeed[] = [
  // --- Ahmedabad (Ahmadabad City taluk — same taluk as the AHM-01 warehouse) ---
  {
    code: 'AHM-S01',
    name: 'Hanafiya — Sarkhej',
    roadArea: '4/B Al-Farooq Com Housing Society, Mohmadmedi Park, Sarkhej Road',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380051',
    lat: 22.98,
    lng: 72.5,
    approxCoords: true,
    priority: 10,
  },
  {
    code: 'AHM-S02',
    name: 'Hanafiya Saraiya Store — Khadia',
    roadArea: '3100, Nr Three Gates, Gandhi Rd, Old City, Pankore Naka',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380001',
    lat: 23.0242386,
    lng: 72.584746,
    approxCoords: false,
    priority: 11,
  },
  {
    code: 'AHM-S03',
    name: 'K.B. Novelty — Maninagar',
    roadArea: 'Block-A, Maninagar Railway Station Rd, opp. BRTS',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380008',
    lat: 22.9979,
    lng: 72.6111,
    approxCoords: false,
    priority: 12,
  },
  {
    code: 'AHM-S04',
    name: 'Shree Kesar Medical — Vejalpur',
    roadArea: '4, Kadambari Society, near Keshar Orthopaedic Hospital, Jivraj Park',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380051',
    lat: 23.0059,
    lng: 72.5313,
    approxCoords: false,
    priority: 13,
  },

  // --- Rajkot district ---
  {
    code: 'RJT-S01',
    name: 'Tanna Sales Agency — Para Bazaar',
    roadArea: '61, Para Bazaar Rd, Krishna Pura, Lohana Para',
    city: 'Rajkot',
    state: 'Gujarat',
    pincode: '360001',
    lat: 22.2996,
    lng: 70.8042,
    approxCoords: false,
    priority: 20,
  },
  {
    code: 'RJT-S02',
    name: 'Krishna Novelty & Antic Jewellery — Bhakti Nagar',
    roadArea: 'Prawaria Colony, Morari Nagar',
    city: 'Rajkot',
    state: 'Gujarat',
    pincode: '360002',
    lat: 22.2619,
    lng: 70.8074,
    approxCoords: false,
    priority: 21,
  },
  {
    code: 'RJT-S03',
    name: 'Kisan Novelty — Vakariya Road',
    roadArea: 'Ranchod Nagar Society, Arya Nagar',
    city: 'Rajkot',
    state: 'Gujarat',
    pincode: '360003',
    lat: 22.3047,
    lng: 70.8132,
    approxCoords: false,
    priority: 22,
  },
  {
    code: 'JSD-S01',
    name: 'Radhe Kangan — Jasdan',
    // No street line supplied by the retailer — left blank, never guessed.
    roadArea: '',
    city: 'Jasdan',
    state: 'Gujarat',
    pincode: '360050',
    lat: 22.04,
    lng: 71.21,
    approxCoords: true,
    priority: 23,
  },

  // --- Sabarkantha district ---
  {
    code: 'HMT-S01',
    name: 'Supreme Sales Agency — Ilol',
    roadArea: 'Hearty Mart Shop, near Ekta Dairy, Ilol',
    city: 'Himmatnagar',
    state: 'Gujarat',
    pincode: '383220',
    lat: 23.649,
    lng: 72.8944,
    approxCoords: false,
    priority: 30,
  },
  {
    code: 'IDR-S01',
    name: 'Jimi Novelty — Idar',
    roadArea: 'Rushabh Complex, opposite ST Bus Stand',
    city: 'Idar',
    state: 'Gujarat',
    pincode: '383430',
    lat: 23.8395,
    lng: 73.0006,
    approxCoords: false,
    priority: 31,
  },

  // --- Surat district ---
  {
    code: 'SRT-S01',
    name: 'Dimpalben (Home Beauty Parlour) — Adajan',
    // No street line supplied by the retailer — left blank, never guessed.
    roadArea: '',
    city: 'Surat',
    state: 'Gujarat',
    pincode: '395009',
    lat: 21.2,
    lng: 72.79,
    approxCoords: true,
    priority: 40,
  },

  // --- Kachchh district ---
  {
    code: 'NKT-S01',
    name: 'Amratlal Senghani — Nakhatrana',
    // No street line supplied by the retailer — left blank, never guessed.
    roadArea: '',
    city: 'Nakhatrana',
    state: 'Gujarat',
    pincode: '370615',
    lat: 23.35,
    lng: 69.26,
    approxCoords: true,
    priority: 50,
  },
]

export interface StoreNodeSummary {
  upserted: number
  approxCoordNodes: string[]
}

/** Upsert every retailer node by `code`, leaving contact fields untouched. */
export async function seedStoreNodes(db: Db): Promise<StoreNodeSummary> {
  for (const store of STORE_NODE_SEEDS) {
    await db
      .insert(pickupNodes)
      .values({
        code: store.code,
        name: store.name,
        roadArea: store.roadArea,
        city: store.city,
        state: store.state,
        pincode: store.pincode,
        lat: store.lat,
        lng: store.lng,
        isActive: true,
        kind: kindForCode(store.code),
        priority: store.priority,
      })
      .onConflictDoUpdate({
        target: pickupNodes.code,
        // Contact name/phone are intentionally absent: an operator who fills
        // them in the admin portal must not have them wiped by a re-run.
        //
        // `stock_enabled` and `public_visible` are absent for a stronger
        // reason: they are OPERATOR DECISIONS, not facts about the shop. An
        // operator who switched a shop off because its counts had gone stale
        // must not have a routine re-seed switch it back on and put a
        // phantom shelf back into the cascade. `kind` is written because it
        // IS a fact about the shop — which of them are our own hubs does not
        // change with an admin toggle.
        set: {
          name: store.name,
          roadArea: store.roadArea,
          city: store.city,
          state: store.state,
          pincode: store.pincode,
          lat: store.lat,
          lng: store.lng,
          isActive: true,
          kind: kindForCode(store.code),
          priority: store.priority,
        },
      })
  }

  return {
    upserted: STORE_NODE_SEEDS.length,
    approxCoordNodes: STORE_NODE_SEEDS.filter((s) => s.approxCoords).map((s) => s.code),
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-store-nodes: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const summary = await seedStoreNodes(db)
    // eslint-disable-next-line no-console
    console.log(
      `db:seed-store-nodes: ${summary.upserted} retailer node(s) upserted.\n` +
        `REMINDER: contact name/phone are blank for all of them, and ${summary.approxCoordNodes.length} ` +
        `have centroid-only coordinates (${summary.approxCoordNodes.join(', ')}). ` +
        'Fill both from the admin portal before booking a real courier pickup against these nodes.'
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
