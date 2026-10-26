/**
 * Fulfilment API contracts (docs/SPEC-LOGISTICS.md). Imports nothing but `zod`
 * (ARCHITECTURE.md rule 4) so the file is shareable with the mobile app.
 *
 * The canonical status enum is therefore **re-declared** here rather than
 * imported from `lib/fulfilmentStatus.ts`. Same deliberate duplication as
 * `Zone` in `contracts/shipping.ts`, and the same guard: a drift test asserts
 * the two lists match, so the copy cannot rot silently.
 */

import { z } from 'zod'

export const FulfilmentStatusSchema = z.enum([
  'pending_manifest',
  'manifested',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'ndr',
  'rto_in_transit',
  'delivered',
  'rto_delivered',
  'cancelled',
  'exception',
])

/**
 * One entry in the shopper-facing timeline.
 *
 * A deliberately narrow projection of `shipment_events`: no `raw`, no sort
 * codes, no NDR instruction text. Those either leak operational detail or are
 * actively confusing to a customer ("X-UCI" means nothing to anyone outside
 * Delhivery), and the customer route is not the place to find out.
 */
export const TrackingEventSchema = z.object({
  status: FulfilmentStatusSchema,
  /** Shopper-safe copy from `labelFor()` — never the carrier's raw string. */
  label: z.string(),
  /** City/hub as the carrier reported it; '' when unknown. */
  location: z.string(),
  occurredAt: z.iso.datetime(),
})

export const TrackingSchema = z.object({
  orderId: z.string(),
  status: FulfilmentStatusSchema,
  label: z.string(),
  /** Null until manifested — the shopper has no tracking number before that. */
  awb: z.string().nullable(),
  courierLabel: z.string(),
  /** Deep link into the carrier's own tracking page; '' when not trackable yet. */
  trackingUrl: z.string(),
  /** What shipping promised at checkout, in days. Null for pre-shipping orders. */
  promisedEtaDays: z.int().nullable(),
  /** The calendar-date form of `promisedEtaDays`, IST 'YYYY-MM-DD' — what the cart/checkout screen actually showed. Null for pre-shipping orders. */
  promisedDeliveryDate: z.string().nullable(),
  estimatedDeliveryAt: z.iso.datetime().nullable(),
  /** What was actually declared to the carrier at manifest time. Null pre-manifest. */
  parcel: z
    .object({
      weightG: z.int(),
      lengthCm: z.int(),
      widthCm: z.int(),
      heightCm: z.int(),
    })
    .nullable(),
  manifestedAt: z.iso.datetime().nullable(),
  pickedUpAt: z.iso.datetime().nullable(),
  outForDeliveryAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  deliveryAttempts: z.int(),
  /** Present only while a delivery attempt has failed and not yet been resolved. */
  ndrReason: z.string().nullable(),
  timeline: z.array(TrackingEventSchema),
})

export const TrackingParamsSchema = z.object({
  orderId: z.string().min(1).max(64),
})

/**
 * The carrier's push payload (SPEC-LOGISTICS.md §5.1).
 *
 * **Loose on purpose — `.loose()`, everything optional.** Delhivery's own
 * documentation says to consume all scans "without hard checks in the first
 * place", and their payload is explicitly negotiable per client. A schema that
 * rejected an unexpected key would drop real scans and, worse, teach their push
 * pipeline to stop sending. Validation of what actually matters (AWB present,
 * timestamp parseable) happens in `readWebhookScan`, which returns null rather
 * than throwing.
 */
export const WebhookScanSchema = z
  .object({
    Shipment: z
      .object({
        AWB: z.union([z.string(), z.number()]).optional(),
        ReferenceNo: z.union([z.string(), z.number()]).optional(),
        NSLCode: z.string().optional(),
        Sortcode: z.string().optional(),
        PickUpDate: z.string().optional(),
        Status: z
          .object({
            Status: z.string().optional(),
            StatusType: z.string().optional(),
            StatusCode: z.string().optional(),
            StatusDateTime: z.string().optional(),
            StatusLocation: z.string().optional(),
            Instructions: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

/** Delhivery expects a bare `200 OK`; the body is ours to choose. */
export const WebhookAckSchema = z.object({
  received: z.boolean(),
  /** False when the AWB matched no shipment — stored as an orphan, still a 200. */
  matched: z.boolean(),
})

// ── Admin ──────────────────────────────────────────────────────────────────

export const AdminShipmentSchema = z.object({
  id: z.uuid(),
  orderId: z.string(),
  courierCode: z.string(),
  awb: z.string().nullable(),
  status: FulfilmentStatusSchema,
  statusDetail: z.string().nullable(),
  nslCode: z.string().nullable(),
  pickupId: z.string().nullable(),
  manifestError: z.string().nullable(),
  manifestAttempts: z.int(),
  deliveryAttempts: z.int(),
  ndrReason: z.string().nullable(),
  lastScanAt: z.iso.datetime().nullable(),
  manifestedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Manual fulfilment fields (docs/SPEC-MANUAL-FULFILMENT.md §4B) — null until an operator acts. */
  manualCourierName: z.string().nullable(),
  manualTrackingUrl: z.string().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  opsNote: z.string().nullable(),
})

export const AdminShipmentListQuerySchema = z.object({
  status: FulfilmentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const AdminShipmentListSchema = z.object({
  shipments: z.array(AdminShipmentSchema),
})

/**
 * Ahmedabad + Gandhinagar intracity pilot — same `AdminShipment` shape plus
 * the destination pincode/city/district it was matched on, so ops can see WHY
 * a row landed in this list without cross-referencing the pincode table.
 */
export const DirectIntracityOrderSchema = AdminShipmentSchema.extend({
  pincode: z.string(),
  city: z.string(),
  district: z.string(),
})

export const DirectIntracityOrderListQuerySchema = z.object({
  status: FulfilmentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const DirectIntracityOrderListSchema = z.object({
  orders: z.array(DirectIntracityOrderSchema),
})

export const ShipmentParamsSchema = z.object({ id: z.uuid() })

/** Result of a sweep — both sweeps report the same shape so ops reads one dashboard. */
export const SweepResultSchema = z.object({
  scanned: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  /** Scans ingested (reconcile) or shipments manifested (manifest). */
  changed: z.int(),
})

export const PickupBodySchema = z
  .object({
    /** `YYYY-MM-DD`, IST. Defaults to today at the service layer. */
    pickupDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'pickupDate must be YYYY-MM-DD')
      .optional(),
    /** `HH:MM:SS`, IST. */
    pickupTime: z
      .string()
      .regex(/^\d{2}:\d{2}:\d{2}$/, 'pickupTime must be HH:MM:SS')
      .optional(),
    expectedPackageCount: z.int().min(1).max(500).optional(),
  })
  .strict()

export const PickupResponseSchema = z.object({
  pickupId: z.string().nullable(),
  ok: z.boolean(),
  remark: z.string().nullable(),
})

/**
 * NDR action. The refinements enforce Delhivery's own per-action requirements
 * up front rather than paying for a rejected async call: `DEFER_DLV` needs a
 * date, `EDIT_DETAILS` needs at least one field to actually edit.
 */
export const NdrActionBodySchema = z
  .object({
    act: z.enum(['DEFER_DLV', 'EDIT_DETAILS', 'RE-ATTEMPT']),
    deferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'deferredDate must be YYYY-MM-DD')
      .optional(),
    name: z.string().trim().min(1).max(120).optional(),
    phone: z
      .string()
      .regex(/^[6-9]\d{9}$/, 'phone must be a 10-digit Indian mobile number')
      .optional(),
    address: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((body) => body.act !== 'DEFER_DLV' || body.deferredDate !== undefined, {
    message: 'deferredDate is required for DEFER_DLV',
    path: ['deferredDate'],
  })
  .refine(
    (body) =>
      body.act !== 'EDIT_DETAILS' ||
      body.name !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined,
    { message: 'EDIT_DETAILS needs at least one of name, phone or address', path: ['act'] }
  )

export const NdrActionResponseSchema = z.object({
  id: z.uuid(),
  act: z.enum(['DEFER_DLV', 'EDIT_DETAILS', 'RE-ATTEMPT']),
  uplId: z.string().nullable(),
  uplStatus: z.enum(['requested', 'accepted', 'rejected', 'unknown']),
  remark: z.string().nullable(),
})

/**
 * The carrier's packing slip, passed through as-is. `packingSlip` is
 * deliberately unshaped: Delhivery returns JSON and the warehouse decides what
 * to print from it, so narrowing it here would be guessing.
 */
export const LabelResponseSchema = z.object({
  ok: z.boolean(),
  awb: z.string(),
  packingSlip: z.unknown(),
})

export const CancelShipmentResponseSchema = z.object({
  ok: z.boolean(),
  status: FulfilmentStatusSchema,
  remark: z.string().nullable(),
})

// ── Manual fulfilment (docs/SPEC-MANUAL-FULFILMENT.md §4B) ─────────────────

/** Response shared by `.../ack`, `.../dispatch`, `.../status` — the updated shipment. */
export const ManualShipmentResponseSchema = z.object({
  ok: z.boolean(),
  shipment: AdminShipmentSchema,
})

export const ManualDispatchBodySchema = z
  .object({
    courierName: z.string().trim().min(1).max(120),
    awb: z.string().trim().min(1).max(64).optional(),
    trackingUrl: z.url().max(500).optional(),
    weightG: z.int().min(1).max(50_000).optional(),
  })
  .strict()

export const ManualStatusBodySchema = z
  .object({
    status: FulfilmentStatusSchema,
    note: z.string().trim().max(500).optional(),
    location: z.string().trim().max(120).optional(),
    /** Defaults to now() at the service layer when omitted. */
    occurredAt: z.iso.datetime().optional(),
  })
  .strict()

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type FulfilmentStatusContract = z.infer<typeof FulfilmentStatusSchema>
export type Tracking = z.infer<typeof TrackingSchema>
export type TrackingEvent = z.infer<typeof TrackingEventSchema>
export type AdminShipment = z.infer<typeof AdminShipmentSchema>
export type DirectIntracityOrder = z.infer<typeof DirectIntracityOrderSchema>
export type SweepResult = z.infer<typeof SweepResultSchema>
export type NdrActionBody = z.infer<typeof NdrActionBodySchema>
export type PickupBody = z.infer<typeof PickupBodySchema>
export type ManualDispatchBody = z.infer<typeof ManualDispatchBodySchema>
export type ManualStatusBody = z.infer<typeof ManualStatusBodySchema>
