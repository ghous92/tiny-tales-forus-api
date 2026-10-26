/**
 * Route tests: /v1/complaints and /v1/admin/complaints (Consumer Protection
 * (E-Commerce) Rules 2020, Rule 4(6)).
 *
 * Covers: lodging a complaint generates a unique tracking ticket number and
 * a 30-day `dueAt` SLA; own-history list + lookup-by-ticket-number, both
 * user-scoped (cross-user reads as 404); admin listing + status/resolution
 * updates (resolving without a note is rejected; resolving stamps
 * `resolvedAt`, reopening clears it); the Brevo notification/confirmation
 * emails are best-effort — a ticket is still created (and returned) even
 * when `legal.company` isn't configured or the Brevo call itself fails.
 */

import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../../src/app.js'
import { appConfig, catalogItems, complaintTickets } from '../../src/db/schema.js'
import type { VerifiedToken } from '../../src/plugins/auth.js'
import {
  auth,
  createTestApp,
  createTestDb,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  USER_B,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
  vi.restoreAllMocks()
})

function validComplaint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'product_quality',
    subject: 'Cracked bottle on arrival',
    message: 'The aloe gel bottle arrived cracked and half the product had leaked out.',
    ...overrides,
  }
}

describe('auth gate', () => {
  it.each([
    ['POST', '/v1/complaints'],
    ['GET', '/v1/complaints'],
    ['GET', '/v1/complaints/TT-20260101-ABCDEF'],
  ] as const)('401s %s %s without a token', async (method, url) => {
    const res = await ctx.app.inject({ method, url })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })
})

describe('POST /v1/complaints', () => {
  it('201s and generates a unique tracking ticket number with a 30-day SLA', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.ticketNumber).toMatch(/^TT-\d{8}-[A-Z0-9]{6}$/)
    expect(body.status).toBe('open')
    expect(body.orderId).toBeNull()
    expect(body.resolutionNote).toBeNull()
    expect(body.resolvedAt).toBeNull()

    const createdAt = new Date(body.createdAt).getTime()
    const dueAt = new Date(body.dueAt).getTime()
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    expect(dueAt - createdAt).toBeGreaterThan(thirtyDaysMs - 5000)
    expect(dueAt - createdAt).toBeLessThan(thirtyDaysMs + 5000)
  })

  it('422s on an invalid category', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ category: 'not_a_real_category' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('422s on a blank subject', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ subject: '' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('422s for unknown body fields (strict)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ extra: 'nope' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('404s when `orderId` names an order that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ orderId: 'order_DOES_NOT_EXIST' }),
    })
    expect(res.statusCode).toBe(404)
  })

  it('201s and stores a `sku` the catalog knows', async () => {
    await ctx.db.insert(catalogItems).values({
      sku: 'TT-ALOE-100',
      productId: 'aloe-gel',
      name: 'Aloe Vera Gel',
      size: '100g',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/products/aloe.jpg',
      active: true,
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ sku: 'TT-ALOE-100' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().sku).toBe('TT-ALOE-100')
  })

  it('accepts a `sku` that is no longer active — shoppers complain about delisted bottles', async () => {
    await ctx.db.insert(catalogItems).values({
      sku: 'TT-DISCONTINUED',
      productId: 'old-cream',
      name: 'Discontinued Cream',
      size: '50g',
      priceInr: 199,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/products/old.jpg',
      active: false,
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ sku: 'TT-DISCONTINUED' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().sku).toBe('TT-DISCONTINUED')
  })

  it('404s when `sku` names a product that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ sku: 'SKU_DOES_NOT_EXIST' }),
    })
    expect(res.statusCode).toBe(404)
  })

  it('defaults `sku` to null when the complaint names no product', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().sku).toBeNull()
  })

  it('creates the ticket even when no email is configured (best-effort, non-blocking)', async () => {
    // The default createTestApp() has no Brevo credentials — this asserts
    // ticket creation never depends on email succeeding.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('GET /v1/complaints (history) and /v1/complaints/:ticketNumber', () => {
  it("lists only the caller's own complaints, newest first", async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ subject: 'First' }),
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ subject: 'Second' }),
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_B.token),
      payload: validComplaint({ subject: "Someone else's" }),
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    const { complaints } = res.json()
    expect(complaints).toHaveLength(2)
    expect(complaints[0].subject).toBe('Second')
    expect(complaints[1].subject).toBe('First')
  })

  it('200s a lookup by ticket number for the owner', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    const { ticketNumber } = create.json()

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/complaints/${ticketNumber}`,
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticketNumber).toBe(ticketNumber)
  })

  it("404s a lookup by another user's ticket number", async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    const { ticketNumber } = create.json()

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/complaints/${ticketNumber}`,
      headers: auth(USER_B.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('404s an unknown ticket number', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/complaints/TT-20260101-ZZZZZZ',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /v1/admin/complaints', () => {
  it('403s for a non-admin caller', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/complaints',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it("200s every complaint for an admin, including the filer's userId", async () => {
    // promoteToAdmin needs the user row to exist first — one authed request upserts it.
    await ctx.app.inject({ method: 'GET', url: '/v1/complaints', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_B.token),
      payload: validComplaint(),
    })

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/complaints',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    const { complaints } = res.json()
    expect(complaints).toHaveLength(2)
    expect(complaints.every((c: { userId?: string }) => typeof c.userId === 'string')).toBe(true)
  })
})

describe('PATCH /v1/admin/complaints/:ticketNumber', () => {
  async function createTicket(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    return res.json().ticketNumber as string
  }

  /** promoteToAdmin needs the user row to exist first — one authed request upserts it. */
  async function makeAdmin(): Promise<void> {
    await ctx.app.inject({ method: 'GET', url: '/v1/complaints', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  }

  it('403s for a non-admin caller', async () => {
    const ticketNumber = await createTicket()
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/complaints/${ticketNumber}`,
      headers: auth(USER_A.token),
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('200s moving to in_progress without a resolution note', async () => {
    await makeAdmin()
    const ticketNumber = await createTicket()
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/complaints/${ticketNumber}`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'in_progress', resolvedAt: null })
  })

  it('422s resolving without a resolution note', async () => {
    await makeAdmin()
    const ticketNumber = await createTicket()
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/complaints/${ticketNumber}`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'resolved' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('200s resolving with a note and stamps resolvedAt; reopening clears it', async () => {
    await makeAdmin()
    const ticketNumber = await createTicket()

    const resolve = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/complaints/${ticketNumber}`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'resolved', resolutionNote: 'Replacement bottle shipped free of charge.' },
    })
    expect(resolve.statusCode).toBe(200)
    const resolved = resolve.json()
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolutionNote).toBe('Replacement bottle shipped free of charge.')
    expect(resolved.resolvedAt).not.toBeNull()

    const reopen = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/complaints/${ticketNumber}`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'open' },
    })
    expect(reopen.statusCode).toBe(200)
    const reopened = reopen.json()
    expect(reopened.status).toBe('open')
    expect(reopened.resolvedAt).toBeNull()
    // The note isn't wiped just because the ticket reopened.
    expect(reopened.resolutionNote).toBe('Replacement bottle shipped free of charge.')
  })

  it('404s an unknown ticket number', async () => {
    await makeAdmin()
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/complaints/TT-20260101-ZZZZZZ',
      headers: auth(USER_ADMIN.token),
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('notification emails (best-effort)', () => {
  const BREVO_API_KEY = 'test_brevo_key_fake'
  const EMAIL_FROM = 'no-reply@tinytales.test'

  /** A fresh app wired with fake Brevo credentials and a recording fetch stub. */
  async function appWithEmail(fetchImpl: typeof fetch) {
    const { db, pglite } = await createTestDb()
    const tokens = new Map<string, VerifiedToken>([
      [USER_A.token, { uid: USER_A.uid, phoneNumber: USER_A.phoneNumber }],
    ])
    const app = buildApp({
      db,
      verifyToken: (t) => {
        const c = tokens.get(t)
        return c ? Promise.resolve(c) : Promise.reject(new Error('invalid test token'))
      },
      logger: false,
      alerts: { brevoApiKey: BREVO_API_KEY, emailFrom: EMAIL_FROM },
      complaintEmailFetchImpl: fetchImpl,
    })
    await app.ready()
    return { app, db, pglite }
  }

  it('emails the published support mailbox when `legal.company` is configured', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const built = await appWithEmail(fakeFetch)
    await built.db.insert(appConfig).values({
      key: 'legal.company',
      // The ONE published contact: a role mailbox, never a named individual.
      value: { supportEmail: 'support@tinytales.test' },
      description: '',
    })

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)

    // The fire-and-forget email send races the response; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fakeFetch).toHaveBeenCalled()
    const internalCall = calls.find((c) =>
      (c.body as { to?: Array<{ email: string }> }).to?.some(
        (r) => r.email === 'support@tinytales.test'
      )
    )
    expect(internalCall).toBeDefined()
    const recipients = (internalCall!.body as { to: Array<{ email: string }> }).to.map(
      (r) => r.email
    )
    expect(recipients).toEqual(['support@tinytales.test'])

    await built.app.close()
  })

  it('falls back to the legacy grievance/nodal keys in a not-yet-reseeded environment', async () => {
    // `legal.company` is a DB row, not code: an environment whose row still
    // carries the pre-scrub keys must keep delivering complaint notifications
    // rather than silently dropping them. Delete this test (and the fallback in
    // `resolveComplaintRecipients`) once every environment has been re-seeded.
    const calls: Array<{ body: { to?: Array<{ email: string }> } }> = []
    const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} })
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const built = await appWithEmail(fakeFetch)
    await built.db.insert(appConfig).values({
      key: 'legal.company',
      value: {
        grievanceEmail: 'grievance@tinytales.test',
        nodalContactEmail: 'nodal@tinytales.test',
      },
      description: '',
    })

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const opsCall = calls.find((c) =>
      c.body.to?.some((r) => r.email === 'grievance@tinytales.test')
    )
    expect(opsCall).toBeDefined()
    expect(opsCall!.body.to!.map((r) => r.email)).toContain('nodal@tinytales.test')

    await built.app.close()
  })

  it('names the product in the ops email, resolving the sku to its catalog name', async () => {
    const calls: Array<{ body: { to?: Array<{ email: string }>; htmlContent?: string } }> = []
    const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} })
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const built = await appWithEmail(fakeFetch)
    await built.db.insert(appConfig).values({
      key: 'legal.company',
      value: { supportEmail: 'support@tinytales.test' },
      description: '',
    })
    await built.db.insert(catalogItems).values({
      sku: 'TT-ALOE-100',
      productId: 'aloe-gel',
      name: 'Aloe Vera Gel',
      size: '100g',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: '/products/aloe.jpg',
      active: true,
    })

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint({ sku: 'TT-ALOE-100' }),
    })
    expect(res.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const opsCall = calls.find((c) => c.body.to?.some((r) => r.email === 'support@tinytales.test'))
    expect(opsCall).toBeDefined()
    // Both the human-readable name and the raw sku ops need to search by.
    expect(opsCall!.body.htmlContent).toContain('Aloe Vera Gel (100g)')
    expect(opsCall!.body.htmlContent).toContain('TT-ALOE-100')

    await built.app.close()
  })

  it('also confirms to the shopper when they have an email on file', async () => {
    const calls: Array<{ body: { to?: Array<{ email: string }> } }> = []
    const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} })
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const built = await appWithEmail(fakeFetch)
    await built.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth(USER_A.token),
      payload: { email: 'asha@example.com' },
    })

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const shopperCall = calls.find((c) => c.body.to?.some((r) => r.email === 'asha@example.com'))
    expect(shopperCall).toBeDefined()

    await built.app.close()
  })

  it('still creates the ticket when the Brevo call itself fails', async () => {
    const fakeFetch = vi.fn(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch
    const built = await appWithEmail(fakeFetch)
    await built.db.insert(appConfig).values({
      key: 'legal.company',
      value: { supportEmail: 'support@tinytales.test' },
      description: '',
    })

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: auth(USER_A.token),
      payload: validComplaint(),
    })
    expect(res.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const [row] = await built.db
      .select()
      .from(complaintTickets)
      .where(and(eq(complaintTickets.ticketNumber, res.json().ticketNumber)))
    expect(row).toBeDefined()

    await built.app.close()
  })
})
