/**
 * `/v1/reviews` — HTTP layer only; business rules live in
 * `services/reviews.ts`. Two plugins mounted at the SAME prefix (mirrors
 * routes/complaints.ts's public/authed split):
 *
 * - `reviewRoutes` — public: `GET /products/:productId` (rating summary +
 *   a page of reviews). No auth, so it's rendered for every PDP visitor.
 * - `authedReviewRoutes` — authed: `POST /products/:productId` (write/edit
 *   the caller's own review), `POST /:reviewId/helpful` (vote).
 *
 * This route layer does the cross-module wiring `services/reviews.ts` is
 * forbidden to do (ARCHITECTURE.md rule 2): it 404s a review write against an
 * unknown product (direct `products` read — `products` is catalog's table,
 * but reading it for existence is the same allowance `routes/cart.ts` uses
 * for `addresses`), reads the caller's `users.name` (the shared identity read
 * model, rule 3) for `authorName`, and calls
 * `services/payments.ts`'s `hasPurchasedProduct` to freeze `verifiedPurchase`.
 */

import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  ProductIdParamsSchema,
  RATING_SUMMARIES_MAX_IDS,
  RatingSummariesQuerySchema,
  RatingSummariesResponseSchema,
  ReviewCreateBodySchema,
  ReviewHelpfulResponseSchema,
  ReviewIdParamsSchema,
  ReviewSchema,
  ReviewsListResponseSchema,
  ReviewsQuerySchema,
} from '../contracts/reviews.js'
import type { Db } from '../db/client.js'
import { products, users } from '../db/schema.js'
import { notFound } from '../lib/errors.js'
import { hasPurchasedProduct } from '../services/payments.js'
import { getProductReviews, getRatingSummaries, upsertReview, voteReviewHelpful } from '../services/reviews.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Fallback when the caller has never set a display name (`PATCH /v1/me`). */
const ANONYMOUS_AUTHOR_NAME = 'Laanya Customer'

async function assertProductExists(db: Db, productId: string): Promise<void> {
  const [row] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1)
  if (!row) throw notFound(`Product "${productId}" not found`)
}

async function resolveAuthorName(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
  return row?.name?.trim() || ANONYMOUS_AUTHOR_NAME
}

export interface ReviewRoutesOptions {
  db: Db
}

/** Public: `GET /v1/reviews/products/:productId`. */
export const reviewRoutes: FastifyPluginAsyncZod<ReviewRoutesOptions> = async (app, { db }) => {
  app.get(
    '/products/:productId',
    {
      schema: {
        params: ProductIdParamsSchema,
        querystring: ReviewsQuerySchema,
        response: { 200: ReviewsListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      getProductReviews(db, request.params.productId, request.query.page, request.query.limit)
  )

  app.get(
    '/summaries',
    {
      schema: {
        querystring: RatingSummariesQuerySchema,
        response: { 200: RatingSummariesResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const ids = request.query.productIds
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .slice(0, RATING_SUMMARIES_MAX_IDS)
      const summaries = await getRatingSummaries(db, ids)
      return { summaries }
    }
  )
}

/** Authed: write/edit the caller's own review, vote a review helpful. */
export const authedReviewRoutes: FastifyPluginAsyncZod<ReviewRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)

  app.post(
    '/products/:productId',
    {
      schema: {
        params: ProductIdParamsSchema,
        body: ReviewCreateBodySchema,
        response: { 200: ReviewSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { productId } = request.params
      await assertProductExists(db, productId)
      const [authorName, verifiedPurchase] = await Promise.all([
        resolveAuthorName(db, request.user.id),
        hasPurchasedProduct(db, request.user.id, productId),
      ])
      return upsertReview(db, {
        productId,
        userId: request.user.id,
        authorName,
        rating: request.body.rating,
        title: request.body.title,
        body: request.body.body,
        verifiedPurchase,
      })
    }
  )

  app.post(
    '/:reviewId/helpful',
    {
      schema: {
        params: ReviewIdParamsSchema,
        response: { 200: ReviewHelpfulResponseSchema, ...errorResponses },
      },
    },
    async (request) => voteReviewHelpful(db, request.params.reviewId, request.user.id)
  )
}
