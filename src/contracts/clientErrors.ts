/**
 * Zod contracts for `POST /v1/client-errors` — the canonical wire shape is
 * documented byte-for-byte in docs/CONTRACTS.md; if either changes, both
 * must change in lockstep (same rule as every other contracts file). Imports
 * only `zod` so it can be shared with the mobile/web repos later.
 */

import { z } from 'zod'

export const ClientErrorEventTypeSchema = z.enum([
  'error',
  'unhandledrejection',
  'console.error',
  'memory',
  'rerender',
])

/**
 * One reported event. `meta` is any small, flat bag of extra context a caller
 * wants attached (e.g. a screen name or a memory figure) — kept to primitive
 * values only so a client can't smuggle an arbitrarily large/nested object
 * into a batch that's already size-capped at the route (`bodyLimit: 32 KB`).
 */
export const ClientErrorEventSchema = z.strictObject({
  type: ClientErrorEventTypeSchema,
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

/**
 * POST body. Capped at 20 events per batch — a client is expected to batch
 * its own local buffer of recent errors into one call, not stream one HTTP
 * request per error.
 */
export const ClientErrorsBodySchema = z.strictObject({
  source: z.enum(['web', 'mobile']),
  events: z.array(ClientErrorEventSchema).min(1).max(20),
})

export type ClientErrorsBody = z.infer<typeof ClientErrorsBodySchema>
export type ClientErrorEventInput = z.infer<typeof ClientErrorEventSchema>

/** 202 response — just a count, so the client can sanity-check nothing was dropped in transit. */
export const ClientErrorsAcceptedSchema = z.object({
  accepted: z.number().int().nonnegative(),
})

/** The error envelope every non-2xx response uses (same shape as every other contracts file's copy). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
