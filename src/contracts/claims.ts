/**
 * Damage claims: the only return path (no change-of-mind returns).
 *
 *   POST  /v1/claims                       file a claim for one order line
 *   GET   /v1/claims                       the caller's claims, newest first
 *   GET   /v1/claims/:claimNumber          one of the caller's claims
 *   GET   /v1/admin/claims                 every claim, newest first
 *   PATCH /v1/admin/claims/:claimNumber    move a claim through review
 *
 * A claim is accepted only for a PAID order of the caller's whose shipment has
 * a recorded delivery, inside `returns.damageWindowHours` of that delivery.
 */
import { z } from 'zod'

export const ClaimStatusSchema = z.enum([
  'submitted',
  'in_review',
  'approved_refund',
  'approved_replacement',
  'rejected',
])

/** An image-intake object key, e.g. "2026/10/26/ab12cd.jpg". */
const photoKey = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9/_.-]+$/, 'photo keys are image-intake object keys')

export const ClaimCreateSchema = z.strictObject({
  orderId: z.string().min(1).max(100),
  sku: z.string().min(1).max(100),
  qty: z.number().int().min(1).max(99).optional(),
  description: z
    .string()
    .min(10, 'Tell us what arrived damaged (at least 10 characters)')
    .max(2000, 'description must be 2000 characters or fewer'),
  photoKeys: z.array(photoKey).min(1, 'Add at least one photo').max(6, 'Up to 6 photos'),
  unboxingVideoUrl: z.url().max(2048).optional(),
})

export const ClaimSchema = z.object({
  claimNumber: z.string(),
  orderId: z.string(),
  sku: z.string(),
  qty: z.int(),
  description: z.string(),
  photoKeys: z.array(z.string()),
  unboxingVideoUrl: z.string().nullable(),
  deliveredAt: z.iso.datetime(),
  status: ClaimStatusSchema,
  resolutionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
})

export const ClaimListResponseSchema = z.object({ claims: z.array(ClaimSchema) })

export const ClaimParamsSchema = z.strictObject({ claimNumber: z.string().min(1).max(64) })

export const ClaimAdminSchema = ClaimSchema.extend({ userId: z.uuid() })

export const ClaimAdminListResponseSchema = z.object({ claims: z.array(ClaimAdminSchema) })

export const ClaimAdminUpdateSchema = z.strictObject({
  status: ClaimStatusSchema,
  resolutionNote: z.string().min(1).max(2000).optional(),
})

export type ClaimStatus = z.infer<typeof ClaimStatusSchema>
export type ClaimCreate = z.infer<typeof ClaimCreateSchema>
export type Claim = z.infer<typeof ClaimSchema>
export type ClaimAdmin = z.infer<typeof ClaimAdminSchema>
export type ClaimAdminUpdate = z.infer<typeof ClaimAdminUpdateSchema>
