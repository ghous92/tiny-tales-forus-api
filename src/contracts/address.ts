/**
 * Zod contracts for the address resource — the single source of truth for
 * request validation AND response types (wired into Fastify through
 * `fastify-type-provider-zod`). This module deliberately imports nothing
 * outside `zod` so it can be shared with the mobile repo later.
 *
 * Field names and validation regexes mirror the mobile form
 * (`mobile/src/components/AddressForm.tsx`) byte-for-byte — if that form
 * changes, this file must change in lockstep. See docs/CONTRACTS.md.
 */

import { z } from 'zod'

/** A complete Indian mobile number: 10 digits, first digit 6–9 (mirrors AddressForm). */
export const INDIAN_MOBILE = /^[6-9]\d{9}$/
/** A complete Indian pincode: 6 digits, never leading zero (mirrors AddressForm). */
export const PINCODE = /^[1-9][0-9]{5}$/

const name = z
  .string()
  .trim()
  .min(1, 'Please enter your name')
  .max(100, 'Name must be 100 characters or fewer')
const phone = z.string().regex(INDIAN_MOBILE, 'Please enter a valid 10-digit mobile number')
const pincode = z.string().regex(PINCODE, 'Please enter a valid 6-digit pincode')
const city = z.string().max(100, 'City must be 100 characters or fewer')
const state = z.string().max(100, 'State must be 100 characters or fewer')
const houseNumber = z
  .string()
  .trim()
  .min(1, 'Please enter the house/flat number')
  .max(200, 'House/flat number must be 200 characters or fewer')
const roadArea = z
  .string()
  .trim()
  .min(1, 'Please enter your road name, area or colony')
  .max(200, 'Road name/area must be 200 characters or fewer')

/**
 * POST /v1/addresses body. Strict: unknown keys are rejected. `city`/`state`
 * are optional and may be "" (the mobile form auto-fills them and sends them
 * disabled). The mobile switch `useAsDefault` maps to `isDefault` here.
 */
export const AddressCreateSchema = z.strictObject({
  name,
  phone,
  pincode,
  city: city.default(''),
  state: state.default(''),
  houseNumber,
  roadArea,
  isDefault: z.boolean().default(false),
})

/** PATCH /v1/addresses/:id body — any subset of the create fields, same rules per field. */
export const AddressUpdateSchema = z.strictObject({
  name: name.optional(),
  phone: phone.optional(),
  pincode: pincode.optional(),
  city: city.optional(),
  state: state.optional(),
  houseNumber: houseNumber.optional(),
  roadArea: roadArea.optional(),
  isDefault: z.boolean().optional(),
})

/** Route params for the single-resource endpoints. */
export const AddressParamsSchema = z.strictObject({
  id: z.uuid(),
})

/**
 * The address resource as served by the API: camelCase, phone as a bare
 * 10-digit string (storage is E.164 — serialization strips the +91).
 */
export const AddressSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  pincode: z.string(),
  city: z.string(),
  state: z.string(),
  houseNumber: z.string(),
  roadArea: z.string(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const AddressListSchema = z.array(AddressSchema)

/** The error envelope every non-2xx response uses. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type AddressCreate = z.infer<typeof AddressCreateSchema>
export type AddressUpdate = z.infer<typeof AddressUpdateSchema>
export type Address = z.infer<typeof AddressSchema>
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>
