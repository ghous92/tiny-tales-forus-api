/**
 * /v1/stock — the PUBLIC availability surface. One route.
 *
 * Unauthenticated, like `/v1/shipping`: "can I get this?" is a question asked
 * before anyone commits to anything, and a shopper who has to sign in to find
 * out has already been told the wrong answer.
 *
 * Three protections follow from being public, and all three are here rather
 * than in the service, because they are properties of the EXPOSURE and not of
 * the cascade:
 *
 * 1. **Per-IP rate limiting**, mirroring `routes/shipping.ts` and
 *    `routes/geocode.ts` rather than inventing a shared limiter. Each request
 *    is four queries over a sku list the caller chooses.
 * 2. **A 50-sku cap**, enforced in the contract. Without it one request could
 *    ask for the whole catalog and the limiter would be measuring the wrong
 *    thing entirely.
 * 3. **The response is stripped.** `checkAvailability` returns the winning
 *    node, its distance and its count; this route forwards `sku`, `status` and
 *    `etaDays` and nothing else. The stripping happens HERE, at the boundary,
 *    so that adding a field to `CascadeResult` can never quietly publish it.
 *
 * ## Caching
 *
 * `private, max-age=60`, and deliberately NO ETag. Availability is
 * per-shopper — it varies by pincode — so a shared cache entry would serve one
 * shopper's answer to another. `private` keeps it in the browser and out of any
 * CDN. And an ETag keyed on stock would let a caller poll a cheap conditional
 * request to watch counts change, which is the inventory feed this endpoint
 * exists to not be.
 *
 * ## Fail OPEN
 *
 * If the cascade throws, this route answers `in_stock` rather than 500ing or
 * hiding the product — the opposite of shipping's fail-safe-to-OFF, and the
 * asymmetry is the point. Shipping failing open would quote ₹0 and we would eat
 * the freight; stock failing CLOSED would take the entire catalog dark on a bad
 * deploy, silently, with every product still on the shelf. A wrong "in stock"
 * at this order volume is one apologetic phone call. The error is logged at
 * error level so it is not silent to us, only to the shopper.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  AvailabilityRequestSchema,
  AvailabilityResponseSchema,
  type AvailabilityItem,
} from '../contracts/stock.js'
import type { Db } from '../db/client.js'
import { checkAvailability, PLACEHOLDER_ETA_DAYS } from '../services/stock.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Sustained requests per IP per minute. A shopper browsing uses a handful. */
const RATE_LIMIT_PER_MINUTE = 60
const RATE_WINDOW_MS = 60_000
/** Cap on tracked IPs, so the limiter itself cannot be turned into a memory leak. */
const RATE_MAX_IPS = 5_000

/** How long a browser may reuse an answer. Short: stock moves, and a stale "in stock" sells air. */
const CACHE_MAX_AGE_SECONDS = 60

interface RateEntry {
  count: number
  windowStart: number
}

/**
 * Fixed-window per-IP counter, mirroring `routes/shipping.ts`. Process-local,
 * so with N Cloud Run instances the effective ceiling is N × the limit — fine,
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
export function clearStockRateLimits(): void {
  buckets.clear()
}

export interface StockRoutesOptions {
  db: Db
}

/** Mounted at '/v1/stock' by app.ts. Public, rate-limited. */
export const stockRoutes: FastifyPluginAsyncZod<StockRoutesOptions> = async (app, { db }) => {
  app.post(
    '/availability',
    {
      schema: {
        body: AvailabilityRequestSchema,
        response: { 200: AvailabilityResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many lookups. Try again shortly.' },
        })
      }

      const { pincode, skus } = request.body
      reply.header('Cache-Control', `private, max-age=${CACHE_MAX_AGE_SECONDS}`)

      let items: AvailabilityItem[]
      try {
        const results = await checkAvailability(db, pincode, skus)
        // The strip. Everything the cascade knows about WHERE stops here.
        items = results.map((result) => ({
          sku: result.sku,
          status: result.status,
          etaDays: result.etaDays,
        }))
      } catch (error) {
        request.log.error(
          { err: error, pincode, skuCount: skus.length },
          'stock availability failed; failing open to in_stock'
        )
        items = skus.map((sku) => ({
          sku,
          status: 'in_stock' as const,
          etaDays: { ...PLACEHOLDER_ETA_DAYS },
        }))
      }

      return { items }
    }
  )
}
