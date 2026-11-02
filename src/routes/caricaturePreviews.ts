/**
 * Caricature previews and the uploaded-character check
 * (contracts/customRequests.ts). Both call OpenAI and cost money per call, so
 * both are signed-in only, and previews are counted against limits per photo,
 * per shopper per day, and for everyone per day (services/caricaturePreviews.ts).
 *
 * The browser sends the photo bytes and either a gallery id or a character
 * picture; the words the image model is given are built here
 * (lib/caricatureCharacters.ts), never taken from the request.
 */
import { createHash } from 'node:crypto'

import multipart from '@fastify/multipart'
import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  CaricaturePreviewResponseSchema,
  CharacterCheckResponseSchema,
  PreviewQuotaSchema,
  SavedPreviewsSchema,
} from '../contracts/customRequests.js'
import type { Db } from '../db/client.js'
import {
  AS_PHOTO_ID,
  CARICATURE_CHARACTERS,
  type CaricatureCharacterId,
} from '../lib/caricatureCharacters.js'
import { MAX_FIGURE_CHARACTERS } from '../lib/customFigures.js'
import { ImageIntakeError, uploadToImageIntake } from '../lib/imageIntake.js'
import {
  OpenAiError,
  asPhotoPrompt,
  galleryPrompt,
  judgeCharacter,
  renderCaricature,
  uploadedCharacterPrompt,
  type OpenAiImage,
} from '../lib/openai.js'
import {
  PreviewLimitError,
  findSavedPreview,
  getSavedPreviewImage,
  keepPreviewSources,
  listSavedPreviews,
  photosLeft,
  previewQuota,
  reservePreview,
  settlePreview,
} from '../services/caricaturePreviews.js'
import { sniffImageType } from './customRequests.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const CHECKS_PER_WINDOW = 10
const CHECK_WINDOW_MS = 60 * 60_000
const CHECK_MAX_USERS = 5_000
const checkBuckets = new Map<string, { count: number; windowStart: number }>()

/** Fixed-window per-user brake on character checks, same shape as the photo-upload one. */
function checkRateLimited(userId: string, now: number): boolean {
  const entry = checkBuckets.get(userId)
  if (!entry || now - entry.windowStart >= CHECK_WINDOW_MS) {
    if (checkBuckets.size >= CHECK_MAX_USERS) {
      const oldest = checkBuckets.keys().next()
      if (!oldest.done) checkBuckets.delete(oldest.value)
    }
    checkBuckets.set(userId, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > CHECKS_PER_WINDOW
}

/** Test seam — resets the limiter between cases. */
export function clearCharacterCheckRateLimits(): void {
  checkBuckets.clear()
}

const LIMIT_REPLIES = {
  photo: {
    status: 429,
    code: 'limit_exceeded',
    message:
      'You have seen both previews for this photo. Send your request, and our artist will send a proof before printing.',
  },
  day: {
    status: 429,
    code: 'limit_exceeded',
    message:
      'You have used today’s previews. Send your request without one, or try again tomorrow.',
  },
  busy: {
    status: 503,
    code: 'preview_busy',
    message:
      'Previews are busy today. Send your request, and our artist will send a proof before printing.',
  },
} as const

const REFUSED_MESSAGE =
  'We cannot make a preview of this photo. Our artist can still make it, and will send you a proof before printing.'

const REFUSED_GALLERY_MESSAGE =
  'We could not make this outfit with this photo. Try another character; this photo’s previews were not used up. Our artist can still make it, and will send you a proof before printing.'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export interface CaricaturePreviewRoutesOptions {
  db: Db
  /** Absent -> every route here answers 503 `preview_disabled`. */
  apiKey?: string | undefined
  imageModel: string
  visionModel: string
  dailyCap: number
  /** Where a rendered preview is kept for the team; absent -> not kept. */
  imageIntakeBaseUrl: string
  uploadToken?: string | undefined
  /** Test seams. */
  openaiFetchImpl?: typeof fetch
  intakeFetchImpl?: typeof fetch
}

/** Mounted at '/v1/custom-requests'. Authenticated. */
export const caricaturePreviewRoutes: FastifyPluginAsyncZod<
  CaricaturePreviewRoutesOptions
> = async (app, opts) => {
  const { db, apiKey, openaiFetchImpl = fetch, intakeFetchImpl = fetch } = opts
  app.addHook('onRequest', app.authenticate)

  await app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 2, fields: 4 },
  })

  const disabled = {
    error: {
      code: 'preview_disabled',
      message: 'Previews are not available right now. You can still send your request.',
    },
  }

  /** Read the multipart body: image files by field name, and plain fields. */
  async function readParts(
    request: FastifyRequest
  ): Promise<
    | { ok: true; files: Map<string, OpenAiImage>; fields: Map<string, string> }
    | { ok: false; status: number; message: string }
  > {
    const files = new Map<string, OpenAiImage>()
    const fields = new Map<string, string>()
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer()
          const mimetype = sniffImageType(bytes)
          if (!mimetype) {
            return { ok: false, status: 400, message: 'Send pictures as JPEG, PNG or WebP.' }
          }
          files.set(part.fieldname, { bytes, mimetype })
        } else if (typeof part.value === 'string') {
          fields.set(part.fieldname, part.value)
        }
      }
    } catch {
      return { ok: false, status: 413, message: 'A picture is over 10 MB.' }
    }
    return { ok: true, files, fields }
  }

  app.get(
    '/previews/quota',
    {
      schema: {
        querystring: z.object({
          photo: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        }),
        response: { 200: PreviewQuotaSchema, ...errorResponses },
      },
    },
    async (request) => previewQuota(db, request.user.id, new Date(), request.query.photo)
  )

  // The shopper's own earlier previews, so they can come back and order.
  app.get(
    '/previews/mine',
    { schema: { response: { 200: SavedPreviewsSchema, ...errorResponses } } },
    async (request) => {
      const rows = await listSavedPreviews(db, request.user.id)
      return {
        previews: rows.map((r) => ({
          id: r.id,
          character: r.character,
          previewKey: r.previewKey,
          photoHash: r.photoHash,
          hasPhoto: r.hasPhoto,
          characters: r.characters,
          createdAt: r.createdAt.toISOString(),
        })),
      }
    }
  )

  // The render, the photo it was made from, and their own character picture:
  // enough to put a saved preview back in the order form.
  const PARTS = { image: 'image', photo: 'photo', character: 'characterImage' } as const
  app.get(
    '/previews/:id/:part',
    {
      schema: {
        params: z.object({
          id: z.string().uuid(),
          part: z.enum(['image', 'photo', 'character']),
        }),
      },
    },
    async (request, reply) => {
      const { id, part } = request.params
      const bytes = await getSavedPreviewImage(db, request.user.id, id, PARTS[part])
      if (!bytes) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'No such preview.' } })
      }
      return reply
        .header('content-type', sniffImageType(bytes) ?? 'image/jpeg')
        .header('cache-control', 'private, max-age=86400')
        .send(bytes)
    }
  )

  app.post(
    '/character-checks',
    { schema: { response: { 200: CharacterCheckResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      if (!apiKey) return reply.code(503).send(disabled)
      if (checkRateLimited(request.user.id, Date.now())) {
        return reply.code(429).send({
          error: {
            code: 'limit_exceeded',
            message: 'Too many characters checked. Try again in an hour.',
          },
        })
      }
      const parts = await readParts(request)
      if (!parts.ok) {
        return reply
          .code(parts.status)
          .send({ error: { code: 'validation_failed', message: parts.message } })
      }
      const character = parts.files.get('character')
      if (!character) {
        return reply
          .code(400)
          .send({ error: { code: 'validation_failed', message: 'No character picture sent.' } })
      }
      try {
        return await judgeCharacter({
          fetchImpl: openaiFetchImpl,
          apiKey,
          model: opts.visionModel,
          image: character,
        })
      } catch (err) {
        if (!(err instanceof OpenAiError)) throw err
        request.log.warn({ err: err.message }, 'character check failed')
        if (err.refused) {
          return reply.send({
            verdict: 'reject' as const,
            headline: 'We can’t use this picture',
            detail: 'Choose a different picture, or pick a character from our gallery.',
            franchise: null,
          })
        }
        return reply.code(502).send({
          error: {
            code: 'preview_failed',
            message: 'We could not check the picture just now. Try again in a minute.',
          },
        })
      }
    }
  )

  app.post(
    '/previews',
    { schema: { response: { 200: CaricaturePreviewResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      if (!apiKey) return reply.code(503).send(disabled)
      const parts = await readParts(request)
      if (!parts.ok) {
        return reply
          .code(parts.status)
          .send({ error: { code: 'validation_failed', message: parts.message } })
      }
      const photo = parts.files.get('photo')
      if (!photo) {
        return reply
          .code(400)
          .send({ error: { code: 'validation_failed', message: 'No photo sent.' } })
      }

      const uploaded = parts.files.get('character')
      const galleryId = parts.fields.get('characterId')
      const characters = Number(parts.fields.get('characters') ?? 1)
      const animals = Number(parts.fields.get('animals') ?? 0)
      if (
        !Number.isInteger(characters) ||
        characters < 1 ||
        characters > MAX_FIGURE_CHARACTERS ||
        !Number.isInteger(animals) ||
        animals < 0 ||
        animals > characters
      ) {
        return reply.code(400).send({
          error: {
            code: 'validation_failed',
            message: `A piece can have up to ${MAX_FIGURE_CHARACTERS} people or pets.`,
          },
        })
      }
      const cast = { characters, animals }
      let prompt: string
      let characterRef: string
      const images: OpenAiImage[] = [photo]
      if (uploaded) {
        prompt = uploadedCharacterPrompt(cast)
        characterRef = `up:${sha256(uploaded.bytes)}`
        images.push(uploaded)
      } else if (galleryId && Object.hasOwn(CARICATURE_CHARACTERS, galleryId)) {
        prompt =
          galleryId === AS_PHOTO_ID
            ? asPhotoPrompt(cast)
            : galleryPrompt(CARICATURE_CHARACTERS[galleryId as CaricatureCharacterId].costume, cast)
        characterRef = `tpl:${galleryId}`
      } else {
        return reply
          .code(400)
          .send({ error: { code: 'validation_failed', message: 'Choose a character first.' } })
      }

      // Same photo and character as one already paid for: hand that back, free.
      const photoHash = sha256(photo.bytes)
      const saved = await findSavedPreview(db, request.user.id, photoHash, characterRef)
      if (saved) {
        if (!saved.hasPhoto) {
          await keepPreviewSources(db, saved.id, {
            photo: photo.bytes,
            characterImage: uploaded?.bytes ?? null,
          })
        }
        const quota = await previewQuota(db, request.user.id)
        return {
          image: `data:image/jpeg;base64,${saved.image.toString('base64')}`,
          previewKey: saved.previewKey,
          remaining: {
            photo: await photosLeft(db, request.user.id, photoHash),
            today: Math.max(0, quota.perDay - quota.usedToday),
          },
        }
      }

      let reservation: Awaited<ReturnType<typeof reservePreview>>
      try {
        reservation = await reservePreview(db, {
          userId: request.user.id,
          photoHash,
          character: characterRef,
          characters,
          model: opts.imageModel,
          dailyCap: opts.dailyCap,
        })
      } catch (err) {
        if (!(err instanceof PreviewLimitError)) throw err
        const r = LIMIT_REPLIES[err.limit]
        return reply.code(r.status).send({ error: { code: r.code, message: r.message } })
      }

      let rendered: Awaited<ReturnType<typeof renderCaricature>>
      try {
        rendered = await renderCaricature({
          fetchImpl: openaiFetchImpl,
          apiKey,
          model: opts.imageModel,
          prompt,
          images,
        })
      } catch (err) {
        if (!(err instanceof OpenAiError)) {
          await settlePreview(db, reservation.id, { status: 'failed' })
          throw err
        }
        request.log.warn({ err: err.message, refused: err.refused }, 'caricature preview failed')
        await settlePreview(db, reservation.id, { status: err.refused ? 'refused' : 'failed' })
        return err.refused
          ? reply.code(422).send({
              error: {
                code: 'preview_refused',
                message: uploaded ? REFUSED_MESSAGE : REFUSED_GALLERY_MESSAGE,
              },
            })
          : reply.code(502).send({
              error: {
                code: 'preview_failed',
                message: 'The preview did not come through. Try again; this one was not counted.',
              },
            })
      }

      // Kept for the team so they can see what the shopper approved. A failed
      // upload costs the shopper nothing: they still get the preview.
      let previewKey: string | null = null
      if (opts.uploadToken) {
        try {
          previewKey = (
            await uploadToImageIntake({
              fetchImpl: intakeFetchImpl,
              baseUrl: opts.imageIntakeBaseUrl,
              uploadToken: opts.uploadToken,
              bytes: rendered.jpeg,
              mimetype: 'image/jpeg',
              filename: 'caricature-preview.jpg',
            })
          ).key
        } catch (err) {
          if (!(err instanceof ImageIntakeError)) throw err
          request.log.warn({ err: err.message }, 'caricature preview not stored')
        }
      }

      await settlePreview(db, reservation.id, {
        status: 'ok',
        inputTokens: rendered.usage.inputTokens,
        outputTokens: rendered.usage.outputTokens,
        previewKey,
        image: rendered.jpeg,
        photo: photo.bytes,
        characterImage: uploaded?.bytes ?? null,
      })
      return {
        image: `data:image/jpeg;base64,${rendered.jpeg.toString('base64')}`,
        previewKey,
        remaining: { photo: reservation.photoLeft, today: reservation.todayLeft },
      }
    }
  )
}
