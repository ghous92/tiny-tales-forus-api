/**
 * "No photo to hand?" on /custom/: email the prices and a link back.
 *
 *   POST /v1/custom-leads   { email, kind?, neededBy? }
 *
 * Public. Nothing is stored: the shopper gets one email, and the team inbox
 * gets a note so someone can help with the photo. The answer is the same
 * whether or not the address was seen before.
 */
import { z } from 'zod'

export const CustomLeadCreateSchema = z.strictObject({
  email: z.email().max(254),
  kind: z.enum(['miniature', 'caricature']).optional(),
  /** When they need the piece by, as the date input gives it. */
  neededBy: z.iso.date().optional(),
})

export const CustomLeadResponseSchema = z.object({ ok: z.literal(true) })

export type CustomLeadCreate = z.infer<typeof CustomLeadCreateSchema>
