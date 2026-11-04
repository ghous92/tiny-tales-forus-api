/**
 * Shop-level reviews and their one-use invites (contracts/storeReviews.ts).
 * Owns `review_invites` and `store_reviews` only.
 *
 * Rules this module keeps:
 * - A review row is only ever inserted together with marking an unused invite
 *   used, in one transaction — no invite, no review.
 * - Moderation changes `status` only. Nothing here can rewrite a buyer's text,
 *   rating or name.
 * - Public reads see `approved` rows only, and the average is computed from
 *   those rows — never a configured or default number.
 */

import { randomBytes } from 'node:crypto'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import {
  STORE_REVIEWS_PUBLIC_LIMIT,
  type AdminInvite,
  type AdminStoreReview,
  type ReviewChannel,
  type StoreReview,
  type StoreReviewCreateBody,
  type StoreReviewsResponse,
} from '../contracts/storeReviews.js'
import type { Db } from '../db/client.js'
import {
  reviewInvites,
  storeReviews,
  type ReviewInviteRow,
  type StoreReviewRow,
} from '../db/schema.js'
import { conflict, notFound } from '../lib/errors.js'

function toPublic(row: StoreReviewRow): StoreReview {
  return {
    id: row.id,
    authorName: row.authorName,
    city: row.city,
    rating: row.rating,
    title: row.title,
    body: row.body,
    productLabel: row.productLabel,
    channel: row.channel as ReviewChannel,
    createdAt: row.createdAt.toISOString(),
  }
}

function toAdminInvite(row: ReviewInviteRow): AdminInvite {
  return {
    id: row.id,
    token: row.token,
    buyerLabel: row.buyerLabel,
    channel: row.channel as ReviewChannel,
    createdAt: row.createdAt.toISOString(),
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
  }
}

/** `GET /v1/store-reviews` — approved reviews only. */
export async function getPublicStoreReviews(db: Db): Promise<StoreReviewsResponse> {
  const approved = eq(storeReviews.status, 'approved')
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<number>`coalesce(avg(${storeReviews.rating}), 0)::float`,
      r5: sql<number>`count(*) filter (where ${storeReviews.rating} = 5)::int`,
      r4: sql<number>`count(*) filter (where ${storeReviews.rating} = 4)::int`,
      r3: sql<number>`count(*) filter (where ${storeReviews.rating} = 3)::int`,
      r2: sql<number>`count(*) filter (where ${storeReviews.rating} = 2)::int`,
      r1: sql<number>`count(*) filter (where ${storeReviews.rating} = 1)::int`,
    })
    .from(storeReviews)
    .where(approved)

  const rows = await db
    .select()
    .from(storeReviews)
    .where(approved)
    .orderBy(desc(storeReviews.createdAt))
    .limit(STORE_REVIEWS_PUBLIC_LIMIT)

  return {
    average: agg?.average ?? 0,
    count: agg?.count ?? 0,
    breakdown: {
      '5': agg?.r5 ?? 0,
      '4': agg?.r4 ?? 0,
      '3': agg?.r3 ?? 0,
      '2': agg?.r2 ?? 0,
      '1': agg?.r1 ?? 0,
    },
    reviews: rows.map(toPublic),
  }
}

/** `GET /v1/store-reviews/invites/:token`. 404 for an unknown token. */
export async function getInviteStatus(db: Db, token: string): Promise<{ status: 'open' | 'used' }> {
  const [row] = await db
    .select({ usedAt: reviewInvites.usedAt })
    .from(reviewInvites)
    .where(eq(reviewInvites.token, token))
    .limit(1)
  if (!row) throw notFound('This review link is not valid.')
  return { status: row.usedAt ? 'used' : 'open' }
}

/**
 * `POST /v1/store-reviews`. Claims the invite (conditional update, so two
 * concurrent submits of one link can't both win) and inserts the review as
 * `pending` in one transaction.
 */
export async function createStoreReview(
  db: Db,
  body: StoreReviewCreateBody
): Promise<{ id: string; status: 'pending' }> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .update(reviewInvites)
      .set({ usedAt: new Date() })
      .where(and(eq(reviewInvites.token, body.token), isNull(reviewInvites.usedAt)))
      .returning()
    if (!invite) {
      const [exists] = await tx
        .select({ id: reviewInvites.id })
        .from(reviewInvites)
        .where(eq(reviewInvites.token, body.token))
        .limit(1)
      if (!exists) throw notFound('This review link is not valid.')
      throw conflict('This review link has already been used.')
    }
    const [row] = await tx
      .insert(storeReviews)
      .values({
        inviteId: invite.id,
        authorName: body.authorName,
        city: body.city,
        rating: body.rating,
        title: body.title,
        body: body.body,
        productLabel: body.productLabel,
        channel: invite.channel,
        status: 'pending',
      })
      .returning({ id: storeReviews.id })
    return { id: row!.id, status: 'pending' as const }
  })
}

/** URL-safe, 22 chars (128 bits). */
function newToken(): string {
  return randomBytes(16).toString('base64url')
}

export async function createInvites(
  db: Db,
  channel: ReviewChannel,
  buyerLabels: string[]
): Promise<AdminInvite[]> {
  const rows = await db
    .insert(reviewInvites)
    .values(buyerLabels.map((buyerLabel) => ({ token: newToken(), buyerLabel, channel })))
    .returning()
  return rows.map(toAdminInvite)
}

export async function listInvites(db: Db): Promise<AdminInvite[]> {
  const rows = await db
    .select()
    .from(reviewInvites)
    .orderBy(desc(reviewInvites.createdAt))
    .limit(500)
  return rows.map(toAdminInvite)
}

export async function listStoreReviewsForAdmin(db: Db): Promise<AdminStoreReview[]> {
  const rows = await db
    .select({ review: storeReviews, buyerLabel: reviewInvites.buyerLabel })
    .from(storeReviews)
    .innerJoin(reviewInvites, eq(storeReviews.inviteId, reviewInvites.id))
    .orderBy(desc(storeReviews.createdAt))
    .limit(500)
  return rows.map(({ review, buyerLabel }) => ({
    ...toPublic(review),
    status: review.status as AdminStoreReview['status'],
    buyerLabel,
    moderatedAt: review.moderatedAt ? review.moderatedAt.toISOString() : null,
  }))
}

export async function moderateStoreReview(
  db: Db,
  reviewId: string,
  status: 'approved' | 'rejected'
): Promise<void> {
  const [row] = await db
    .update(storeReviews)
    .set({ status, moderatedAt: new Date() })
    .where(eq(storeReviews.id, reviewId))
    .returning({ id: storeReviews.id })
  if (!row) throw notFound('Review not found')
}
