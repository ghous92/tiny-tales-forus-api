/**
 * "Notify me" for a piece that is unpriced or out of stock.
 *
 *   POST /v1/restock-requests   { sku, email? }
 *
 * Signed-in callers are recorded by account and need no email; anyone else
 * must give one. Asking twice is idempotent (one pending request per person
 * and piece), and the answer never reveals whether someone else asked.
 */
import { z } from 'zod'

export const RestockRequestCreateSchema = z.strictObject({
  sku: z.string().min(1).max(100),
  email: z.email().max(254).optional(),
})

export const RestockRequestResponseSchema = z.object({ ok: z.literal(true) })

export type RestockRequestCreate = z.infer<typeof RestockRequestCreateSchema>
