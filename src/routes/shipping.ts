/**
 * /v1/shipping — the public delivery and COD-preview surfaces.
 *
 * These are unauthenticated on purpose: "do you deliver to my pincode, and what
 * will it cost?" is a question a shopper asks BEFORE committing to anything,
 * and answering it late is what makes a delivery fee feel like an ambush. Two
 * consequences follow, and both are enforced here:
 *
 * 1. **Rate limiting.** The repo has no global limiter — `routes/geocode.ts`
 *    and `routes/clientErrors.ts` each run their own per-route bucket, and this
 *    file follows that pattern rather than inventing a shared one.
 * 2. **No client-supplied weight.** `GET /quote` takes a sku and a quantity,
 *    never a weight. Accepting a weight would let anyone quote a 1 g parcel and
 *    then point at the number the API returned.
 *
 * The admin simulator lives in `routes/shippingAdmin.ts` with the rest of the
 * admin surface.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  CodPreviewQuerySchema,
  CodPreviewSchema,
  ServiceabilityQuerySchema,
  ServiceabilitySchema,
  ShippingQuoteQuerySchema,
  ShippingQuoteSchema,
} from '../contracts/shipping.js'
import type { Db } from '../db/client.js'
import { COD_UNAVAILABLE, evaluateCod, evaluateCodBeforeDestination } from '../lib/cod.js'
import { notFound } from '../lib/errors.js'
import { estimatedDeliveryDate, selectShipment, type ShippingLine } from '../lib/shipping.js'
import { getItemBySku } from '../services/catalog.js'
import { countCodOrdersThisMonth, loadCodConfig } from '../services/cod.js'
import { loadShippingContext, priceShipping } from '../services/shipping.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Sustained requests per IP per minute. A shopper typing one pincode uses a handful. */
const RATE_LIMIT_PER_MINUTE = 60
const RATE_WINDOW_MS = 60_000
/** Cap on tracked IPs, so the limiter itself cannot be turned into a memory leak. */
const RATE_MAX_IPS = 5_000

interface RateEntry {
  count: number
  windowStart: number
}

/**
 * Fixed-window per-IP counter, mirroring `routes/geocode.ts`. Process-local, so
 * with N Cloud Run instances the effective ceiling is N × the limit — fine,
 * this is an abuse brake on our own database, not a correctness control.
 */
const buckets = new Map<string, RateEntry>()

function rateLimited(ip: string, now: number): boolean {
  const entry = buckets.get(ip)
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (buckets.size >= RATE_MAX_IPS) {
      const oldest = buckets.keys().next()
      if (!oldest.done) buckets.delete(oldest.value)
    }
    buckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT_PER_MINUTE
}

/** Test seam — resets the limiter between cases. Never called in production. */
export function clearShippingRateLimits(): void {
  buckets.clear()
}

export interface ShippingRoutesOptions {
  db: Db
}

/** Mounted at '/v1/shipping' by app.ts. Public, rate-limited. */
export const shippingRoutes: FastifyPluginAsyncZod<ShippingRoutesOptions> = async (
  app,
  { db }
) => {
  app.get(
    '/serviceability',
    {
      schema: {
        querystring: ServiceabilityQuerySchema,
        response: { 200: ServiceabilitySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many lookups. Try again shortly.' },
        })
      }

      const { pincode } = request.query
      const context = await loadShippingContext(db, pincode)

      // A single nominal 500 g, small-carton parcel: enough to find a candidate
      // without pretending to know what the shopper will actually buy. Dims are
      // mandatory now (dims_unknown blocks quoting, no assume bypass), so the
      // probe needs a plausible nominal box, same as its nominal weight.
      const probe: ShippingLine[] = [
        { sku: '__probe__', qty: 1, weightG: 500, lengthCm: 10, widthCm: 8, heightCm: 6 },
      ]
      const shipment = selectShipment({
        lines: probe,
        destPincode: pincode,
        nodes: context.nodes,
        couriers: context.couriers,
        pincodeIndex: context.pincodeIndex,
        rule: context.rule,
        declaredValueInr: 0,
        isCod: false,
      })

      if (!context.rule.enabled) {
        return {
          pincode,
          serviceable: true,
          estimated: false,
          distanceKm: null,
          zone: null,
          etaDays: null,
          estimatedDeliveryDate: null,
          reason: 'disabled' as const,
        }
      }

      const winner = shipment.winner

      return {
        pincode,
        // This is sales coverage, not a promise of carrier-confirmed coverage.
        // Every validated Indian pincode is accepted; pricing may be estimated.
        serviceable: true,
        estimated: winner?.estimated ?? false,
        distanceKm: winner?.distanceKm ?? null,
        zone: winner?.zone ?? null,
        etaDays: winner?.slaDays ?? null,
        estimatedDeliveryDate: winner
          ? estimatedDeliveryDate(Date.now(), winner.nodeCutoffIst, winner.slaDays)
          : null,
        reason: winner ? null : (shipment.reason ?? 'not_serviceable'),
      }
    }
  )

  app.get(
    '/quote',
    {
      schema: {
        querystring: ShippingQuoteQuerySchema,
        response: { 200: ShippingQuoteSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many lookups. Try again shortly.' },
        })
      }

      const { sku, pincode } = request.query
      const qty = request.query.qty ?? 1

      // Weight comes from the catalog, never from the caller.
      const item = await getItemBySku(db, sku)
      if (!item) throw notFound(`Sku "${sku}" not found`)

      const context = await loadShippingContext(db, pincode)
      const { block } = priceShipping({
        context,
        destPincode: pincode,
        lines: [
          {
            sku: item.sku,
            qty,
            weightG: item.weightG,
            lengthCm: item.lengthCm,
            widthCm: item.widthCm,
            heightCm: item.heightCm,
          },
        ],
        // A PDP widget prices the parcel, not a cart, so there is no subtotal to
        // measure the free-delivery threshold against: `freeAboveInr` is
        // reported so the page can say "free above ₹249", but nothing is waived.
        preCouponInr: item.priceInr * qty,
        postCouponInr: item.priceInr * qty,
        cartUpdatedAt: '',
      })

      return {
        pincode,
        serviceable: block.reason === null,
        feeInr: block.wouldBeFeeInr,
        freeAboveInr: block.freeAboveInr,
        zone: block.zone,
        etaDays: block.etaDays,
        estimatedDeliveryDate: block.estimatedDeliveryDate,
        courierLabel: block.courierLabel,
        chargeableWeightG: block.chargeableWeightG,
        estimated: block.estimated,
        distanceKm: block.distanceKm,
        reason: block.reason,
      }
    }
  )

  app.get(
    '/cod-preview',
    {
      schema: {
        querystring: CodPreviewQuerySchema,
        response: { 200: CodPreviewSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many lookups. Try again shortly.' },
        })
      }

      const { sku, pincode } = request.query
      const qty = request.query.qty ?? 1
      const item = await getItemBySku(db, sku)
      if (!item) throw notFound(`Sku "${sku}" not found`)

      const config = await loadCodConfig(db)
      const goodsTotalInr = item.priceInr * qty
      if (!config.enabled) {
        return {
          ...COD_UNAVAILABLE('disabled'),
          pincodeRequired: false,
          totalInr: goodsTotalInr,
        }
      }

      const codOrdersThisMonth = await countCodOrdersThisMonth(db)

      if (!pincode) {
        const preview = evaluateCodBeforeDestination({
          config,
          cartTotalInr: goodsTotalInr,
          codOrdersThisMonth,
        })
        return {
          ...preview,
          pincodeRequired: preview.available,
          totalInr: goodsTotalInr,
        }
      }

      const context = await loadShippingContext(db, pincode)
      const { block } = priceShipping({
        context,
        destPincode: pincode,
        lines: [
          {
            sku: item.sku,
            qty,
            weightG: item.weightG,
            lengthCm: item.lengthCm,
            widthCm: item.widthCm,
            heightCm: item.heightCm,
          },
        ],
        preCouponInr: goodsTotalInr,
        postCouponInr: goodsTotalInr,
        cartUpdatedAt: '',
      })

      if (block.reason !== null) {
        return {
          available: false,
          pincodeRequired: false,
          tokenInr: 0,
          dueOnDeliveryInr: 0,
          totalInr: goodsTotalInr,
          reason: 'delivery_unavailable' as const,
        }
      }

      const totalInr = goodsTotalInr + block.feeInr
      const preview = evaluateCod({
        config,
        cartTotalInr: totalInr,
        destPincode: pincode,
        codOrdersThisMonth,
      })
      return { ...preview, pincodeRequired: false, totalInr }
    }
  )
}
