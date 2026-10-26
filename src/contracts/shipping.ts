/**
 * Zod contracts for the shipping module (docs/SPEC-SHIPPING.md §6). Source of
 * truth for request validation AND response types; imports only `zod`, same
 * rule as every other contracts file.
 *
 * The `Zone` and reason enums are re-declared here rather than imported from
 * `lib/shipping.ts`. That duplication is deliberate: contracts must stay
 * importable with no dependency but zod (so the mobile and admin repos can
 * share them), and the arithmetic module must stay importable with none at all.
 * The two lists are small, closed, and change together.
 *
 * Cart's own `shipping` block lives in contracts/cart.ts (`CartShippingSchema`)
 * — it is part of the cart resource, not a separate one.
 */

import { z } from 'zod'

/** Six digits, never leading zero — the same rule as contracts/address.ts. */
export const PINCODE = /^[1-9][0-9]{5}$/

const pincode = z.string().regex(PINCODE, 'pincode must be 6 digits and not start with 0')

/** Courier zone. A = same taluk, B = rest of the state, D = rest of India. */
export const ZoneSchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F'])

/** Why a cart or quote has no delivery fee. Mirrors `ShippingReason` in lib/shipping.ts. */
export const ShippingReasonSchema = z.enum([
  'disabled',
  'no_destination',
  'not_serviceable',
  'no_single_node',
  'weight_unknown',
  'dims_unknown',
])

// --- Public surfaces ---------------------------------------------------------

/** `GET /v1/shipping/serviceability?pincode=` — "do you deliver here, and how fast?" */
export const ServiceabilityQuerySchema = z.strictObject({ pincode })

export const ServiceabilitySchema = z.object({
  estimated: z.boolean().default(false),
  distanceKm: z.number().nullable().default(null),
  pincode: z.string(),
  serviceable: z.boolean(),
  zone: ZoneSchema.nullable(),
  etaDays: z.int().nullable(),
  /** Tentative delivery date, IST 'YYYY-MM-DD'; null when not serviceable. */
  estimatedDeliveryDate: z.string().nullable(),
  /** Quote status; PAN India acceptance can remain true without a priced lane. */
  reason: ShippingReasonSchema.nullable(),
})

/**
 * `GET /v1/shipping/quote?sku=&qty=&pincode=` — the PDP delivery widget.
 *
 * There is deliberately no `weightG` input. Weight is looked up server-side
 * from the sku; accepting it from the client would let anyone quote a 1 g
 * parcel and then hold the API to that price.
 */
export const ShippingQuoteQuerySchema = z.strictObject({
  sku: z.string().min(1).max(120),
  qty: z.coerce.number().int().min(1).max(99).optional(),
  pincode,
})

export const ShippingQuoteSchema = z.object({
  estimated: z.boolean().default(false),
  distanceKm: z.number().nullable().default(null),
  pincode: z.string(),
  serviceable: z.boolean(),
  /** What this parcel alone would cost to deliver; 0 when not serviceable. */
  feeInr: z.int(),
  /** Free-delivery threshold at this parcel's weight; 0 when no tier applies. */
  freeAboveInr: z.int(),
  zone: ZoneSchema.nullable(),
  etaDays: z.int().nullable(),
  /** Tentative delivery date, IST 'YYYY-MM-DD'; null when not serviceable. */
  estimatedDeliveryDate: z.string().nullable(),
  courierLabel: z.string(),
  chargeableWeightG: z.int(),
  reason: ShippingReasonSchema.nullable(),
})

// --- Admin simulator ---------------------------------------------------------

/**
 * `POST /v1/admin/shipping/simulate` — the instrument that keeps the customer
 * slab table honest. It is Phase 1, not Phase 2, because a rate table that
 * loses money on every 2 kg parcel is invisible until something computes the
 * margin, and by then the orders have shipped.
 */
export const ShippingSimulateBodySchema = z.strictObject({
  destPincode: pincode,
  /** Dead weight of the goods in grams (tare is added by the engine). */
  weightG: z.number().int().min(0).max(50000),
  /** Goods value — drives the risk/COD components and the free-delivery threshold. */
  cartValueInr: z.number().int().min(0).max(10_000_000),
  /** Optional carton, to exercise volumetric weight. */
  lengthCm: z.number().int().min(0).max(300).optional(),
  widthCm: z.number().int().min(0).max(300).optional(),
  heightCm: z.number().int().min(0).max(300).optional(),
  /** Prepaid by default (SPEC-SHIPPING D6); the flag exists so COD can be modelled before it launches. */
  isCod: z.boolean().optional(),
})

/** One (node, courier) pairing, priced — with the margin spelled out. */
export const ShippingSimulateCandidateSchema = z.object({
  estimated: z.boolean().default(false),
  nodeCode: z.string(),
  courierCode: z.string(),
  courierLabel: z.string(),
  zone: ZoneSchema,
  chargeableWeightG: z.int(),
  /** What the courier bills us, all six components. */
  trueCostInr: z.int(),
  /** What the shopper would be charged, before any free-delivery waiver. */
  customerFeeInr: z.int(),
  /** `customerFeeInr − trueCostInr`. NEGATIVE means this cell is subsidised. */
  marginInr: z.int(),
  slaDays: z.int(),
  distanceKm: z.number().nullable(),
  /** True for the candidate the engine would actually pick. */
  chosen: z.boolean(),
})

export const ShippingSimulateSchema = z.object({
  destPincode: z.string(),
  /** The weight the engine derived, tare included, before per-courier minimums. */
  deadWeightG: z.int(),
  serviceable: z.boolean(),
  reason: ShippingReasonSchema.nullable(),
  /** Free-delivery threshold at this weight; 0 when no tier applies (never free). */
  freeAboveInr: z.int(),
  /** Whether a cart of `cartValueInr` at this weight would ship free. */
  freeApplied: z.boolean(),
  /** What the shopper actually pays after the threshold is applied. */
  feeInr: z.int(),
  /** Every viable candidate, best-first. Empty when nothing can serve the destination. */
  candidates: z.array(ShippingSimulateCandidateSchema),
  /**
   * Set when `shipping.enabled` is true but the config failed validation, which
   * turns delivery pricing off store-wide and is otherwise indistinguishable
   * from having switched it off deliberately. Names the offending key. Null
   * when the config is fine — including when shipping is simply disabled.
   */
  configError: z.string().nullable(),
})

export type Serviceability = z.infer<typeof ServiceabilitySchema>
export type ShippingQuoteQuery = z.infer<typeof ShippingQuoteQuerySchema>
export type ShippingQuoteResponse = z.infer<typeof ShippingQuoteSchema>
export type ShippingSimulateBody = z.infer<typeof ShippingSimulateBodySchema>
export type ShippingSimulateCandidate = z.infer<typeof ShippingSimulateCandidateSchema>
export type ShippingSimulate = z.infer<typeof ShippingSimulateSchema>
