/**
 * Damage claims routes (contracts/claims.ts).
 *
 * The route resolves the two facts the claims service may not look up itself:
 * the delivery time (fulfilment module) and the reporting window (config).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  ClaimAdminListResponseSchema,
  ClaimAdminSchema,
  ClaimAdminUpdateSchema,
  ClaimCreateSchema,
  ClaimListResponseSchema,
  ClaimParamsSchema,
  ClaimSchema,
} from '../contracts/claims.js'
import type { Db } from '../db/client.js'
import {
  createClaim,
  DEFAULT_DAMAGE_WINDOW_HOURS,
  getClaim,
  listAllClaims,
  listClaims,
  updateClaimStatus,
} from '../services/claims.js'
import { getConfigValue } from '../services/config.js'
import { getShipmentForUser } from '../services/fulfilment.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface ClaimRoutesOptions {
  db: Db
  /** Test seam for the window check. */
  now?: () => Date
}

/** `returns.damageWindowHours`, or the default when unset or malformed. */
async function damageWindowHours(db: Db): Promise<number> {
  const value = await getConfigValue<unknown>(db, 'returns.damageWindowHours')
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 24 * 30
    ? value
    : DEFAULT_DAMAGE_WINDOW_HOURS
}

/** Mounted at '/v1/claims'. Authenticated: a shopper's own claims only. */
export const claimRoutes: FastifyPluginAsyncZod<ClaimRoutesOptions> = async (app, opts) => {
  const { db } = opts
  app.addHook('onRequest', app.authenticate)

  app.post(
    '/',
    { schema: { body: ClaimCreateSchema, response: { 201: ClaimSchema, ...errorResponses } } },
    async (request, reply) => {
      const shipment = await getShipmentForUser(db, request.user.id, request.body.orderId)
      const claim = await createClaim(db, request.user.id, request.body, {
        deliveredAt: shipment?.shipment.deliveredAt ?? null,
        windowHours: await damageWindowHours(db),
        ...(opts.now ? { now: opts.now() } : {}),
      })
      return reply.code(201).send(claim)
    }
  )

  app.get(
    '/',
    { schema: { response: { 200: ClaimListResponseSchema, ...errorResponses } } },
    async (request) => ({ claims: await listClaims(db, request.user.id) })
  )

  app.get(
    '/:claimNumber',
    {
      schema: {
        params: ClaimParamsSchema,
        response: { 200: ClaimSchema, ...errorResponses },
      },
    },
    async (request) => getClaim(db, request.user.id, request.params.claimNumber)
  )
}

/** Mounted at '/v1/admin/claims'. */
export const adminClaimRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, opts) => {
  const { db } = opts
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: ClaimAdminListResponseSchema, ...errorResponses } } },
    async () => ({ claims: await listAllClaims(db) })
  )

  app.patch(
    '/:claimNumber',
    {
      schema: {
        params: ClaimParamsSchema,
        body: ClaimAdminUpdateSchema,
        response: { 200: ClaimAdminSchema, ...errorResponses },
      },
    },
    async (request) => updateClaimStatus(db, request.params.claimNumber, request.body)
  )
}
