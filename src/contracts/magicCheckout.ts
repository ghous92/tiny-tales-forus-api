/**
 * Zod contracts for Razorpay Magic Checkout, the guest checkout path. Imports
 * only `zod`, same rule as the other contracts.
 *
 * The three `Razorpay*` shapes are Razorpay's, not ours: it calls these URLs
 * from its own servers, so they are deliberately lenient about extra fields.
 */

import { z } from 'zod'

import { MAX_LINES, MAX_QTY_PER_LINE } from './cart.js'

/**
 * POST /v1/payments/magic/orders. The bag comes from the browser because a
 * guest has no server cart, but only as sku + qty: every price is re-read from
 * the catalog. `termsAccepted` is the line shown above the button; the literal
 * means a client cannot create an order without having shown it.
 */
export const MagicOrderCreateSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        sku: z.string().min(1).max(100),
        qty: z.int().min(1).max(MAX_QTY_PER_LINE),
      })
    )
    .min(1)
    .max(MAX_LINES),
  couponCode: z.string().min(1).max(64).optional(),
  termsAccepted: z.literal(true),
  anonymousId: z.string().min(1).max(128).optional(),
  attribution: z
    .object({
      utmSource: z.string().min(1).max(128).optional(),
      utmMedium: z.string().min(1).max(128).optional(),
      utmCampaign: z.string().min(1).max(128).optional(),
      utmContent: z.string().min(1).max(128).optional(),
      gclid: z.string().min(1).max(512).optional(),
      oppref: z.string().min(1).max(2048).optional(),
    })
    .optional(),
})
export type MagicOrderCreate = z.infer<typeof MagicOrderCreateSchema>

/** What the browser needs to open the modal. `keyId` is the public key. */
export const MagicOrderSchema = z.object({
  orderId: z.string(),
  keyId: z.string(),
  mode: z.enum(['test', 'live']),
  amountPaise: z.int(),
  currency: z.literal('INR'),
  totalInr: z.number(),
  /** Coupon already taken off `amountPaise`; 0 when none applied. */
  discountInr: z.number(),
  couponCode: z.string().nullable(),
})
export type MagicOrder = z.infer<typeof MagicOrderSchema>

/**
 * GET /v1/payments/magic/orders/:orderId. Public, because a guest has no
 * session, so the phone is reduced to its last four digits and the address is
 * left out. `items` feed the purchase pixels on the success screen.
 */
export const MagicOrderStatusSchema = z.object({
  orderId: z.string(),
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  totalInr: z.number(),
  phoneLast4: z.string().nullable(),
  items: z.array(
    z.object({ sku: z.string(), name: z.string(), priceInr: z.number(), qty: z.number() })
  ),
})
export type MagicOrderStatus = z.infer<typeof MagicOrderStatusSchema>

export const MagicOrderParamsSchema = z.object({ orderId: z.string().min(1).max(64) })

/** Razorpay's shipping-info request. `zipcode` is all we decide on. */
export const RazorpayShippingInfoSchema = z.looseObject({
  addresses: z
    .array(
      z.looseObject({
        id: z.union([z.string(), z.number()]),
        zipcode: z.string(),
        country: z.string().optional(),
      })
    )
    .max(50),
})

export const RazorpayShippingInfoResponseSchema = z.object({
  addresses: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      zipcode: z.string(),
      country: z.string(),
      shipping_methods: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          serviceable: z.boolean(),
          shipping_fee: z.int(),
          cod: z.boolean(),
          cod_fee: z.int(),
        })
      ),
    })
  ),
})
