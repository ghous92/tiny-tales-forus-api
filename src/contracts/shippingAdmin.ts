/**
 * Zod contracts for the shipping admin surface — the data-in half of the
 * engine. Imports only `zod`, same rule as every other contracts module.
 *
 * Endpoints (see routes/shippingAdmin.ts), all `authenticate` + `requireAdmin`:
 *   GET    /v1/admin/shipping/nodes                list pickup nodes
 *   POST   /v1/admin/shipping/nodes                create
 *   PUT    /v1/admin/shipping/nodes/:code          partial patch
 *   DELETE /v1/admin/shipping/nodes/:code          hard delete
 *   GET    /v1/admin/shipping/couriers             list, slabs + areas inlined
 *   POST   /v1/admin/shipping/couriers             create
 *   PUT    /v1/admin/shipping/couriers/:code       partial patch
 *   DELETE /v1/admin/shipping/couriers/:code       hard delete (cascades rates)
 *   PUT    /v1/admin/shipping/couriers/:code/slabs REPLACE the whole rate card
 *   PUT    /v1/admin/shipping/couriers/:code/service-areas  replace ranges
 *   POST   /v1/admin/shipping/couriers/:code/exceptions     CSV import
 *   POST   /v1/admin/shipping/pincodes/import      CSV import (India Post)
 *
 * Two shapes recur and are deliberate:
 *
 * **Rate cards are REPLACED, never patched row by row.** A slab table is only
 * meaningful as a whole — a per-row PUT lets an operator leave zone B holding
 * yesterday's ≤500 g row beside today's ≤2 kg one, which prices real parcels
 * from a table that never existed on any carrier's contract. Send the card,
 * get the card.
 *
 * **Money fields are integers.** Rupees whole, percentages in basis points,
 * matching lib/pricing.ts and lib/shipping.ts. A `number` that can be 11.5 has
 * no place in a freight bill.
 *
 * **Update schemas are built from default-FREE field shapes.** `.partial()` in
 * Zod 4 does not remove a `.default()` — an absent key still materialises its
 * default, so `CreateSchema.partial()` turns every PUT into a full row
 * overwrite. `PUT /couriers/x {fuelBps: 1100}` would have quietly reset gstBps,
 * minChargeableG and reliabilityScore to their defaults, which is a rate card
 * nobody entered. The `*Fields` records below carry no defaults; the create
 * schemas add them, the update schemas do not.
 */

import { z } from 'zod'

export { ErrorEnvelopeSchema } from './config.js'

const ZoneEnum = z.enum(['A', 'B', 'C', 'D', 'E', 'F'])
const nonNegInt = z.number().int().min(0)
const posInt = z.number().int().positive()

/** Same 6-digit rule the `pickup_nodes` / `addresses` CHECK constraints enforce. */
const pincode = z.string().regex(/^[1-9][0-9]{5}$/, 'Pincode must be 6 digits and not start with 0')

/** Courier/node handles appear in URLs and ops tooling — keep them boring. */
const handle = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, digits, hyphen or underscore')

const nodeCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphen or underscore')

// --- Pickup nodes ------------------------------------------------------------

/**
 * Address fields mirror `AddressForm.tsx` so the admin form and the shopper
 * form stay recognisably the same thing.
 *
 * `lat`/`lng` are nullable and are NOT set by the geocoder on the server's own
 * initiative — the admin resolves coordinates, looks at the map, and saves.
 * A silently-geocoded origin mis-prices every order from that node, and it does
 * so quietly, which is why confirmation is a workflow step rather than a
 * default.
 */
const pickupNodeFields = {
  name: z.string().min(1).max(200),
  contactName: z.string().max(200),
  contactPhone: z.string().max(20),
  houseNumber: z.string().max(200),
  roadArea: z.string().max(300),
  city: z.string().max(120),
  state: z.string().max(120),
  pincode,
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  isActive: z.boolean(),
  priority: z.number().int(),
  cutoffIst: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Cutoff must be IST "HH:MM"'),
}

export const PickupNodeSchema = z.object({
  code: nodeCode,
  ...pickupNodeFields,
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  cutoffIst: z.string(),
})

export const PickupNodeCreateSchema = z.strictObject({
  code: nodeCode,
  ...pickupNodeFields,
  contactName: pickupNodeFields.contactName.default(''),
  contactPhone: pickupNodeFields.contactPhone.default(''),
  houseNumber: pickupNodeFields.houseNumber.default(''),
  roadArea: pickupNodeFields.roadArea.default(''),
  city: pickupNodeFields.city.default(''),
  state: pickupNodeFields.state.default(''),
  isActive: pickupNodeFields.isActive.default(true),
  priority: pickupNodeFields.priority.default(0),
  cutoffIst: pickupNodeFields.cutoffIst.default('15:00'),
})

/**
 * A genuine patch: only the keys sent are written. `code` is absent because it
 * is the URL, and re-coding a node would orphan every reference to it.
 */
export const PickupNodeUpdateSchema = z.strictObject(pickupNodeFields).partial()

export const PickupNodeListSchema = z.object({ nodes: z.array(PickupNodeSchema) })
export const NodeCodeParamsSchema = z.strictObject({ code: nodeCode })

// --- Couriers ----------------------------------------------------------------

/**
 * One rate-card row: everything up to `uptoG` costs `rateInr` in base freight.
 *
 * `addlPerG`/`addlRateInr` are read ONLY off the heaviest row of a zone — that
 * is the above-table extrapolation, and a top row with no per-step charge means
 * the zone simply refuses to quote heavier parcels rather than repeating its
 * top price forever.
 */
export const RateSlabSchema = z.object({
  zone: ZoneEnum,
  uptoG: posInt,
  rateInr: nonNegInt,
  addlPerG: posInt,
  addlRateInr: nonNegInt,
})

export const ServiceAreaSchema = z.object({
  fromPincode: pincode,
  toPincode: pincode,
  prepaid: z.boolean(),
  cod: z.boolean(),
  isActive: z.boolean(),
})

export const ServiceExceptionSchema = z.object({
  pincode,
  serviceable: z.boolean(),
})

const courierFields = {
  name: z.string().min(1).max(200),
  isActive: z.boolean(),
  mode: z.enum(['surface', 'express']),
  rateModel: z.enum(['weight', 'distance']),
  volumetricDivisor: posInt,
  minChargeableG: nonNegInt,
  fuelBps: nonNegInt,
  gstBps: nonNegInt,
  docketFeeInr: nonNegInt,
  riskBps: nonNegInt,
  riskMinInr: nonNegInt,
  codFlatInr: nonNegInt,
  codBps: nonNegInt,
  rtoBps: nonNegInt,
  slaDaysZoneA: nonNegInt,
  slaDaysZoneB: nonNegInt,
  reliabilityScore: z.number().int().min(0).max(100),
  priority: z.number().int(),
}

/** The whole cost formula for one carrier, plus its rate card. */
export const CourierSchema = z.object({
  code: handle,
  ...courierFields,
  slabs: z.array(RateSlabSchema),
  serviceAreas: z.array(ServiceAreaSchema),
  /** Count only — the exception table is per-pincode and can run to thousands. */
  exceptionCount: z.number().int(),
})

export const CourierCreateSchema = z.strictObject({
  code: handle,
  ...courierFields,
  isActive: courierFields.isActive.default(true),
  mode: courierFields.mode.default('surface'),
  rateModel: courierFields.rateModel.default('weight'),
  volumetricDivisor: courierFields.volumetricDivisor.default(5000),
  minChargeableG: courierFields.minChargeableG.default(500),
  fuelBps: courierFields.fuelBps.default(0),
  gstBps: courierFields.gstBps.default(1800),
  docketFeeInr: courierFields.docketFeeInr.default(0),
  riskBps: courierFields.riskBps.default(0),
  riskMinInr: courierFields.riskMinInr.default(0),
  codFlatInr: courierFields.codFlatInr.default(0),
  codBps: courierFields.codBps.default(0),
  rtoBps: courierFields.rtoBps.default(0),
  slaDaysZoneA: courierFields.slaDaysZoneA.default(2),
  slaDaysZoneB: courierFields.slaDaysZoneB.default(4),
  reliabilityScore: courierFields.reliabilityScore.default(50),
  priority: courierFields.priority.default(0),
})

/** Patch semantics, for the same reason as {@link PickupNodeUpdateSchema}. */
export const CourierUpdateSchema = z.strictObject(courierFields).partial()

export const CourierListSchema = z.object({ couriers: z.array(CourierSchema) })
export const CourierCodeParamsSchema = z.strictObject({ code: handle })

/**
 * Replace a courier's whole rate card.
 *
 * Empty is allowed and means "this carrier quotes nothing" — which is a real
 * state (a carrier being onboarded) and reads as unserviceable rather than as
 * free, because `lookupSlab` returns null, never 0.
 */
export const SlabsReplaceSchema = z.strictObject({
  slabs: z.array(RateSlabSchema).max(200),
})

export const ServiceAreasReplaceSchema = z.strictObject({
  serviceAreas: z
    .array(
      z.strictObject({
        fromPincode: pincode,
        toPincode: pincode,
        prepaid: z.boolean().default(true),
        cod: z.boolean().default(false),
        isActive: z.boolean().default(true),
      })
    )
    .max(500),
})

// --- CSV imports -------------------------------------------------------------

/**
 * Carrier serviceability files and the India Post pincode file both arrive as
 * CSV, both are large, and both are pasted rather than uploaded — the admin SPA
 * is a static export with no upload endpoint, and a text body keeps it that
 * way.
 *
 * 4 MB caps the body at roughly the full India Post file (~155k rows), which is
 * the largest thing anyone will legitimately paste.
 */
const csvBody = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024)

export const ExceptionsImportSchema = z.strictObject({
  csv: csvBody,
  /** Wipe this courier's existing exceptions first. Default false — imports usually top up. */
  replace: z.boolean().default(false),
})

export const PincodesImportSchema = z.strictObject({
  csv: csvBody,
})

/**
 * What an import did, and — more usefully — what it refused.
 *
 * `errors` is capped and carries the row number, because the failure mode that
 * actually happens is a file with three malformed rows in the middle, and
 * "imported 154,997 of 155,000" with no line numbers is not an answer anyone
 * can act on.
 */
export const ImportResultSchema = z.object({
  parsed: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  /** True when `errors` was truncated — there were more problems than are listed. */
  errorsTruncated: z.boolean(),
})

// --- Forward geocode ---------------------------------------------------------

/**
 * `POST /v1/admin/shipping/geocode/forward` — address text to a coordinate.
 *
 * ADMIN-GATED, unlike the reverse endpoint. Reverse geocoding needs a
 * coordinate the caller already has, so it leaks nothing; forward geocoding
 * turns arbitrary text into coordinates, which is a general-purpose lookup
 * service and an obvious thing to point a script at. It exists to place a
 * pickup node, and nothing else needs it.
 */
export const ForwardGeocodeBodySchema = z.strictObject({
  address: z.string().min(3).max(500),
})

export const ForwardGeocodeResultSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  pincode: z.string(),
  formattedAddress: z.string(),
})

export type PickupNode = z.infer<typeof PickupNodeSchema>
export type PickupNodeCreate = z.infer<typeof PickupNodeCreateSchema>
export type PickupNodeUpdate = z.infer<typeof PickupNodeUpdateSchema>
export type AdminCourier = z.infer<typeof CourierSchema>
export type CourierCreate = z.infer<typeof CourierCreateSchema>
export type CourierUpdate = z.infer<typeof CourierUpdateSchema>
export type RateSlabInput = z.infer<typeof RateSlabSchema>
export type ServiceAreasReplace = z.infer<typeof ServiceAreasReplaceSchema>
export type ImportResult = z.infer<typeof ImportResultSchema>
export type ForwardGeocodeResult = z.infer<typeof ForwardGeocodeResultSchema>
