/**
 * Razorpay Magic Checkout for guests.
 *
 * Razorpay's modal collects the phone, the delivery address and the payment, so
 * at order-create we know neither who this is nor where it is going. `payments`
 * requires both, so the order waits in `magic_checkouts` and becomes an ordinary
 * `payments` row once a capture exists ({@link convertMagicCheckout}). From that
 * point verify, the webhook, recover, invoices and fulfilment run unchanged.
 *
 * The order is attached to the account holding the phone Razorpay reports. No
 * session is ever issued from that number: Razorpay only documents an OTP for
 * loading or saving an address, so it may be unverified. The shopper sees the
 * order after signing in with our own OTP on the same number.
 *
 * Like `services/payments.ts`, this never imports another module's service. The
 * route resolves pricing, coupons and stock and passes plain values in.
 */

import { and, eq, lt, sql } from 'drizzle-orm'

import type { Cart } from '../contracts/cart.js'
import type { MagicOrder, MagicOrderCreate, MagicOrderStatus } from '../contracts/magicCheckout.js'
import type { Db } from '../db/client.js'
import { magicCheckouts, payments, users, type MagicCheckoutRow } from '../db/schema.js'
import { RAZORPAY_STORE_TAG } from '../lib/brand.js'
import { validationFailed } from '../lib/errors.js'
import type {
  MagicCustomerDetails,
  MagicLineItem,
  PaymentsGateway,
  RazorpayApi,
} from '../lib/razorpay.js'
import { getItemsBySkus } from './catalog.js'
import {
  RECOVER_EXPIRE_AFTER_MS,
  RECOVER_STALE_AFTER_MS,
  toPaise,
  type AddressSnapshot,
  type CartSnapshot,
} from './payments.js'

type Log = (obj: Record<string, unknown>, msg: string) => void

/** Bounds one sweep's Razorpay round trips, like `RECOVER_MAX_BATCH`. */
const SWEEP_BATCH = 50

/** Razorpay's `state_code` values, for when it reports a code instead of a name. */
const STATE_NAMES_BY_ISO: Readonly<Record<string, string>> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CH: 'Chandigarh',
  CT: 'Chhattisgarh',
  DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OR: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TN: 'Tamil Nadu',
  TG: 'Telangana',
  TR: 'Tripura',
  UP: 'Uttar Pradesh',
  UT: 'Uttarakhand',
  WB: 'West Bengal',
}

/**
 * A state the invoice can use. A name we do not recognise is kept as Razorpay
 * sent it: the invoice hook then logs and leaves that invoice for backfill,
 * rather than holding up an order the shopper has already paid for.
 */
export function canonicalState(raw: string): string {
  const trimmed = raw.trim()
  return STATE_NAMES_BY_ISO[trimmed.toUpperCase()] ?? trimmed
}

/** `+919876543210` / `919876543210` / `9876543210` → 10 digits, or null if not Indian mobile. */
export function nationalPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  const national = digits.length > 10 && digits.startsWith('91') ? digits.slice(2) : digits
  return /^[6-9]\d{9}$/.test(national) ? national : null
}

/** The shipping address on a Magic order, in the shape `address_snapshot` holds. */
export function addressFromCustomerDetails(
  details: MagicCustomerDetails | null | undefined
): AddressSnapshot | null {
  const shipping = details?.shipping_address
  if (!shipping) return null
  const phone = nationalPhone(shipping.contact) ?? nationalPhone(details?.contact)
  const pincode = shipping.zipcode?.trim() ?? ''
  const city = shipping.city?.trim() ?? ''
  const state = shipping.state?.trim() ?? ''
  const houseNumber = shipping.line1?.trim() ?? ''
  if (!phone || !/^\d{6}$/.test(pincode) || !city || !state || !houseNumber) return null
  return {
    name: shipping.name?.trim() || 'Customer',
    phone,
    pincode,
    city,
    state: canonicalState(state),
    houseNumber,
    // Some addresses fit on line1 alone; the snapshot's consumers expect text here.
    roadArea: shipping.line2?.trim() || city,
  }
}

/**
 * Create the Razorpay order and hold it. `amount` and `line_items_total` both
 * carry the post-coupon total while the lines keep their prices, which is
 * Razorpay's documented shape for a discount applied before Checkout opens.
 */
export async function createMagicOrder(
  db: Db,
  gateway: PaymentsGateway,
  cart: Cart,
  body: MagicOrderCreate
): Promise<MagicOrder> {
  const activeLines = cart.items.filter((line) => line.active && line.qty > 0)
  if (activeLines.length === 0 || cart.totalInr <= 0) throw validationFailed('Your cart is empty')

  const gstBySku = new Map(
    (
      await getItemsBySkus(
        db,
        activeLines.map((line) => line.sku)
      )
    ).map((item) => [item.sku, { hsn: item.hsnCode, gstRatePct: item.gstRatePct }])
  )

  const amountPaise = toPaise(cart.totalInr)
  const lineItems: MagicLineItem[] = activeLines.map((line) => ({
    sku: line.sku,
    variant_id: line.sku,
    price: toPaise(line.priceInr),
    offer_price: toPaise(line.priceInr),
    quantity: line.qty,
    name: line.name,
    description: line.size,
    ...(line.imageUrl ? { image_url: line.imageUrl } : {}),
  }))

  const rzp = await gateway.client()
  const order = await rzp.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `tt_${crypto.randomUUID().replaceAll('-', '').slice(0, 32)}`,
    notes: { store: RAZORPAY_STORE_TAG, checkout: 'magic' },
    payment_capture: 1,
    line_items_total: amountPaise,
    line_items: lineItems,
  })

  const discountInr = cart.coupon.discountInr
  const couponCode = cart.coupon.code && discountInr > 0 ? cart.coupon.code : null
  const snapshot: CartSnapshot = {
    items: activeLines.map((line) => ({ ...line, ...gstBySku.get(line.sku) })),
    goodsInr: cart.coupon.subtotalInr,
    couponDiscountInr: discountInr,
    ...(couponCode ? { couponCode } : {}),
    shippingFeeInr: 0,
    totalInr: cart.totalInr,
  }
  const attribution = body.attribution
  await db.insert(magicCheckouts).values({
    orderId: order.id,
    amountPaise,
    currency: 'INR',
    cartSnapshot: snapshot,
    termsAcceptedAt: new Date(),
    analyticsAnonymousId: body.anonymousId ?? null,
    utmSource: attribution?.utmSource ?? null,
    utmMedium: attribution?.utmMedium ?? null,
    utmCampaign: attribution?.utmCampaign ?? null,
    utmContent: attribution?.utmContent ?? null,
    gclid: attribution?.gclid ?? null,
    oppref: attribution?.oppref ?? null,
  })

  return {
    orderId: order.id,
    keyId: gateway.config.keyId,
    mode: gateway.config.mode,
    amountPaise,
    currency: 'INR',
    totalInr: cart.totalInr,
    discountInr,
    couponCode,
  }
}

/** The account for this phone, created if new. Our OTP sign-in re-links it by phone. */
async function userForPhone(db: Db, phone: string, email: string | null): Promise<string> {
  const e164 = `+91${phone}`
  await db
    .insert(users)
    .values({ firebaseUid: `magic:${e164}`, phone: e164 })
    .onConflictDoNothing({ target: users.phone })
  const [user] = await db
    .update(users)
    // Only fills a blank: this number may be unverified, so it must not be able
    // to change the email on someone's existing account.
    .set({ email: sql`coalesce(${users.email}, ${email}::text)`, updatedAt: sql`now()` })
    .where(eq(users.phone, e164))
    .returning({ id: users.id })
  if (!user) throw new Error('magic checkout: user upsert returned no row')
  return user.id
}

/** What conversion produced, so the route can save the address for next time. */
export interface MagicConversion {
  userId: string
  address: AddressSnapshot
}

/**
 * Turn a held order into a `pending` `payments` row. Returns null when the order
 * is not a Magic order (the common case on the webhook) or is already converted.
 * Idempotent: verify, the webhook and the sweep can all race here, and the
 * primary key lets exactly one insert land.
 *
 * Throws when Razorpay has not given us a complete address. The money is
 * captured at that point, so the row stays `open`, the caller logs an error, and
 * the sweep tries again.
 */
export async function convertMagicCheckout(
  db: Db,
  rzp: RazorpayApi,
  orderId: string,
  stockOrigins?: (pincode: string, skus: string[]) => Promise<ReadonlyMap<string, string>>
): Promise<MagicConversion | null> {
  const [held] = await db
    .select()
    .from(magicCheckouts)
    .where(and(eq(magicCheckouts.orderId, orderId), eq(magicCheckouts.status, 'open')))
    .limit(1)
  if (!held) return null

  const order = await rzp.orders.fetch(orderId)
  const address = addressFromCustomerDetails(order.customer_details)
  if (!address) throw new Error(`magic checkout: incomplete customer_details on ${orderId}`)

  // Razorpay's placeholder for "no email given". Nothing can be sent to it.
  const rawEmail = order.customer_details?.email?.trim()
  const email = rawEmail && rawEmail !== 'void@razorpay.com' ? rawEmail : null
  const userId = await userForPhone(db, String(address.phone), email)

  const snapshot = held.cartSnapshot as CartSnapshot
  const origins = await stockOrigins?.(
    String(address.pincode),
    snapshot.items.map((line) => line.sku)
  )
  return await convertHeld(db, held, userId, address, {
    ...snapshot,
    items: snapshot.items.map((line) => {
      const nodeId = origins?.get(line.sku)
      return nodeId ? { ...line, stockNodeId: nodeId } : line
    }),
  })
}

async function convertHeld(
  db: Db,
  held: MagicCheckoutRow,
  userId: string,
  address: AddressSnapshot,
  snapshot: CartSnapshot
): Promise<MagicConversion | null> {
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(payments)
      .values({
        orderId: held.orderId,
        userId,
        amountPaise: held.amountPaise,
        currency: held.currency,
        status: 'pending',
        cartSnapshot: snapshot,
        addressSnapshot: address,
        shippingSnapshot: null,
        consentSnapshot: {
          accepted: true,
          acceptedAt: held.termsAcceptedAt.toISOString(),
          surface: 'magic_checkout',
        },
        analyticsAnonymousId: held.analyticsAnonymousId,
        utmSource: held.utmSource,
        utmMedium: held.utmMedium,
        utmCampaign: held.utmCampaign,
        utmContent: held.utmContent,
        gclid: held.gclid,
        oppref: held.oppref,
        // The order's real age, so the recover sweep can pick it up straight away.
        createdAt: held.createdAt,
      })
      .onConflictDoNothing({ target: payments.orderId })
      .returning({ orderId: payments.orderId })
    await tx
      .update(magicCheckouts)
      .set({ status: 'converted', updatedAt: sql`now()` })
      .where(eq(magicCheckouts.orderId, held.orderId))
    return inserted.length > 0 ? { userId, address } : null
  })
}

/**
 * Convert held orders whose capture we never heard about, and expire the ones
 * nobody paid for. Runs ahead of `recover`, which then finds the new rows and
 * performs the paid transition exactly as it does for any lost webhook.
 */
export async function sweepMagicCheckouts(
  db: Db,
  gateway: PaymentsGateway,
  log: Log,
  now: Date = new Date(),
  stockOrigins?: (pincode: string, skus: string[]) => Promise<ReadonlyMap<string, string>>,
  onConverted?: (conversion: MagicConversion) => Promise<void>
): Promise<void> {
  const staleBefore = new Date(now.getTime() - RECOVER_STALE_AFTER_MS)
  const expireBefore = new Date(now.getTime() - RECOVER_EXPIRE_AFTER_MS)
  const stale = await db
    .select()
    .from(magicCheckouts)
    .where(and(eq(magicCheckouts.status, 'open'), lt(magicCheckouts.createdAt, staleBefore)))
    .orderBy(magicCheckouts.createdAt)
    .limit(SWEEP_BATCH)
  if (stale.length === 0) return

  const rzp = await gateway.client()
  for (const held of stale) {
    try {
      const { items } = await rzp.orders.fetchPayments(held.orderId)
      if (items.some((payment) => payment.status === 'captured')) {
        const conversion = await convertMagicCheckout(db, rzp, held.orderId, stockOrigins)
        if (conversion) await onConverted?.(conversion)
      } else if (held.createdAt < expireBefore) {
        await db
          .update(magicCheckouts)
          .set({ status: 'expired', updatedAt: sql`now()` })
          .where(and(eq(magicCheckouts.orderId, held.orderId), eq(magicCheckouts.status, 'open')))
      }
    } catch (err) {
      // Captured money with no order is the one state that must not stay quiet.
      log({ err, orderId: held.orderId }, 'magic checkout sweep: could not convert order')
    }
  }
}

/** The public status read. Only ever answers for Magic orders, never other orders. */
export async function getMagicOrderStatus(
  db: Db,
  orderId: string
): Promise<MagicOrderStatus | null> {
  const [held] = await db
    .select()
    .from(magicCheckouts)
    .where(eq(magicCheckouts.orderId, orderId))
    .limit(1)
  if (!held) return null
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1)
  const snapshot = (row?.cartSnapshot ?? held.cartSnapshot) as CartSnapshot
  const phone = (row?.addressSnapshot as { phone?: unknown } | undefined)?.phone
  return {
    orderId,
    status: (row?.status ?? 'pending') as MagicOrderStatus['status'],
    totalInr: held.amountPaise / 100,
    phoneLast4: typeof phone === 'string' ? phone.slice(-4) : null,
    items: (snapshot.items as Array<CartSnapshot['items'][number] & { name: string }>).map((line) => ({
      sku: line.sku,
      name: line.name,
      priceInr: line.priceInr,
      qty: line.qty,
    })),
  }
}

/** Shipping-info answer. Delivery is free, and order-create refuses if that ever changes. */
export function magicShippingMethods(zipcode: string) {
  return [
    {
      id: 'standard',
      name: 'Free delivery',
      description: 'Delivered across India',
      serviceable: /^[1-9]\d{5}$/.test(zipcode),
      shipping_fee: 0,
      cod: false,
      cod_fee: 0,
    },
  ]
}

