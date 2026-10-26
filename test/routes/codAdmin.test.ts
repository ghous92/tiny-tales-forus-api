/**
 * `GET /v1/admin/cod/health` — the P7.3 ops readout (docs/SPEC-COD.md).
 *
 * The cases that carry weight are the two the readout exists to get right: the
 * RTO denominator (settled only, so an in-flight cohort cannot report a
 * flattering zero) and the minimum sample (so a single refusal cannot label
 * itself a breach).
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { appConfig, payments, shipments, users } from '../../src/db/schema.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext
/** Reset per test — the database is fresh each time, so the seeded ids must be too. */
let seq = 0

beforeEach(async () => {
  ctx = await createTestApp()
  // The first authed request creates the `users` row; only then can the role flip.
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/cod/health',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  seq = 0
})

const setConfig = async (rows: Record<string, unknown>) => {
  await ctx.db
    .insert(appConfig)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value, description: 'test' })))
}

/**
 * One COD (or prepaid) order plus its shipment. `amountPaise` is the ORDER
 * TOTAL and `codAmountPaise` the balance, per SPEC-COD D1 — the CHECK
 * constraints reject any other pairing.
 */
async function seedOrder(opts: {
  status: string
  mode?: 'cod' | 'prepaid'
  paymentStatus?: 'paid' | 'pending'
}): Promise<string> {
  const n = ++seq
  const [user] = await ctx.db
    .insert(users)
    .values({ firebaseUid: `uid-cod-${n}`, phone: `+9188000000${String(n).padStart(2, '0')}` })
    .returning({ id: users.id })
  const orderId = `order_COD_${n}`
  const mode = opts.mode ?? 'cod'
  await ctx.db.insert(payments).values({
    orderId,
    userId: user!.id,
    amountPaise: 70_000,
    paymentMode: mode,
    codAmountPaise: mode === 'cod' ? 65_100 : 0,
    status: opts.paymentStatus ?? 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 700 }], totalInr: 700 },
    addressSnapshot: { pincode: '395003' },
  })
  await ctx.db.insert(shipments).values({
    orderId,
    userId: user!.id,
    courierCode: 'delhivery',
    status: opts.status,
  })
  return orderId
}

/**
 * A second leg on an order that already has one — a re-manifest. The reason
 * the readout counts ORDERS and not shipment rows.
 */
async function addShipment(orderId: string, status: string): Promise<void> {
  const [row] = await ctx.db
    .select({ userId: payments.userId })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .limit(1)
  await ctx.db
    .insert(shipments)
    .values({ orderId, userId: row!.userId, courierCode: 'delhivery', status })
}

const health = async (token: string = USER_ADMIN.token) =>
  ctx.app.inject({ method: 'GET', url: '/v1/admin/cod/health', headers: auth(token) })

describe('GET /v1/admin/cod/health — access', () => {
  it('401s without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/admin/cod/health' })
    expect(res.statusCode).toBe(401)
  })

  it('403s for a non-admin — the pincode policy is a risk control', async () => {
    expect((await health(USER_A.token)).statusCode).toBe(403)
  })
})

describe('GET /v1/admin/cod/health — config readout', () => {
  it('reports the shipped-off defaults when nothing is configured', async () => {
    const body = (await health()).json()
    expect(body).toMatchObject({
      enabled: false,
      tokenInr: 49,
      maxCartInr: 2000,
      pincodes: { mode: 'all', listSize: 0 },
      killSwitchKey: 'payments.cod.enabled',
    })
    expect(body.month.cap).toBe(100)
    expect(body.rto).toMatchObject({ killSwitchRtoPct: 15, minSample: 20 })
  })

  it('summarises the pincode list by SIZE, never by contents', async () => {
    await setConfig({
      'payments.cod.pincodes': { mode: 'allow', list: ['380001', '395003'] },
    })
    const body = (await health()).json()
    expect(body.pincodes).toEqual({ mode: 'allow', listSize: 2 })
    expect(JSON.stringify(body)).not.toContain('380001')
  })
})

describe('GET /v1/admin/cod/health — monthly cap', () => {
  it('counts paid COD orders against the cap and reports the remainder', async () => {
    await setConfig({ 'payments.cod.monthlyOrderCap': 3 })
    await seedOrder({ status: 'in_transit' })
    await seedOrder({ status: 'delivered' })
    const body = (await health()).json()
    expect(body.month).toMatchObject({ ordersTaken: 2, cap: 3, remaining: 1, capReached: false })
  })

  it('ignores pending tokens and prepaid orders', async () => {
    await seedOrder({ status: 'in_transit', paymentStatus: 'pending' })
    await seedOrder({ status: 'delivered', mode: 'prepaid' })
    expect((await health()).json().month.ordersTaken).toBe(0)
  })

  it('flags the cap as reached, which is why COD went quiet', async () => {
    await setConfig({ 'payments.cod.monthlyOrderCap': 1 })
    await seedOrder({ status: 'delivered' })
    expect((await health()).json().month).toMatchObject({ remaining: 0, capReached: true })
  })
})

describe('GET /v1/admin/cod/health — RTO', () => {
  it('divides by SETTLED orders, not by everything shipped', async () => {
    await seedOrder({ status: 'delivered' })
    await seedOrder({ status: 'delivered' })
    await seedOrder({ status: 'delivered' })
    await seedOrder({ status: 'rto_delivered' })
    // Neither of these may touch the denominator: one is still moving, the
    // other never reached a door.
    await seedOrder({ status: 'in_transit' })
    await seedOrder({ status: 'cancelled' })

    expect((await health()).json().rto).toMatchObject({
      delivered: 3,
      rtoDelivered: 1,
      settled: 4,
      inFlight: 1,
      rtoPct: 25,
    })
  })

  it('counts a re-shipped order once, not once per leg', async () => {
    // Returned, re-manifested, and delivered on the second attempt. Summing
    // per-status counts would put this one order in BOTH settled buckets:
    // settled 2 out of 1 order, and a 50% rate invented out of nothing.
    const orderId = await seedOrder({ status: 'rto_delivered' })
    await addShipment(orderId, 'delivered')
    // …and a cancelled leg must not resurrect it as a third count either.
    await addShipment(orderId, 'cancelled')

    expect((await health()).json().rto).toMatchObject({
      delivered: 1,
      rtoDelivered: 0,
      settled: 1,
      inFlight: 0,
      rtoPct: 0,
    })
  })

  it('does not let an in-flight leg hide a settled outcome', async () => {
    const orderId = await seedOrder({ status: 'rto_delivered' })
    await addShipment(orderId, 'in_transit')
    expect((await health()).json().rto).toMatchObject({
      rtoDelivered: 1,
      settled: 1,
      inFlight: 0,
    })
  })

  it('reports a null rate rather than 0% when nothing has settled', async () => {
    await seedOrder({ status: 'in_transit' })
    expect((await health()).json().rto).toMatchObject({
      settled: 0,
      rtoPct: null,
      sampleSufficient: false,
      breached: false,
    })
  })

  it('ignores prepaid RTOs — this readout is about cash orders only', async () => {
    await seedOrder({ status: 'rto_delivered', mode: 'prepaid' })
    expect((await health()).json().rto).toMatchObject({ rtoDelivered: 0, settled: 0 })
  })

  it('will not call a breach on a sample too small to mean anything', async () => {
    // 1 of 4 returned = 25%, well past the 15% threshold — and still noise.
    await seedOrder({ status: 'rto_delivered' })
    await seedOrder({ status: 'delivered' })
    await seedOrder({ status: 'delivered' })
    await seedOrder({ status: 'delivered' })
    expect((await health()).json().rto).toMatchObject({
      rtoPct: 25,
      sampleSufficient: false,
      breached: false,
    })
  })

  it('calls a breach once the sample is large enough and the threshold is passed', async () => {
    await setConfig({ 'payments.cod.killSwitchRtoPct': 15 })
    for (let i = 0; i < 4; i++) await seedOrder({ status: 'rto_delivered' })
    for (let i = 0; i < 16; i++) await seedOrder({ status: 'delivered' })
    expect((await health()).json().rto).toMatchObject({
      settled: 20,
      rtoPct: 20,
      sampleSufficient: true,
      breached: true,
    })
  })

  it('stays below a threshold the operator raised', async () => {
    await setConfig({ 'payments.cod.killSwitchRtoPct': 25 })
    for (let i = 0; i < 4; i++) await seedOrder({ status: 'rto_delivered' })
    for (let i = 0; i < 16; i++) await seedOrder({ status: 'delivered' })
    expect((await health()).json().rto).toMatchObject({ rtoPct: 20, breached: false })
  })
})
