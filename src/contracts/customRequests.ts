/**
 * Custom pieces made from a shopper's photographs: a miniature (full figure)
 * or a caricature (head and shoulders, exaggerated). The storefront checks
 * every photo in the browser before upload (blur, side pose, old or
 * black-and-white photos, checked clothes, framing); the API stores the
 * request, the photos and that check report for the team to quote from.
 *
 *   POST  /v1/custom-requests/photos              upload one photo (multipart {file})
 *   POST  /v1/custom-requests                     submit a request
 *   GET   /v1/custom-requests                     the caller's requests, newest first
 *   GET   /v1/custom-requests/miniature-allowance unpaid miniature pieces left on this device
 *   GET   /v1/admin/custom-requests               every request, newest first
 *   PATCH /v1/admin/custom-requests/:requestNumber move a request through review
 *
 * Caricatures also choose a character (a gallery costume, or a picture the
 * shopper uploads) and may see a preview made by an image model:
 *
 *   POST  /v1/custom-requests/character-checks    judge an uploaded character (multipart {character})
 *   POST  /v1/custom-requests/previews            render a preview (multipart {photo, character | characterId})
 *   GET   /v1/custom-requests/previews/quota      previews left today
 */
import { z } from 'zod'

import { CARICATURE_CHARACTER_IDS } from '../lib/caricatureCharacters.js'
import { MAX_FIGURE_CHARACTERS } from '../lib/customFigures.js'

export const CustomKindSchema = z.enum(['miniature', 'caricature'])

export const CustomRequestStatusSchema = z.enum([
  'submitted',
  'in_review',
  'quoted',
  'declined',
  'closed',
])

/** An image-intake object key (a UUID, optionally with a path and extension). */
const photoKey = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9/_.-]+$/, 'photo keys are image-intake object keys')

/**
 * One browser-side check as the shopper saw it. Stored for the team, never
 * trusted as a gate: a request is accepted on its own merits server-side.
 */
const PhotoCheckSchema = z.strictObject({
  id: z.string().min(1).max(40),
  status: z.enum(['pass', 'fail', 'skip']),
})

export const CharacterVerdictSchema = z.enum(['good', 'note', 'reject'])

/** What a caricature wears: a gallery costume, or a character picture the shopper sent. */
export const CaricatureCharacterSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('gallery'), id: z.enum(CARICATURE_CHARACTER_IDS) }),
  z.strictObject({
    type: z.literal('upload'),
    key: photoKey,
    /** The character check the shopper was shown; stored for the team, not trusted. */
    verdict: CharacterVerdictSchema.optional(),
    franchise: z.string().max(80).nullable().optional(),
  }),
])

export const CustomPhotoSchema = z.strictObject({
  key: photoKey,
  /** What the browser measured, e.g. { sharpness: 182, yawDeg: 9 }. */
  metrics: z.record(z.string().max(40), z.number()).optional(),
  checks: z.array(PhotoCheckSchema).max(20).optional(),
  /** People and pets the browser counted in this photo: the piece's size, and its sku. */
  characters: z.number().int().min(1).max(MAX_FIGURE_CHARACTERS).optional(),
  /** Caricatures only: the costume for everyone in this photo. */
  character: CaricatureCharacterSchema.optional(),
  /** image-intake key of the preview the shopper last saw, if any. */
  previewKey: photoKey.optional(),
})

export const CustomColoursSchema = z.strictObject({
  /** Paint it as the photo shows, or the shopper describes the colours. */
  mode: z.enum(['as_photo', 'custom']),
  notes: z.string().trim().max(500).optional(),
})

/** The random id the browser keeps for itself: not personal data, and not proof of anything. */
export const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{16,64}$/)

export const CustomRequestCreateSchema = z
  .strictObject({
    kind: CustomKindSchema,
    deviceId: DeviceIdSchema.optional(),
    photos: z.array(CustomPhotoSchema).min(1, 'Add at least one photo').max(6, 'Up to 6 photos'),
    colours: CustomColoursSchema,
    notes: z.string().trim().max(2000).optional(),
    pincode: z
      .string()
      .regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode')
      .optional(),
    /** YYYY-MM-DD the shopper needs it by, if any. */
    neededBy: z.iso.date().optional(),
  })
  .refine((v) => v.colours.mode === 'as_photo' || (v.colours.notes ?? '').length >= 3, {
    message: 'Tell us the colours you want',
    path: ['colours', 'notes'],
  })
  .refine((v) => v.kind === 'caricature' || v.photos.every((p) => !p.character), {
    message: 'Characters are for caricatures only',
    path: ['photos'],
  })

export const CustomRequestSchema = z.object({
  requestNumber: z.string(),
  kind: CustomKindSchema,
  photoKeys: z.array(z.string()),
  colours: CustomColoursSchema,
  notes: z.string().nullable(),
  pincode: z.string().nullable(),
  neededBy: z.string().nullable(),
  status: CustomRequestStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const MiniatureAllowanceQuerySchema = z.object({
  device: DeviceIdSchema.optional(),
})

export const MiniatureAllowanceSchema = z.object({
  limit: z.number().int(),
  used: z.number().int(),
  left: z.number().int(),
})

export const CustomRequestListResponseSchema = z.object({
  requests: z.array(CustomRequestSchema),
})

export const CustomRequestAdminSchema = CustomRequestSchema.extend({
  userId: z.string(),
  phone: z.string().nullable(),
  photos: z.array(CustomPhotoSchema),
  adminNote: z.string().nullable(),
})

export const CustomRequestAdminListResponseSchema = z.object({
  requests: z.array(CustomRequestAdminSchema),
})

export const CustomRequestParamsSchema = z.object({
  requestNumber: z.string().min(1).max(40),
})

export const CustomRequestAdminUpdateSchema = z.strictObject({
  status: CustomRequestStatusSchema,
  adminNote: z.string().trim().max(2000).optional(),
})

export const CustomPhotoUploadResponseSchema = z.object({
  key: z.string(),
  /** Small preview, served by image-intake. */
  thumbUrl: z.string(),
})

export const PreviewQuotaSchema = z.object({
  perPhoto: z.number().int(),
  perDay: z.number().int(),
  usedToday: z.number().int(),
  /** With `?photo=<sha-256 of the photo bytes>`: previews used on that photo. */
  photoUsed: z.number().int().optional(),
  /** With `?photo=`: 'tpl:<id>' / 'up:<hash>' characters already previewed, free again. */
  saved: z.array(z.string()).optional(),
})

export const SavedPreviewsSchema = z.object({
  previews: z.array(
    z.object({
      id: z.string().uuid(),
      /** 'tpl:<gallery id>' or 'up:<hash>'. */
      character: z.string(),
      previewKey: z.string().nullable(),
      /** SHA-256 of the photo, to match it to a photo already in the form. */
      photoHash: z.string(),
      /** Whether the photo is kept, so the preview can be ordered from the list alone. */
      hasPhoto: z.boolean(),
      /** People and pets in the photo, which sets the piece's price. */
      characters: z.number().int(),
      createdAt: z.string(),
    })
  ),
})

export const CaricaturePreviewResponseSchema = z.object({
  /** The rendered figurine as a JPEG data URL, shown straight away. */
  image: z.string(),
  /** Where it is kept for the team, when image storage is configured. */
  previewKey: z.string().nullable(),
  remaining: z.object({ photo: z.number().int(), today: z.number().int() }),
})

export const CharacterCheckResponseSchema = z.object({
  verdict: CharacterVerdictSchema,
  headline: z.string(),
  detail: z.string(),
  franchise: z.string().nullable(),
})

export type CustomKind = z.infer<typeof CustomKindSchema>
export type CustomRequestCreate = z.infer<typeof CustomRequestCreateSchema>
export type CustomRequest = z.infer<typeof CustomRequestSchema>
export type CustomRequestAdmin = z.infer<typeof CustomRequestAdminSchema>
export type CustomRequestAdminUpdate = z.infer<typeof CustomRequestAdminUpdateSchema>
export type CustomPhoto = z.infer<typeof CustomPhotoSchema>
