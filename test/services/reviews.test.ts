/**
 * Service-rule tests against PGlite for the reviews module: empty-state
 * aggregate, breakdown/average computation, pagination, upsert (one review
 * per user per product — a resubmission edits, never duplicates), and the
 * helpful-vote idempotency guard.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { categories, products, reviews, users } from '../../src/db/schema.js'
import { getProductReviews, upsertReview, voteReviewHelpful } from '../../src/services/reviews.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
let userAId: string
let userBId: string

const PRODUCT_ID = 'dan-hair-oil'

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db

  await db.insert(categories).values({ slug: 'hair oil', label: 'Hair Oil' })
  await db.insert(products).values({
    id: PRODUCT_ID,
    slug: 'hair-oil',
    name: 'Bhringraj Hair Oil',
    category: 'hair oil',
  })

  const [a] = await db
    .insert(users)
    .values({ firebaseUid: 'uid-a', phone: '+919000000001' })
    .returning({ id: users.id })
  const [b] = await db
    .insert(users)
    .values({ firebaseUid: 'uid-b', phone: '+919000000002' })
    .returning({ id: users.id })
  if (!a || !b) throw new Error('user insert failed')
  userAId = a.id
  userBId = b.id
})

describe('getProductReviews', () => {
  it('returns average: 0, count: 0 for a product with no reviews — never a fabricated default', async () => {
    const result = await getProductReviews(db, PRODUCT_ID, 1, 10)
    expect(result).toMatchObject({ average: 0, count: 0, reviews: [], hasMore: false })
    expect(result.breakdown).toEqual({ '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 })
  })

  it('computes the average and star breakdown over the WHOLE set, not just the page', async () => {
    await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 5,
      title: '',
      body: '',
      verifiedPurchase: false,
    })
    await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userBId,
      authorName: 'Bhavna',
      rating: 3,
      title: '',
      body: '',
      verifiedPurchase: false,
    })

    const result = await getProductReviews(db, PRODUCT_ID, 1, 1)
    expect(result.count).toBe(2)
    expect(result.average).toBe(4) // (5+3)/2
    expect(result.breakdown).toMatchObject({ '5': 1, '3': 1 })
    expect(result.reviews).toHaveLength(1)
    expect(result.hasMore).toBe(true)
  })

  it('orders most-helpful-first', async () => {
    const low = await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 4,
      title: '',
      body: '',
      verifiedPurchase: false,
    })
    const high = await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userBId,
      authorName: 'Bhavna',
      rating: 4,
      title: '',
      body: '',
      verifiedPurchase: false,
    })
    await voteReviewHelpful(db, high.id, userAId)

    const result = await getProductReviews(db, PRODUCT_ID, 1, 10)
    expect(result.reviews.map((r) => r.id)).toEqual([high.id, low.id])
  })
})

describe('upsertReview', () => {
  it('one review per user per product: a resubmission UPDATES the existing row, never duplicates', async () => {
    await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 2,
      title: 'Meh',
      body: 'not great',
      verifiedPurchase: false,
    })
    const updated = await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 5,
      title: 'Actually great',
      body: 'changed my mind',
      verifiedPurchase: true,
    })

    const rows = await db.select().from(reviews)
    expect(rows).toHaveLength(1)
    expect(updated.rating).toBe(5)
    expect(updated.title).toBe('Actually great')
    expect(updated.verifiedPurchase).toBe(true)
  })

  it('different users on the same product each get their own row', async () => {
    await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 5,
      title: '',
      body: '',
      verifiedPurchase: false,
    })
    await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userBId,
      authorName: 'Bhavna',
      rating: 1,
      title: '',
      body: '',
      verifiedPurchase: false,
    })
    const rows = await db.select().from(reviews)
    expect(rows).toHaveLength(2)
  })
})

describe('voteReviewHelpful', () => {
  it('increments once per caller; a repeat vote is a no-op with alreadyVoted: true', async () => {
    const review = await upsertReview(db, {
      productId: PRODUCT_ID,
      userId: userAId,
      authorName: 'Asha',
      rating: 5,
      title: '',
      body: '',
      verifiedPurchase: false,
    })

    const first = await voteReviewHelpful(db, review.id, userBId)
    expect(first).toEqual({ helpfulCount: 1, alreadyVoted: false })

    const repeat = await voteReviewHelpful(db, review.id, userBId)
    expect(repeat).toEqual({ helpfulCount: 1, alreadyVoted: true })
  })

  it('404s for an unknown review id', async () => {
    await expect(
      voteReviewHelpful(db, '00000000-0000-0000-0000-000000000000', userAId)
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
