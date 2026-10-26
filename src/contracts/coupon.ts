/**
 * Zod contracts for the coupon resource — the single source of truth for
 * request validation AND response types. Imports only `zod`, same rule as
 * `contracts/cart.ts` / `contracts/config.ts`.
 *
 * Endpoints (see routes/coupons.ts):
 *   GET    /v1/coupons              public — active + time-valid cards
 *   POST   /v1/coupons/validate     public — stateless validate-by-cartTotal
 *   GET    /v1/admin/coupons        admin  — list, incl. inactive/expired
 *   POST   /v1/admin/coupons        admin  — create
 *   GET    /v1/admin/coupons/:code  admin  — read one (edit form)
 *   PUT    /v1/admin/coupons/:code  admin  — partial patch
 *   DELETE /v1/admin/coupons/:code  admin  — hard delete
 */

import { z } from 'zod'

/** Coupon codes are case-insensitive at the edge; the service uppercases on every write and lookup. */
const codeInput = z
  .string()
  .min(1, 'code is required')
  .max(64, 'code must be 64 characters or fewer')
  .regex(/^[A-Za-z0-9]+$/, 'Coupon code must contain only letters and numbers')

const label = z.string().min(1).max(200)
const description = z.string().max(2000)
const discountType = z.enum(['flat', 'percent'])
const discountValue = z.number().int()
const minCartInr = z.number().int().min(0)
const maxDiscountInr = z.number().int().positive().nullish()
const sortOrder = z.number().int()
/** Total redemptions allowed across all shoppers; null = unlimited. */
const usageLimit = z.number().int().positive().nullish()
/** Redemptions allowed per shopper; null = unlimited. */
const perUserLimit = z.number().int().positive().nullish()
const validAt = z.iso.datetime().nullish()
/** Waive delivery entirely while this coupon is applied — see `coupons.waives_shipping`. */
const waivesShipping = z.boolean().optional()

/**
 * Percent 1..90 / flat > 0 — checked here whenever BOTH fields are present in
 * the same payload (always true on create; on a partial update this only
 * fires when the caller patches both together — the service re-checks the
 * EFFECTIVE merged values against the existing row for every other partial
 * combination, since a schema-only check can't see the unpatched half).
 */
function pricingRefinement(v: {
  discountType?: 'flat' | 'percent' | undefined
  discountValue?: number | undefined
}): boolean {
  if (v.discountType === undefined || v.discountValue === undefined) return true
  return v.discountType === 'percent'
    ? v.discountValue >= 1 && v.discountValue <= 90
    : v.discountValue > 0
}

/** valid_from <= valid_to — only checked when both are present (and non-null) in the same payload. */
function windowRefinement(v: {
  validFrom?: string | null | undefined
  validTo?: string | null | undefined
}): boolean {
  if (!v.validFrom || !v.validTo) return true
  return new Date(v.validFrom).getTime() <= new Date(v.validTo).getTime()
}

/** POST /v1/admin/coupons */
export const CouponCreateSchema = z
  .strictObject({
    code: codeInput,
    label,
    description: description.optional(),
    discountType,
    discountValue,
    minCartInr: minCartInr.optional(),
    maxDiscountInr,
    validFrom: validAt,
    validTo: validAt,
    active: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
    usageLimit,
    perUserLimit,
    waivesShipping,
  })
  .refine(pricingRefinement, {
    message:
      'discountValue must be 1..90 for a percent coupon, or a positive whole number for a flat coupon',
    path: ['discountValue'],
  })
  .refine(windowRefinement, {
    message: 'validFrom must be on or before validTo',
    path: ['validTo'],
  })

/** PUT /v1/admin/coupons/:code — partial patch. `code` is immutable (path only). */
export const CouponUpdateSchema = z
  .strictObject({
    label: label.optional(),
    description: description.optional(),
    discountType: discountType.optional(),
    discountValue: discountValue.optional(),
    minCartInr: minCartInr.optional(),
    maxDiscountInr,
    validFrom: validAt,
    validTo: validAt,
    active: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
    usageLimit,
    perUserLimit,
    waivesShipping,
  })
  .refine(pricingRefinement, {
    message:
      'discountValue must be 1..90 for a percent coupon, or a positive whole number for a flat coupon',
    path: ['discountValue'],
  })
  .refine(windowRefinement, {
    message: 'validFrom must be on or before validTo',
    path: ['validTo'],
  })

/** Path params for the admin single-coupon routes. */
export const CouponCodeParamsSchema = z.strictObject({ code: codeInput })

/** Admin view of a coupon — the full DB row (camelCase, ISO dates), incl. inactive/expired. */
export const CouponSchema = z.object({
  code: z.string(),
  label: z.string(),
  description: z.string(),
  discountType,
  discountValue: z.int(),
  minCartInr: z.int(),
  maxDiscountInr: z.int().nullable(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  active: z.boolean(),
  sortOrder: z.int(),
  usageLimit: z.int().nullable(),
  perUserLimit: z.int().nullable(),
  /** True when this code waives the delivery fee outright, whatever the subtotal. */
  waivesShipping: z.boolean(),
  /** Live (unrevoked) redemptions of this code, all shoppers. Read-only, derived from `coupon_redemptions`. */
  redemptionCount: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const CouponListSchema = z.array(CouponSchema)

/** GET /v1/coupons — the public offers-strip card shape (no admin-only fields). */
export const PublicCouponSchema = z.object({
  code: z.string(),
  label: z.string(),
  description: z.string(),
  discountType,
  discountValue: z.int(),
  minCartInr: z.int(),
  maxDiscountInr: z.int().nullable(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  /** Public so the offers strip can say "+ free delivery" without a second call. */
  waivesShipping: z.boolean(),
})

export const PublicCouponListSchema = z.object({ coupons: z.array(PublicCouponSchema) })

/** POST /v1/coupons/validate body — stateless: a code plus the caller's client-local cart total. */
export const CouponValidateBodySchema = z.strictObject({
  code: codeInput,
  cartTotalInr: z.number().int().min(0),
})

/**
 * POST /v1/coupons/validate response, and the shape folded (with `subtotalInr`
 * already included) into `CartCouponSchema` on `GET /v1/cart`.
 */
export const CouponValidateResponseSchema = z.object({
  applied: z.boolean(),
  code: z.string().nullable(),
  label: z.string(),
  discountType: discountType.nullable(),
  discountValue: z.int(),
  minCartInr: z.int(),
  maxDiscountInr: z.int().nullable(),
  discountInr: z.int(),
  subtotalInr: z.int(),
  /** True only when the coupon is applied AND waives delivery. */
  waivesShipping: z.boolean(),
  reason: z
    .enum(['below_min', 'invalid', 'expired', 'inactive', 'usage_exceeded', 'user_limit_exceeded'])
    .nullable(),
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type CouponDiscountTypeInput = z.infer<typeof discountType>
export type CouponCreate = z.infer<typeof CouponCreateSchema>
export type CouponUpdate = z.infer<typeof CouponUpdateSchema>
export type CouponCodeParams = z.infer<typeof CouponCodeParamsSchema>
export type Coupon = z.infer<typeof CouponSchema>
export type PublicCoupon = z.infer<typeof PublicCouponSchema>
export type PublicCouponList = z.infer<typeof PublicCouponListSchema>
export type CouponValidateBody = z.infer<typeof CouponValidateBodySchema>
export type CouponValidateResponse = z.infer<typeof CouponValidateResponseSchema>
