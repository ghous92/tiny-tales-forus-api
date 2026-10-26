/**
 * Reviews business rules (PDP "Ratings & Reviews"). Owns the `reviews` /
 * `review_helpful_votes` tables and is the ONLY place that queries them
 * directly (docs/ARCHITECTURE.md rule 2 — this module may not import another
 * module's service, and no other module may import this one except through
 * these exports).
 *
 * `verifiedPurchase` and `authorName` are resolved by the ROUTE layer
 * (`routes/reviews.ts`, mirroring `resolveWholesaleRule` in `routes/cart.ts`)
 * and handed in as plain values — this module never reaches into `payments`
 * or `users` itself.
 *
 * Every review is shopper-written (`source: 'user'`) until the Amazon
 * Solution Provider feed lands (docs/SPEC-REVIEWS.md), which will write
 * `source: 'amazon'` rows the client labels as imported. There is no
 * placeholder source: a product with no reviews returns an empty list, never
 * fabricated ones. Wiring the feed only changes what writes this table, never
 * this module's shape or the mobile contract.
 */

import { desc, eq, inArray, sql } from 'drizzle-orm'

import type {
  RatingSummary,
  Review,
  ReviewsBreakdown,
  ReviewsListResponse,
} from '../contracts/reviews.js'
import type { Db } from '../db/client.js'
import { reviewHelpfulVotes, reviews, type ReviewRow } from '../db/schema.js'
import { notFound } from '../lib/errors.js'

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    authorName: row.authorName,
    rating: row.rating,
    title: row.title,
    body: row.body,
    verifiedPurchase: row.verifiedPurchase,
    source: row.source as Review['source'],
    helpfulCount: row.helpfulCount,
    createdAt: row.createdAt.toISOString(),
  }
}

const EMPTY_BREAKDOWN: ReviewsBreakdown = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }

/**
 * GET /v1/reviews/products/:productId. `average`/`count`/`breakdown` are
 * computed over the FULL set (not just this page) via one aggregate query;
 * `reviews` is the requested page, most-helpful-first
 * (`reviews_product_id_helpful_idx`). A product with no reviews yet returns
 * `average: 0, count: 0` — never a fabricated default rating.
 */
export async function getProductReviews(
  db: Db,
  productId: string,
  page: number,
  limit: number
): Promise<ReviewsListResponse> {
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<number>`coalesce(avg(${reviews.rating}), 0)::float`,
      r5: sql<number>`count(*) filter (where ${reviews.rating} = 5)::int`,
      r4: sql<number>`count(*) filter (where ${reviews.rating} = 4)::int`,
      r3: sql<number>`count(*) filter (where ${reviews.rating} = 3)::int`,
      r2: sql<number>`count(*) filter (where ${reviews.rating} = 2)::int`,
      r1: sql<number>`count(*) filter (where ${reviews.rating} = 1)::int`,
    })
    .from(reviews)
    .where(eq(reviews.productId, productId))

  const count = agg?.count ?? 0
  const breakdown: ReviewsBreakdown =
    count === 0
      ? EMPTY_BREAKDOWN
      : { '5': agg!.r5, '4': agg!.r4, '3': agg!.r3, '2': agg!.r2, '1': agg!.r1 }

  const offset = (page - 1) * limit
  const rows =
    count === 0
      ? []
      : await db
          .select()
          .from(reviews)
          .where(eq(reviews.productId, productId))
          .orderBy(desc(reviews.helpfulCount), desc(reviews.createdAt))
          .limit(limit + 1)
          .offset(offset)

  const hasMore = rows.length > limit
  const page_ = hasMore ? rows.slice(0, limit) : rows

  return {
    productId,
    average: count === 0 ? 0 : Math.round(agg!.average * 10) / 10,
    count,
    breakdown,
    reviews: page_.map(toReview),
    page,
    limit,
    hasMore,
  }
}

/**
 * GET /v1/reviews/summaries. Batched `average`/`count` for a list of product
 * ids — one aggregate query, grouped, instead of the Home grid or PDP header
 * firing `getProductReviews` per card. A product with no reviews is simply
 * absent from the result (never a fabricated 0-review row).
 */
export async function getRatingSummaries(db: Db, productIds: string[]): Promise<RatingSummary[]> {
  if (productIds.length === 0) return []

  const rows = await db
    .select({
      productId: reviews.productId,
      count: sql<number>`count(*)::int`,
      average: sql<number>`coalesce(avg(${reviews.rating}), 0)::float`,
    })
    .from(reviews)
    .where(inArray(reviews.productId, productIds))
    .groupBy(reviews.productId)

  return rows.map((row) => ({
    productId: row.productId,
    average: Math.round(row.average * 10) / 10,
    count: row.count,
  }))
}

export interface UpsertReviewInput {
  productId: string
  userId: string
  authorName: string
  rating: number
  title: string
  body: string
  verifiedPurchase: boolean
}

/**
 * POST /v1/reviews/products/:productId. One review per user per product
 * (`reviews_one_per_user_product`) — a resubmission UPDATES the existing row
 * (new rating/title/body/verifiedPurchase, and `source` stays `'user'`).
 */
export async function upsertReview(db: Db, input: UpsertReviewInput): Promise<Review> {
  const [row] = await db
    .insert(reviews)
    .values({
      productId: input.productId,
      userId: input.userId,
      authorName: input.authorName,
      rating: input.rating,
      title: input.title,
      body: input.body,
      verifiedPurchase: input.verifiedPurchase,
      source: 'user',
    })
    .onConflictDoUpdate({
      target: [reviews.productId, reviews.userId],
      // The conflict target is a PARTIAL unique index (`reviews_one_per_user_product`
      // excludes null userId — Amazon-imported rows may repeat a productId with
      // no uniqueness constraint at all) — Postgres only matches a partial
      // index's arbiter when the same predicate is repeated here.
      targetWhere: sql`${reviews.userId} is not null`,
      set: {
        authorName: input.authorName,
        rating: input.rating,
        title: input.title,
        body: input.body,
        verifiedPurchase: input.verifiedPurchase,
        source: 'user',
        updatedAt: sql`now()`,
      },
    })
    .returning()
  if (!row) throw new Error('review upsert returned no row')
  return toReview(row)
}

/**
 * POST /v1/reviews/:reviewId/helpful. Idempotent per caller: the vote insert
 * is the guard (`onConflictDoNothing`), and `helpfulCount` only increments
 * when that insert actually landed a new row — a repeat tap returns the
 * current count with `alreadyVoted: true` instead of counting twice.
 */
export async function voteReviewHelpful(
  db: Db,
  reviewId: string,
  userId: string
): Promise<{ helpfulCount: number; alreadyVoted: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: reviews.id, helpfulCount: reviews.helpfulCount })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .limit(1)
    if (!existing) throw notFound('Review not found')

    const inserted = await tx
      .insert(reviewHelpfulVotes)
      .values({ reviewId, userId })
      .onConflictDoNothing()
      .returning({ reviewId: reviewHelpfulVotes.reviewId })
    if (inserted.length === 0) {
      return { helpfulCount: existing.helpfulCount, alreadyVoted: true }
    }

    const [updated] = await tx
      .update(reviews)
      .set({ helpfulCount: sql`${reviews.helpfulCount} + 1` })
      .where(eq(reviews.id, reviewId))
      .returning({ helpfulCount: reviews.helpfulCount })
    return { helpfulCount: updated?.helpfulCount ?? existing.helpfulCount + 1, alreadyVoted: false }
  })
}
