/**
 * `/v1/admin/media/*` — proxies a product-photo upload from the admin SPA to
 * the image-intake Cloudflare Worker (R2 storage + resize-on-request, see
 * /Users/ghousnawaz/Desktop/Projects/image-resize). The Worker's `/api/upload`
 * is gated by a shared secret (`x-upload-token`); this route exists so that
 * secret never reaches the browser — the admin SPA has no server-side
 * environment of its own to hold it.
 *
 * POST /upload  multipart {file} -> Worker upload -> ImageSet (4 URLs + lqip)
 *
 * Requires `app.authenticate` THEN `app.requireAdmin`, same as every other
 * admin route. 503 `media_disabled` when IMAGE_INTAKE_UPLOAD_TOKEN is unset —
 * same degrade shape as payments/geocode/fulfilment for a missing credential.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import multipart from '@fastify/multipart'

import { ImageSetSchema } from '../contracts/catalog.js'
import { ErrorEnvelopeSchema } from '../contracts/config.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Cap mirrors the Worker's own MAX_BYTES so a too-large file 413s here, before spending an outbound request. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Placeholder is refused past this size — see backfill-image-placeholders.ts MAX_PLACEHOLDER_BYTES for the same rule applied offline. */
const MAX_LQIP_BYTES = 4 * 1024

export interface MediaAdminRoutesOptions {
  /** Base URL of the image-intake Worker, no trailing slash (`env.IMAGE_INTAKE_BASE_URL`). */
  imageIntakeBaseUrl: string
  /** Shared secret for the Worker's upload gate (`env.IMAGE_INTAKE_UPLOAD_TOKEN`). Absent -> route answers 503. */
  uploadToken?: string | undefined
  /** Test seam: inject a fetch instead of calling the real Worker. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch the `lqip` variant and inline it as a base64 data URI, exactly like
 * backfill-image-placeholders.ts does offline. `/img/*` is the Worker's public
 * delivery path (unlike `/api/*`), so no upload token is needed here.
 * Best-effort: a failure just omits `lqip`, never fails the upload.
 */
async function fetchLqip(
  fetchImpl: typeof fetch,
  baseUrl: string,
  key: string
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/img/${key}/lqip`, {
      headers: { Accept: 'image/webp' },
    })
    if (!res.ok) return undefined
    const bytes = await res.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_LQIP_BYTES) return undefined
    return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return undefined
  }
}

/** Admin media routes. Mounted at '/v1/admin/media' by app.ts. */
export const mediaAdminRoutes: FastifyPluginAsyncZod<MediaAdminRoutesOptions> = async (
  app,
  { imageIntakeBaseUrl, uploadToken, fetchImpl = fetch }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  })

  app.post(
    '/upload',
    { schema: { response: { 200: ImageSetSchema, ...errorResponses } } },
    async (request, reply) => {
      if (!uploadToken) {
        return reply.code(503).send({
          error: { code: 'media_disabled', message: 'Image uploads are not configured.' },
        })
      }

      const file = await request.file().catch(() => null)
      if (!file) {
        return reply
          .code(400)
          .send({ error: { code: 'validation_failed', message: 'No file field in upload.' } })
      }

      const bytes = await file.toBuffer().catch(() => null)
      if (!bytes) {
        return reply
          .code(413)
          .send({ error: { code: 'validation_failed', message: 'File exceeds the 10 MB cap.' } })
      }

      const form = new FormData()
      form.append('file', new Blob([bytes], { type: file.mimetype }), file.filename || 'image')

      let upstream: Response
      try {
        upstream = await fetchImpl(`${imageIntakeBaseUrl}/api/upload`, {
          method: 'POST',
          headers: { 'x-upload-token': uploadToken },
          body: form,
        })
      } catch (err) {
        return reply.code(502).send({
          error: {
            code: 'media_upload_failed',
            message: `Could not reach the image host: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      }

      const data = (await upstream.json().catch(() => null)) as { key?: string; error?: string } | null
      if (!upstream.ok || !data?.key) {
        return reply.code(502).send({
          error: { code: 'media_upload_failed', message: data?.error || `Upload failed (HTTP ${upstream.status})` },
        })
      }

      const { key } = data
      const urlFor = (variant: string) => `${imageIntakeBaseUrl}/img/${key}/${variant}`
      const lqip = await fetchLqip(fetchImpl, imageIntakeBaseUrl, key)

      return reply.send({
        thumb: urlFor('thumb'),
        grid: urlFor('grid'),
        pdp: urlFor('pdp'),
        zoom: urlFor('zoom'),
        ...(lqip ? { lqip } : {}),
      })
    }
  )
}
