/**
 * "Notify me" routes (contracts/restock.ts).
 *
 *   POST /v1/restock-requests      public, email required, rate-limited
 *   POST /v1/restock-requests/me   signed in, recorded against the account
 */
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import { RestockRequestCreateSchema, RestockRequestResponseSchema } from '../contracts/restock.js'
import type { Db } from '../db/client.js'
import { requestRestock } from '../services/restock.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const RATE_LIMIT_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000
const RATE_MAX_IPS = 5_000
const buckets = new Map<string, { count: number; windowStart: number }>()

/** Fixed-window per-IP brake, same shape as routes/shipping.ts. */
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

/** Test seam — resets the limiter between cases. */
export function clearRestockRateLimits(): void {
  buckets.clear()
}

export const restockRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, opts) => {
  const { db } = opts

  app.post(
    '/',
    {
      schema: {
        body: RestockRequestCreateSchema,
        response: { 200: RestockRequestResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many requests. Try again shortly.' },
        })
      }
      await requestRestock(db, { sku: request.body.sku, email: request.body.email })
      return { ok: true as const }
    }
  )

  app.register(async (scope) => {
    const authed = scope.withTypeProvider<ZodTypeProvider>()
    authed.addHook('onRequest', authed.authenticate)
    authed.post(
      '/me',
      {
        schema: {
          body: RestockRequestCreateSchema,
          response: { 200: RestockRequestResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        await requestRestock(db, { sku: request.body.sku, userId: request.user.id })
        return { ok: true as const }
      }
    )
  })
}
