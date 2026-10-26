/**
 * Coupon HTTP layer. Zod schemas validate every input (strict: unknown JSON
 * keys are rejected) and serialize every output; business rules live in
 * `services/coupons.ts`. Two plugins:
 *
 * - `couponRoutes` (mounted at `/v1/coupons` by app.ts) — PUBLIC, behind only
 *   the edge proxy gate: `GET /` (the offers-strip cards) and
 *   `POST /validate` (stateless validate-by-cartTotal).
 * - `adminCouponsRoutes` (mounted at `/v1/admin/coupons`) — every route
 *   requires `app.authenticate` THEN `app.requireAdmin` (mirrors
 *   routes/catalogAdmin.ts): full CRUD, `GET /:code` included here (not on
 *   the public prefix) so the admin edit-form read stays behind the same
 *   auth gate as the rest of the admin surface.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  CouponCodeParamsSchema,
  CouponCreateSchema,
  CouponListSchema,
  CouponSchema,
  CouponUpdateSchema,
  CouponValidateBodySchema,
  CouponValidateResponseSchema,
  ErrorEnvelopeSchema,
  PublicCouponListSchema,
} from '../contracts/coupon.js'
import type { Db } from '../db/client.js'
import { getConfigValue } from '../services/config.js'
import {
  createCoupon,
  deleteCoupon,
  DEFAULT_AUTO_SUGGEST_COUNT,
  getAdminCoupon,
  listAdminCoupons,
  listPublicCoupons,
  updateCoupon,
  validateCoupon,
} from '../services/coupons.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Coerce a JSON config value to a finite positive integer, or undefined if it isn't one. */
function asPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

/**
 * Resolve `coupons.autoSuggestCount` from config for `GET /v1/coupons`. Lives
 * in the ROUTE layer for the same reason `resolveWholesaleRule` does in
 * routes/cart.ts: `services/coupons.ts` must not read `app_config` directly
 * (ARCHITECTURE.md rule 5). Missing/malformed/non-positive → the sane default
 * — the public offers strip must never render nothing because of a bad config
 * value.
 */
async function resolveAutoSuggestCount(db: Db): Promise<number> {
  const value = await getConfigValue(db, 'coupons.autoSuggestCount')
  return asPositiveInt(value) ?? DEFAULT_AUTO_SUGGEST_COUNT
}

export interface CouponRoutesOptions {
  db: Db
}

/** Public coupon routes: `GET /v1/coupons`, `POST /v1/coupons/validate`. */
export const couponRoutes: FastifyPluginAsyncZod<CouponRoutesOptions> = async (app, { db }) => {
  app.get(
    '/',
    { schema: { response: { 200: PublicCouponListSchema, ...errorResponses } } },
    async () => ({ coupons: await listPublicCoupons(db, await resolveAutoSuggestCount(db)) })
  )

  app.post(
    '/validate',
    {
      schema: {
        body: CouponValidateBodySchema,
        response: { 200: CouponValidateResponseSchema, ...errorResponses },
      },
    },
    async (request) => validateCoupon(db, request.body.code, request.body.cartTotalInr)
  )
}

/** Admin coupon CRUD, mounted at `/v1/admin/coupons`. */
export const adminCouponsRoutes: FastifyPluginAsyncZod<CouponRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: CouponListSchema, ...errorResponses } } },
    async () => listAdminCoupons(db)
  )

  app.post(
    '/',
    { schema: { body: CouponCreateSchema, response: { 201: CouponSchema, ...errorResponses } } },
    async (request, reply) => {
      const created = await createCoupon(db, request.body, request.user.id)
      return reply.code(201).send(created)
    }
  )

  app.get(
    '/:code',
    {
      schema: {
        params: CouponCodeParamsSchema,
        response: { 200: CouponSchema, ...errorResponses },
      },
    },
    async (request) => getAdminCoupon(db, request.params.code)
  )

  app.put(
    '/:code',
    {
      schema: {
        params: CouponCodeParamsSchema,
        body: CouponUpdateSchema,
        response: { 200: CouponSchema, ...errorResponses },
      },
    },
    async (request) => updateCoupon(db, request.params.code, request.body, request.user.id)
  )

  app.delete(
    '/:code',
    {
      schema: {
        params: CouponCodeParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteCoupon(db, request.params.code)
      return reply.code(204).send(null)
    }
  )
}
