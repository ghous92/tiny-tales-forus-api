/**
 * Custom miniature and caricature requests (contracts/customRequests.ts).
 *
 * The photo upload proxies to image-intake so its upload token never reaches
 * the browser (same reason as routes/mediaAdmin.ts). Only JPEG, PNG and WebP
 * are accepted, checked by their leading bytes rather than the declared type:
 * the storefront re-encodes every photo to JPEG after checking it.
 */
import multipart from '@fastify/multipart'
import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  CustomPhotoUploadResponseSchema,
  CustomRequestAdminListResponseSchema,
  CustomRequestAdminSchema,
  CustomRequestAdminUpdateSchema,
  CustomRequestCreateSchema,
  CustomRequestListResponseSchema,
  CustomRequestParamsSchema,
  CustomRequestSchema,
  MiniatureAllowanceQuerySchema,
  MiniatureAllowanceSchema,
  type CustomPhoto,
  type CustomRequest,
} from '../contracts/customRequests.js'
import type { Db } from '../db/client.js'
import { customUploads } from '../db/schema.js'
import { escapeHtml, sendTransactionalEmail, type EmailSenderConfig } from '../lib/email.js'
import { ImageIntakeError, uploadToImageIntake } from '../lib/imageIntake.js'
import {
  createCustomRequest,
  listAllCustomRequests,
  listCustomRequests,
  miniatureAllowance,
  updateCustomRequestStatus,
} from '../services/customRequests.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Mirrors the Worker's own cap. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const UPLOADS_PER_WINDOW = 30
const UPLOAD_WINDOW_MS = 10 * 60_000
const UPLOAD_MAX_USERS = 5_000
const uploadBuckets = new Map<string, { count: number; windowStart: number }>()

/** Fixed-window per-user brake on photo uploads, same shape as routes/restock.ts. */
function uploadRateLimited(userId: string, now: number): boolean {
  const entry = uploadBuckets.get(userId)
  if (!entry || now - entry.windowStart >= UPLOAD_WINDOW_MS) {
    if (uploadBuckets.size >= UPLOAD_MAX_USERS) {
      const oldest = uploadBuckets.keys().next()
      if (!oldest.done) uploadBuckets.delete(oldest.value)
    }
    uploadBuckets.set(userId, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > UPLOADS_PER_WINDOW
}

/** Test seam — resets the limiter between cases. */
export function clearCustomUploadRateLimits(): void {
  uploadBuckets.clear()
}

/** The image type the bytes really are, or null when it is none we accept. */
export function sniffImageType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export interface CustomRequestRoutesOptions {
  db: Db
  /** Base URL of the image-intake Worker, no trailing slash. */
  imageIntakeBaseUrl: string
  /** Absent -> the photo upload answers 503 `media_disabled`. */
  uploadToken?: string | undefined
  /** Test seam: inject a fetch instead of calling the real Worker. */
  fetchImpl?: typeof fetch
  /**
   * Brevo sender for the hand-check email, on the same credentials as the
   * other alert senders. Absent (or no `alertEmailTo`) -> requests are still
   * created; only the email is skipped.
   */
  email?: EmailSenderConfig | undefined
  /** `ALERT_EMAIL_TO`: the team inbox the hand-check email goes to. */
  alertEmailTo?: string | undefined
  /** Test seam: injected fetch for the Brevo call. */
  emailFetchImpl?: typeof fetch
}

/**
 * Why the team must look at this photo by hand before modelling, or null when
 * the storefront's checker passed it. The checker is advice, not a gate: the
 * shopper may send a photo it flagged ("Use this photo"), and a slow or
 * missing checker lets a photo through unjudged. The storefront promises
 * these are checked by hand, so each one is mailed to the team.
 */
export function handCheckReason(photo: CustomPhoto): string | null {
  const failed = (photo.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id)
  const m = photo.metrics ?? {}
  if (failed.length) return `Sent past the photo checker. Failed: ${failed.join(', ')}`
  if (m.checkerTimedOut) return 'The photo checker timed out on their phone; not checked'
  if (m.checkerFailed) return 'The photo checker could not load on their phone; not checked'
  return null
}

/** Best-effort: an email failure never fails the request, which is already saved. */
async function sendHandCheckEmail(
  request: CustomRequest,
  photos: CustomPhoto[],
  imageIntakeBaseUrl: string,
  email: EmailSenderConfig | undefined,
  alertEmailTo: string | undefined,
  emailFetchImpl: typeof fetch | undefined,
  log: FastifyBaseLogger
): Promise<void> {
  const flagged = photos.flatMap((photo, i) => {
    const reason = handCheckReason(photo)
    return reason ? [{ photo, n: i + 1, reason }] : []
  })
  if (!flagged.length) return
  log.info(
    { requestNumber: request.requestNumber, photos: flagged.map((f) => f.n) },
    'custom request: photos need a hand check'
  )
  if (!email || !alertEmailTo) return
  const rows = flagged
    .map(({ photo, n, reason }) => {
      const thumb = `${imageIntakeBaseUrl}/img/${photo.key}/thumb`
      return (
        `<tr><td style="padding:8px;vertical-align:top;"><a href="${escapeHtml(thumb)}">` +
        `<img src="${escapeHtml(thumb)}" width="120" alt="Photo ${n}" style="border-radius:6px;"></a></td>` +
        `<td style="padding:8px;vertical-align:top;"><b>Photo ${n}</b> (${photo.characters ?? '?'} in it)<br>` +
        `${escapeHtml(reason)}</td></tr>`
      )
    })
    .join('')
  try {
    await sendTransactionalEmail(
      email,
      {
        to: [{ email: alertEmailTo }],
        subject: `Hand check: custom ${request.kind} ${request.requestNumber} (${flagged.length} of ${photos.length} photos)`,
        html:
          `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;">` +
          `<p>A shopper sent ${flagged.length === 1 ? 'a photo' : 'photos'} the photo checker did not pass. ` +
          `The page tells them we check every photo by hand, so look at ${flagged.length === 1 ? 'it' : 'these'} ` +
          `before modelling, and ask for a new photo if one will not work.</p>` +
          `<p>Request <b>${escapeHtml(request.requestNumber)}</b>, ${escapeHtml(request.kind)}. ` +
          `It is in their bag, not yet paid.</p>` +
          `<table style="border-collapse:collapse;">${rows}</table>` +
          `</div>`,
      },
      emailFetchImpl
    )
  } catch (caught) {
    log.error(
      { err: caught, requestNumber: request.requestNumber },
      'custom request: failed to send hand-check email'
    )
  }
}

/**
 * Mounted at '/v1/custom-requests'. Authenticated: a shopper's own requests
 * only. A Google/Apple sign-in without a phone is enough here (see
 * `authenticateAnyProvider` in plugins/auth.ts); paying still needs one.
 */
export const customRequestRoutes: FastifyPluginAsyncZod<CustomRequestRoutesOptions> = async (
  app,
  { db, imageIntakeBaseUrl, uploadToken, fetchImpl = fetch, email, alertEmailTo, emailFetchImpl }
) => {
  app.addHook('onRequest', app.authenticateAnyProvider)

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  })

  app.post(
    '/photos',
    { schema: { response: { 200: CustomPhotoUploadResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      if (!uploadToken) {
        return reply.code(503).send({
          error: { code: 'media_disabled', message: 'Photo uploads are not available right now.' },
        })
      }
      if (uploadRateLimited(request.user.id, Date.now())) {
        return reply.code(429).send({
          error: {
            code: 'limit_exceeded',
            message: 'Too many photos. Try again in a few minutes.',
          },
        })
      }

      const file = await request.file().catch(() => null)
      if (!file) {
        return reply
          .code(400)
          .send({ error: { code: 'validation_failed', message: 'No photo in the upload.' } })
      }
      const bytes = await file.toBuffer().catch(() => null)
      if (!bytes) {
        return reply
          .code(413)
          .send({ error: { code: 'validation_failed', message: 'The photo is over 10 MB.' } })
      }
      const mimetype = sniffImageType(bytes)
      if (!mimetype) {
        return reply.code(400).send({
          error: { code: 'validation_failed', message: 'Send the photo as a JPEG, PNG or WebP.' },
        })
      }

      try {
        const { key } = await uploadToImageIntake({
          fetchImpl,
          baseUrl: imageIntakeBaseUrl,
          uploadToken,
          bytes,
          mimetype,
          filename: file.filename,
        })
        await db.insert(customUploads).values({ key, userId: request.user.id })
        return reply.send({ key, thumbUrl: `${imageIntakeBaseUrl}/img/${key}/thumb` })
      } catch (err) {
        if (!(err instanceof ImageIntakeError)) throw err
        return reply
          .code(502)
          .send({ error: { code: 'media_upload_failed', message: err.message } })
      }
    }
  )

  app.post(
    '/',
    {
      schema: {
        body: CustomRequestCreateSchema,
        response: { 201: CustomRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const created = await createCustomRequest(db, request.user.id, request.body)
      await sendHandCheckEmail(
        created,
        request.body.photos,
        imageIntakeBaseUrl,
        email,
        alertEmailTo,
        emailFetchImpl,
        request.log
      )
      return reply.code(201).send(created)
    }
  )

  app.get(
    '/miniature-allowance',
    {
      schema: {
        querystring: MiniatureAllowanceQuerySchema,
        response: { 200: MiniatureAllowanceSchema, ...errorResponses },
      },
    },
    async (request) => miniatureAllowance(db, request.user.id, request.query.device)
  )

  app.get(
    '/',
    { schema: { response: { 200: CustomRequestListResponseSchema, ...errorResponses } } },
    async (request) => ({ requests: await listCustomRequests(db, request.user.id) })
  )
}

/** Mounted at '/v1/admin/custom-requests'. */
export const adminCustomRequestRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, opts) => {
  const { db } = opts
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: CustomRequestAdminListResponseSchema, ...errorResponses } } },
    async () => ({ requests: await listAllCustomRequests(db) })
  )

  app.patch(
    '/:requestNumber',
    {
      schema: {
        params: CustomRequestParamsSchema,
        body: CustomRequestAdminUpdateSchema,
        response: { 200: CustomRequestAdminSchema, ...errorResponses },
      },
    },
    async (request) => updateCustomRequestStatus(db, request.params.requestNumber, request.body)
  )
}
