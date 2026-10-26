/**
 * `GET /v1/geocode/reverse` — HTTP layer for the Google reverse-geocoding proxy.
 * Business rules and the cache live in `services/geocode.ts`; read that file's
 * header before touching anything here, it carries the privacy contract.
 *
 * DELIBERATELY UNAUTHENTICATED. The delivery-location map picker runs on the
 * home screen before sign-in, so requiring a token would break the guest flow
 * this endpoint exists to serve. The exposure that buys is quota drain, not
 * data leakage — the endpoint reveals nothing a public map doesn't — so it is
 * defended with the service-level cache plus the per-IP bucket below rather
 * than with auth.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/config.js'
import { ReverseGeocodeQuerySchema, ReverseGeocodeResultSchema } from '../contracts/geocode.js'
import { notFound } from '../lib/errors.js'
import { reverseGeocode } from '../services/geocode.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Sustained requests per IP per minute. A shopper panning the map debounces to a handful. */
const RATE_LIMIT_PER_MINUTE = 60
const RATE_WINDOW_MS = 60_000
/** Cap on tracked IPs, so the limiter itself can't be turned into a memory leak. */
const RATE_MAX_IPS = 5_000

interface RateEntry {
  count: number
  windowStart: number
}

/**
 * Fixed-window per-IP counter. Process-local, so with N Cloud Run instances the
 * effective ceiling is N x the limit — that is fine, this is an abuse brake on
 * our Google quota, not a correctness control.
 */
const buckets = new Map<string, RateEntry>()

function rateLimited(ip: string, now: number): boolean {
  const entry = buckets.get(ip)
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (buckets.size >= RATE_MAX_IPS) {
      // Insertion-ordered: drop the oldest tracked IP to make room.
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
export function clearGeocodeRateLimits(): void {
  buckets.clear()
}

export interface GeocodeRoutesOptions {
  /**
   * Google Maps server key (`env.GOOGLE_MAPS_SERVER_KEY`). OPTIONAL — when
   * absent the route answers 503 `geocoding_disabled` and the mobile client
   * silently falls back to its on-device geocoder, so the API ships safely
   * before the key exists (same graceful-degrade strategy as payments).
   */
  apiKey?: string | undefined
}

/** Mounted at '/v1/geocode' by app.ts. */
export const geocodeRoutes: FastifyPluginAsyncZod<GeocodeRoutesOptions> = async (
  app,
  { apiKey }
) => {
  app.get(
    '/reverse',
    {
      schema: {
        querystring: ReverseGeocodeQuerySchema,
        response: { 200: ReverseGeocodeResultSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many lookups. Try again shortly.' },
        })
      }

      const { lat, lng } = request.query

      const result = await reverseGeocode(lat, lng, { apiKey })
      if (!result) {
        // No upstream answer (ocean, ZERO_RESULTS, upstream hiccup). NOTE: the
        // coordinate is deliberately absent from this log line — see the
        // privacy contract in services/geocode.ts.
        request.log.info('reverse geocode returned no result')
        throw notFound('No address found for that location')
      }

      // Shoppers re-detect the same spot repeatedly; let the CDN/OS absorb that
      // too. Safe to cache publicly: the response carries no user identity, and
      // the TTL stays far inside Google's 30-day caching cap.
      reply.header('Cache-Control', 'public, max-age=3600')
      return reply.code(200).send(result)
    }
  )
}
