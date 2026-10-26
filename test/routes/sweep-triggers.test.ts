/**
 * Enqueue intent from the post-commit ops-notification sender
 * (docs/WIP-EVENT-DRIVEN-SWEEPS.md; the invoice-email and order-create
 * triggers are asserted through the real payment flow in
 * test/routes/invoices.test.ts).
 *
 * The claim is narrow and entirely about cost: **a task is created when, and
 * only when, the row is still something the sweep would pick up.** Enqueuing
 * for a row the sweep would skip buys a Neon compute window guaranteed to find
 * nothing — the exact spend the whole design removes — and NOT enqueuing for a
 * row that is still owed strands it until the daily backstop cron.
 *
 * Nothing here asserts delivery. Delivery is `sendOpsNotification`'s job and is
 * covered in test/services/opsNotifications.test.ts; this file only asks
 * whether the wake-up signal was raised.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FastifyBaseLogger } from 'fastify'

import type { Db } from '../../src/db/client.js'
import { payments, users } from '../../src/db/schema.js'
import type { NotificationChannelRegistry } from '../../src/lib/notify/registry.js'
import { DRAIN_BUCKET_MS, taskNameFor, type TaskEnqueueInput } from '../../src/lib/tasks.js'
import { sendPendingOpsNotifications } from '../../src/routes/opsNotifications.js'
import { enqueueOpsNotification } from '../../src/services/opsNotifications.js'
import { createTestDb } from '../helpers/app.js'

const ORDER_ID = 'order_TRIGGER1'

let db: Db
let enqueued: TaskEnqueueInput[]

function fakeLog(): FastifyBaseLogger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
}

/** Stands in for `app.ts`'s Cloud Tasks enqueuer; records rather than calls GCP. */
const tasks = {
  enqueue: async (input: TaskEnqueueInput) => {
    enqueued.push(input)
  },
}

/** A registry whose WhatsApp adapter answers however the test says. */
function channels(
  send: () => Promise<{ ok: boolean; error?: string }>
): NotificationChannelRegistry {
  return { whatsapp_cloud: { send: async () => send() } }
}

async function seedOrder(): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ firebaseUid: `uid-${ORDER_ID}`, phone: '+919876500001' })
    .returning({ id: users.id })
  await db.insert(payments).values({
    orderId: ORDER_ID,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 179 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
  })
  await enqueueOpsNotification(db, {
    kind: 'order_paid',
    orderId: ORDER_ID,
    channel: 'whatsapp_cloud',
    target: '919900000001',
    message: { params: [ORDER_ID] },
  })
}

/** `sendPendingOpsNotifications` is fire-and-forget; wait for it to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  enqueued = []
  await seedOrder()
})

describe('sendPendingOpsNotifications enqueue intent', () => {
  it('does NOT ask for a sweep when the send succeeded', async () => {
    // The common case by far, and the one that decides the bill: a delivered
    // notification leaves nothing for the sweep, so a task here would be a
    // guaranteed-empty Neon wake on every single paid order.
    sendPendingOpsNotifications(
      db,
      ORDER_ID,
      channels(async () => ({ ok: true })),
      fakeLog(),
      tasks
    )
    await settle()
    expect(enqueued).toEqual([])
  })

  it('asks for a sweep on the next 5-minute boundary when the send failed', async () => {
    sendPendingOpsNotifications(
      db,
      ORDER_ID,
      channels(async () => ({ ok: false, error: 'meta 131026' })),
      fakeLog(),
      tasks
    )
    await settle()

    expect(enqueued).toHaveLength(1)
    const [task] = enqueued
    expect(task!.kind).toBe('ops-notifications')
    // Named for the boundary it fires on, so every other failure inside this
    // same window collapses onto it — one task, one Neon wake.
    expect(task!.name).toBe(taskNameFor('ops-notifications', task!.scheduleTime))
    expect(task!.scheduleTime.getTime() % DRAIN_BUCKET_MS).toBe(0)
    expect(task!.scheduleTime.getTime()).toBeGreaterThanOrEqual(Date.now())
  })

  it('asks for a sweep when the channel is unconfigured', async () => {
    // `skipped_unconfigured` counts as owed ON PURPOSE. It is the state prod
    // sits in while a WhatsApp template waits on Meta approval, and it is what
    // makes that backlog deliver itself the moment credentials land, rather
    // than waiting for someone to notice.
    sendPendingOpsNotifications(db, ORDER_ID, {}, fakeLog(), tasks)
    await settle()

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.kind).toBe('ops-notifications')
  })

  it('asks for a sweep when the send throws outright', async () => {
    sendPendingOpsNotifications(
      db,
      ORDER_ID,
      channels(() => Promise.reject(new Error('socket hang up'))),
      fakeLog(),
      tasks
    )
    await settle()
    expect(enqueued).toHaveLength(1)
  })

  it('is inert with no enqueuer — the backstop cron drains, exactly as today', async () => {
    sendPendingOpsNotifications(
      db,
      ORDER_ID,
      channels(async () => ({ ok: false, error: 'meta 131026' })),
      fakeLog()
    )
    await settle()
    expect(enqueued).toEqual([])
  })
})
