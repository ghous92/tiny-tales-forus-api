/**
 * Damage claims: the only return path. Accepted only for the caller's own paid
 * order, for a piece that order contained, once delivery is recorded, and
 * inside the reporting window.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appConfig, payments, shipments, users } from '../../src/db/schema.js'
import { clearRestockRateLimits } from '../../src/routes/restock.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext
const DELIVERED = new Date('2026-10-20T10:00:00.000Z')
let now = new Date('2026-10-21T09:00:00.000Z')

async function userIdFor(uid: string): Promise<string> {
  const [row] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.firebaseUid, uid))
  return row!.id
}

async function seedPaidOrder(opts: { delivered?: boolean; status?: string } = {}) {
  // First authed call creates the user row.
  await ctx.app.inject({ method: 'GET', url: '/v1/claims', headers: auth(USER_A.token) })
  const userId = await userIdFor(USER_A.uid)
  await ctx.db.insert(payments).values({
    orderId: 'order_CLAIM1',
    userId,
    amountPaise: 129900,
    status: opts.status ?? 'paid',
    cartSnapshot: {
      items: [{ sku: 'TT-WIZ-STD', name: 'The Old Wizard', qty: 2, priceInr: 1299 }],
    },
    addressSnapshot: {},
  })
  await ctx.db.insert(shipments).values({
    orderId: 'order_CLAIM1',
    userId,
    courierCode: 'manual',
    status: opts.delivered === false ? 'in_transit' : 'delivered',
    deliveredAt: opts.delivered === false ? null : DELIVERED,
  })
}

const VALID = {
  orderId: 'order_CLAIM1',
  sku: 'TT-WIZ-STD',
  description: 'The staff snapped off the wizard in transit.',
  photoKeys: ['2026/10/21/abc123.jpg'],
}

function fileClaim(payload: Record<string, unknown> = VALID, token: string = USER_A.token) {
  return ctx.app.inject({ method: 'POST', url: '/v1/claims', headers: auth(token), payload })
}

beforeEach(async () => {
  now = new Date('2026-10-21T09:00:00.000Z')
  ctx = await createTestApp({ claimsNow: () => now })
  clearRestockRateLimits()
})

afterEach(async () => {
  await ctx.app.close()
})

describe('POST /v1/claims', () => {
  it('files a claim inside the window', async () => {
    await seedPaidOrder()
    const res = await fileClaim()
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      orderId: 'order_CLAIM1',
      sku: 'TT-WIZ-STD',
      qty: 1,
      status: 'submitted',
      deliveredAt: DELIVERED.toISOString(),
    })
    expect(res.json().claimNumber).toMatch(/^TT-DC-\d{8}-[A-Z2-9]{6}$/)
  })

  it('refuses after the default 48-hour window', async () => {
    await seedPaidOrder()
    now = new Date(DELIVERED.getTime() + 49 * 3_600_000)
    const res = await fileClaim()
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('48 hours')
  })

  it('honours returns.damageWindowHours from config', async () => {
    await seedPaidOrder()
    await ctx.db
      .insert(appConfig)
      .values({ key: 'returns.damageWindowHours', value: 72, description: 'test' })
    now = new Date(DELIVERED.getTime() + 60 * 3_600_000)
    expect((await fileClaim()).statusCode).toBe(201)
  })

  it('refuses before delivery is recorded', async () => {
    await seedPaidOrder({ delivered: false })
    const res = await fileClaim()
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('delivered')
  })

  it("treats someone else's order as absent", async () => {
    await seedPaidOrder()
    const res = await fileClaim(VALID, USER_ADMIN.token)
    expect(res.statusCode).toBe(404)
  })

  it('refuses a piece the order did not contain, or more than were ordered', async () => {
    await seedPaidOrder()
    expect((await fileClaim({ ...VALID, sku: 'TT-OTHER' })).statusCode).toBe(422)
    expect((await fileClaim({ ...VALID, qty: 3 })).statusCode).toBe(422)
  })

  it('requires at least one photo', async () => {
    await seedPaidOrder()
    expect((await fileClaim({ ...VALID, photoKeys: [] })).statusCode).toBe(422)
  })

  it('allows one open claim per order line', async () => {
    await seedPaidOrder()
    expect((await fileClaim()).statusCode).toBe(201)
    expect((await fileClaim()).statusCode).toBe(409)
  })
})

describe('admin review', () => {
  it('decides a claim once, and a decided claim is final', async () => {
    await seedPaidOrder()
    const claim = (await fileClaim()).json() as { claimNumber: string }
    await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/claims',
      headers: auth(USER_ADMIN.token),
    })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const decide = (status: string) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/v1/admin/claims/${claim.claimNumber}`,
        headers: auth(USER_ADMIN.token),
        payload: { status, resolutionNote: 'Replacement printed' },
      })
    const res = await decide('approved_replacement')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'approved_replacement' })
    expect(res.json().resolvedAt).not.toBeNull()
    expect((await decide('approved_refund')).statusCode).toBe(409)
  })
})

describe('POST /v1/restock-requests', () => {
  it('records a request by email, idempotently', async () => {
    const post = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/restock-requests',
        payload: { sku: 'TT-WIZ-STD', email: 'Collector@Example.com' },
      })
    expect((await post()).json()).toEqual({ ok: true })
    expect((await post()).statusCode).toBe(200)
  })

  it('needs an email when signed out', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/restock-requests',
      payload: { sku: 'TT-WIZ-STD' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('records a signed-in request against the account', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/restock-requests/me',
      headers: auth(USER_A.token),
      payload: { sku: 'TT-WIZ-STD' },
    })
    expect(res.json()).toEqual({ ok: true })
  })
})
