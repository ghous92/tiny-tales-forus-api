/**
 * Custom miniature and caricature requests: photo upload through the
 * image-intake proxy, then the request itself. Shoppers see only their own;
 * admins see every request with its photos and the browser's check report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearCustomUploadRateLimits, sniffImageType } from '../../src/routes/customRequests.js'
import { MAX_OPEN_REQUESTS } from '../../src/services/customRequests.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  USER_B,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext
let uploads: { url: string; token: string | null }[]

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
const KEY = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b'

function fakeWorker(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    uploads.push({ url: String(input), token: headers.get('x-upload-token') })
    return new Response(JSON.stringify({ key: KEY }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function multipartBody(bytes: Buffer, filename = 'me.jpg', type = 'image/jpeg') {
  const boundary = '----tinytalesboundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function uploadPhoto(bytes: Buffer = JPEG, token: string = USER_A.token) {
  const { payload, contentType } = multipartBody(bytes)
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/custom-requests/photos',
    headers: { ...auth(token), 'content-type': contentType },
    payload,
  })
}

const VALID = {
  kind: 'miniature',
  photos: [
    {
      key: KEY,
      metrics: { sharpness: 182, yawDeg: 8 },
      checks: [
        { id: 'sharp', status: 'pass' },
        { id: 'front', status: 'pass' },
      ],
    },
  ],
  colours: { mode: 'as_photo' },
  notes: 'For our anniversary',
  pincode: '826001',
}

function submit(payload: Record<string, unknown> = VALID, token: string = USER_A.token) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/custom-requests',
    headers: auth(token),
    payload,
  })
}

beforeEach(async () => {
  uploads = []
  clearCustomUploadRateLimits()
  ctx = await createTestApp({
    imageIntake: { baseUrl: 'https://intake.test', uploadToken: 'secret-token' },
    mediaUploadFetchImpl: fakeWorker(),
  })
})

afterEach(async () => {
  await ctx.app.close()
})

describe('sniffImageType', () => {
  it('reads JPEG, PNG and WebP from their leading bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(
      sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
    ).toBe('image/png')
    expect(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary'))).toBe('image/webp')
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})

describe('POST /v1/custom-requests/photos', () => {
  it('requires sign-in', async () => {
    const { payload, contentType } = multipartBody(JPEG)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/custom-requests/photos',
      headers: { 'content-type': contentType },
      payload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('forwards a JPEG to image-intake with the server-side token', async () => {
    const res = await uploadPhoto()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ key: KEY, thumbUrl: `https://intake.test/img/${KEY}/thumb` })
    expect(uploads).toEqual([{ url: 'https://intake.test/api/upload', token: 'secret-token' }])
  })

  it('refuses a file that is not an image, whatever it claims to be', async () => {
    const res = await uploadPhoto(Buffer.from('<html>not a photo</html>'))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
    expect(uploads).toHaveLength(0)
  })

  it('answers 503 when uploads are not configured', async () => {
    await ctx.app.close()
    ctx = await createTestApp()
    const res = await uploadPhoto()
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('media_disabled')
  })

  it('brakes a burst of uploads from one shopper', async () => {
    for (let i = 0; i < 30; i++) expect((await uploadPhoto()).statusCode).toBe(200)
    expect((await uploadPhoto()).statusCode).toBe(429)
    expect((await uploadPhoto(JPEG, USER_B.token)).statusCode).toBe(200)
  })
})

describe('POST /v1/custom-requests', () => {
  it('records a request and returns its number', async () => {
    const res = await submit()
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      kind: 'miniature',
      photoKeys: [KEY],
      colours: { mode: 'as_photo' },
      notes: 'For our anniversary',
      pincode: '826001',
      neededBy: null,
      status: 'submitted',
    })
    expect(res.json().requestNumber).toMatch(/^TT-CR-\d{8}-[A-Z2-9]{6}$/)
  })

  it('asks for the colours when the shopper chose their own', async () => {
    const res = await submit({ ...VALID, colours: { mode: 'custom' } })
    expect(res.statusCode).toBe(422)
  })

  it('accepts a caricature with chosen colours', async () => {
    const res = await submit({
      ...VALID,
      kind: 'caricature',
      colours: { mode: 'custom', notes: 'Red kurta, black hair' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().colours).toEqual({ mode: 'custom', notes: 'Red kurta, black hair' })
  })

  it('keeps the character chosen for each caricature photo, for caricatures only', async () => {
    const photos = [
      { key: KEY, character: { type: 'gallery', id: 'groom' }, previewKey: KEY },
      { key: KEY, character: { type: 'upload', key: KEY, verdict: 'note', franchise: null } },
    ]
    const res = await submit({ ...VALID, kind: 'caricature', photos })
    expect(res.statusCode).toBe(201)

    await ctx.app.inject({
      method: 'GET',
      url: '/v1/custom-requests',
      headers: auth(USER_ADMIN.token),
    })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/custom-requests',
      headers: auth(USER_ADMIN.token),
    })
    expect(list.json().requests[0].photos).toEqual(photos)

    expect((await submit({ ...VALID, kind: 'miniature', photos })).statusCode).toBe(422)
    expect(
      (
        await submit({
          ...VALID,
          kind: 'caricature',
          photos: [{ key: KEY, character: { type: 'gallery', id: 'spider-man' } }],
        })
      ).statusCode
    ).toBe(422)
  })

  it('refuses an unknown kind, no photos, or a key that is not an image-intake key', async () => {
    expect((await submit({ ...VALID, kind: 'bust' })).statusCode).toBe(422)
    expect((await submit({ ...VALID, photos: [] })).statusCode).toBe(422)
    expect((await submit({ ...VALID, photos: [{ key: '../etc/passwd?x=1' }] })).statusCode).toBe(
      422
    )
  })

  it(`stops at ${MAX_OPEN_REQUESTS} requests waiting on the team`, async () => {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) expect((await submit()).statusCode).toBe(201)
    const res = await submit()
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('limit_exceeded')
  })

  it("lists only the caller's own requests", async () => {
    await submit()
    await submit(VALID, USER_B.token)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/custom-requests',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().requests).toHaveLength(1)
  })
})

describe('/v1/admin/custom-requests', () => {
  it('is closed to shoppers', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/custom-requests',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lists every request with photos, phone and check report, and moves status', async () => {
    const created = (await submit()).json()
    // First authed call creates the admin's user row.
    await ctx.app.inject({
      method: 'GET',
      url: '/v1/custom-requests',
      headers: auth(USER_ADMIN.token),
    })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/custom-requests',
      headers: auth(USER_ADMIN.token),
    })
    expect(list.statusCode).toBe(200)
    const [row] = list.json().requests
    expect(row).toMatchObject({
      requestNumber: created.requestNumber,
      phone: USER_A.phoneNumber,
      photos: VALID.photos,
      adminNote: null,
    })

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/custom-requests/${created.requestNumber}`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'quoted', adminNote: 'Quoted ₹2,499 on WhatsApp' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({
      status: 'quoted',
      adminNote: 'Quoted ₹2,499 on WhatsApp',
    })
  })
})
