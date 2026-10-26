/**
 * /v1/admin/fulfilment — the ops write surface (docs/SPEC-LOGISTICS.md §6.3).
 * Every route is `authenticate` then `requireAdmin`, mirroring
 * routes/shippingAdmin.ts.
 *
 * This layer owns the cross-module wiring the service is forbidden to do
 * (ARCHITECTURE.md rule 2): it resolves the carrier credentials from `env` into
 * a {@link CarrierAdapter}, reads the fulfilment rule through the config
 * service, and — the important one — builds each manifest out of the ORDER'S
 * OWN FROZEN SNAPSHOTS by reading `payments` here rather than letting
 * `services/fulfilment.ts` reach into another module's tables.
 *
 * Unconfigured carrier (no token / no base URL) ⇒ 503 on every route that would
 * have called out, exactly as payments answered before Razorpay keys existed.
 * A deploy without carrier secrets is safe and inert.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import {
  AdminShipmentListQuerySchema,
  AdminShipmentListSchema,
  CancelShipmentResponseSchema,
  DirectIntracityOrderListQuerySchema,
  DirectIntracityOrderListSchema,
  ErrorEnvelopeSchema,
  ManualDispatchBodySchema,
  ManualShipmentResponseSchema,
  ManualStatusBodySchema,
  NdrActionBodySchema,
  NdrActionResponseSchema,
  PickupBodySchema,
  PickupResponseSchema,
  LabelResponseSchema,
  ShipmentParamsSchema,
  SweepResultSchema,
  type AdminShipment,
} from '../contracts/fulfilment.js'
import type { Db } from '../db/client.js'
import { payments, pincodes, shipments } from '../db/schema.js'
import type { CarrierAdapter } from '../lib/delhivery.js'
import type { CarrierTracker } from '../lib/shreeMaruti.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import type { ReplenishmentTaskEnqueuer } from '../lib/replenishmentTask.js'
import { conflict, fulfilmentDisabled, notFound, validationFailed } from '../lib/errors.js'
import { isNdrAct, type FulfilmentStatus } from '../lib/fulfilmentStatus.js'
import {
  acknowledgeShipment,
  applyManualStatus,
  cancelShipment,
  getShipmentById,
  istDate,
  listShipments,
  manifestPending,
  reconcileStale,
  recordManualDispatch,
  requestNdrAction,
  type FulfilmentRule,
  type ManifestSource,
  type ManifestSourceResolver,
} from '../services/fulfilment.js'
import type { ShipmentRow } from '../db/schema.js'
import { reactToShipmentMilestone } from './customerNotifications.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/**
 * Ahmedabad-metro intracity pilot districts (india-post naming, as stored in
 * `pincodes.district` by `scripts/import-pincodes.ts`). Matched case-insensitively
 * — the source data is not guaranteed consistently cased.
 */
const INTRACITY_DISTRICTS = ['ahmedabad', 'gandhinagar']

export interface FulfilmentAdminRoutesOptions {
  db: Db
  /** Absent ⇒ every carrier-calling route answers 503. */
  adapter?: CarrierAdapter | undefined
  /** Track-only carriers keyed by `shipments.courier_code`; see `reconcileStale`. */
  trackers?: Readonly<Record<string, CarrierTracker>> | undefined
  /** Resolved per-request from `app_config` by the injected loader. */
  loadRule: (db: Db) => Promise<FulfilmentRule>
  /** Seller GST TIN, when one exists. See the note on `manifestSourceFor`. */
  sellerGstTin?: string | undefined
  hsnCode?: string | undefined
  /** Lets a delivery found by the reconcile poll schedule the refill and review follow-ups. */
  replenishmentTasks?: ReplenishmentTaskEnqueuer | undefined
  /** Present ⇒ milestone messages found by reconcile are sent now, not at the daily sweep. */
  channels?: NotificationChannelRegistry | undefined
}

function toDto(row: ShipmentRow): AdminShipment {
  return {
    id: row.id,
    orderId: row.orderId,
    courierCode: row.courierCode,
    awb: row.awb,
    status: row.status as FulfilmentStatus,
    statusDetail: row.statusDetail,
    nslCode: row.nslCode,
    pickupId: row.pickupId,
    manifestError: row.manifestError,
    manifestAttempts: row.manifestAttempts,
    deliveryAttempts: row.deliveryAttempts,
    ndrReason: row.ndrReason,
    lastScanAt: row.lastScanAt?.toISOString() ?? null,
    manifestedAt: row.manifestedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    manualCourierName: row.manualCourierName,
    manualTrackingUrl: row.manualTrackingUrl,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    opsNote: row.opsNote,
  }
}

interface AddressSnapshot {
  name?: unknown
  phone?: unknown
  houseNumber?: unknown
  roadArea?: unknown
  landmark?: unknown
  city?: unknown
  state?: unknown
  pincode?: unknown
}

interface CartSnapshot {
  items?: Array<{ sku?: unknown; qty?: unknown; name?: unknown; priceInr?: unknown }>
  totalInr?: unknown
  goodsInr?: unknown
}

interface ShippingSnapshot {
  chargeableWeightG?: unknown
  parcel?: { lengthCm?: unknown; widthCm?: unknown; heightCm?: unknown }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Build the manifest inputs from the frozen order snapshots.
 *
 * **Reads the snapshots, never the live rows.** `addresses` and `catalog_items`
 * both move — an address edited after checkout or a renamed SKU must not change
 * the parcel we ship, for the same reason `invoices.document` is a complete
 * denormalised copy rather than a view.
 *
 * Returns null when the order cannot produce a shippable parcel, which the
 * sweep records as a non-retryable-ish failure rather than calling the carrier
 * with a half-built payload.
 */
export function manifestSourceFor(
  addressSnapshot: unknown,
  cartSnapshot: unknown,
  shippingSnapshot: unknown,
  extras: {
    sellerGstTin?: string | undefined
    hsnCode?: string | undefined
  }
): ManifestSource | null {
  const address = (addressSnapshot ?? {}) as AddressSnapshot
  const cart = (cartSnapshot ?? {}) as CartSnapshot
  const shipping = (shippingSnapshot ?? {}) as ShippingSnapshot

  const pincode = text(address.pincode)
  const phoneRaw = text(address.phone)
  // Phones are stored E.164 (+91…) and Delhivery wants the bare 10 digits.
  const phone = phoneRaw.replace(/^\+91/, '').replace(/\D/g, '')
  const line = [text(address.houseNumber), text(address.roadArea), text(address.landmark)]
    .filter((part) => part !== '')
    .join(', ')

  if (pincode === '' || phone.length !== 10 || line === '') return null

  const items = Array.isArray(cart.items) ? cart.items : []
  if (items.length === 0) return null

  const unitCount = items.reduce((sum, item) => sum + num(item.qty), 0)
  const description = items
    .map((item) => {
      const label = text(item.name) !== '' ? text(item.name) : text(item.sku)
      const qty = num(item.qty)
      return label === '' ? '' : qty > 1 ? `${label} x${qty}` : label
    })
    .filter((part) => part !== '')
    .join(', ')

  // `goodsInr` is the post-2026 cart snapshot shape; older rows only carry
  // `totalInr` (SPEC-SHIPPING §4.9). Declared value must never read as 0.
  const declared = num(cart.goodsInr) > 0 ? num(cart.goodsInr) : num(cart.totalInr)
  if (declared <= 0 || unitCount <= 0) return null

  // All three or none: a partial dim (e.g. length only) is worse than no dims
  // at all — Delhivery would read the missing two as literal zero centimetres.
  const lengthCm = num(shipping.parcel?.lengthCm)
  const widthCm = num(shipping.parcel?.widthCm)
  const heightCm = num(shipping.parcel?.heightCm)
  const hasDims = lengthCm > 0 && widthCm > 0 && heightCm > 0

  return {
    consigneeName: text(address.name) !== '' ? text(address.name) : 'Customer',
    consigneePhone: phone,
    address: line,
    city: text(address.city),
    state: text(address.state),
    pincode,
    declaredValueInr: Math.round(declared),
    weightG: num(shipping.chargeableWeightG),
    ...(hasDims ? { lengthCm, widthCm, heightCm } : {}),
    productDescription: description !== '' ? description : 'Personal care products',
    // Delhivery's `quantity` is the PACKAGE count, not the unit count — it bills
    // freight per package. Every order ships as one box, so this is always 1;
    // unit counts live in `products_desc` instead.
    quantity: 1,
    // Liquids. Declared on every parcel because the whole catalog is liquid —
    // FEASIBILITY-LOGISTICS §1.1 treats leakage as a carrier-level risk, not a
    // per-order judgement call.
    fragile: true,
    ...(extras.sellerGstTin !== undefined ? { sellerGstTin: extras.sellerGstTin } : {}),
    ...(extras.hsnCode !== undefined ? { hsnCode: extras.hsnCode } : {}),
    // Every order is prepaid: nothing is ever collected at the door.
    codAmountInr: 0,
  }
}

/**
 * The `ManifestSourceResolver` every manifest sweep runs on — the admin button
 * and the scheduled one (`routes/internalSweeps.ts`) alike.
 *
 * Extracted so there is exactly ONE definition of "which orders may be handed
 * to a carrier, built from what". A second copy in the internal route would be
 * a copy of the `status !== 'paid'` guard, which is the single check standing
 * between a stale row and a real parcel.
 */
export function makeManifestSourceResolver(
  db: Db,
  extras: { sellerGstTin?: string | undefined; hsnCode?: string | undefined }
): ManifestSourceResolver {
  return async (orderId) => {
    const found = await db
      .select({
        addressSnapshot: payments.addressSnapshot,
        cartSnapshot: payments.cartSnapshot,
        shippingSnapshot: payments.shippingSnapshot,
        status: payments.status,
      })
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1)
    const order = found[0]
    // Only a paid order ships. Anything else is a bug upstream and must
    // not be handed to a carrier on the strength of a stale row.
    if (order === undefined || order.status !== 'paid') return null
    return manifestSourceFor(
      order.addressSnapshot,
      order.cartSnapshot,
      order.shippingSnapshot,
      extras
    )
  }
}

export const fulfilmentAdminRoutes: FastifyPluginAsyncZod<FulfilmentAdminRoutesOptions> = async (
  app,
  { db, adapter, trackers, loadRule, sellerGstTin, hsnCode, replenishmentTasks, channels }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  /** 503 rather than 500: an unconfigured carrier is a deploy state, not a fault. */
  function requireCarrier(): CarrierAdapter {
    if (adapter === undefined) {
      throw fulfilmentDisabled(
        'Carrier is not configured (DELHIVERY_API_TOKEN / DELHIVERY_BASE_URL)'
      )
    }
    return adapter
  }

  app.get(
    '/shipments',
    {
      schema: {
        querystring: AdminShipmentListQuerySchema,
        response: { 200: AdminShipmentListSchema, ...errorResponses },
      },
    },
    async (request) => {
      const rows = await listShipments(db, {
        status: request.query.status as FulfilmentStatus | undefined,
        limit: request.query.limit,
        offset: request.query.offset,
      })
      return { shipments: rows.map(toDto) }
    }
  )

  /**
   * Ahmedabad + Gandhinagar intracity pilot list. Joins live here, not in the
   * fulfilment service, for the same reason `manifestSourceFor` does
   * (ARCHITECTURE.md rule 2): the destination pincode only exists on the
   * order's `payments.addressSnapshot`, and `services/fulfilment.ts` may
   * never read `payments`.
   */
  app.get(
    '/direct-intracity-orders/list',
    {
      schema: {
        querystring: DirectIntracityOrderListQuerySchema,
        response: { 200: DirectIntracityOrderListSchema, ...errorResponses },
      },
    },
    async (request) => {
      const destPincode = sql<string>`${payments.addressSnapshot} ->> 'pincode'`
      const rows = await db
        .select({
          shipment: shipments,
          pincode: destPincode,
          city: sql<string>`${payments.addressSnapshot} ->> 'city'`,
          district: pincodes.district,
        })
        .from(shipments)
        .innerJoin(payments, eq(shipments.orderId, payments.orderId))
        .innerJoin(pincodes, eq(pincodes.pincode, destPincode))
        .where(
          and(
            inArray(sql`lower(${pincodes.district})`, INTRACITY_DISTRICTS),
            request.query.status !== undefined
              ? eq(shipments.status, request.query.status)
              : undefined
          )
        )
        .orderBy(desc(shipments.createdAt))
        .limit(request.query.limit)
        .offset(request.query.offset)

      return {
        orders: rows.map((row) => ({
          ...toDto(row.shipment),
          pincode: row.pincode,
          city: row.city,
          district: row.district,
        })),
      }
    }
  )

  /**
   * Manifest everything waiting (§6.2). Idempotent and safe to call on a
   * schedule: it only ever picks up `pending_manifest` rows under the attempt
   * cap, and a row that succeeds leaves that set immediately.
   */
  app.post(
    '/manifest',
    { schema: { response: { 200: SweepResultSchema, ...errorResponses } } },
    async (request) => {
      const carrier = requireCarrier()
      const rule = await loadRule(db)
      if (!rule.enabled) throw fulfilmentDisabled('Fulfilment is disabled (fulfilment.enabled)')
      if (rule.pickupLocationName === '') {
        throw conflict(
          'fulfilment.pickupLocationName is empty; the carrier will reject every manifest'
        )
      }

      const outcome = await manifestPending(
        db,
        carrier,
        rule,
        makeManifestSourceResolver(db, { sellerGstTin, hsnCode })
      )

      if (outcome.failed > 0) {
        request.log.warn({ outcome }, 'manifest sweep had failures')
      }
      return outcome
    }
  )

  /** Pull tracking for shipments the webhook has gone quiet on (§5.2). */
  app.post(
    '/reconcile',
    { schema: { response: { 200: SweepResultSchema, ...errorResponses } } },
    async (request) => {
      const carrier = requireCarrier()
      const rule = await loadRule(db)
      if (!rule.enabled) throw fulfilmentDisabled('Fulfilment is disabled (fulfilment.enabled)')
      return reconcileStale(
        db,
        carrier,
        rule,
        new Date(),
        async (result) => {
          try {
            await reactToShipmentMilestone(db, {
              orderId: result.orderId!,
              status: result.status,
              awb: result.awb,
              courierCode: result.courierCode,
              log: request.log,
              ...(replenishmentTasks ? { replenishmentTasks } : {}),
              ...(channels ? { channels } : {}),
            })
          } catch (err) {
            request.log.error(
              { err, orderId: result.orderId },
              'customer milestone notification failed'
            )
          }
        },
        trackers
      )
    }
  )

  app.post(
    '/shipments/:id/pickup',
    {
      schema: {
        params: ShipmentParamsSchema,
        body: PickupBodySchema,
        response: { 200: PickupResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const carrier = requireCarrier()
      const rule = await loadRule(db)
      const shipment = await getShipmentById(db, request.params.id)
      if (shipment === null) throw notFound('Shipment not found')
      if (shipment.awb === null) throw conflict('Shipment has not been manifested yet')

      const result = await carrier.createPickup({
        pickupLocationName: rule.pickupLocationName,
        // IST, because the carrier's cut-off is an IST wall-clock time and a
        // UTC date rolls over five and a half hours early.
        pickupDate: request.body.pickupDate ?? istDate(new Date()),
        pickupTime: request.body.pickupTime ?? '14:00:00',
        expectedPackageCount: request.body.expectedPackageCount ?? 1,
      })

      if (result.ok && result.pickupId !== undefined) {
        await db
          .update(shipments)
          .set({ pickupId: result.pickupId, updatedAt: sql`now()` })
          .where(eq(shipments.id, shipment.id))
      }
      return {
        pickupId: result.pickupId ?? null,
        ok: result.ok,
        remark: result.remark ?? null,
      }
    }
  )

  /**
   * The packing slip. Delhivery returns JSON, not a PDF — rendering is ours to
   * do, so this hands the operator the carrier's payload rather than pretending
   * to produce a label. Passed through verbatim: a label is a legal-ish document
   * and reshaping it here would be guessing at what the warehouse needs printed.
   */
  app.get(
    '/shipments/:id/label',
    {
      schema: {
        params: ShipmentParamsSchema,
        response: { 200: LabelResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const carrier = requireCarrier()
      const shipment = await getShipmentById(db, request.params.id)
      if (shipment === null) throw notFound('Shipment not found')
      if (shipment.awb === null) throw conflict('Shipment has not been manifested yet')

      const result = await carrier.label(shipment.awb)
      return { ok: result.ok, awb: shipment.awb, packingSlip: result.raw ?? null }
    }
  )

  app.post(
    '/shipments/:id/cancel',
    {
      schema: {
        params: ShipmentParamsSchema,
        response: { 200: CancelShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const carrier = requireCarrier()
      const shipment = await getShipmentById(db, request.params.id)
      if (shipment === null) throw notFound('Shipment not found')
      // Cancelling a shipment does NOT refund the shopper — that is a payments
      // decision (SPEC-LOGISTICS §1.1) and deliberately stays a separate act.
      return cancelShipment(db, carrier, shipment)
    }
  )

  app.post(
    '/shipments/:id/ndr',
    {
      schema: {
        params: ShipmentParamsSchema,
        body: NdrActionBodySchema,
        response: { 200: NdrActionResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const carrier = requireCarrier()
      const shipment = await getShipmentById(db, request.params.id)
      if (shipment === null) throw notFound('Shipment not found')
      if (shipment.awb === null) throw conflict('Shipment has not been manifested yet')
      if (!isNdrAct(request.body.act)) throw validationFailed('Unsupported NDR action')

      const row = await requestNdrAction(
        db,
        carrier,
        shipment,
        {
          act: request.body.act,
          deferredDate: request.body.deferredDate,
          name: request.body.name,
          phone: request.body.phone,
          address: request.body.address,
        },
        request.user.id
      )

      return {
        id: row.id,
        act: row.act as 'DEFER_DLV' | 'EDIT_DETAILS' | 'RE-ATTEMPT',
        uplId: row.uplId,
        uplStatus: row.uplStatus as 'requested' | 'accepted' | 'rejected' | 'unknown',
        remark: row.lastError,
      }
    }
  )

  // ── Manual fulfilment (docs/SPEC-MANUAL-FULFILMENT.md §4B) ────────────────
  // No `requireCarrier()` on any of these three — that is the entire point of
  // manual mode: an operator drives a parcel to `delivered` with no Delhivery
  // token configured at all.

  /** "A human has seen this." Idempotent — a second ack is a no-op on the timestamp. */
  app.post(
    '/shipments/:id/ack',
    {
      schema: {
        params: ShipmentParamsSchema,
        response: { 200: ManualShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const shipment = await getShipmentById(db, request.params.id)
      if (shipment === null) throw notFound('Shipment not found')
      const updated = await acknowledgeShipment(db, shipment.id, request.user.id)
      return { ok: true, shipment: toDto(updated ?? shipment) }
    }
  )

  /**
   * Record who is physically carrying the parcel, then fold a manual
   * `manifested` event through the same fold every carrier scan uses. A
   * duplicate AWB answers 409, not a raw constraint violation (§4B trap #2).
   */
  app.post(
    '/shipments/:id/dispatch',
    {
      schema: {
        params: ShipmentParamsSchema,
        body: ManualDispatchBodySchema,
        response: { 200: ManualShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const result = await recordManualDispatch(db, request.params.id, {
        courierName: request.body.courierName,
        awb: request.body.awb,
        trackingUrl: request.body.trackingUrl,
        weightG: request.body.weightG,
        actorId: request.user.id,
      })
      if (result === null) throw notFound('Shipment not found')
      return { ok: true, shipment: toDto(result.shipment) }
    }
  )

  /**
   * Advance (or correct) the shipment's status by hand. Validated against the
   * SAME canonical `FulfilmentStatusSchema` every carrier scan is, folded
   * through the SAME out-of-order-safe rule — no parallel status path.
   */
  app.post(
    '/shipments/:id/status',
    {
      schema: {
        params: ShipmentParamsSchema,
        body: ManualStatusBodySchema,
        response: { 200: ManualShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const result = await applyManualStatus(db, request.params.id, {
        status: request.body.status,
        note: request.body.note,
        location: request.body.location,
        occurredAt: request.body.occurredAt ? new Date(request.body.occurredAt) : undefined,
        actorId: request.user.id,
      })
      if (result === null) throw notFound('Shipment not found')
      if (
        result.advanced &&
        (result.shipment.status === 'out_for_delivery' || result.shipment.status === 'delivered')
      ) {
        await reactToShipmentMilestone(db, {
          orderId: result.shipment.orderId,
          status: result.shipment.status,
          awb: result.shipment.awb,
          courierCode: result.shipment.courierCode,
          log: request.log,
        }).catch((err: unknown) => {
          request.log.error(
            { err, orderId: result.shipment.orderId },
            'customer milestone notification failed'
          )
        })
      }
      return { ok: true, shipment: toDto(result.shipment) }
    }
  )
}
