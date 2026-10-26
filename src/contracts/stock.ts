/**
 * Zod contracts for the stock module (docs/SPEC-STOCK.md §4, §5). Source of
 * truth for request validation AND response types; imports only `zod`, same
 * rule as every other contracts file.
 *
 * ## The public shape is defined by what it REFUSES to say
 *
 * The cascade knows a great deal by the time it answers: which shop holds the
 * sku, how far away it is, how many units are on that shelf. The public
 * response carries none of it — no node id, no store name, no city, no
 * quantity, no indication that more than one location even exists. The owner's
 * decision (SPEC-STOCK.md §1) was "In Stock, delivered in 2–4 days, that's it,
 * no details from where it will be shipped", and three separate things depend
 * on holding that line:
 *
 * - **The retailers.** These are consignment shelves in shops that also sell
 *   competing brands. Publishing a live per-shop stock feed hands a competitor
 *   a map of our distribution and hands each retailer a view of the others'
 *   inventory. Nothing in the signed agreements contemplates that.
 * - **The shopper.** A store name in an availability response is an implied
 *   promise about where a parcel ships from, and the cascade winner at
 *   browse time is not binding — stock moves between the PDP and the capture.
 * - **Us.** An unauthenticated endpoint that reports per-location quantities
 *   is a scraper's inventory-intelligence API. It would be one, within a week.
 *
 * `LowStock` is the one concession, and it is deliberately a BAND rather than a
 * number: "only a few left" is honest urgency; "3 left at Rajkot" is a data
 * feed.
 *
 * The admin contracts below are the opposite — they carry node identity and
 * exact counts, because that is the whole job of the admin panel, and they sit
 * behind the admin role.
 */

import { z } from 'zod'

/** Six digits, never leading zero — same rule as contracts/address.ts and contracts/shipping.ts. */
export const PINCODE = /^[1-9][0-9]{5}$/

const pincode = z.string().regex(PINCODE, 'pincode must be 6 digits and not start with 0')

const sku = z.string().min(1).max(120)

/**
 * How many skus one availability call may ask about.
 *
 * A PDP asks about one; a cart asks about however many lines it has. 50 covers
 * both with room to spare, and caps the work a single unauthenticated request
 * can commission — without it, one request could ask for the entire catalog's
 * availability and make the rate limiter meaningless.
 */
export const MAX_AVAILABILITY_SKUS = 50

/**
 * What a shopper is told. Three states, and none of them leak a location.
 *
 * `low_stock` requires an actual tracked count at or under the threshold. A
 * shelf marked `tracked = false` ("stocked here, count unknown") can never
 * produce it — claiming scarcity we cannot substantiate would be a misleading
 * representation under the Consumer Protection Act 2019, the same reason
 * fabricated reviews were removed.
 */
export const StockStatusSchema = z.enum(['in_stock', 'low_stock', 'out_of_stock'])

/**
 * The delivery promise, as a RANGE.
 *
 * Decided 2026-08-01. The owner asked for "delivered in 2 days"; nothing in
 * this codebase computes a real per-shopper ETA yet, and a fixed scalar shown
 * against a lane whose courier SLA is 4 days is a promise we would break
 * roughly half the time. A `{min, max}` pair lets a real computation — courier
 * `slaDaysZoneA`/`slaDaysZoneB` plus `pickup_nodes.cutoffIst`, both already in
 * the schema — narrow this later without a contract change.
 */
export const EtaDaysSchema = z.object({
  min: z.int().min(0),
  max: z.int().min(0),
})

export const AvailabilityItemSchema = z.object({
  sku: z.string(),
  status: StockStatusSchema,
  /** Null when out of stock — there is no delivery to promise. */
  etaDays: EtaDaysSchema.nullable(),
})

/**
 * `POST /v1/stock/availability` — POST rather than GET because a cart-sized sku
 * list does not belong in a URL (query-length limits, and it would land in
 * every access log and CDN key). Nothing is created; the route is idempotent
 * and safe to retry.
 */
export const AvailabilityRequestSchema = z.strictObject({
  pincode,
  skus: z.array(sku).min(1).max(MAX_AVAILABILITY_SKUS),
})

export const AvailabilityResponseSchema = z.object({
  items: z.array(AvailabilityItemSchema),
})

// --- Admin -------------------------------------------------------------------

/** Why a count changed. Mirrors the `store_stock_audit_reason_valid` constraint. */
export const StockChangeReasonSchema = z.enum([
  'manual',
  'order_paid',
  'restock',
  'correction',
  'import',
])

/**
 * Reasons an ADMIN may assert. `order_paid` is absent on purpose: it is written
 * only by the decrement inside `markOrderPaid`, and letting an operator stamp a
 * manual correction with it would make the audit trail unable to answer "did we
 * actually sell these, or did someone adjust the number?".
 */
export const AdminStockChangeReasonSchema = z.enum([
  'manual',
  'restock',
  'correction',
  'import',
])

export const StockPolicyModeSchema = z.enum(['auto', 'force_in', 'force_out'])

/** One shelf row as the admin panel sees it — node identity and exact count included. */
export const AdminStockRowSchema = z.object({
  nodeId: z.string(),
  nodeCode: z.string(),
  nodeName: z.string(),
  nodeKind: z.enum(['warehouse', 'retail', 'hub']),
  /** Whether the cascade may source from this node at all. A count here is inert while false. */
  stockEnabled: z.boolean(),
  sku: z.string(),
  qty: z.int(),
  tracked: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string(),
})

export const AdminStockListQuerySchema = z.strictObject({
  sku: sku.optional(),
  nodeId: z.string().uuid().optional(),
})

export const AdminStockListSchema = z.object({
  rows: z.array(AdminStockRowSchema),
})

/**
 * `PUT /v1/admin/stock/:nodeId/:sku` — set an absolute count, not a delta.
 *
 * Absolute because the operator is transcribing a physical count off a shelf,
 * and a delta form invites double-application on a retry: submit "+5" twice and
 * the shelf gains ten units that were never there. An absolute value is
 * idempotent, so a flaky connection cannot corrupt the number.
 *
 * The audit row still records the delta, computed server-side from the value
 * that was actually replaced.
 */
export const AdminStockUpsertSchema = z.strictObject({
  qty: z.int().min(0).max(1_000_000),
  tracked: z.boolean().optional(),
  reason: AdminStockChangeReasonSchema,
  /** Free-text note; goes to the audit row, never to a shopper. */
  reference: z.string().max(500).optional(),
})

export const AdminStockPolicySchema = z.object({
  sku: z.string(),
  mode: StockPolicyModeSchema,
  lowStockAt: z.int().nullable(),
  maxCascadeStores: z.int().nullable(),
  maxRadiusKm: z.int().nullable(),
  hubFallback: z.boolean(),
  note: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
})

export const AdminStockPolicyListSchema = z.object({
  policies: z.array(AdminStockPolicySchema),
  /** The values a sku with no policy row runs on, so the panel can show them as the baseline. */
  defaults: z.object({
    lowStockAt: z.int(),
    maxCascadeStores: z.int(),
    maxRadiusKm: z.int(),
  }),
})

/**
 * `PUT /v1/admin/stock/policy/:sku`. Every limit is nullable, and null means
 * "use the service default" rather than "no limit" — an operator clearing a
 * field should fall back to the sane value, not remove the guard rail.
 */
export const AdminStockPolicyUpsertSchema = z.strictObject({
  mode: StockPolicyModeSchema,
  lowStockAt: z.int().min(0).max(10_000).nullable().optional(),
  maxCascadeStores: z.int().min(1).max(100).nullable().optional(),
  maxRadiusKm: z.int().min(1).max(5_000).nullable().optional(),
  hubFallback: z.boolean().optional(),
  note: z.string().max(500).optional(),
})

export const AdminStockAuditRowSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  sku: z.string(),
  oldQty: z.int().nullable(),
  newQty: z.int(),
  delta: z.int(),
  reason: StockChangeReasonSchema,
  reference: z.string(),
  changedBy: z.string(),
  changedAt: z.string(),
})

export const AdminStockAuditQuerySchema = z.strictObject({
  sku: sku.optional(),
  nodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const AdminStockAuditListSchema = z.object({
  entries: z.array(AdminStockAuditRowSchema),
})

/**
 * `GET /v1/admin/stock/explain?sku=&pincode=` — replays the cascade and shows
 * every step, including the candidates it rejected and why.
 *
 * This is the panel's most important screen. The cascade's whole job is to pick
 * one shop out of many by a rule the operator cannot see, and without this an
 * operator staring at "Out of Stock" for a sku that is visibly on three shelves
 * has no way to tell a policy override from an unranked coordinate from a
 * disabled node. It is admin-only for the obvious reason: it is precisely the
 * store-by-store detail the public endpoint refuses to give.
 */
export const AdminStockExplainQuerySchema = z.strictObject({ sku, pincode })

export const AdminStockExplainCandidateSchema = z.object({
  nodeId: z.string(),
  nodeCode: z.string(),
  nodeName: z.string(),
  nodeKind: z.enum(['warehouse', 'retail', 'hub']),
  qty: z.int(),
  tracked: z.boolean(),
  /** Null when the node or the destination pincode has no coordinate — unrankable, not zero. */
  distanceKm: z.number().nullable(),
  /** Whether this candidate was the one the cascade settled on. */
  chosen: z.boolean(),
  /** Why it was not chosen. Null for the winner. */
  rejectedBecause: z.string().nullable(),
})

export const AdminStockExplainSchema = z.object({
  sku: z.string(),
  pincode: z.string(),
  status: StockStatusSchema,
  etaDays: EtaDaysSchema.nullable(),
  /** The decisive step, e.g. 'policy_force_out', 'variant_out_of_stock', 'retail_hit', 'hub_fallback', 'no_candidates'. */
  decidedBy: z.string(),
  /** Null when the destination pincode has no coordinate, which disables distance ranking entirely. */
  destinationCoords: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  effectivePolicy: z.object({
    mode: StockPolicyModeSchema,
    lowStockAt: z.int(),
    maxCascadeStores: z.int(),
    maxRadiusKm: z.int(),
    hubFallback: z.boolean(),
  }),
  candidates: z.array(AdminStockExplainCandidateSchema),
})

export type StockStatus = z.infer<typeof StockStatusSchema>
export type EtaDays = z.infer<typeof EtaDaysSchema>
export type AvailabilityItem = z.infer<typeof AvailabilityItemSchema>
export type StockChangeReason = z.infer<typeof StockChangeReasonSchema>
export type AdminStockChangeReason = z.infer<typeof AdminStockChangeReasonSchema>
export type StockPolicyMode = z.infer<typeof StockPolicyModeSchema>
export type AdminStockRow = z.infer<typeof AdminStockRowSchema>
export type AdminStockPolicy = z.infer<typeof AdminStockPolicySchema>
export type AdminStockExplain = z.infer<typeof AdminStockExplainSchema>
