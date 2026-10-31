/** /v1/wishlist — the caller's saved products. HTTP layer only; rules live in `services/wishlist.ts`. */

import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/profile.js'
import {
  WishlistMergeSchema,
  WishlistParamsSchema,
  WishlistSchema,
} from '../contracts/wishlist.js'
import type { Db } from '../db/client.js'
import {
  addWishlistItem,
  getWishlist,
  mergeWishlist,
  removeWishlistItem,
} from '../services/wishlist.js'

const errorResponses = { '4xx': ErrorEnvelopeSchema, '5xx': ErrorEnvelopeSchema }

export const wishlistRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', { schema: { response: { 200: WishlistSchema, ...errorResponses } } }, (request) =>
    getWishlist(db, request.user.id)
  )

  app.post(
    '/merge',
    { schema: { body: WishlistMergeSchema, response: { 200: WishlistSchema, ...errorResponses } } },
    (request) => mergeWishlist(db, request.user.id, request.body.productIds)
  )

  app.put(
    '/:productId',
    { schema: { params: WishlistParamsSchema, response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      await addWishlistItem(db, request.user.id, request.params.productId)
      return reply.code(204).send(null)
    }
  )

  app.delete(
    '/:productId',
    { schema: { params: WishlistParamsSchema, response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      await removeWishlistItem(db, request.user.id, request.params.productId)
      return reply.code(204).send(null)
    }
  )
}
