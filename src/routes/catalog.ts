/**
 * `GET /v1/catalog` (public) — the denormalized catalog blob the mobile app
 * fetches instead of bundling. HTTP layer only; assembly lives in
 * services/catalogRead.ts. Admin catalog CRUD is a separate plugin
 * (routes/catalogAdmin.ts, mounted under /v1/admin/catalog).
 *
 * Caching mirrors /v1/config exactly: the catalog version is the ETag, a
 * matching If-None-Match returns a bodyless 304, and Cache-Control lets the
 * Cloudflare edge cache the blob. See the config route for why 304 uses
 * `hijack()` rather than a declared response schema.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { CatalogSnapshotSchema } from '../contracts/catalog.js'
import { ErrorEnvelopeSchema } from '../contracts/config.js'
import type { Db } from '../db/client.js'
import { ifNoneMatchSatisfied } from '../lib/etag.js'
import { getCatalogSnapshot } from '../services/catalogRead.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface CatalogRoutesOptions {
  db: Db
}

/** Public catalog route. Mounted at '/v1/catalog' by app.ts. */
export const catalogRoutes: FastifyPluginAsyncZod<CatalogRoutesOptions> = async (app, { db }) => {
  app.get(
    '/',
    { schema: { response: { 200: CatalogSnapshotSchema, ...errorResponses } } },
    async (request, reply) => {
      const snapshot = await getCatalogSnapshot(db)
      const etag = `"${snapshot.version}"`
      // Catalog changes rarely and the edge revalidates; 5 min keeps reads fast
      // while bounding staleness (the "few minutes" eventual-consistency window).
      const cacheControl = 'public, max-age=300'

      // Weak-comparison match — Cloudflare hands the app `W/"n"` whenever it
      // compressed the response, so a strict string compare never hits.
      // See lib/etag.ts for the full story.
      if (ifNoneMatchSatisfied(request.headers['if-none-match'], snapshot.version)) {
        // Bodyless 304 — see config route for why hijack() beats a declared schema.
        reply.hijack()
        reply.raw.statusCode = 304
        reply.raw.setHeader('ETag', etag)
        reply.raw.setHeader('Cache-Control', cacheControl)
        reply.raw.end()
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', cacheControl)
      return reply.code(200).send(snapshot)
    }
  )
}
