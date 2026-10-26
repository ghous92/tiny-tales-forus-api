/**
 * `POST /v1/client-errors` — HTTP layer only. Batched client-side telemetry
 * (web + mobile crash reports, unhandled rejections, and the noisier
 * console.error/memory/rerender signals) funneled into the same
 * `ErrorAlerter` a server 500 uses, so a real incident on a device gets the
 * same treatment as a server bug: an alert email (staging/production only)
 * and, optionally, a GitHub issue tagged for the automated fixer. See
 * `lib/alerts.ts` for that machinery and docs/CONTRACTS.md for the canonical
 * wire contract this route implements byte-for-byte.
 *
 * DELIBERATELY UNAUTHENTICATED, same reasoning as `routes/geocode.ts`: a
 * crash can happen before sign-in, which is exactly the case most worth
 * capturing — gating this behind a Bearer token would silently drop it.
 * Defended by a per-IP rate limit (replicated from `routes/geocode.ts`'s
 * fixed-window pattern) and a small `bodyLimit` instead of auth.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ClientErrorsAcceptedSchema,
  ClientErrorsBodySchema,
  ErrorEnvelopeSchema,
} from '../contracts/clientErrors.js'
import type { ErrorAlerter } from '../lib/alerts.js'
import { rateLimitExceeded } from '../lib/errors.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Sustained requests per IP per minute. A device retrying a crash loop can burst; this caps the damage well below the alerter's own storm brake. */
const RATE_LIMIT_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000
/** Cap on tracked IPs, so the limiter itself can't be turned into a memory leak (same cap as routes/geocode.ts). */
const RATE_MAX_IPS = 5_000

interface RateEntry {
  count: number
  windowStart: number
}

/**
 * Fixed-window per-IP counter, replicated from `routes/geocode.ts` rather
 * than shared: process-local, so with N Cloud Run instances the effective
 * ceiling is N x the limit — fine, this is an abuse brake, not a correctness
 * control (identical tradeoff to the geocode limiter).
 */
const buckets = new Map<string, RateEntry>()

function isRateLimited(ip: string, now: number): boolean {
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
export function clearClientErrorsRateLimits(): void {
  buckets.clear()
}

export interface ClientErrorsRoutesOptions {
  /**
   * Wired in from `app.ts`. Absent (e.g. alerting entirely unconfigured, or a
   * route test built without one) still 202s and logs the batch at warn —
   * graceful degrade, same philosophy as `payments_disabled`: the caller
   * never needs to know or care whether alerting is wired up.
   */
  alerter?: ErrorAlerter
}

/** Mounted at '/v1/client-errors' by app.ts. */
export const clientErrorsRoutes: FastifyPluginAsyncZod<ClientErrorsRoutesOptions> = async (
  app,
  { alerter }
) => {
  app.post(
    '/',
    {
      bodyLimit: 32 * 1024,
      schema: {
        body: ClientErrorsBodySchema,
        response: { 202: ClientErrorsAcceptedSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (isRateLimited(request.ip, Date.now())) {
        throw rateLimitExceeded('Too many error reports. Try again shortly.')
      }

      const { source, events } = request.body

      // Logged regardless of alerter presence — Cloud Logging must carry the
      // record even in dev/unconfigured deploys, same as every other
      // graceful-degrade path in this codebase.
      request.log.warn(
        { source, count: events.length, types: events.map((event) => event.type), ip: request.ip },
        'client error batch received'
      )

      if (alerter) {
        const userAgentHeader = request.headers['user-agent']
        alerter.notifyClientEvents(events, {
          ip: request.ip,
          source,
          ...(typeof userAgentHeader === 'string' ? { userAgent: userAgentHeader } : {}),
        })
      }

      return reply.code(202).send({ accepted: events.length })
    }
  )
}
