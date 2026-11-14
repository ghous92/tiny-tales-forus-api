/**
 * Caricature and miniature previews, and the uploaded-character check
 * (contracts/customRequests.ts). Both call OpenAI and cost money per call, so
 * previews are counted against limits per photo, per shopper per day, and for
 * everyone per day (services/caricaturePreviews.ts).
 *
 * A shopper need not sign in to see a preview. Every shopper who was asked to
 * sign in before one closed the dialog, so the preview is where the sign-in
 * wall used to be and sign-in is asked for at add-to-bag only. Without a
 * token the browser sends its own id in `X-Preview-Guest`; a guest gets fewer
 * previews, a per-connection brake on top, and when they sign in their
 * previews move onto the account. The saved-preview list and its pictures stay
 * signed-in only: a guessed browser id must not open someone's photos.
 *
 * The browser sends the photo bytes and either a gallery id or a character
 * picture; the words the image model is given are built here
 * (lib/caricatureCharacters.ts), never taken from the request.
 */
import { createHash } from 'node:crypto'

import multipart from '@fastify/multipart'
import type { FastifyReply, FastifyRequest } from 'fastify'
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
  miniaturePrompt,
  renderCaricature,
  uploadedCharacterPrompt,
  type OpenAiImage,
} from '../lib/openai.js'
import {
  PreviewLimitError,
  type PreviewOwner,
  claimGuestPreviews,
  findSavedPreview,
  getSavedPreviewImage,
  guestIdFromHeader,
  keepPreviewSources,
  listSavedPreviews,
  photosLeft,
  previewQuota,
  reservePreview,
  settlePreview,
} from '../services/caricaturePreviews.js'
import { sniffImageType } from './customRequests.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `identify` on the preview routes a guest may call. */
    previewOwner: PreviewOwner | null
  }
}

const guestIdOf = (request: FastifyRequest) =>
  guestIdFromHeader(request.headers['x-preview-guest'])

/**
 * Guests are only told apart by an id the browser chose, so a per-connection
 * brake sits on top of the per-guest limits: this many preview attempts per
 * IP per India day, counted whether or not the render succeeds.
 */
const GUEST_IP_PREVIEWS_PER_DAY = 6
const GUEST_IP_MAX_KEYS = 20_000
const guestIpBuckets = new Map<string, { count: number; windowStart: number }>()

function guestIpLimited(ip: string, now: number): boolean {
  const entry = guestIpBuckets.get(ip)
  if (!entry || now - entry.windowStart >= 24 * 60 * 60_000) {
    if (guestIpBuckets.size >= GUEST_IP_MAX_KEYS) {
      const oldest = guestIpBuckets.keys().next()
      if (!oldest.done) guestIpBuckets.delete(oldest.value)
    }
    guestIpBuckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > GUEST_IP_PREVIEWS_PER_DAY
}

/** Test seam — resets the guest brake between cases. */
export function clearGuestPreviewRateLimits(): void {
  guestIpBuckets.clear()
}

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const CHECKS_PER_WINDOW = 10
const CHECK_WINDOW_MS = 60 * 60_000
const CHECK_MAX_USERS = 5_000
const checkBuckets = new Map<string, { count: number; windowStart: number }>()

/** Fixed-window per-owner brake on character checks, same shape as the photo-upload one. */
function checkRateLimited(ownerKey: string, now: number): boolean {
  const entry = checkBuckets.get(ownerKey)
  if (!entry || now - entry.windowStart >= CHECK_WINDOW_MS) {
    if (checkBuckets.size >= CHECK_MAX_USERS) {
      const oldest = checkBuckets.keys().next()
      if (!oldest.done) checkBuckets.delete(oldest.value)
    }
    checkBuckets.set(ownerKey, { count: 1, windowStart: now })
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
  guestDay: {
    status: 429,
    code: 'limit_exceeded',
    message: 'You have used today’s previews. Sign in for more, or send your request without one.',
  },
  connection: {
    status: 429,
    code: 'limit_exceeded',
    message: 'Previews from this connection are used up for today. Sign in to make more.',
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

/**
 * `characterId` for a miniature preview: no costume, true to life. Stored as
 * 'tpl:miniature' and counted against the same limits as a caricature's.
 */
export const MINIATURE_PREVIEW_ID = 'miniature'

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

/**
 * Mounted at '/v1/custom-requests'. Previews, the quota and the character
 * check take a signed-in shopper (a Google/Apple sign-in without a phone is
 * enough) or a guest with an X-Preview-Guest id; the saved list and its
 * pictures take a signed-in shopper only.
 */
export const caricaturePreviewRoutes: FastifyPluginAsyncZod<
  CaricaturePreviewRoutesOptions
> = async (app, opts) => {
  const { db, apiKey, openaiFetchImpl = fetch, intakeFetchImpl = fetch } = opts
  app.decorateRequest('previewOwner', null)

  /**
   * Who is asking: a bearer token makes this the signed-in shopper (and claims
   * any previews their browser made before signing in); otherwise the browser
   * id. Neither -> 401, the same answer the signed-in-only routes give.
   */
  async function identify(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const guestId = guestIdOf(request)
    if (request.headers.authorization) {
      await app.authenticateAnyProvider(request, reply)
      if (reply.sent) return
      request.previewOwner = { kind: 'user', id: request.user.id }
      if (guestId) {
        const moved = await claimGuestPreviews(db, request.user.id, guestId)
        if (moved) request.log.info({ moved }, 'guest previews claimed')
      }
      return
    }
    if (!guestId) {
      return reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'Sign in, or allow this site to remember your previews on this device.',
        },
      })
    }
    request.previewOwner = { kind: 'guest', id: guestId }
  }

  function ownerOf(request: FastifyRequest): PreviewOwner {
    const owner = request.previewOwner
    if (!owner) throw new Error('preview route without identify')
    return owner
  }

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
      onRequest: identify,
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
    async (request) => previewQuota(db, ownerOf(request), new Date(), request.query.photo)
  )

  // The shopper's own earlier previews, so they can come back and order.
  app.get(
    '/previews/mine',
    {
      onRequest: app.authenticateAnyProvider,
      schema: { response: { 200: SavedPreviewsSchema, ...errorResponses } },
    },
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
      onRequest: app.authenticateAnyProvider,
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
    {
      onRequest: identify,
      schema: { response: { 200: CharacterCheckResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      if (!apiKey) return reply.code(503).send(disabled)
      const owner = ownerOf(request)
      if (checkRateLimited(`${owner.kind}:${owner.id}`, Date.now())) {
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
        const judgement = await judgeCharacter({
          fetchImpl: openaiFetchImpl,
          apiKey,
          model: opts.visionModel,
          image: character,
        })
        // The verdict is not stored anywhere else; without this line a shopper
        // who leaves after a rejection is indistinguishable from one who passed.
        request.log.info(
          { verdict: judgement.verdict, franchise: judgement.franchise },
          'character check'
        )
        return judgement
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
    {
      onRequest: identify,
      schema: { response: { 200: CaricaturePreviewResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      if (!apiKey) return reply.code(503).send(disabled)
      const owner = ownerOf(request)
      if (owner.kind === 'guest' && guestIpLimited(request.ip, Date.now())) {
        const r = LIMIT_REPLIES.connection
        return reply.code(r.status).send({ error: { code: r.code, message: r.message } })
      }
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
      if (galleryId === MINIATURE_PREVIEW_ID && !uploaded) {
        prompt = miniaturePrompt(cast)
        characterRef = `tpl:${MINIATURE_PREVIEW_ID}`
      } else if (uploaded) {
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
      const saved = await findSavedPreview(db, owner, photoHash, characterRef)
      if (saved) {
        if (!saved.hasPhoto) {
          await keepPreviewSources(db, saved.id, {
            photo: photo.bytes,
            characterImage: uploaded?.bytes ?? null,
          })
        }
        const quota = await previewQuota(db, owner)
        return {
          image: `data:image/jpeg;base64,${saved.image.toString('base64')}`,
          previewKey: saved.previewKey,
          remaining: {
            photo: await photosLeft(db, owner, photoHash),
            today: Math.max(0, quota.perDay - quota.usedToday),
          },
        }
      }

      let reservation: Awaited<ReturnType<typeof reservePreview>>
      try {
        reservation = await reservePreview(db, {
          owner,
          photoHash,
          character: characterRef,
          characters,
          model: opts.imageModel,
          dailyCap: opts.dailyCap,
        })
      } catch (err) {
        if (!(err instanceof PreviewLimitError)) throw err
        const r =
          err.limit === 'day' && owner.kind === 'guest'
            ? LIMIT_REPLIES.guestDay
            : LIMIT_REPLIES[err.limit]
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
                message:
                  uploaded || galleryId === MINIATURE_PREVIEW_ID
                    ? REFUSED_MESSAGE
                    : REFUSED_GALLERY_MESSAGE,
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
