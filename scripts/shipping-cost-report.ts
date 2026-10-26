#!/usr/bin/env tsx
/**
 * `npm run shipping:report` — price a set of representative lanes through the
 * REAL engine and print what each one costs.
 *
 * This exists because the interesting numbers in this domain are emergent, not
 * configured. Nobody sets "Rajkot costs ₹36"; that falls out of a pincode pair
 * resolving to a zone, a zone selecting a slab, six cost components stacking,
 * and the cheapest (node, courier) pairing winning. Re-deriving that by hand —
 * in a spreadsheet, or in a chat message — is how the published number and the
 * charged number drift apart. So this calls `selectShipment` and `resolveFee`
 * directly, exactly as the cart does, and reports what they return.
 *
 * It is READ-ONLY. It loads config, nodes, couriers and pincodes, and writes
 * nothing back.
 *
 * Two questions are answered separately, because they are different businesses:
 *
 * - **Customer delivery** — a shopper's parcel, from whichever node is cheapest.
 *   Run once against every node and once against the warehouse alone, so the
 *   value of having onboarded the retailers as origins is visible as a delta
 *   rather than asserted.
 * - **Retailer restock** — a consignment from the warehouse to a shop, which
 *   must originate at the warehouse and therefore ignores the retailer nodes.
 *
 * Every number it prints is only as good as the rate cards behind it, and those
 * are still the placeholders from `seed-shipping.ts`. The shape of the answer is
 * trustworthy; the rupees are not, until a negotiated card replaces them.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import {
  customerFeeInr,
  resolveFee,
  selectShipment,
  type ShippingLine,
  type ShippingNode,
} from '../src/lib/shipping.js'
import { loadShippingContext, type ShippingContext } from '../src/services/shipping.js'

/** A destination worth pricing, and why it is in the list. */
interface Lane {
  pincode: string
  label: string
  /** True when this destination is one of the 12 onboarded retailers. */
  isPartnerStore: boolean
}

const LANES: Lane[] = [
  // The 12 onboarded retailers, in the same order as seed-store-nodes.ts.
  { pincode: '380051', label: 'Hanafiya / Shree Kesar — Ahmedabad', isPartnerStore: true },
  { pincode: '380001', label: 'Hanafiya Saraiya — Khadia, Ahmedabad', isPartnerStore: true },
  { pincode: '380008', label: 'K.B. Novelty — Maninagar, Ahmedabad', isPartnerStore: true },
  { pincode: '360001', label: 'Tanna Sales — Rajkot', isPartnerStore: true },
  { pincode: '360002', label: 'Krishna Novelty — Rajkot', isPartnerStore: true },
  { pincode: '360003', label: 'Kisan Novelty — Rajkot', isPartnerStore: true },
  { pincode: '360050', label: 'Radhe Kangan — Jasdan', isPartnerStore: true },
  { pincode: '383220', label: 'Supreme Sales — Himmatnagar', isPartnerStore: true },
  { pincode: '383430', label: 'Jimi Novelty — Idar', isPartnerStore: true },
  { pincode: '395009', label: 'Dimpalben — Adajan, Surat', isPartnerStore: true },
  { pincode: '370615', label: 'Amratlal Senghani — Nakhatrana', isPartnerStore: true },
  // Cities with no partner store, to show what the network does for ordinary
  // shoppers rather than only for the retailers themselves.
  { pincode: '380015', label: 'Satellite, Ahmedabad', isPartnerStore: false },
  { pincode: '390001', label: 'Vadodara', isPartnerStore: false },
  { pincode: '395003', label: 'Nanpura, Surat', isPartnerStore: false },
  { pincode: '370001', label: 'Bhuj', isPartnerStore: false },
  { pincode: '361001', label: 'Jamnagar', isPartnerStore: false },
  { pincode: '364001', label: 'Bhavnagar', isPartnerStore: false },
  { pincode: '384001', label: 'Mehsana', isPartnerStore: false },
]

/** A cart shape worth pricing. Weights/dims are the real catalog values. */
interface Basket {
  label: string
  lines: ShippingLine[]
  valueInr: number
}

const CREAM_200: Omit<ShippingLine, 'qty'> = {
  sku: 'N0-4OKP-YVLQ',
  weightG: 252,
  lengthCm: 8,
  widthCm: 8,
  heightCm: 8,
}
const CREAM_500: Omit<ShippingLine, 'qty'> = {
  sku: 'ER-XS2V-2XRH',
  weightG: 585,
  lengthCm: 11,
  widthCm: 11,
  heightCm: 10,
}

const SINGLE_UNIT: Basket = {
  label: 'Single 200ml cream (₹199)',
  lines: [{ ...CREAM_200, qty: 1 }],
  valueInr: 199,
}

const TYPICAL_BASKET: Basket = {
  label: 'Typical basket — 2×200ml + 1×500ml (₹747)',
  lines: [
    { ...CREAM_200, qty: 2 },
    { ...CREAM_500, qty: 1 },
  ],
  valueInr: 747,
}

const RESTOCK_CARTON: Basket = {
  label: 'Restock carton — 24×200ml (₹4,776)',
  lines: [{ ...CREAM_200, qty: 24 }],
  valueInr: 4776,
}

/** One priced lane, flattened for printing. */
interface Priced {
  lane: string
  pincode: string
  node: string
  zone: string
  courier: string
  weightG: number
  trueCostInr: number
  customerFeeInr: number
  marginInr: number
  etaDays: number
  reason: string
}

/** Price one basket to one destination, optionally restricting which nodes may serve it. */
function priceLane(
  context: ShippingContext,
  lane: Lane,
  basket: Basket,
  nodeFilter?: (node: ShippingNode) => boolean
): Priced {
  const nodes = nodeFilter ? context.nodes.filter(nodeFilter) : context.nodes
  const shipment = selectShipment({
    lines: basket.lines,
    destPincode: lane.pincode,
    nodes,
    couriers: context.couriers,
    pincodeIndex: context.pincodeIndex,
    rule: context.rule,
    declaredValueInr: basket.valueInr,
    isCod: false,
  })

  const blank: Priced = {
    lane: lane.label,
    pincode: lane.pincode,
    node: '—',
    zone: '—',
    courier: '—',
    weightG: 0,
    trueCostInr: 0,
    customerFeeInr: 0,
    marginInr: 0,
    etaDays: 0,
    reason: shipment.reason ?? 'no_winner',
  }
  const winner = shipment.winner
  if (!winner) return blank

  const gross = customerFeeInr(winner.trueCostInr, context.rule.marginBps)
  // Threshold basis is pre-coupon here: no coupon is modelled in this report.
  const outcome = resolveFee(
    gross,
    winner.chargeableWeightG,
    basket.valueInr,
    basket.valueInr,
    context.rule
  )

  return {
    lane: lane.label,
    pincode: lane.pincode,
    node: winner.nodeCode,
    zone: winner.zone,
    courier: winner.courierCode,
    weightG: winner.chargeableWeightG,
    trueCostInr: winner.trueCostInr,
    customerFeeInr: outcome.feeInr,
    marginInr: outcome.feeInr - winner.trueCostInr,
    etaDays: winner.slaDays,
    reason: outcome.freeApplied ? 'FREE (threshold met)' : '',
  }
}

function printTable(title: string, rows: Priced[]): void {
  /* eslint-disable no-console */
  console.log(`\n${'='.repeat(110)}\n${title}\n${'='.repeat(110)}`)
  console.table(
    rows.map((r) => ({
      Destination: r.lane,
      Pin: r.pincode,
      'Ships from': r.node,
      Zone: r.zone,
      Courier: r.courier,
      'Chg g': r.weightG,
      'Our cost ₹': r.trueCostInr,
      'Cust fee ₹': r.customerFeeInr,
      'Margin ₹': r.marginInr,
      ETA: r.etaDays,
      Note: r.reason,
    }))
  )
  /* eslint-enable no-console */
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('shipping:report: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db

    // One context is enough: loadShippingContext caches per-db, and we widen the
    // pincode index by loading every lane's destination up front.
    const context = await loadShippingContext(db, LANES[0]!.pincode)
    if (!context.rule.enabled) {
      console.error('shipping:report: shipping.enabled is FALSE — nothing to price.')
      process.exit(1)
    }
    // Warm the index for every destination in one query.
    const { loadPincodeIndex } = await import('../src/services/shipping.js')
    const fullIndex = await loadPincodeIndex(db, [
      ...LANES.map((l) => l.pincode),
      ...context.nodes.map((n) => n.pincode),
    ])
    const ctx: ShippingContext = { ...context, pincodeIndex: fullIndex }

    const isWarehouse = (node: ShippingNode): boolean => node.code === 'AHM-01'

    printTable(
      `CUSTOMER DELIVERY — ${SINGLE_UNIT.label} — all ${ctx.nodes.length} nodes (12 retailers + warehouse)`,
      LANES.map((lane) => priceLane(ctx, lane, SINGLE_UNIT))
    )

    printTable(
      `CUSTOMER DELIVERY — ${SINGLE_UNIT.label} — WAREHOUSE ONLY (the network before the retailers were onboarded)`,
      LANES.map((lane) => priceLane(ctx, lane, SINGLE_UNIT, isWarehouse))
    )

    printTable(
      `CUSTOMER DELIVERY — ${TYPICAL_BASKET.label} — all nodes`,
      LANES.map((lane) => priceLane(ctx, lane, TYPICAL_BASKET))
    )

    printTable(
      `RETAILER RESTOCK — ${RESTOCK_CARTON.label} — from the AHM-01 warehouse only`,
      LANES.filter((l) => l.isPartnerStore).map((lane) =>
        priceLane(ctx, lane, RESTOCK_CARTON, isWarehouse)
      )
    )

    // eslint-disable-next-line no-console
    console.log(
      '\nNOTE: courier rate cards are still the PLACEHOLDERS from seed-shipping.ts.\n' +
        'The zones, the winning nodes and the relative shape are real; the rupee figures are not\n' +
        'billable until a negotiated rate card replaces them.\n'
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
