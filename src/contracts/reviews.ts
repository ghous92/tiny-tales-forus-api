/**
 * Zod contracts for the reviews resource (PDP "Ratings & Reviews"). Imports
 * only `zod`, same rule as `contracts/cart.ts` / `contracts/address.ts`.
 */

import { z } from 'zod'

export const REVIEW_TITLE_MAX = 120
export const REVIEW_BODY_MAX = 2000
export const REVIEWS_PAGE_MAX = 50
export const REVIEWS_PAGE_DEFAULT = 10

/**
 * Where a review row came from. `user` = written in the app by a signed-in
 * shopper; `amazon` = imported from the Amazon listing feed, which the client
 * must label as such. There is no placeholder/seed source — a product with no
 * reviews returns none rather than fabricated ones.
 */
export const ReviewSourceSchema = z.enum(['user', 'amazon'])

export const ReviewSchema = z.object({
  id: z.uuid(),
  authorName: z.string(),
  rating: z.int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  verifiedPurchase: z.boolean(),
  source: ReviewSourceSchema,
  helpfulCount: z.int(),
  createdAt: z.iso.datetime(),
})

/** Count of reviews at each star rating, 1..5 — drives the histogram bars under the average. */
export const ReviewsBreakdownSchema = z.object({
  '5': z.int(),
  '4': z.int(),
  '3': z.int(),
  '2': z.int(),
  '1': z.int(),
})

/**
 * `GET /v1/reviews/products/:productId` response. `average`/`count`/
 * `breakdown` describe the WHOLE set (not just this page); `reviews` is one
 * page, ordered most-helpful-first. `average` is 0 when `count` is 0 — never
 * a fabricated default rating.
 */
export const ReviewsListResponseSchema = z.object({
  productId: z.string(),
  average: z.number(),
  count: z.int(),
  breakdown: ReviewsBreakdownSchema,
  reviews: z.array(ReviewSchema),
  page: z.int(),
  limit: z.int(),
  hasMore: z.boolean(),
})

export const ReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(REVIEWS_PAGE_MAX).default(REVIEWS_PAGE_DEFAULT),
})

export const ProductIdParamsSchema = z.strictObject({
  productId: z.string().min(1),
})

export const RATING_SUMMARIES_MAX_IDS = 100

/** One product's rating aggregate — same `average`/`count` semantics as `ReviewsListResponseSchema`. */
export const RatingSummarySchema = z.object({
  productId: z.string(),
  average: z.number(),
  count: z.int(),
})

/** `GET /v1/reviews/summaries` querystring — comma-separated product ids, e.g. `?productIds=a,b,c`. */
export const RatingSummariesQuerySchema = z.object({
  productIds: z.string().min(1),
})

/**
 * `GET /v1/reviews/summaries` response — batched `average`/`count` for a Home
 * grid or PDP header, so those screens don't fire one request per product.
 * Ids with zero reviews are simply absent (never a fabricated 0-review row).
 */
export const RatingSummariesResponseSchema = z.object({
  summaries: z.array(RatingSummarySchema),
})

export const ReviewIdParamsSchema = z.strictObject({
  reviewId: z.uuid(),
})

/** `POST /v1/reviews/products/:productId` body — one review per caller per product (a resubmission edits it). */
export const ReviewCreateBodySchema = z.strictObject({
  rating: z.int().min(1).max(5),
  title: z.string().max(REVIEW_TITLE_MAX).optional().default(''),
  body: z.string().max(REVIEW_BODY_MAX).optional().default(''),
})

/** `POST /v1/reviews/:reviewId/helpful` response — idempotent per caller. */
export const ReviewHelpfulResponseSchema = z.object({
  helpfulCount: z.int(),
  alreadyVoted: z.boolean(),
})

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type ReviewSource = z.infer<typeof ReviewSourceSchema>
export type Review = z.infer<typeof ReviewSchema>
export type ReviewsBreakdown = z.infer<typeof ReviewsBreakdownSchema>
export type ReviewsListResponse = z.infer<typeof ReviewsListResponseSchema>
export type ReviewsQuery = z.infer<typeof ReviewsQuerySchema>
export type ProductIdParams = z.infer<typeof ProductIdParamsSchema>
export type ReviewIdParams = z.infer<typeof ReviewIdParamsSchema>
export type ReviewCreateBody = z.infer<typeof ReviewCreateBodySchema>
export type ReviewHelpfulResponse = z.infer<typeof ReviewHelpfulResponseSchema>
export type RatingSummary = z.infer<typeof RatingSummarySchema>
export type RatingSummariesQuery = z.infer<typeof RatingSummariesQuerySchema>
export type RatingSummariesResponse = z.infer<typeof RatingSummariesResponseSchema>
