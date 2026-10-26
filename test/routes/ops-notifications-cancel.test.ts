/**
 * Cancellation ops notifications — the `order_cancelled` fan-out and the
 * `shipment_cancel_failed` alert (docs/SPEC-MANUAL-FULFILMENT.md §4A).
 *
 * The test that matters most here is the unconfigured-template one. These two
 * kinds deliberately have NO env fallback: the deployed fallback template says
 * "New paid order {{1}} …", so falling back would announce a purchase for an
 * order that was just refunded. Silence is the correct failure mode, and it has
 * to stay the correct failure mode.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'

import type { Db } from '../../src/db/client.js'
import { appConfig, opsNotifications, payments, users } from '../../src/db/schema.js'
import type { NotificationChannelRegistry } from '../../src/lib/notify/registry.js'
import type { NotificationMessage, SendResult } from '../../src/lib/notify/types.js'
import {
  enqueueShipmentCancelFailedNotification,
  makeOrderCancelledNotificationHook,
  sendOpsNotification,
} from '../../src/routes/opsNotifications.js'
import type { OrderInvoiceSource } from '../../src/services/payments.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

const ORDER_ID = 'order_CANCELNOTIFY'
const TARGET = '919900000001'
const ADMIN_ORIGIN = 'https://laanya.shop'

/** A silent logger — these paths log on failure, and a failure is the test's business. */
const log = { error: vi.fn() } as unknown as FastifyBaseLogger

function order(): OrderInvoiceSource {
  return {
    orderId: ORDER_ID,
    userId: 'user-1',
    status: 'refunded',
    createdAt: new Date('2026-08-01T10:00:00Z'),
    paidAt: new Date('2026-08-01T10:01:00Z'),
    paymentReference: 'pay_1',
    amountPaise: 17_900,
    address: { name: 'Asha  Rao', city: 'Surat', pincode: '395003' },
    lines: [{ sku: 'SKU-1', qty: 1, priceInr: 179, hsn: '3304', gstRatePct: 18 }],
    goodsInr: 179,
    couponDiscountInr: 0,
    couponCode: null,
    shippingFeeInr: 0,
    totalInr: 179,
    paymentMode: 'prepaid',
    codAmountInr: 0,
  }
}

async function seedOrder(): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ firebaseUid: 'uid-cancel', phone: '+919876500001' })
    .returning({ id: users.id })
  await db.insert(payments).values({
    orderId: ORDER_ID,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'refunded',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 179 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
  })
}

async function setConfig(key: string, value: unknown): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value } })
}

async function rowsFor(kind: string) {
  return db.select().from(opsNotifications).where(eq(opsNotifications.kind, kind))
}

/** A channel that records what it was asked to send. */
function recordingChannel(result: SendResult = { ok: true, providerMessageId: 'wamid.1' }) {
  const sent: Array<{ target: string; message: NotificationMessage }> = []
  const channels: NotificationChannelRegistry = {
    whatsapp_cloud: {
      async send(target, message) {
        sent.push({ target, message })
        return result
      },
    },
  }
  return { channels, sent }
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  await seedOrder()
  await setConfig('ops.notifyNumbers', [TARGET])
})

describe('makeOrderCancelledNotificationHook', () => {
  it('enqueues one row per configured number with the refund params frozen on it', async () => {
    const hook = makeOrderCancelledNotificationHook({ adminOrigin: ADMIN_ORIGIN, log })
    await db.transaction(async (tx) => hook(tx, ORDER_ID, order(), 'Ordered by mistake'))

    const rows = await rowsFor('order_cancelled')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.target).toBe(TARGET)
    expect(rows[0]?.status).toBe('pending')
    expect((rows[0]?.payload as NotificationMessage).params).toEqual([
      ORDER_ID,
      // The double space in the seeded name is collapsed — Meta rejects 4+
      // consecutive spaces (132000) and the adapter does not sanitise.
      'Asha Rao',
      'Surat',
      '179',
      'Ordered by mistake',
      `${ADMIN_ORIGIN}/admin/orders/${ORDER_ID}`,
    ])
  })

  it('is idempotent — a replayed refund transition enqueues nothing new', async () => {
    const hook = makeOrderCancelledNotificationHook({ adminOrigin: ADMIN_ORIGIN, log })
    await db.transaction(async (tx) => hook(tx, ORDER_ID, order(), 'Ordered by mistake'))
    await db.transaction(async (tx) => hook(tx, ORDER_ID, order(), 'Ordered by mistake'))

    expect(await rowsFor('order_cancelled')).toHaveLength(1)
  })

  it('enqueues nothing when no ops numbers are configured', async () => {
    await setConfig('ops.notifyNumbers', [])
    const hook = makeOrderCancelledNotificationHook({ adminOrigin: ADMIN_ORIGIN, log })
    await db.transaction(async (tx) => hook(tx, ORDER_ID, order(), 'Ordered by mistake'))

    expect(await rowsFor('order_cancelled')).toHaveLength(0)
  })
})

describe('enqueueShipmentCancelFailedNotification', () => {
  it('enqueues one alert carrying the AWB and the carrier remark', async () => {
    await enqueueShipmentCancelFailedNotification(db, {
      orderId: ORDER_ID,
      unresolved: [{ awb: '18000000001', remark: 'Carrier refused the cancellation' }],
      adminOrigin: ADMIN_ORIGIN,
    })

    const rows = await rowsFor('shipment_cancel_failed')
    expect(rows).toHaveLength(1)
    expect((rows[0]?.payload as NotificationMessage).params).toEqual([
      ORDER_ID,
      '18000000001',
      'Carrier refused the cancellation',
      `${ADMIN_ORIGIN}/admin/orders/${ORDER_ID}`,
    ])
  })

  it('collapses two stuck parcels into one message per order', async () => {
    await enqueueShipmentCancelFailedNotification(db, {
      orderId: ORDER_ID,
      unresolved: [
        { awb: '18000000001', remark: null },
        { awb: '18000000002', remark: 'Already out for delivery' },
      ],
      adminOrigin: ADMIN_ORIGIN,
    })

    const rows = await rowsFor('shipment_cancel_failed')
    expect(rows).toHaveLength(1)
    const params = (rows[0]?.payload as NotificationMessage).params
    expect(params[1]).toBe('18000000001, 18000000002')
    expect(params[2]).toBe('Already out for delivery')
  })

  it('enqueues nothing when there is nothing unresolved', async () => {
    await enqueueShipmentCancelFailedNotification(db, {
      orderId: ORDER_ID,
      unresolved: [],
      adminOrigin: ADMIN_ORIGIN,
    })
    expect(await rowsFor('shipment_cancel_failed')).toHaveLength(0)
  })
})

describe('sendOpsNotification for a cancellation kind', () => {
  it('sends nothing and burns no attempt while the template is unconfigured', async () => {
    await enqueueShipmentCancelFailedNotification(db, {
      orderId: ORDER_ID,
      unresolved: [{ awb: '18000000001', remark: 'Carrier refused' }],
      adminOrigin: ADMIN_ORIGIN,
    })
    const [row] = await rowsFor('shipment_cancel_failed')
    const { channels, sent } = recordingChannel()

    const after = await sendOpsNotification(db, row!, channels, log)

    // The whole point: it must NOT fall through to the adapter's order_paid
    // template and announce a purchase for a refunded order.
    expect(sent).toHaveLength(0)
    expect(after?.status).toBe('skipped_unconfigured')
    expect(after?.attempts).toBe(0)
  })

  it('sends with the configured template once an admin sets both keys', async () => {
    await setConfig('notify.shipmentCancelFailedTemplate', 'shipment_cancel_failed_ops')
    await setConfig('notify.shipmentCancelFailedLocale', 'en')
    await enqueueShipmentCancelFailedNotification(db, {
      orderId: ORDER_ID,
      unresolved: [{ awb: '18000000001', remark: 'Carrier refused' }],
      adminOrigin: ADMIN_ORIGIN,
    })
    const [row] = await rowsFor('shipment_cancel_failed')
    const { channels, sent } = recordingChannel()

    const after = await sendOpsNotification(db, row!, channels, log)

    expect(after?.status).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.template).toEqual({ name: 'shipment_cancel_failed_ops', locale: 'en' })
  })

  it('stays silent when only the template name is set — a half-set pair is ignored', async () => {
    await setConfig('notify.orderCancelledTemplate', 'order_cancelled_ops')
    const hook = makeOrderCancelledNotificationHook({ adminOrigin: ADMIN_ORIGIN, log })
    await db.transaction(async (tx) => hook(tx, ORDER_ID, order(), 'Ordered by mistake'))
    const [row] = await rowsFor('order_cancelled')
    const { channels, sent } = recordingChannel()

    const after = await sendOpsNotification(db, row!, channels, log)

    expect(sent).toHaveLength(0)
    expect(after?.status).toBe('skipped_unconfigured')
  })
})
