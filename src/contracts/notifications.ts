/**
 * Ops notification API contracts (docs/SPEC-MANUAL-FULFILMENT.md §4A).
 * Imports nothing but `zod` (ARCHITECTURE.md rule 4).
 */

import { z } from 'zod'

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

/** Result of `POST /v1/admin/notifications/dispatch` — same shape as `SweepResultSchema` in contracts/fulfilment.ts. */
export const OpsNotificationSweepResponseSchema = z.object({
  scanned: z.int(),
  sent: z.int(),
  failed: z.int(),
  skipped: z.int(),
})

export type OpsNotificationSweepResponse = z.infer<typeof OpsNotificationSweepResponseSchema>
