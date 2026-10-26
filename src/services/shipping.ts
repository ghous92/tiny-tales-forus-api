/**
 * Shipping business rules (docs/SPEC-SHIPPING.md). This module owns the
 * shipping tables and the delivery quote; the arithmetic itself lives in
 * `lib/shipping.ts` and is never duplicated here.
 *
 * What this file is responsible for:
 *
 * - **Turning config into a rule.** Fifteen `app_config` keys become one
 *   {@link ShippingRule}. Anything missing or malformed collapses the whole
 *   thing to {@link SHIPPING_OFF} — a pricing rule must never switch itself on,
 *   and a half-parsed rate table is more dangerous than no rate table.
 * - **Loading rate data.** Behind a {@link RateProvider} seam, so a live
 *   carrier API can be added later without the cart read path ever depending on
 *   a third party's uptime. Today there is one implementation and it reads the
 *   admin-maintained tables.
 * - **Signing the quote.** The delivery fee is displayed on the cart screen and
 *   charged at checkout, and those are two different requests against two
 *   possibly-different destinations. The signed token is what turns that gap
 *   from a silent mispricing into an explicit 409.
 *
 * Caching: rate data and config are read on EVERY cart request, so both are
 * held in a short process-local TTL cache keyed by the `db` handle (a WeakMap,
 * so each test's throwaway database gets its own — a process-global cache would
 * leak one test's couriers into the next). Cloud Run runs several instances, so
 * this is a latency damper, not a coherent cache: a miss costs one query, never
 * a wrong answer, and the 60-second ceiling bounds how long an admin edit takes
 * to show up.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { SHIPPING_NONE, type CartShipping } from '../contracts/cart.js'
import type { Db } from '../db/client.js'
import {
  courierRateSlabs,
  courierServiceAreas,
  courierServiceExceptions,
  couriers as couriersTable,
  pickupNodes,
  pickupNodeSkus,
  pincodes as pincodesTable,
} from '../db/schema.js'
import { canonicalJson } from '../lib/canonical-json.js'
import {
  discountedFeeInr,
  estimatedDeliveryDate,
  estimatedPincodeInfo,
  resolveFee,
  selectShipment,
  SHIPPING_OFF,
  shopperFeeInr,
  type FreightCost,
  type PincodeInfo,
  type ShippingCourier,
  type ShippingLine,
  type ShippingNode,
  type ShippingRule,
  type Zone,
} from '../lib/shipping.js'
import { getConfigValues } from './config.js'

/** How long rate data and the parsed rule are reused before re-reading. */
const CACHE_TTL_MS = 60_000

/** A quote is good for 15 minutes — long enough to check out, short enough that a rate edit lands. */
const QUOTE_TTL_MS = 15 * 60_000

// --- Config → rule -----------------------------------------------------------

/** Every key the shipping rule is assembled from. Read in ONE query (see getConfigValues). */
export const SHIPPING_CONFIG_KEYS = [
  'shipping.enabled',
  'shipping.freeAboveTiers',
  'shipping.thresholdBasis',
  'shipping.marginBps',
  'shipping.feeDiscountBps',
  'shipping.packagingTareG',
  'shipping.volumetricPackFactor',
  'shipping.unknownWeightBehavior',
  'shipping.assumedWeightG',
  'shipping.unserviceableBehavior',
  'shipping.fallbackFeeInr',
  'shipping.serviceableStates',
  'shipping.rankBy',
] as const

const nonNegInt = z.number().int().min(0)

/**
 * The shape of the config keys, validated rather than coerced. A malformed
 * slab table must not silently become a partially-populated one: `safeParse`
 * failing anywhere drops the whole rule to off, which shows up immediately as
 * "delivery unavailable" instead of as three months of mispriced parcels.
 */
const RuleConfigSchema = z.object({
  'shipping.enabled': z.boolean(),
  'shipping.freeAboveTiers': z.array(
    z.object({ uptoG: z.number().int().positive(), freeAboveInr: nonNegInt })
  ),
  'shipping.thresholdBasis': z.enum(['preCoupon', 'postCoupon']).default('preCoupon'),
  /** Basis points on top of true courier cost (1000 = 10%). */
  'shipping.marginBps': nonNegInt,
  /** Basis points taken OFF the shopper fee (5000 = half price). Absent means no discount. */
  'shipping.feeDiscountBps': nonNegInt.max(10_000).default(0),
  'shipping.packagingTareG': nonNegInt.default(0),
  'shipping.volumetricPackFactor': z.number().positive().default(1),
  'shipping.unknownWeightBehavior': z.enum(['block', 'assume']).default('block'),
  'shipping.assumedWeightG': nonNegInt.default(0),
  'shipping.unserviceableBehavior': z.enum(['block', 'flat']).default('block'),
  'shipping.fallbackFeeInr': nonNegInt.default(0),
  /** Legacy admin setting; PAN India quoting no longer depends on this list. */
  'shipping.serviceableStates': z.array(z.string().min(1)).default([]),
  'shipping.rankBy': z.enum(['cost', 'sla', 'reliability']).default('cost'),
})

/**
 * Why the rule is off, when it is off — `null` when it parsed, or when the
 * operator simply left `shipping.enabled` false (which is not a fault).
 *
 * This exists because collapsing every failure to {@link SHIPPING_OFF} is right
 * for the cart and blind for the admin. `shipping.freeAboveTiers` is edited as
 * raw JSON in the config screen; a typo there does not raise an error, it turns
 * delivery pricing off across the entire store and looks exactly like someone
 * having disabled it on purpose. Surfaced through the admin simulator only —
 * shoppers still get the safe, silent behaviour.
 */
export interface ShippingRuleDiagnosis {
  rule: ShippingRule
  configError: string | null
}

/** Config map → a validated {@link ShippingRule} plus the reason it failed, if it did. */
export function diagnoseShippingRule(values: Map<string, unknown>): ShippingRuleDiagnosis {
  if (values.get('shipping.enabled') !== true) {
    return { rule: SHIPPING_OFF, configError: null }
  }

  const parsed = RuleConfigSchema.safeParse(Object.fromEntries(values))
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return {
      rule: SHIPPING_OFF,
      // Named keys, not a stack: the operator has to be able to go straight to
      // the row they broke.
      configError: `shipping.enabled is true but the config did not validate, so delivery pricing is OFF — ${issues}`,
    }
  }
  const c = parsed.data

  return {
    rule: {
      enabled: true,
      freeAboveTiers: c['shipping.freeAboveTiers'],
      thresholdBasis: c['shipping.thresholdBasis'],
      marginBps: c['shipping.marginBps'],
      feeDiscountBps: c['shipping.feeDiscountBps'],
      tareG: c['shipping.packagingTareG'],
      volumetricPackFactor: c['shipping.volumetricPackFactor'],
      serviceableStates: c['shipping.serviceableStates'],
      unknownWeightBehavior: c['shipping.unknownWeightBehavior'],
      assumedWeightG: c['shipping.assumedWeightG'],
      unserviceableBehavior: c['shipping.unserviceableBehavior'],
      fallbackFeeInr: c['shipping.fallbackFeeInr'],
      rankBy: c['shipping.rankBy'],
    },
    configError: null,
  }
}

/** Config map → a validated {@link ShippingRule}, or {@link SHIPPING_OFF} on any problem. */
export function parseShippingRule(values: Map<string, unknown>): ShippingRule {
  return diagnoseShippingRule(values).rule
}

/**
 * Re-read config uncached and report why the rule is off. Admin-only — the
 * cached {@link resolveShippingRule} is what the cart path uses.
 */
export async function diagnoseShippingConfig(db: Db): Promise<ShippingRuleDiagnosis> {
  return diagnoseShippingRule(await getConfigValues(db, [...SHIPPING_CONFIG_KEYS]))
}

// --- Rate provider -----------------------------------------------------------

/**
 * Where nodes and courier rate cards come from.
 *
 * The seam exists because published carrier rates are ranges and negotiated
 * rates are contracts, so the DB is the authority — but a live rate API may
 * later be worth consulting. When that happens it plugs in here and falls back
 * to {@link DbRateProvider} on any error, so a carrier outage degrades to
 * yesterday's rate card rather than to no cart.
 */
export interface RateProvider {
  nodes(db: Db): Promise<ShippingNode[]>
  couriers(db: Db): Promise<ShippingCourier[]>
}

/** Reads the admin-maintained tables. The only implementation today. */
export const DbRateProvider: RateProvider = {
  async nodes(db: Db): Promise<ShippingNode[]> {
    const [rows, allowlist] = await Promise.all([
      db.select().from(pickupNodes).where(eq(pickupNodes.isActive, true)),
      db.select().from(pickupNodeSkus),
    ])
    const skusByNode = new Map<string, string[]>()
    for (const row of allowlist) {
      const list = skusByNode.get(row.nodeId) ?? []
      list.push(row.sku)
      skusByNode.set(row.nodeId, list)
    }
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      pincode: row.pincode,
      lat: row.lat,
      lng: row.lng,
      priority: row.priority,
      skus: skusByNode.get(row.id) ?? [],
      cutoffIst: row.cutoffIst,
    }))
  },

  async couriers(db: Db): Promise<ShippingCourier[]> {
    const [rows, slabs, areas, exceptions] = await Promise.all([
      db.select().from(couriersTable).where(eq(couriersTable.isActive, true)),
      db.select().from(courierRateSlabs),
      db.select().from(courierServiceAreas),
      db.select().from(courierServiceExceptions),
    ])

    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      rateModel: row.rateModel === 'distance' ? 'distance' : 'weight',
      volumetricDivisor: row.volumetricDivisor,
      minChargeableG: row.minChargeableG,
      fuelBps: row.fuelBps,
      gstBps: row.gstBps,
      docketFeeInr: row.docketFeeInr,
      riskBps: row.riskBps,
      riskMinInr: row.riskMinInr,
      codFlatInr: row.codFlatInr,
      codBps: row.codBps,
      slaDaysZoneA: row.slaDaysZoneA,
      slaDaysZoneB: row.slaDaysZoneB,
      reliabilityScore: row.reliabilityScore,
      priority: row.priority,
      slabs: slabs
        .filter((slab) => slab.courierCode === row.code)
        .map((slab) => ({
          zone: slab.zone as Zone,
          uptoG: slab.uptoG,
          rateInr: slab.rateInr,
          addlPerG: slab.addlPerG,
          addlRateInr: slab.addlRateInr,
        })),
      serviceAreas: areas
        .filter((area) => area.courierCode === row.code)
        .map((area) => ({
          fromPincode: area.fromPincode,
          toPincode: area.toPincode,
          isActive: area.isActive,
        })),
      serviceExceptions: exceptions
        .filter((exception) => exception.courierCode === row.code)
        .map((exception) => ({
          pincode: exception.pincode,
          serviceable: exception.serviceable,
        })),
    }))
  },
}

// --- Cache -------------------------------------------------------------------

interface CacheState {
  rule?: { value: ShippingRule; expiresAt: number }
  nodes?: { value: ShippingNode[]; expiresAt: number }
  couriers?: { value: ShippingCourier[]; expiresAt: number }
  /** Pincode reference rows are immutable seed data, so they are cached without expiry. */
  pincodes: Map<string, PincodeInfo | null>
}

const caches = new WeakMap<object, CacheState>()

function cacheFor(db: Db): CacheState {
  const existing = caches.get(db as object)
  if (existing) return existing
  const fresh: CacheState = { pincodes: new Map() }
  caches.set(db as object, fresh)
  return fresh
}

/** Drop everything cached for this db. Call after an admin write to rate data. */
export function resetShippingCache(db: Db): void {
  caches.delete(db as object)
}

async function cached<K extends 'rule' | 'nodes' | 'couriers'>(
  db: Db,
  key: K,
  load: () => Promise<NonNullable<CacheState[K]>['value']>
): Promise<NonNullable<CacheState[K]>['value']> {
  const state = cacheFor(db)
  const hit = state[key]
  const now = Date.now()
  if (hit && hit.expiresAt > now) return hit.value as NonNullable<CacheState[K]>['value']
  const value = await load()
  state[key] = { value, expiresAt: now + CACHE_TTL_MS } as CacheState[K]
  return value
}

// --- Loading -----------------------------------------------------------------

/** The parsed rule for this request, from cache when warm. */
export async function resolveShippingRule(db: Db): Promise<ShippingRule> {
  return cached(db, 'rule', async () =>
    parseShippingRule(await getConfigValues(db, [...SHIPPING_CONFIG_KEYS]))
  )
}

/**
 * Reference rows for exactly the pincodes involved (origins + destination).
 * Never the whole table: India Post publishes ~155k rows, and a cart read needs
 * three of them. Misses are cached as `null` too, so an unknown pincode does
 * not re-query on every keystroke. Valid misses get a coarse regional location
 * in the returned index; no remote lookup or bulk import is needed.
 */
export async function loadPincodeIndex(
  db: Db,
  wanted: string[]
): Promise<Map<string, PincodeInfo>> {
  const state = cacheFor(db)
  const unique = [...new Set(wanted.filter(Boolean))]
  const missing = unique.filter((p) => !state.pincodes.has(p))

  if (missing.length > 0) {
    const rows = await db
      .select()
      .from(pincodesTable)
      .where(inArray(pincodesTable.pincode, missing))
    const found = new Set<string>()
    for (const row of rows) {
      found.add(row.pincode)
      state.pincodes.set(row.pincode, {
        pincode: row.pincode,
        taluk: row.taluk,
        district: row.district,
        state: row.state,
        lat: row.lat,
        lng: row.lng,
      })
    }
    for (const p of missing) if (!found.has(p)) state.pincodes.set(p, null)
  }

  const index = new Map<string, PincodeInfo>()
  for (const p of unique) {
    const info = state.pincodes.get(p) ?? estimatedPincodeInfo(p)
    if (info) index.set(p, info)
  }
  return index
}

/** Everything the cart service needs to price delivery, resolved once per request. */
export interface ShippingContext {
  rule: ShippingRule
  nodes: ShippingNode[]
  couriers: ShippingCourier[]
  pincodeIndex: ReadonlyMap<string, PincodeInfo>
}

/**
 * Load the rule, the rate data, and just the pincode rows this destination
 * needs. Returns a context with `rule.enabled === false` — and nothing else
 * loaded — when shipping is switched off, so the off state costs one config
 * read and no table scans.
 */
export async function loadShippingContext(
  db: Db,
  destPincode: string,
  provider: RateProvider = DbRateProvider
): Promise<ShippingContext> {
  const rule = await resolveShippingRule(db)
  if (!rule.enabled) {
    return { rule, nodes: [], couriers: [], pincodeIndex: new Map() }
  }

  const [nodes, couriers] = await Promise.all([
    cached(db, 'nodes', () => provider.nodes(db)),
    cached(db, 'couriers', () => provider.couriers(db)),
  ])

  const pincodeIndex = await loadPincodeIndex(db, [
    destPincode,
    ...nodes.map((node) => node.pincode),
  ])

  return { rule, nodes, couriers, pincodeIndex }
}

/** Compatibility helper: valid Indian pincodes are accepted nationwide. */
export interface DestinationFenceResult {
  allowed: boolean
  /** The destination's resolved state, or null when the pincode is unrecognised. */
  state: string | null
}

/**
 * Accept PAN India without a state allowlist or a complete pincode catalogue.
 * Address request validation remains responsible for pincode format.
 */
export async function checkOrderDestination(
  db: Db,
  destPincode: string
): Promise<DestinationFenceResult> {
  const index = await loadPincodeIndex(db, [destPincode])
  const dest = index.get(destPincode) ?? null
  return { allowed: /^[1-9][0-9]{5}$/.test(destPincode), state: dest?.state || null }
}

// --- Quote token -------------------------------------------------------------

/** The fields a quote token binds. Any change to any of them invalidates it. */
export interface QuoteTokenPayload {
  destPincode: string
  zone: Zone | null
  courierCode: string
  chargeableWeightG: number
  feeInr: number
  /** The cart's own `updatedAt` — so adding an item after the quote invalidates it. */
  cartUpdatedAt: string
}

/**
 * The signing key, domain-separated from whatever secret it is derived from.
 *
 * Deriving (rather than using a payment secret directly) means a leaked quote
 * token can never be replayed against anything else, and every instance derives
 * the same key from the same configured secret. The last-resort branch is a
 * fixed development string: it keeps tests and local runs working, and it is
 * safe precisely because a forged token can only ever assert a fee the server
 * itself recomputes and compares against.
 */
function quoteSigningKey(): Buffer {
  const base =
    process.env.SHIPPING_QUOTE_SECRET ??
    process.env.RAZORPAY_KEY_SECRET ??
    process.env.PROXY_SHARED_SECRET ??
    'tinytales-dev-unsigned'
  return createHmac('sha256', base).update('tinytales-shipping-quote-v1').digest()
}

function quoteMac(payload: QuoteTokenPayload, expiresAt: number): string {
  return createHmac('sha256', quoteSigningKey())
    .update(canonicalJson({ ...payload, exp: expiresAt }))
    .digest('hex')
}

/**
 * Sign a quote. The token carries only its expiry and a MAC — never the quoted
 * fields themselves, so there is nothing in it for a client to edit. Verifying
 * means recomputing the MAC from a FRESHLY resolved quote: if anything moved,
 * the MACs differ and the caller gets a 409.
 */
export function signQuoteToken(payload: QuoteTokenPayload, now = Date.now()): string {
  const expiresAt = now + QUOTE_TTL_MS
  return `v1.${expiresAt}.${quoteMac(payload, expiresAt)}`
}

/** Why a token was rejected — `expired` and `mismatch` are both a 409, but they log differently. */
export type QuoteTokenFailure = 'malformed' | 'expired' | 'mismatch'

/** Does this token match a freshly computed quote, and is it still in date? */
export function verifyQuoteToken(
  token: string,
  payload: QuoteTokenPayload,
  now = Date.now()
): { ok: true } | { ok: false; failure: QuoteTokenFailure } {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, failure: 'malformed' }

  const expiresAt = Number(parts[1])
  if (!Number.isFinite(expiresAt)) return { ok: false, failure: 'malformed' }
  if (expiresAt <= now) return { ok: false, failure: 'expired' }

  const expected = Buffer.from(quoteMac(payload, expiresAt), 'hex')
  const supplied = Buffer.from(parts[2]!, 'hex')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, failure: 'mismatch' }
  }
  return { ok: true }
}

// --- Pricing a cart ----------------------------------------------------------

/** {@link SHIPPING_NONE} with specific fields overridden — the shape of every "no quote" answer. */
export function shippingBlock(over: Partial<CartShipping> = {}): CartShipping {
  return { ...SHIPPING_NONE, ...over }
}

/**
 * The internal record frozen onto a payment row: what we charged AND what it
 * costs us, per order. Never serialized to a client — `trueCostInr` is the
 * whole margin story and it is nobody's business but ops'.
 */
export interface ShippingSnapshot {
  estimated?: boolean
  distanceKm?: number | null
  nodeId: string
  nodeCode: string
  courierCode: string
  zone: Zone
  chargeableWeightG: number
  customerFeeInr: number
  trueCostInr: number
  etaDays: number
  /** `YYYY-MM-DD`, IST — see {@link estimatedDeliveryDate}. OPTIONAL: absent on orders frozen before this field existed. */
  estimatedDeliveryDate?: string
  destPincode: string
  /**
   * `trueCostInr` split into the lines a courier's tax invoice carries, most
   * importantly its GST — freight is an input service and that tax is
   * claimable, so `services/itcFreight.ts` reports on it.
   *
   * Frozen here, at order-create, for the same reason an invoice freezes its
   * own tax: the rate card moves. Re-deriving the split later from a live
   * `couriers` row would restate a period that has already been filed.
   *
   * OPTIONAL, and readers must handle its absence: every order created before
   * this field existed has a snapshot without it. See the ITC report's
   * `unpriced` count.
   */
  cost?: FreightCost
  /**
   * Carton dims to declare to the carrier at manifest time (`cartParcelDims`),
   * frozen here for the same reason `cost` is: re-deriving from a live catalog
   * later could pick up a dimension the SKU didn't have at checkout.
   *
   * OPTIONAL — orders created before this field existed have no `parcel`, and
   * the manifest builder must fall back to "no dims" rather than throw.
   */
  parcel?: { lengthCm: number; widthCm: number; heightCm: number }
}

/** A priced shipment: the client-facing block, plus the ops record behind it. */
export interface PricedShipping {
  block: CartShipping
  /** Null whenever no courier was chosen (disabled, unserviceable, empty cart). */
  snapshot: ShippingSnapshot | null
  /**
   * True when order creation must refuse with 422 rather than charge.
   *
   * Decided HERE, where the rule is in hand, rather than re-derived by
   * payments from the block's fields: only this function knows whether an
   * unserviceable destination was allowed through by `unserviceableBehavior:
   * 'flat'` (the operator's explicit "sell it and I'll book a courier by
   * hand") or refused by the `block` default.
   */
  blocksOrder: boolean
}

/** What {@link priceCartShipping} needs beyond the context: the cart itself. */
export interface CartShippingInput {
  context: ShippingContext
  destPincode: string
  lines: ShippingLine[]
  /** Post-wholesale subtotal, before any coupon — the default threshold basis. */
  preCouponInr: number
  /** Post-wholesale subtotal minus the coupon discount. */
  postCouponInr: number
  /**
   * The APPLIED coupon waives delivery outright (`coupons.waives_shipping`).
   * Optional so the PDP quote route — which prices a parcel, not a cart, and
   * has no coupon — is unaffected.
   */
  couponWaivesShipping?: boolean
  /** The cart's `updatedAt`, bound into the quote token. */
  cartUpdatedAt: string
  /**
   * This order is being paid cash on delivery.
   *
   * It changes the SNAPSHOT's `trueCostInr`/`cost` and NOTHING the shopper
   * sees — not the courier chosen, not the fee, not the free-delivery
   * threshold (docs/SPEC-COD.md D8). That asymmetry is the point: the courier's
   * COD collection charge is a real cost the margin report must see, but
   * `customerFeeInr` is derived from the courier bill, so letting it through
   * would put a delivery surcharge on top of the ₹49 token — and it would move
   * the fee AFTER the shopper was quoted it, failing the quote-token check on
   * their own order.
   *
   * Absent ⇒ prepaid, which is every caller written before COD existed.
   */
  isCod?: boolean
  /** Injected in tests; defaults to the real clock. */
  now?: number
}

/**
 * The delivery block for one priced cart — the single place the customer fee,
 * the threshold, and the quote token come together.
 *
 * `wouldBeFeeInr` is computed before the threshold is applied and survives the
 * waiver, because it is the number the whole mechanism rests on: "spend ₹130
 * more and the ₹60 you were about to pay for courier becomes a second
 * product". It is reported as the fee at the cart's CURRENT weight, which is
 * why client copy has to say "up to" — an added item can cross a weight slab.
 */
export function priceShipping(input: CartShippingInput): PricedShipping {
  const { context, destPincode, lines } = input
  const { rule } = context

  if (!rule.enabled) return { block: shippingBlock(), snapshot: null, blocksOrder: false }
  if (lines.length === 0) {
    return {
      block: shippingBlock({ enabled: true, reason: null, destinationPincode: destPincode }),
      snapshot: null,
      blocksOrder: false,
    }
  }

  const shipment = selectShipment({
    lines,
    destPincode,
    nodes: context.nodes,
    couriers: context.couriers,
    pincodeIndex: context.pincodeIndex,
    rule,
    declaredValueInr: input.preCouponInr,
    // ALWAYS prepaid, deliberately — see `CartShippingInput.isCod`. Selection
    // and the customer fee are priced prepaid on every order; only the
    // snapshot below carries the COD-inclusive figure.
    isCod: false,
  })

  const winner = shipment.winner
  if (!winner) {
    // No candidate. `flat` still charges — for an operator who would rather
    // hand-book a courier than lose the order — but the reason is reported
    // either way, and `block` is the default because shipping where you cannot
    // service is worse than not selling.
    const base = shippingBlock({
      enabled: true,
      destinationPincode: destPincode,
      reason: shipment.reason,
    })
    const chargeFallback =
      rule.unserviceableBehavior === 'flat' &&
      shipment.reason !== 'no_destination' &&
      rule.fallbackFeeInr > 0
    if (!chargeFallback) return { block: base, snapshot: null, blocksOrder: true }

    const fallbackFeeInr = discountedFeeInr(rule.fallbackFeeInr, rule.feeDiscountBps)
    const outcome = resolveFee(
      fallbackFeeInr,
      0,
      input.preCouponInr,
      input.postCouponInr,
      rule,
      input.couponWaivesShipping
    )
    return {
      block: {
        ...base,
        feeApplied: outcome.feeInr > 0,
        freeApplied: outcome.freeApplied,
        feeInr: outcome.feeInr,
        freeAboveInr: outcome.freeAboveInr,
        remainingInr: outcome.remainingInr,
        wouldBeFeeInr: fallbackFeeInr,
        savedInr: outcome.freeApplied ? fallbackFeeInr : 0,
        waivedByCoupon: outcome.waivedByCoupon,
      },
      snapshot: null,
      blocksOrder: false,
    }
  }

  const grossFeeInr = shopperFeeInr(winner.trueCostInr, rule)

  const outcome = resolveFee(
    grossFeeInr,
    winner.chargeableWeightG,
    input.preCouponInr,
    input.postCouponInr,
    rule,
    input.couponWaivesShipping
  )

  const payload: QuoteTokenPayload = {
    destPincode,
    zone: winner.zone,
    courierCode: winner.courierCode,
    chargeableWeightG: winner.chargeableWeightG,
    feeInr: outcome.feeInr,
    cartUpdatedAt: input.cartUpdatedAt,
  }

  const deliveryDate = estimatedDeliveryDate(
    input.now ?? Date.now(),
    winner.nodeCutoffIst,
    winner.slaDays
  )

  return {
    block: {
      enabled: true,
      feeApplied: outcome.feeInr > 0,
      freeApplied: outcome.freeApplied,
      feeInr: outcome.feeInr,
      freeAboveInr: outcome.freeAboveInr,
      remainingInr: outcome.remainingInr,
      wouldBeFeeInr: grossFeeInr,
      savedInr: outcome.freeApplied ? grossFeeInr : 0,
      waivedByCoupon: outcome.waivedByCoupon,
      zone: winner.zone,
      chargeableWeightG: winner.chargeableWeightG,
      destinationPincode: destPincode,
      etaDays: winner.slaDays,
      estimatedDeliveryDate: deliveryDate,
      courierLabel: winner.courierName,
      courierCode: winner.courierCode,
      quoteToken: signQuoteToken(payload, input.now),
      estimated: winner.estimated,
      distanceKm: winner.distanceKm,
      reason: null,
    },
    snapshot: {
      estimated: winner.estimated,
      distanceKm: winner.distanceKm,
      nodeId: winner.nodeId,
      nodeCode: winner.nodeCode,
      courierCode: winner.courierCode,
      zone: winner.zone,
      chargeableWeightG: winner.chargeableWeightG,
      customerFeeInr: outcome.feeInr,
      // The COD-inclusive bill on a cash order. This is the ONE number the
      // payment mode moves, and it moves only here — what the shopper was
      // shown above is identical either way.
      trueCostInr: input.isCod ? winner.codCost.totalInr : winner.trueCostInr,
      etaDays: winner.slaDays,
      estimatedDeliveryDate: deliveryDate,
      destPincode,
      cost: input.isCod ? winner.codCost : winner.cost,
      parcel: { lengthCm: winner.lengthCm, widthCm: winner.widthCm, heightCm: winner.heightCm },
    },
    blocksOrder: false,
  }
}

/** The cart path only ever needs the client-facing half. */
export function priceCartShipping(input: CartShippingInput): CartShipping {
  return priceShipping(input).block
}

/**
 * Rebuild the token payload for an already-priced cart — what order creation
 * re-verifies a client-supplied token against. Built from the block rather
 * than from the winner so that "what the shopper was shown" and "what we
 * re-derived" are compared field for field.
 */
export function quotePayloadFor(shipping: CartShipping, cartUpdatedAt: string): QuoteTokenPayload {
  return {
    destPincode: shipping.destinationPincode,
    zone: shipping.zone,
    courierCode: shipping.courierCode,
    chargeableWeightG: shipping.chargeableWeightG,
    feeInr: shipping.feeInr,
    cartUpdatedAt,
  }
}
