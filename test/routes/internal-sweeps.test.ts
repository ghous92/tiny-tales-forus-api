/**
 * `/v1/internal/sweeps` — the scheduler-driven half of the background work
 * (docs/SPEC-SWEEP-AUTOMATION.md).
 *
 * Two properties carry the weight here, and both are about failure modes that
 * produce silence rather than errors:
 *
 * 1. **The gate is closed when unconfigured, and closed to strangers.** A
 *    correctly-signed Google token proves only that SOME GCP identity minted
 *    it — anyone with a GCP account can do that for any audience — so the
 *    allowlist has to be the thing that actually refuses, and it has to refuse
 *    even when the signature is perfectly valid.
 *
 * 2. **A skip is a 200, a fault is a 5xx.** Cloud Scheduler retries non-2xx and
 *    marks the job red. `fulfilment.enabled: false` is a state prod sits in
 *    deliberately for weeks; answering 503 there would keep a job permanently
 *    red and permanently retrying, and an operator who has learned to ignore
 *    that red is an operator who will miss a real failure.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { appConfig, payments, shipments, users } from '../../src/db/schema.js'
import { taskNameFor, type TaskEnqueueInput } from '../../src/lib/tasks.js'
import type { CarrierAdapter } from '../../src/lib/delhivery.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  SCHEDULER_AUDIENCE,
  SCHEDULER_SA,
  SCHEDULER_STRANGER,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

const AWB = '18000000042'
const ORDER_ID = 'order_SWEEP1'
const SCHEDULER = { audience: SCHEDULER_AUDIENCE, allowedServiceAccounts: [SCHEDULER_SA.email] }

function oidc(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

function fakeAdapter(over: Partial<CarrierAdapter> = {}): CarrierAdapter {
  return {
    code: 'delhivery',
    config: {
      baseUrl: 'https://staging-express.delhivery.com',
      apiToken: 't',
      clientName: 'C',
      mode: 'staging',
    },
    manifest: vi.fn(async () => ({ ok: true, awb: AWB, raw: {} })),
    track: vi.fn(async () => ({ scans: [], expectedDeliveryDate: null })),
    createPickup: vi.fn(async () => ({ ok: true, pickupId: 'PU-1', raw: {} })),
    label: vi.fn(async () => ({ ok: true, raw: {} })),
    cancel: vi.fn(async () => ({ ok: true, raw: {} })),
    ndrAction: vi.fn(async () => ({ ok: true, uplId: 'UPL-1', raw: {} })),
    serviceability: vi.fn(async () => []),
    invoiceCharges: vi.fn(async () => ({ chargeInr: null, raw: {} })),
    ...over,
  }
}

/**
 * The ten `fulfilment.*` rows, live by default. `parseFulfilmentRule` is
 * all-or-nothing, so a partial seed here would silently test FULFILMENT_OFF
 * while looking like it tested a live rule — the exact trap the readiness
 * endpoint exists to expose.
 */
async function seedRule(ctx: TestContext, over: Record<string, unknown> = {}): Promise<void> {
  const values: Record<string, unknown> = {
    'fulfilment.enabled': true,
    'fulfilment.carrier': 'delhivery',
    'fulfilment.autoManifest': false,
    'fulfilment.pickupLocationName': 'AHM-01 SAMAN PRODUCTS',
    'fulfilment.manifestMaxAttempts': 5,
    'fulfilment.reconcileStaleMinutes': 180,
    'fulfilment.reconcileBatchSize': 100,
    'fulfilment.trackingUrlTemplate': 'https://www.delhivery.com/track/package/{awb}',
    'fulfilment.mode': 'carrier',
    ...over,
  }
  for (const [key, value] of Object.entries(values)) {
    await ctx.db.insert(appConfig).values({ key, value }).onConflictDoNothing()
  }
}

/** One paid order with a shipment waiting to be manifested. */
async function seedPendingShipment(ctx: TestContext): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({ firebaseUid: 'uid-sweep', phone: '+919000000019' })
    .returning({ id: users.id })
  await ctx.db.insert(payments).values({
    orderId: ORDER_ID,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, name: 'Hair Oil', priceInr: 179 }], totalInr: 179 },
    addressSnapshot: {
      fullName: 'Test Buyer',
      phone: '+919876543210',
      houseNumber: '12',
      roadArea: 'MG Road',
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380001',
    },
    shippingSnapshot: { chargeableWeightG: 500 },
  })
  const [row] = await ctx.db
    .insert(shipments)
    .values({
      orderId: ORDER_ID,
      userId: user!.id,
      courierCode: 'delhivery',
      awb: null,
      status: 'pending_manifest',
    })
    .returning({ id: shipments.id })
  return row!.id
}

describe('scheduler gate', () => {
  it('answers 503 scheduler_disabled when no audience/allowlist is configured', async () => {
    const ctx = await createTestApp({ carrierAdapter: fakeAdapter() })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('scheduler_disabled')
  })

  it('401s with no bearer token', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/internal/sweeps/manifest' })
    expect(res.statusCode).toBe(401)
  })

  it('401s on a token the verifier rejects', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc('not-a-real-oidc-token'),
    })
    expect(res.statusCode).toBe(401)
  })

  it('403s a VALID token from a service account that is not allowlisted', async () => {
    // The load-bearing case: Google will sign a token for any GCP customer's
    // service account against any audience, so a valid signature is not
    // authorisation. If this ever passes, the endpoint is world-callable and
    // will manifest real parcels for strangers.
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter() })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_STRANGER.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects a Firebase customer token — the human gate is not the machine gate', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts the allowlisted service account', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/ops-notifications',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('skips are 200, not 503', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter() })
  })

  it('reports fulfilment_disabled without failing the scheduler run', async () => {
    await seedRule(ctx, { 'fulfilment.enabled': false })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sweep: 'manifest', ran: false, reason: 'fulfilment_disabled' })
  })

  it('reports manual_mode separately from fulfilment_disabled', async () => {
    // Two independent gates (SPEC-MANUAL-FULFILMENT §4B). Collapsing them into
    // one reason would send an operator to change the wrong key.
    await seedRule(ctx, { 'fulfilment.mode': 'manual' })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.json()).toMatchObject({ ran: false, reason: 'manual_mode' })
  })

  it('reports pickup_location_unset — live config that rejects every manifest', async () => {
    await seedRule(ctx, { 'fulfilment.pickupLocationName': '' })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ran: false, reason: 'pickup_location_unset' })
  })

  it('reports carrier_unconfigured when the deploy has no Delhivery env', async () => {
    const noAdapter = await createTestApp({ scheduler: SCHEDULER })
    await seedRule(noAdapter)
    const res = await noAdapter.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/reconcile',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ran: false, reason: 'carrier_unconfigured' })
  })
})

describe('the sweeps actually sweep', () => {
  it('manifests a pending shipment and reports ran: true', async () => {
    const adapter = fakeAdapter()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: adapter })
    await seedRule(ctx)
    const id = await seedPendingShipment(ctx)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sweep: 'manifest', ran: true, reason: null, scanned: 1, succeeded: 1 })
    expect(adapter.manifest).toHaveBeenCalledTimes(1)

    const [row] = await ctx.db.select().from(shipments).where(eq(shipments.id, id))
    expect(row!.awb).toBe(AWB)
    expect(row!.status).toBe('manifested')
  })

  it('is idempotent — a second run finds nothing left to do', async () => {
    // What makes it safe to run every few minutes: the row leaves
    // `pending_manifest` the moment it succeeds, so an overlapping or repeated
    // run cannot double-book the same parcel.
    const adapter = fakeAdapter()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: adapter })
    await seedRule(ctx)
    await seedPendingShipment(ctx)

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/manifest',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(first.json().succeeded).toBe(1)
    expect(second.json()).toMatchObject({ ran: true, scanned: 0, succeeded: 0 })
    expect(adapter.manifest).toHaveBeenCalledTimes(1)
  })

  it('drains the ops notification outbox without WhatsApp configured', async () => {
    // `skipped_unconfigured` is a resting state, not a failure: the rows stay
    // eligible, so this same sweep delivers the backlog the moment Meta moves
    // `order_paid_ops` out of PENDING — with no deploy and nobody watching.
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/sweeps/ops-notifications',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sweep: 'ops-notifications', ran: true, reason: null })
  })
})

describe('readiness', () => {
  it('reports blockedBy and a real backlog while fulfilment is off', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter() })
    await seedRule(ctx, { 'fulfilment.enabled': false })
    await seedPendingShipment(ctx)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/internal/sweeps/readiness',
      headers: oidc(SCHEDULER_SA.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ready).toBe(false)
    expect(body.blockedBy).toBe('fulfilment_disabled')
    expect(body.rule.pickupLocationName).toBe('AHM-01 SAMAN PRODUCTS')
    expect(body.carrierConfigured).toBe(true)
    expect(body.schedulerConfigured).toBe(true)
    expect(body.backlog.pendingManifest).toBe(1)
    expect(body.backlog.manifestExhausted).toBe(0)
  })

  it('is not ready when config is perfect but no scheduler can reach it', async () => {
    // The precise state production was in: eleven correct config rows, live
    // carrier credentials, and zero Cloud Scheduler jobs. Nothing errors, and
    // nothing happens. Reporting that as ready is how it stays invisible.
    const ctx = await createTestApp({ carrierAdapter: fakeAdapter() })
    await seedRule(ctx)
    await ctx.app.inject({ method: 'GET', url: '/v1/addresses', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/fulfilment/readiness',
      headers: auth(USER_ADMIN.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.blockedBy).toBeNull()
    expect(body.schedulerConfigured).toBe(false)
    expect(body.ready).toBe(false)
  })

  it('separates exhausted rows from the drainable backlog', async () => {
    // Folded together they read as a backlog about to drain. `manifestAttempts`
    // at the cap means no sweep will ever touch that row again.
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter() })
    await seedRule(ctx)
    const id = await seedPendingShipment(ctx)
    await ctx.db.update(shipments).set({ manifestAttempts: 5 }).where(eq(shipments.id, id))

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/internal/sweeps/readiness',
      headers: oidc(SCHEDULER_SA.token),
    })
    const body = res.json()
    expect(body.backlog.pendingManifest).toBe(0)
    expect(body.backlog.manifestExhausted).toBe(1)
    expect(body.backlog.oldestPendingManifestHours).not.toBeNull()
  })

  it('requires admin on the human twin', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/fulfilment/readiness',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(403)
  })
})

/**
 * The carrier half of the event-driven triggers (docs/WIP-EVENT-DRIVEN-SWEEPS.md
 * §4). Manifest and reconcile differ from the other sweeps in that their work
 * is not finished when the sweep returns — a parcel that just got an AWB has to
 * be polled for days — so instead of a single enqueue at the failure site, each
 * run decides whether to schedule the next one.
 *
 * Two failure modes are being guarded against, and they pull in opposite
 * directions:
 *
 * 1. **Chaining when there is nothing to do** puts the poller back, with extra
 *    steps: a Neon compute window every five minutes forever.
 * 2. **Not chaining when there is** strands parcels until the daily backstop,
 *    which for tracking means a shopper watching a stale page for 24 hours.
 */
describe('event-driven chaining', () => {
  function recorder(): { taskEnqueuer: { enqueue: (i: TaskEnqueueInput) => Promise<void> }; calls: TaskEnqueueInput[] } {
    const calls: TaskEnqueueInput[] = []
    return {
      calls,
      taskEnqueuer: {
        enqueue: async (input: TaskEnqueueInput) => {
          calls.push(input)
        },
      },
    }
  }

  /** The enqueue is fire-and-forget; let it settle before asserting. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  function sweep(ctx: TestContext, name: 'manifest' | 'reconcile') {
    return ctx.app.inject({
      method: 'POST',
      url: `/v1/internal/sweeps/${name}`,
      headers: oidc(SCHEDULER_SA.token),
    })
  }

  it('does not chain when the manifest sweep drained everything', async () => {
    const { taskEnqueuer, calls } = recorder()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter(), taskEnqueuer })
    await seedRule(ctx)
    await seedPendingShipment(ctx)

    await sweep(ctx, 'manifest')
    await settle()

    // The one parcel is manifested, so nothing is left waiting.
    expect(calls.filter((c) => c.kind === 'manifest')).toEqual([])
  })

  it('chains the manifest sweep while a parcel is still waiting', async () => {
    // A carrier rejection leaves the row `pending_manifest` under the attempt
    // cap. It terminates because every outcome burns an attempt — including
    // this one — so the chain is bounded by `manifestMaxAttempts`.
    const { taskEnqueuer, calls } = recorder()
    const adapter = fakeAdapter({ manifest: vi.fn(async () => ({ ok: false, remark: 'bad pincode', raw: {} })) })
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: adapter, taskEnqueuer })
    await seedRule(ctx)
    await seedPendingShipment(ctx)

    await sweep(ctx, 'manifest')
    await settle()

    const chained = calls.filter((c) => c.kind === 'manifest')
    expect(chained).toHaveLength(1)
    expect(chained[0]!.name).toBe(taskNameFor('manifest', chained[0]!.scheduleTime))
  })

  it('seeds the reconcile chain from a successful manifest', async () => {
    // The parcel is now moving and the tracking webhook may never fire for it.
    // The poll is created HERE, so it exists only once something is in flight.
    const { taskEnqueuer, calls } = recorder()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter(), taskEnqueuer })
    await seedRule(ctx)
    await seedPendingShipment(ctx)

    await sweep(ctx, 'manifest')
    await settle()

    const [poll] = calls.filter((c) => c.kind === 'reconcile')
    expect(poll).toBeDefined()
    // Not before the shipment could possibly be stale (reconcileStaleMinutes).
    expect(poll!.scheduleTime.getTime()).toBeGreaterThan(Date.now() + 170 * 60_000)
  })

  it('keeps the reconcile chain alive while parcels are in flight', async () => {
    // Deliberately NOT keyed on "is anything stale": this run just refreshed
    // `lastScanAt`, so staleness is zero by definition the moment it finishes.
    // Chaining off that would stop the chain exactly when it worked.
    const { taskEnqueuer, calls } = recorder()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter(), taskEnqueuer })
    await seedRule(ctx)
    const id = await seedPendingShipment(ctx)
    await ctx.db
      .update(shipments)
      .set({ awb: AWB, status: 'in_transit' })
      .where(eq(shipments.id, id))

    await sweep(ctx, 'reconcile')
    await settle()

    expect(calls.filter((c) => c.kind === 'reconcile')).toHaveLength(1)
  })

  it('ends the reconcile chain when nothing is moving', async () => {
    const { taskEnqueuer, calls } = recorder()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter(), taskEnqueuer })
    await seedRule(ctx)

    await sweep(ctx, 'reconcile')
    await settle()

    expect(calls).toEqual([])
  })

  it('enqueues nothing at all while fulfilment is off', async () => {
    // The reason manifest and reconcile were left on cron until now: every task
    // created here would buy a Neon compute window to be told `ran: false`.
    const { taskEnqueuer, calls } = recorder()
    const ctx = await createTestApp({ scheduler: SCHEDULER, carrierAdapter: fakeAdapter(), taskEnqueuer })
    await seedRule(ctx, { 'fulfilment.enabled': false })
    await seedPendingShipment(ctx)

    await sweep(ctx, 'manifest')
    await sweep(ctx, 'reconcile')
    await settle()

    expect(calls).toEqual([])
  })
})
