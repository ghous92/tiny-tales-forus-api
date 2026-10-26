/**
 * Zod contracts for the config resource (SPEC-V2.md §2) — the single source
 * of truth for request validation AND response types. Imports only `zod` so
 * it can be shared with the mobile repo later, same rule as
 * `contracts/address.ts`.
 */

import { z } from 'zod'

/** 16 KB cap on a single value's serialized size (`Buffer.byteLength` of `JSON.stringify`). */
export const MAX_VALUE_BYTES = 16 * 1024

/** Config key: dot-separated lowerCamel segments, e.g. `checkout.whatsappNumber`. */
export const CONFIG_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/

const key = z
  .string()
  .max(100, 'Config key must be 100 characters or fewer')
  .regex(CONFIG_KEY, 'Config key must be dot-separated lowerCamel segments (e.g. "checkout.mode")')

/** Any JSON value, size-capped so a single row can't blow past a sane payload. */
const value = z
  .unknown()
  .refine((val) => Buffer.byteLength(JSON.stringify(val)) <= MAX_VALUE_BYTES, {
    message: `Config value must serialize to ${MAX_VALUE_BYTES} bytes or fewer`,
  })

/** PUT /v1/admin/config/:key body. Strict: unknown keys rejected. */
export const ConfigUpsertSchema = z.strictObject({
  value,
  description: z.string().max(1000, 'Description must be 1000 characters or fewer').optional(),
})

/** Route params for the single-key admin endpoints. */
export const ConfigKeyParamsSchema = z.strictObject({
  key,
})

/**
 * GET /v1/config — public snapshot. `values` carries only the allowlisted
 * keys (`PUBLIC_CONFIG_KEYS` in services/config.ts), not every `app_config`
 * row; the record stays open-ended so adding a key needs no contract change.
 */
export const ConfigSnapshotSchema = z.object({
  version: z.string(),
  updatedAt: z.iso.datetime(),
  values: z.record(z.string(), z.unknown()),
})

/** GET/PUT/DELETE /v1/admin/config* — a single config row, admin view. */
export const ConfigEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  description: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const ConfigEntryListSchema = z.array(ConfigEntrySchema)

/** The error envelope every non-2xx response uses (same shape as address.ts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type ConfigUpsert = z.infer<typeof ConfigUpsertSchema>
export type ConfigKeyParams = z.infer<typeof ConfigKeyParamsSchema>
export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>
