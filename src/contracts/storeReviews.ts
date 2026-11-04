/**
 * Zod contracts for shop-level reviews (`/v1/store-reviews`, storefront review
 * widget) and their one-use invites (`/v1/admin/store-reviews`). Imports only
 * `zod`, same rule as `contracts/reviews.ts`.
 *
 * A store review can only be written through an admin-minted invite sent to a
 * real off-site buyer (WhatsApp/Instagram), which is what backs the "Verified
 * buyer" tag. There is no seed path: the widget shows nothing until approved
 * reviews exist.
 */

import { z } from 'zod'

export const STORE_REVIEW_NAME_MAX = 40
export const STORE_REVIEW_CITY_MAX = 40
export const STORE_REVIEW_TITLE_MAX = 100
export const STORE_REVIEW_BODY_MIN = 10
export const STORE_REVIEW_BODY_MAX = 1500
export const STORE_REVIEW_PRODUCT_MAX = 60
export const STORE_REVIEWS_PUBLIC_LIMIT = 24

export const ReviewChannelSchema = z.enum(['whatsapp', 'instagram', 'website', 'other'])
export const StoreReviewStatusSchema = z.enum(['pending', 'approved', 'rejected'])

/** Public view — no invite id, no operator note. */
export const StoreReviewSchema = z.object({
  id: z.uuid(),
  authorName: z.string(),
  city: z.string(),
  rating: z.int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  productLabel: z.string(),
  channel: ReviewChannelSchema,
  createdAt: z.iso.datetime(),
})

export const StoreReviewsBreakdownSchema = z.object({
  '5': z.int(),
  '4': z.int(),
  '3': z.int(),
  '2': z.int(),
  '1': z.int(),
})

/**
 * `GET /v1/store-reviews`. `average`/`count`/`breakdown` cover every approved
 * review; `reviews` is the newest `STORE_REVIEWS_PUBLIC_LIMIT`. `average` is 0
 * when `count` is 0 — never a default rating.
 */
export const StoreReviewsResponseSchema = z.object({
  average: z.number(),
  count: z.int(),
  breakdown: StoreReviewsBreakdownSchema,
  reviews: z.array(StoreReviewSchema),
})

export const InviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

export const InviteTokenParamsSchema = z.strictObject({ token: InviteTokenSchema })

/** `GET /v1/store-reviews/invites/:token` — lets `/review/` show the right screen before the form. */
export const InviteStatusResponseSchema = z.object({
  status: z.enum(['open', 'used']),
})

/** `POST /v1/store-reviews` body. */
export const StoreReviewCreateBodySchema = z.strictObject({
  token: InviteTokenSchema,
  rating: z.int().min(1).max(5),
  title: z.string().trim().max(STORE_REVIEW_TITLE_MAX).optional().default(''),
  body: z.string().trim().min(STORE_REVIEW_BODY_MIN).max(STORE_REVIEW_BODY_MAX),
  authorName: z.string().trim().min(1).max(STORE_REVIEW_NAME_MAX),
  city: z.string().trim().max(STORE_REVIEW_CITY_MAX).optional().default(''),
  productLabel: z.string().trim().max(STORE_REVIEW_PRODUCT_MAX).optional().default(''),
})

export const StoreReviewCreateResponseSchema = z.object({
  id: z.uuid(),
  status: StoreReviewStatusSchema,
})

// ── Admin ──────────────────────────────────────────────────────────────────

export const INVITES_BATCH_MAX = 50

/** `POST /v1/admin/store-reviews/invites` body — one invite per buyer label. */
export const InviteCreateBodySchema = z.strictObject({
  channel: ReviewChannelSchema,
  buyerLabels: z.array(z.string().trim().max(120)).min(1).max(INVITES_BATCH_MAX),
})

export const AdminInviteSchema = z.object({
  id: z.uuid(),
  token: z.string(),
  buyerLabel: z.string(),
  channel: ReviewChannelSchema,
  createdAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
})

export const AdminInviteListResponseSchema = z.object({
  invites: z.array(AdminInviteSchema),
})

export const AdminStoreReviewSchema = StoreReviewSchema.extend({
  status: StoreReviewStatusSchema,
  buyerLabel: z.string(),
  moderatedAt: z.iso.datetime().nullable(),
})

export const AdminStoreReviewListResponseSchema = z.object({
  reviews: z.array(AdminStoreReviewSchema),
})

export const StoreReviewIdParamsSchema = z.strictObject({ reviewId: z.uuid() })

/** `PATCH /v1/admin/store-reviews/:reviewId` — status only; review text is the buyer's and is never editable. */
export const StoreReviewModerateBodySchema = z.strictObject({
  status: z.enum(['approved', 'rejected']),
})

export type ReviewChannel = z.infer<typeof ReviewChannelSchema>
export type StoreReview = z.infer<typeof StoreReviewSchema>
export type StoreReviewsResponse = z.infer<typeof StoreReviewsResponseSchema>
export type StoreReviewCreateBody = z.infer<typeof StoreReviewCreateBodySchema>
export type AdminInvite = z.infer<typeof AdminInviteSchema>
export type AdminStoreReview = z.infer<typeof AdminStoreReviewSchema>
