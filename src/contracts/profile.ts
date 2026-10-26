/**
 * Zod contracts for the caller's own profile (`/v1/me`) — request validation
 * AND response serialization, wired into Fastify through
 * `fastify-type-provider-zod`. Imports nothing outside `zod` so it can be
 * shared with the mobile repo later (same rule as `contracts/address.ts`).
 *
 * The profile is the name + email captured by the app's post-login prompt,
 * plus the optional `gender`/`dob` captured by the profile screen for
 * analytics/personalization only. None of these are an identity: the
 * Firebase uid and the phone claim remain the only login keys, so every
 * field here is optional/nullable and freely editable.
 */

import { z } from 'zod'

const name = z
  .string()
  .trim()
  .min(1, 'Please enter your name')
  .max(100, 'Name must be 100 characters or fewer')

// Length-capped before the format check so a pathological input fails cheaply.
const email = z
  .string()
  .trim()
  .max(254, 'Email must be 254 characters or fewer')
  .pipe(z.email('Please enter a valid email address'))

const genderEnum = z.enum(['miss', 'mr'])

// Date-only (no time/zone). Bounded to a plausible human lifespan so a typo
// (e.g. a future date, or a 200-year-old) fails validation rather than
// silently polluting analytics.
const dob = z.iso.date('Please enter a valid date of birth').refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`)
  const now = new Date()
  if (parsed.getTime() > now.getTime()) return false
  const minDate = new Date(
    Date.UTC(now.getUTCFullYear() - 120, now.getUTCMonth(), now.getUTCDate())
  )
  return parsed.getTime() >= minDate.getTime()
}, 'Please enter a valid date of birth')

/**
 * PATCH /v1/me body. Strict: unknown keys are rejected. Every field optional
 * (a partial update), but an entirely empty body is rejected — that is always
 * a client bug, never a meaningful no-op.
 */
export const ProfileUpdateSchema = z
  .strictObject({
    name: name.optional(),
    email: email.optional(),
    gender: genderEnum.optional(),
    dob: dob.optional(),
    /**
     * WhatsApp MARKETING opt-in — the replenishment reminder and nothing else.
     * This is the OPT-OUT path as much as the opt-in one: sending `false`
     * withdraws consent, and DPDP requires withdrawal be as easy as granting.
     *
     * Boolean rather than tri-state on the wire: omitting the field means "do
     * not change it", which is what the stored `null` (never asked) already
     * means. There is no way to un-ask a question, and no reason to offer one.
     */
    marketingWhatsappOptIn: z.boolean().optional(),
    /**
     * Ad-audience consent (see `users.adAudienceOptIn`). Same opt-in /
     * opt-out / omitted-means-unchanged semantics as the field above.
     */
    adAudienceOptIn: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.email !== undefined ||
      body.gender !== undefined ||
      body.dob !== undefined ||
      body.marketingWhatsappOptIn !== undefined ||
      body.adAudienceOptIn !== undefined,
    {
      message:
        'Provide at least one of name, email, gender, dob, marketingWhatsappOptIn or adAudienceOptIn',
    }
  )

/**
 * The profile resource: `phone` is a bare 10-digit string (storage is E.164),
 * matching the address contract. `name`/`email`/`gender`/`dob` are null until
 * captured.
 */
export const ProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  gender: genderEnum.nullable(),
  dob: z.iso.date().nullable(),
  phone: z.string(),
  /**
   * Tri-state, and null is NOT the same as false — see
   * `users.marketingWhatsappOptIn`. Null means never asked, which is what a
   * settings screen should render as an unticked box it still wants an answer
   * to; false means they answered no.
   */
  marketingWhatsappOptIn: z.boolean().nullable(),
  /** Tri-state like the field above — see `users.adAudienceOptIn`. */
  adAudienceOptIn: z.boolean().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

/** The error envelope every non-2xx response uses. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>
export type Profile = z.infer<typeof ProfileSchema>
