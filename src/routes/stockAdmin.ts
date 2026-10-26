/**
 * `/v1/admin/stock/*` — the operator's stock surface (HTTP layer only).
 * Business rules live in `services/stockAdmin.ts`; every route requires
 * `app.authenticate` THEN `app.requireAdmin`, same as `routes/catalogAdmin.ts`.
 *
 * Routes (all under the /v1/admin/stock prefix set in app.ts):
 *   GET    /                      shelf rows, optionally filtered by sku or node
 *   PUT    /:nodeId/:sku          set a shelf's absolute count (audited)
 *   DELETE /:nodeId/:sku          remove a shelf row (audited as a correction)
 *   GET    /nodes                 nodes with their stock flags and coordinate status
 *   PUT    /nodes/:nodeId/enabled toggle a node's cascade participation
 *   GET    /skus                  every sku with at least one shelf row
 *   GET    /policy                policy rows + the defaults an unlisted sku runs on
 *   PUT    /policy/:sku           create or replace a sku's policy
 *   DELETE /policy/:sku           drop it — back to auto on defaults
 *   GET    /audit                 recent changes, newest first
 *   GET    /oversells             shelves driven negative by a paid order
 *   GET    /explain               replay the cascade for one (sku, pincode)
 *
 * **This is why the stock config could not live in `app_config`.** The
 * decision predates the `GET /v1/config` allowlist, when `getSnapshot`
 * returned every row — a per-sku policy or a per-shop count stored there
 * would have been a public inventory feed. The allowlist closed that, but the
 * separation still stands on its own: stock needs per-sku rows and its own
 * audit surface, not one jsonb blob per knob (SPEC-STOCK.md §8).
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorEnvelopeSchema } from '../contracts/config.js'
import {
  AdminStockAuditListSchema,
  AdminStockAuditQuerySchema,
  AdminStockExplainQuerySchema,
  AdminStockExplainSchema,
  AdminStockListQuerySchema,
  AdminStockListSchema,
  AdminStockPolicyListSchema,
  AdminStockPolicySchema,
  AdminStockPolicyUpsertSchema,
  AdminStockRowSchema,
  AdminStockUpsertSchema,
} from '../contracts/stock.js'
import type { Db } from '../db/client.js'
import {
  deletePolicy,
  deleteStock,
  explainCascade,
  listAudit,
  listOversells,
  listPolicies,
  listStock,
  listStockedSkus,
  listStockNodes,
  setNodeStockEnabled,
  upsertPolicy,
  upsertStock,
} from '../services/stockAdmin.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const NodeSkuParamsSchema = z.strictObject({
  nodeId: z.string().uuid(),
  sku: z.string().min(1).max(120),
})

const SkuParamsSchema = z.strictObject({ sku: z.string().min(1).max(120) })
const NodeParamsSchema = z.strictObject({ nodeId: z.string().uuid() })

const StockNodeListSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      kind: z.enum(['warehouse', 'retail', 'hub']),
      stockEnabled: z.boolean(),
      isActive: z.boolean(),
      /** False = unrankable by distance; it can only win after every placeable shop misses. */
      hasCoords: z.boolean(),
      city: z.string(),
      pincode: z.string(),
    })
  ),
})

const DeletedSchema = z.object({ deleted: z.boolean() })
const SkuListSchema = z.object({ skus: z.array(z.string()) })
const NodeEnabledSchema = z.object({ id: z.string(), stockEnabled: z.boolean() })

export interface StockAdminRoutesOptions {
  db: Db
}

/** Admin stock routes. Mounted at '/v1/admin/stock' by app.ts. */
export const stockAdminRoutes: FastifyPluginAsyncZod<StockAdminRoutesOptions> = async (
  app,
  { db }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  // --- Shelves ---------------------------------------------------------------

  app.get(
    '/',
    {
      schema: {
        querystring: AdminStockListQuerySchema,
        response: { 200: AdminStockListSchema, ...errorResponses },
      },
    },
    async (request) => listStock(db, request.query)
  )

  app.put(
    '/:nodeId/:sku',
    {
      schema: {
        params: NodeSkuParamsSchema,
        body: AdminStockUpsertSchema,
        response: { 200: AdminStockRowSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { nodeId, sku } = request.params
      // The audit's `changed_by` is the admin's own user id, not a shared
      // service account — a count that changed with no attributable person
      // behind it is indistinguishable from shrinkage.
      return upsertStock(db, nodeId, sku, request.body, request.user.id)
    }
  )

  app.delete(
    '/:nodeId/:sku',
    {
      schema: {
        params: NodeSkuParamsSchema,
        response: { 200: DeletedSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { nodeId, sku } = request.params
      return deleteStock(db, nodeId, sku, request.user.id)
    }
  )

  // --- Nodes -----------------------------------------------------------------

  app.get(
    '/nodes',
    { schema: { response: { 200: StockNodeListSchema, ...errorResponses } } },
    async () => listStockNodes(db)
  )

  app.put(
    '/nodes/:nodeId/enabled',
    {
      schema: {
        params: NodeParamsSchema,
        body: z.strictObject({ enabled: z.boolean() }),
        response: { 200: NodeEnabledSchema, ...errorResponses },
      },
    },
    async (request) => setNodeStockEnabled(db, request.params.nodeId, request.body.enabled)
  )

  app.get('/skus', { schema: { response: { 200: SkuListSchema, ...errorResponses } } }, async () =>
    listStockedSkus(db)
  )

  // --- Policy ----------------------------------------------------------------

  app.get(
    '/policy',
    { schema: { response: { 200: AdminStockPolicyListSchema, ...errorResponses } } },
    async () => listPolicies(db)
  )

  app.put(
    '/policy/:sku',
    {
      schema: {
        params: SkuParamsSchema,
        body: AdminStockPolicyUpsertSchema,
        response: { 200: AdminStockPolicySchema, ...errorResponses },
      },
    },
    async (request) => upsertPolicy(db, request.params.sku, request.body, request.user.id)
  )

  app.delete(
    '/policy/:sku',
    {
      schema: { params: SkuParamsSchema, response: { 200: DeletedSchema, ...errorResponses } },
    },
    async (request) => deletePolicy(db, request.params.sku)
  )

  // --- Diagnostics -----------------------------------------------------------

  app.get(
    '/audit',
    {
      schema: {
        querystring: AdminStockAuditQuerySchema,
        response: { 200: AdminStockAuditListSchema, ...errorResponses },
      },
    },
    async (request) => listAudit(db, request.query)
  )

  app.get(
    '/oversells',
    { schema: { response: { 200: AdminStockListSchema, ...errorResponses } } },
    async () => listOversells(db)
  )

  app.get(
    '/explain',
    {
      schema: {
        querystring: AdminStockExplainQuerySchema,
        response: { 200: AdminStockExplainSchema, ...errorResponses },
      },
    },
    async (request) => explainCascade(db, request.query.sku, request.query.pincode)
  )
}
