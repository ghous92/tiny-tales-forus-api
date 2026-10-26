/**
 * Shipping admin HTTP layer, mounted at `/v1/admin/shipping` by app.ts. Every
 * route is `authenticate` then `requireAdmin`, mirroring routes/catalogAdmin.ts
 * and routes/coupons.ts.
 *
 * The simulator (`POST /simulate`) deliberately stays in routes/shipping.ts
 * beside the public quote endpoints, because it shares their loading path and
 * is the read half of the same feature. This module is the write half.
 *
 * No cost arithmetic happens here — the handlers hand DTOs to
 * services/shippingAdmin.ts, which is the only other file besides the engine
 * allowed to name a rate-formula field. test/arch/shipping-containment.test.ts
 * enforces that.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ShippingSimulateBodySchema,
  ShippingSimulateSchema,
  type ShippingSimulateCandidate,
} from '../contracts/shipping.js'
import {
  CourierCodeParamsSchema,
  CourierCreateSchema,
  CourierListSchema,
  CourierSchema,
  CourierUpdateSchema,
  ErrorEnvelopeSchema,
  ExceptionsImportSchema,
  ForwardGeocodeBodySchema,
  ForwardGeocodeResultSchema,
  ImportResultSchema,
  NodeCodeParamsSchema,
  PickupNodeCreateSchema,
  PickupNodeListSchema,
  PickupNodeSchema,
  PickupNodeUpdateSchema,
  PincodesImportSchema,
  ServiceAreasReplaceSchema,
  SlabsReplaceSchema,
} from '../contracts/shippingAdmin.js'
import type { Db } from '../db/client.js'
import { notFound } from '../lib/errors.js'
import {
  deadWeightG,
  freeTierFor,
  qualifiesForFreeShipping,
  shopperFeeInr,
  selectShipment,
  type ShippingLine,
} from '../lib/shipping.js'
import { forwardGeocode } from '../services/geocode.js'
import { diagnoseShippingConfig, loadShippingContext } from '../services/shipping.js'
import {
  createCourier,
  createPickupNode,
  deleteCourier,
  deletePickupNode,
  getCourier,
  importPincodes,
  importServiceExceptions,
  listCouriers,
  listPickupNodes,
  replaceServiceAreas,
  replaceSlabs,
  shippingReadiness,
  updateCourier,
  updatePickupNode,
} from '../services/shippingAdmin.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const ReadinessSchema = z.object({
  ready: z.boolean(),
  problems: z.array(z.string()),
})

export interface ShippingAdminRoutesOptions {
  db: Db
  /** `env.GOOGLE_MAPS_SERVER_KEY`. Absent → forward geocode answers 503, same as reverse. */
  mapsApiKey?: string | undefined
}

export const shippingAdminRoutes: FastifyPluginAsyncZod<ShippingAdminRoutesOptions> = async (
  app,
  { db, mapsApiKey }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  // --- Simulator ------------------------------------------------------------

  /**
   * The instrument the rate card cannot be validated without.
   *
   * For a parcel of this weight to this pincode: what does each courier cost
   * us, what would we charge, and what is the gap? A slab table that loses ₹80
   * on every 5 kg parcel looks identical to a profitable one until something
   * computes that subtraction — which is why this shipped in Phase 1, before
   * any of the CRUD below it.
   */
  app.post(
    '/simulate',
    {
      schema: {
        body: ShippingSimulateBodySchema,
        response: { 200: ShippingSimulateSchema, ...errorResponses },
      },
    },
    async (request) => {
      const body = request.body
      const context = await loadShippingContext(db, body.destPincode)
      const { rule } = context
      // Uncached and separate from the cart's rule on purpose: the operator is
      // asking "why is this not pricing", and a 60-second-stale answer to that
      // question is worse than no answer.
      const { configError } = await diagnoseShippingConfig(db)

      const lines: ShippingLine[] = [
        {
          sku: '__simulated__',
          qty: 1,
          weightG: body.weightG,
          lengthCm: body.lengthCm ?? 0,
          widthCm: body.widthCm ?? 0,
          heightCm: body.heightCm ?? 0,
        },
      ]

      const shipment = selectShipment({
        lines,
        destPincode: body.destPincode,
        nodes: context.nodes,
        couriers: context.couriers,
        pincodeIndex: context.pincodeIndex,
        rule,
        declaredValueInr: body.cartValueInr,
        isCod: body.isCod ?? false,
      })

      const winner = shipment.winner
      const tier = winner ? freeTierFor(rule.freeAboveTiers, winner.chargeableWeightG) : null
      const freeApplied = qualifiesForFreeShipping(body.cartValueInr, tier)

      const candidates: ShippingSimulateCandidate[] = shipment.candidates.map((candidate) => {
        // Margin on, promotional discount off — the same number the cart quotes.
        const fee = shopperFeeInr(candidate.trueCostInr, rule)
        return {
          estimated: candidate.estimated,
          nodeCode: candidate.nodeCode,
          courierCode: candidate.courierCode,
          courierLabel: candidate.courierName,
          zone: candidate.zone,
          chargeableWeightG: candidate.chargeableWeightG,
          trueCostInr: candidate.trueCostInr,
          customerFeeInr: fee,
          marginInr: fee - candidate.trueCostInr,
          slaDays: candidate.slaDays,
          distanceKm: candidate.distanceKm,
          chosen: candidate === winner,
        }
      })

      const winningFee = candidates.find((candidate) => candidate.chosen)?.customerFeeInr ?? 0

      return {
        destPincode: body.destPincode,
        deadWeightG: deadWeightG(lines, rule.tareG),
        serviceable: winner !== null,
        reason: winner ? null : (shipment.reason ?? 'not_serviceable'),
        freeAboveInr: tier?.freeAboveInr ?? 0,
        freeApplied,
        feeInr: freeApplied ? 0 : winningFee,
        candidates,
        configError,
      }
    }
  )

  // --- Readiness ------------------------------------------------------------

  /**
   * Everything that must exist before `shipping.enabled` can be turned on
   * without immediately refusing every cart. The admin UI blocks the toggle on
   * this; it is advisory to the API itself, because the engine is already
   * fail-closed and would simply report `not_serviceable`.
   */
  app.get(
    '/readiness',
    { schema: { response: { 200: ReadinessSchema, ...errorResponses } } },
    async () => shippingReadiness(db)
  )

  // --- Pickup nodes ---------------------------------------------------------

  app.get(
    '/nodes',
    { schema: { response: { 200: PickupNodeListSchema, ...errorResponses } } },
    async () => ({ nodes: await listPickupNodes(db) })
  )

  app.post(
    '/nodes',
    {
      schema: {
        body: PickupNodeCreateSchema,
        response: { 201: PickupNodeSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await createPickupNode(db, request.body))
  )

  app.put(
    '/nodes/:code',
    {
      schema: {
        params: NodeCodeParamsSchema,
        body: PickupNodeUpdateSchema,
        response: { 200: PickupNodeSchema, ...errorResponses },
      },
    },
    async (request) => updatePickupNode(db, request.params.code, request.body)
  )

  app.delete(
    '/nodes/:code',
    {
      schema: { params: NodeCodeParamsSchema, response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      await deletePickupNode(db, request.params.code)
      return reply.code(204).send(null)
    }
  )

  // --- Couriers -------------------------------------------------------------

  app.get(
    '/couriers',
    { schema: { response: { 200: CourierListSchema, ...errorResponses } } },
    async () => ({ couriers: await listCouriers(db) })
  )

  app.post(
    '/couriers',
    { schema: { body: CourierCreateSchema, response: { 201: CourierSchema, ...errorResponses } } },
    async (request, reply) => reply.code(201).send(await createCourier(db, request.body))
  )

  app.get(
    '/couriers/:code',
    {
      schema: {
        params: CourierCodeParamsSchema,
        response: { 200: CourierSchema, ...errorResponses },
      },
    },
    async (request) => getCourier(db, request.params.code)
  )

  app.put(
    '/couriers/:code',
    {
      schema: {
        params: CourierCodeParamsSchema,
        body: CourierUpdateSchema,
        response: { 200: CourierSchema, ...errorResponses },
      },
    },
    async (request) => updateCourier(db, request.params.code, request.body)
  )

  app.delete(
    '/couriers/:code',
    {
      schema: { params: CourierCodeParamsSchema, response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      await deleteCourier(db, request.params.code)
      return reply.code(204).send(null)
    }
  )

  /** Replace, never patch — see contracts/shippingAdmin.ts for why. */
  app.put(
    '/couriers/:code/slabs',
    {
      schema: {
        params: CourierCodeParamsSchema,
        body: SlabsReplaceSchema,
        response: { 200: CourierSchema, ...errorResponses },
      },
    },
    async (request) => replaceSlabs(db, request.params.code, request.body.slabs)
  )

  app.put(
    '/couriers/:code/service-areas',
    {
      schema: {
        params: CourierCodeParamsSchema,
        body: ServiceAreasReplaceSchema,
        response: { 200: CourierSchema, ...errorResponses },
      },
    },
    async (request) => replaceServiceAreas(db, request.params.code, request.body)
  )

  app.post(
    '/couriers/:code/exceptions',
    {
      schema: {
        params: CourierCodeParamsSchema,
        body: ExceptionsImportSchema,
        response: { 200: ImportResultSchema, ...errorResponses },
      },
    },
    async (request) =>
      importServiceExceptions(db, request.params.code, request.body.csv, request.body.replace)
  )

  // --- Pincode reference data ----------------------------------------------

  app.post(
    '/pincodes/import',
    {
      schema: {
        body: PincodesImportSchema,
        response: { 200: ImportResultSchema, ...errorResponses },
      },
    },
    async (request) => importPincodes(db, request.body.csv)
  )

  // --- Forward geocode ------------------------------------------------------

  /**
   * Address text → coordinate, for placing a pickup node.
   *
   * ADMIN-ONLY, unlike `GET /v1/geocode/reverse`. Reverse geocoding needs a
   * coordinate the caller already possesses; forward geocoding turns arbitrary
   * strings into coordinates, which is a general-purpose lookup service running
   * on our Google quota. There is exactly one legitimate caller and it is
   * behind an admin login.
   *
   * The result is NEVER saved from here. The operator sees the point, checks
   * it, and saves the node — a silently-geocoded origin mis-prices every order
   * from that node and gives no sign it has done so.
   */
  app.post(
    '/geocode/forward',
    {
      schema: {
        body: ForwardGeocodeBodySchema,
        response: { 200: ForwardGeocodeResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      // A missing Maps key throws 503 `geocoding_disabled` from inside the
      // service (same as reverse); a null return means Google had no answer,
      // which is a 404 about the address, not an outage.
      const result = await forwardGeocode(request.body.address, { apiKey: mapsApiKey })
      if (!result) throw notFound('No coordinates found for that address')
      return result
    }
  )
}
