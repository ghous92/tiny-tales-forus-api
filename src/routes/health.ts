/**
 * Unauthenticated health endpoints for Cloud Run / uptime checks.
 * `/livez` is pure liveness (no DB); `/readyz` proves the database is
 * reachable with a `select 1` and answers 503 when it is not.
 *
 * Not named `/healthz`: GCP's Google Frontend reserves that exact path and
 * intercepts it before it reaches the container (returns a Google-branded
 * 404, never hits our route or Cloud Run logs).
 */

import { sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorEnvelopeSchema } from '../contracts/address.js'
import type { Db } from '../db/client.js'

const OkSchema = z.object({ ok: z.literal(true) })

export interface HealthRoutesOptions {
  db: Db
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, { db }) => {
  app.get(
    '/livez',
    { schema: { response: { 200: OkSchema } } },
    async () => ({ ok: true }) as const
  )

  app.get(
    '/readyz',
    { schema: { response: { 200: OkSchema, 503: ErrorEnvelopeSchema } } },
    async (request, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { ok: true } as const
      } catch (err) {
        request.log.error({ err }, 'readiness check failed')
        return reply
          .code(503)
          .send({ error: { code: 'internal', message: 'Database unreachable' } })
      }
    }
  )
}
