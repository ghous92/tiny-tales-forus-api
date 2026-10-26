/**
 * Ops notification outbox service — docs/SPEC-MANUAL-FULFILMENT.md §4A, §7.
 * Against a real Postgres (PGlite + committed migrations), same shape as
 * test/services/fulfilment.test.ts and test/services/invoices.test.ts-style
 * outbox tests.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { opsNotifications, payments, users } from '../../src/db/schema.js'
import {
  claimOpsNotification,
  countOpsNotificationsNeedingSend,
  enqueueOpsNotification,
  listOpsNotificationsNeedingSend,
  listPendingOpsNotificationsForOrder,
  MAX_OPS_NOTIFICATION_ATTEMPTS,
  OPS_NOTIFICATION_CLAIM_STALE_MS,
  opsNotificationDedupeKey,
  reapStuckOpsNotifications,
  recordOpsNotificationAttempt,
} from '../../src/services/opsNotifications.js'
import { createTestDb } from '../helpers/app.js'

let db: Db
const ORDER_ID = 'order_OPSNOTIFY1'

function phoneFor(orderId: string): string {
  let hash = 0
  for (const char of orderId) hash = (hash * 31 + char.charCodeAt(0)) % 10_000
  return `+91987650${hash.toString().padStart(4, '0')}`
}

async function seedOrder(orderId = ORDER_ID): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ firebaseUid: `uid-${orderId}`, phone: phoneFor(orderId) })
    .returning({ id: users.id })
  await db.insert(payments).values({
    orderId,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 179 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe('opsNotificationDedupeKey', () => {
  it('composes kind:orderId:channel:target', () => {
    expect(opsNotificationDedupeKey('order_paid', ORDER_ID, 'whatsapp_cloud', '919900000001')).toBe(
      `order_paid:${ORDER_ID}:whatsapp_cloud:919900000001`
    )
  })
})

describe('enqueueOpsNotification', () => {
  it('inserts a pending row with the frozen payload', async () => {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: [ORDER_ID, 'Asha', 'Surat', '2 items', '179', 'https://laanya.shop/admin/orders/x'] },
    })
    expect(row).not.toBeNull()
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(0)
    expect(row?.dedupeKey).toBe(opsNotificationDedupeKey('order_paid', ORDER_ID, 'whatsapp_cloud', '919900000001'))
    expect((row?.payload as { params: string[] }).params[0]).toBe(ORDER_ID)
  })

  it('is idempotent — a repeat enqueue for the same (kind, order, channel, target) is a no-op', async () => {
    await seedOrder()
    const input = {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    }
    const first = await enqueueOpsNotification(db, input)
    const second = await enqueueOpsNotification(db, input)
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    const rows = await db.select().from(opsNotifications).where(eq(opsNotifications.orderId, ORDER_ID))
    expect(rows).toHaveLength(1)
  })

  it('enqueues a separate row per distinct target (fan-out)', async () => {
    await seedOrder()
    await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000002',
      message: { params: ['a'] },
    })
    const rows = await db.select().from(opsNotifications).where(eq(opsNotifications.orderId, ORDER_ID))
    expect(rows).toHaveLength(2)
  })
})

describe('recordOpsNotificationAttempt', () => {
  async function enqueueOne(): Promise<string> {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    return row!.id
  }

  it('sent: sets status, sentAt, providerMessageId, clears lastError', async () => {
    const id = await enqueueOne()
    await claimOpsNotification(db, id)
    const updated = await recordOpsNotificationAttempt(db, id, {
      status: 'sent',
      providerMessageId: 'wamid.ABC',
    })
    expect(updated?.status).toBe('sent')
    expect(updated?.sentAt).not.toBeNull()
    expect(updated?.providerMessageId).toBe('wamid.ABC')
    expect(updated?.lastError).toBeNull()
  })

  it('failed: sets status, records the error, leaves sentAt null', async () => {
    const id = await enqueueOne()
    await claimOpsNotification(db, id)
    const updated = await recordOpsNotificationAttempt(db, id, {
      status: 'failed',
      error: 'HTTP 500',
    })
    expect(updated?.status).toBe('failed')
    expect(updated?.lastError).toBe('HTTP 500')
    expect(updated?.sentAt).toBeNull()
  })

  it('does NOT touch attempts — the claim already counted the try', async () => {
    const id = await enqueueOne()
    const claimed = await claimOpsNotification(db, id)
    expect(claimed?.attempts).toBe(1)
    const updated = await recordOpsNotificationAttempt(db, id, {
      status: 'failed',
      error: 'HTTP 500',
    })
    expect(updated?.attempts).toBe(1)
  })

  it('skipped_unconfigured: does NOT count as an attempt', async () => {
    const id = await enqueueOne()
    const updated = await recordOpsNotificationAttempt(db, id, { status: 'skipped_unconfigured' })
    expect(updated?.status).toBe('skipped_unconfigured')
    expect(updated?.attempts).toBe(0)
  })
})

describe('claimOpsNotification', () => {
  async function enqueueOne(target = '919900000001'): Promise<string> {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target,
      message: { params: ['a'] },
    })
    return row!.id
  }

  it('moves the row to sending and counts the attempt', async () => {
    const id = await enqueueOne()
    const claimed = await claimOpsNotification(db, id)
    expect(claimed?.status).toBe('sending')
    expect(claimed?.attempts).toBe(1)
  })

  // The whole reason the status exists: two senders holding the same row must
  // not both reach WhatsApp.
  it('a second claim on the same row returns undefined', async () => {
    const id = await enqueueOne()
    const first = await claimOpsNotification(db, id)
    const second = await claimOpsNotification(db, id)
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('re-checks the attempt cap rather than trusting the caller', async () => {
    const id = await enqueueOne()
    for (let i = 0; i < MAX_OPS_NOTIFICATION_ATTEMPTS; i += 1) {
      const claimed = await claimOpsNotification(db, id)
      expect(claimed).toBeDefined()
      await recordOpsNotificationAttempt(db, id, { status: 'failed', error: `attempt ${i}` })
    }
    expect(await claimOpsNotification(db, id)).toBeUndefined()
  })

  it('will not claim a row that already sent', async () => {
    const id = await enqueueOne()
    await claimOpsNotification(db, id)
    await recordOpsNotificationAttempt(db, id, { status: 'sent', providerMessageId: null })
    expect(await claimOpsNotification(db, id)).toBeUndefined()
  })
})

describe('reapStuckOpsNotifications', () => {
  async function claimOne(): Promise<string> {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    await claimOpsNotification(db, row!.id)
    return row!.id
  }

  it('leaves a fresh claim alone — a slow send is not an abandoned one', async () => {
    const id = await claimOne()
    expect(await reapStuckOpsNotifications(db)).toBe(0)
    const [row] = await db.select().from(opsNotifications).where(eq(opsNotifications.id, id))
    expect(row?.status).toBe('sending')
  })

  it('returns a stale claim to failed, eligible again with its attempt still spent', async () => {
    const id = await claimOne()
    const later = new Date(Date.now() + OPS_NOTIFICATION_CLAIM_STALE_MS + 60_000)
    expect(await reapStuckOpsNotifications(db, later)).toBe(1)

    const [row] = await db.select().from(opsNotifications).where(eq(opsNotifications.id, id))
    expect(row?.status).toBe('failed')
    expect(row?.attempts).toBe(1)
    expect(row?.lastError).toContain('abandoned')

    const owed = await listOpsNotificationsNeedingSend(db)
    expect(owed.map((r) => r.id)).toContain(id)
  })
})

describe('listOpsNotificationsNeedingSend', () => {
  it('returns pending and failed rows under the attempt cap, oldest first', async () => {
    await seedOrder()
    const pending = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    const failed = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000002',
      message: { params: ['a'] },
    })
    await claimOpsNotification(db, failed!.id)
    await recordOpsNotificationAttempt(db, failed!.id, { status: 'failed', error: 'boom' })
    const sent = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000003',
      message: { params: ['a'] },
    })
    await claimOpsNotification(db, sent!.id)
    await recordOpsNotificationAttempt(db, sent!.id, { status: 'sent', providerMessageId: null })

    const owed = await listOpsNotificationsNeedingSend(db)
    const ids = owed.map((row) => row.id)
    expect(ids).toContain(pending!.id)
    expect(ids).toContain(failed!.id)
    expect(ids).not.toContain(sent!.id)
  })

  /**
   * The regression this predicate exists for. `skipped_unconfigured` is where
   * every row rests while WhatsApp is unwired or Meta has the template in
   * PENDING — the inline post-commit sender writes it seconds after payment.
   * If the sweep cannot see those rows, the backlog never delivers itself when
   * approval lands, which is the entire justification for the job.
   */
  it('still returns rows parked in skipped_unconfigured', async () => {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000007',
      message: { params: ['a'] },
    })
    await recordOpsNotificationAttempt(db, row!.id, { status: 'skipped_unconfigured' })

    const owed = await listOpsNotificationsNeedingSend(db)
    expect(owed.map((r) => r.id)).toContain(row!.id)
    // Nothing was attempted, so the full retry budget survives the outage.
    expect(owed.find((r) => r.id === row!.id)?.attempts).toBe(0)
    expect(await countOpsNotificationsNeedingSend(db)).toBe(1)

    // And it is claimable, or being selected would be a permanent no-op.
    expect((await claimOpsNotification(db, row!.id))?.status).toBe('sending')
  })

  it('stops retrying once attempts hits the cap', async () => {
    await seedOrder()
    const row = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000009',
      message: { params: ['a'] },
    })
    for (let i = 0; i < MAX_OPS_NOTIFICATION_ATTEMPTS; i += 1) {
      await claimOpsNotification(db, row!.id)
      await recordOpsNotificationAttempt(db, row!.id, { status: 'failed', error: `attempt ${i}` })
    }
    const owed = await listOpsNotificationsNeedingSend(db)
    expect(owed.map((r) => r.id)).not.toContain(row!.id)
  })

})

describe('listPendingOpsNotificationsForOrder', () => {
  it('scopes to one order and only pending rows', async () => {
    await seedOrder(ORDER_ID)
    await seedOrder('order_OTHER')
    const mine = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    const other = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: 'order_OTHER',
      channel: 'whatsapp_cloud',
      target: '919900000001',
      message: { params: ['a'] },
    })
    const alreadySent = await enqueueOpsNotification(db, {
      kind: 'order_paid',
      orderId: ORDER_ID,
      channel: 'whatsapp_cloud',
      target: '919900000002',
      message: { params: ['a'] },
    })
    await recordOpsNotificationAttempt(db, alreadySent!.id, { status: 'sent', providerMessageId: null })

    const rows = await listPendingOpsNotificationsForOrder(db, ORDER_ID)
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual([mine!.id])
    expect(ids).not.toContain(other!.id)
    expect(ids).not.toContain(alreadySent!.id)
  })
})
