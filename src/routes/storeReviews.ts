/**
 * Shop-level reviews — HTTP layer only; rules live in `services/storeReviews.ts`.
 *
 * - `storeReviewRoutes` (`/v1/store-reviews`) — public: the approved list for
 *   the storefront widget, an invite-status probe, and the invite-gated write.
 *   No account needed: off-site buyers (WhatsApp/Instagram) have none. The
 *   one-use invite token is the credential, plus a per-IP brake on writes.
 * - `adminStoreReviewRoutes` (`/v1/admin/store-reviews`) — authed + admin:
 *   mint invites, list them, list reviews, approve/reject.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorEnvelopeSchema } from '../contracts/reviews.js'
import {
  AdminInviteListResponseSchema,
  AdminStoreReviewListResponseSchema,
  InviteCreateBodySchema,
  InviteStatusResponseSchema,
  InviteTokenParamsSchema,
  StoreReviewCreateBodySchema,
  StoreReviewCreateResponseSchema,
  StoreReviewIdParamsSchema,
  StoreReviewModerateBodySchema,
  StoreReviewsResponseSchema,
} from '../contracts/storeReviews.js'
import type { Db } from '../db/client.js'
import {
  createInvites,
  createStoreReview,
  getInviteStatus,
  getPublicStoreReviews,
  listInvites,
  listStoreReviewsForAdmin,
  moderateStoreReview,
} from '../services/storeReviews.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const RATE_LIMIT_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000
const RATE_MAX_IPS = 5_000
const buckets = new Map<string, { count: number; windowStart: number }>()

/** Fixed-window per-IP brake, same shape as routes/restock.ts. */
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
export function clearStoreReviewRateLimits(): void {
  buckets.clear()
}

export interface StoreReviewRoutesOptions {
  db: Db
}

export const storeReviewRoutes: FastifyPluginAsyncZod<StoreReviewRoutesOptions> = async (
  app,
  { db }
) => {
  app.get(
    '/',
    { schema: { response: { 200: StoreReviewsResponseSchema, ...errorResponses } } },
    async (_request, reply) => {
      // Short shared cache: a freshly approved review shows within minutes,
      // and a home-page traffic spike doesn't turn into one query per view.
      reply.header('Cache-Control', 'public, max-age=300')
      return getPublicStoreReviews(db)
    }
  )

  app.get(
    '/invites/:token',
    {
      schema: {
        params: InviteTokenParamsSchema,
        response: { 200: InviteStatusResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many requests. Try again shortly.' },
        })
      }
      reply.header('Cache-Control', 'no-store')
      return getInviteStatus(db, request.params.token)
    }
  )

  app.post(
    '/',
    {
      schema: {
        body: StoreReviewCreateBodySchema,
        response: { 201: StoreReviewCreateResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (rateLimited(request.ip, Date.now())) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many requests. Try again shortly.' },
        })
      }
      const created = await createStoreReview(db, request.body)
      return reply.code(201).send(created)
    }
  )
}

export const adminStoreReviewRoutes: FastifyPluginAsyncZod<StoreReviewRoutesOptions> = async (
  app,
  { db }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: AdminStoreReviewListResponseSchema, ...errorResponses } } },
    async () => ({ reviews: await listStoreReviewsForAdmin(db) })
  )

  app.patch(
    '/:reviewId',
    {
      schema: {
        params: StoreReviewIdParamsSchema,
        body: StoreReviewModerateBodySchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await moderateStoreReview(db, request.params.reviewId, request.body.status)
      return reply.code(204).send(null)
    }
  )

  app.get(
    '/invites',
    { schema: { response: { 200: AdminInviteListResponseSchema, ...errorResponses } } },
    async () => ({ invites: await listInvites(db) })
  )

  app.post(
    '/invites',
    {
      schema: {
        body: InviteCreateBodySchema,
        response: { 201: AdminInviteListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const invites = await createInvites(db, request.body.channel, request.body.buyerLabels)
      return reply.code(201).send({ invites })
    }
  )
}
