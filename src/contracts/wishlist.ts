/** Zod contracts for the caller's wishlist (`/v1/wishlist`). Ids only, like the client store. */

import { z } from 'zod'

/** Most products one wishlist can hold. */
export const MAX_WISHLIST_ITEMS = 200

export const ProductIdSchema = z.string().trim().min(1).max(120)

export const WishlistParamsSchema = z.strictObject({ productId: ProductIdSchema })

/** `POST /merge` body: a device's list, absorbed at sign-in. */
export const WishlistMergeSchema = z.strictObject({
  productIds: z.array(ProductIdSchema).max(MAX_WISHLIST_ITEMS),
})

export const WishlistSchema = z.object({ productIds: z.array(z.string()) })

export type Wishlist = z.infer<typeof WishlistSchema>
