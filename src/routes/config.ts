/**
 * `/v1/config` (public) and `/v1/admin/config` (admin) — HTTP layer only.
 * Zod schemas validate every input and serialize every output; business
 * rules live in `services/config.ts`. Admin routes require
 * `app.authenticate` THEN `app.requireAdmin` (see plugins/auth.ts).
 *
 * The public snapshot carries only `PUBLIC_CONFIG_KEYS` — the allowlist is
 * enforced in `getSnapshot`, not here, so there is no route-level filter to
 * forget. The admin list is the unfiltered one, behind admin auth.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ConfigEntryListSchema,
  ConfigEntrySchema,
  ConfigKeyParamsSchema,
  ConfigSnapshotSchema,
  ConfigUpsertSchema,
  ErrorEnvelopeSchema,
} from '../contracts/config.js'
import type { Db } from '../db/client.js'
import { ifNoneMatchSatisfied } from '../lib/etag.js'
import {
  deleteConfigEntry,
  getSnapshot,
  listConfigEntries,
  upsertConfigEntry,
} from '../services/config.js'

/** Error envelope for every non-2xx status, declared once per route. */
const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface ConfigRoutesOptions {
  db: Db
}

/** Public GET /v1/config — no prefix baked in; app.ts mounts this at '/v1/config'. */
export const configRoutes: FastifyPluginAsyncZod<ConfigRoutesOptions> = async (app, { db }) => {
  app.get(
    '/',
    {
      // No response schema entry for 304 on purpose: unlike a declared 204
      // (which Fastify special-cases to never write a body regardless of
      // payload), a declared 304 schema still runs the payload through the
      // zod serializer and writes its result as the body — `z.null()` would
      // literally send the 4-byte string "null". Sending a bare '' string
      // instead skips schema serialization entirely (Fastify's plain-string
      // fast path), giving a genuinely empty body.
      schema: { response: { 200: ConfigSnapshotSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const snapshot = await getSnapshot(db)
      const etag = `"${snapshot.version}"`
      const cacheControl = 'public, max-age=60'

      // Weak-comparison match — Cloudflare hands clients `W/"n"` whenever it
      // compressed the response, so a strict string compare never hits.
      // See lib/etag.ts for the full story.
      if (ifNoneMatchSatisfied(request.headers['if-none-match'], snapshot.version)) {
        // `hijack()` opts this response out of Fastify's schema serializer —
        // a declared 304 response schema would still run `null` through zod
        // and write the literal string "null" as the body (unlike 204, which
        // Fastify hard-codes to never write a body). Writing the raw
        // response directly is the only way to get a genuinely empty 304.
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

/** Admin config routes: list, upsert, delete. Mounted at '/v1/admin/config'. */
export const adminConfigRoutes: FastifyPluginAsyncZod<ConfigRoutesOptions> = async (
  app,
  { db }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: ConfigEntryListSchema, ...errorResponses } } },
    async () => listConfigEntries(db)
  )

  app.put(
    '/:key',
    {
      schema: {
        params: ConfigKeyParamsSchema,
        body: ConfigUpsertSchema,
        response: { 200: ConfigEntrySchema, ...errorResponses },
      },
    },
    async (request) => upsertConfigEntry(db, request.params.key, request.body, request.user.id)
  )

  app.delete(
    '/:key',
    {
      schema: {
        params: ConfigKeyParamsSchema,
        // Fastify sends no body for a 204; z.null() documents "empty".
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteConfigEntry(db, request.params.key, request.user.id)
      return reply.code(204).send(null)
    }
  )
}
