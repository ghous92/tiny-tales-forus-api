/**
 * `services/marketingConsent.ts` — the one gate the MARKETING replenishment
 * reminder passes through. Against a real Postgres (PGlite + committed
 * migrations), same shape as `test/services/opsNotifications.test.ts`.
 *
 * The property that matters is which RECORD decides. `payments.consent_snapshot`
 * is evidence and is frozen per order; `users.marketing_whatsapp_opt_in` is
 * current state. Reading the snapshot would mean a shopper who opted out last
 * week still gets the reminder scheduled against an order from March — the
 * snapshot for that order says yes and always will. So the decisive test here is
 * the last one: opting out must suppress a reminder for an order whose snapshot
 * recorded an opt-IN.
 *
 * Three-valued on purpose. `unknown` (never asked) is recoverable — the row
 * parks and delivers itself if the shopper opts in later — while `declined` is
 * terminal. Defaulting an unresolvable user to `granted` would be a compliance
 * incident rather than a bug, so that case is pinned too.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { payments, users } from '../../src/db/schema.js'
import {
  adAudienceConsentForOrder,
  marketingConsentForOrder,
  setAdAudienceOptIn,
  setMarketingWhatsappOptIn,
} from '../../src/services/marketingConsent.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

/** One paid order and its shopper. `optIn` seeds `users.marketing_whatsapp_opt_in`. */
async function seedOrder(
  orderId: string,
  optIn: boolean | null,
  consentSnapshot?: Record<string, unknown>
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      firebaseUid: `uid-${orderId}`,
      phone: `+9198765${orderId.slice(-5).padStart(5, '0')}`,
      ...(optIn === null
        ? {}
        : { marketingWhatsappOptIn: optIn, marketingWhatsappOptInAt: new Date() }),
    })
    .returning({ id: users.id })
  await db.insert(payments).values({
    orderId,
    userId: user!.id,
    amountPaise: 17_900,
    status: 'paid',
    cartSnapshot: { items: [{ sku: 'SKU-1', qty: 1, priceInr: 179 }], totalInr: 179 },
    addressSnapshot: { pincode: '395003' },
    ...(consentSnapshot ? { consentSnapshot } : {}),
  })
  return user!.id
}

describe('marketingConsentForOrder', () => {
  it('is granted for a shopper who opted in', async () => {
    await seedOrder('order_OPTIN1', true)
    expect(await marketingConsentForOrder(db, 'order_OPTIN1')).toBe('granted')
  })

  it('is declined for a shopper who said no', async () => {
    await seedOrder('order_OPTOUT1', false)
    expect(await marketingConsentForOrder(db, 'order_OPTOUT1')).toBe('declined')
  })

  it('is unknown for a shopper who was never asked', async () => {
    await seedOrder('order_NEVER1', null)
    expect(await marketingConsentForOrder(db, 'order_NEVER1')).toBe('unknown')
  })

  /**
   * A missing user is not consent. The row parks on `unknown` rather than
   * sending, which is the safe direction: the alternative failure mode is a
   * marketing send to someone who never agreed.
   */
  it('is unknown — never granted — for an order that does not exist', async () => {
    expect(await marketingConsentForOrder(db, 'order_NOSUCH')).toBe('unknown')
  })
})

describe('setMarketingWhatsappOptIn', () => {
  it('records the flag and stamps when it changed', async () => {
    const userId = await seedOrder('order_SET1', null)

    await setMarketingWhatsappOptIn(db, userId, true)

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    expect(row?.marketingWhatsappOptIn).toBe(true)
    expect(row?.marketingWhatsappOptInAt).toBeInstanceOf(Date)
    expect(await marketingConsentForOrder(db, 'order_SET1')).toBe('granted')
  })

  it('moves the timestamp forward when a choice is re-affirmed', async () => {
    const userId = await seedOrder('order_SET2', null)
    await setMarketingWhatsappOptIn(db, userId, true)
    const [first] = await db.select().from(users).where(eq(users.id, userId)).limit(1)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await setMarketingWhatsappOptIn(db, userId, true)

    const [second] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    expect(second!.marketingWhatsappOptInAt!.getTime()).toBeGreaterThan(
      first!.marketingWhatsappOptInAt!.getTime()
    )
  })

  /**
   * The whole reason state and evidence are separate records. The order's frozen
   * snapshot still says the shopper agreed — and must, it is the regulator's
   * copy — but the withdrawal is what a send reads.
   */
  it('suppresses an order whose consent_snapshot recorded an opt-IN', async () => {
    const userId = await seedOrder('order_WITHDRAW', true, {
      marketingWhatsapp: { accepted: true, at: '2026-03-01T00:00:00.000Z' },
    })
    expect(await marketingConsentForOrder(db, 'order_WITHDRAW')).toBe('granted')

    await setMarketingWhatsappOptIn(db, userId, false)

    expect(await marketingConsentForOrder(db, 'order_WITHDRAW')).toBe('declined')
    const [order] = await db
      .select()
      .from(payments)
      .where(eq(payments.orderId, 'order_WITHDRAW'))
      .limit(1)
    // Evidence is untouched by a withdrawal — it describes a moment that passed.
    expect(order?.consentSnapshot).toMatchObject({ marketingWhatsapp: { accepted: true } })
  })

  it('withdrawal reaches EVERY past order of that shopper, not just the newest', async () => {
    const userId = await seedOrder('order_OLD', true)
    // A second order for the same shopper, sharing the user row.
    await db.insert(payments).values({
      orderId: 'order_NEW',
      userId,
      amountPaise: 29_900,
      status: 'paid',
      cartSnapshot: { items: [{ sku: 'SKU-2', qty: 1, priceInr: 299 }], totalInr: 299 },
      addressSnapshot: { pincode: '395003' },
    })

    await setMarketingWhatsappOptIn(db, userId, false)

    expect(await marketingConsentForOrder(db, 'order_OLD')).toBe('declined')
    expect(await marketingConsentForOrder(db, 'order_NEW')).toBe('declined')
  })
})

/**
 * The gate on sending hashed identifiers to an ad platform. Only an explicit,
 * current `true` opens it; WhatsApp consent must not leak into it.
 */
describe('adAudienceConsentForOrder', () => {
  it('is false for a shopper never asked, even with WhatsApp consent', async () => {
    await seedOrder('order_AD_NEVER', true)
    expect(await adAudienceConsentForOrder(db, 'order_AD_NEVER')).toBe(false)
  })

  it('follows the live flag, including a later withdrawal', async () => {
    const userId = await seedOrder('order_AD_LIVE', null)
    await setAdAudienceOptIn(db, userId, true)
    expect(await adAudienceConsentForOrder(db, 'order_AD_LIVE')).toBe(true)

    await setAdAudienceOptIn(db, userId, false)
    expect(await adAudienceConsentForOrder(db, 'order_AD_LIVE')).toBe(false)
    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row?.adAudienceOptInAt).toBeInstanceOf(Date)
  })

  it('is false for an order that does not exist', async () => {
    expect(await adAudienceConsentForOrder(db, 'order_AD_NOSUCH')).toBe(false)
  })
})
