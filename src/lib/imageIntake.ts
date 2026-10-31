/**
 * Upload one image to the image-intake Cloudflare Worker (R2 + resize on
 * request). The Worker's `/api/upload` is gated by a shared secret
 * (`x-upload-token`) that must never reach a browser, so every upload goes
 * through the API. Keys are `crypto.randomUUID()`, so a photo's delivery URL
 * cannot be guessed from another one.
 */

export class ImageIntakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageIntakeError'
  }
}

export async function uploadToImageIntake(opts: {
  fetchImpl: typeof fetch
  baseUrl: string
  uploadToken: string
  bytes: Buffer
  mimetype: string
  filename: string
}): Promise<{ key: string }> {
  const form = new FormData()
  form.append('file', new Blob([opts.bytes], { type: opts.mimetype }), opts.filename || 'image')

  let upstream: Response
  try {
    upstream = await opts.fetchImpl(`${opts.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'x-upload-token': opts.uploadToken },
      body: form,
    })
  } catch (err) {
    throw new ImageIntakeError(
      `Could not reach the image host: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const data = (await upstream.json().catch(() => null)) as { key?: string; error?: string } | null
  if (!upstream.ok || !data?.key) {
    throw new ImageIntakeError(data?.error || `Upload failed (HTTP ${upstream.status})`)
  }
  return { key: data.key }
}

/** Delete one image. Deleting a key that is already gone still succeeds, so a retry is safe. */
export async function deleteFromImageIntake(opts: {
  fetchImpl: typeof fetch
  baseUrl: string
  uploadToken: string
  key: string
}): Promise<void> {
  let upstream: Response
  try {
    upstream = await opts.fetchImpl(`${opts.baseUrl}/api/images/${encodeURIComponent(opts.key)}`, {
      method: 'DELETE',
      headers: { 'x-upload-token': opts.uploadToken },
    })
  } catch (err) {
    throw new ImageIntakeError(
      `Could not reach the image host: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!upstream.ok) throw new ImageIntakeError(`Delete failed (HTTP ${upstream.status})`)
}
