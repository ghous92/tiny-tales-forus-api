#!/usr/bin/env tsx
/**
 * `npm run db:seed-coupons` — inserts the sample coupons (DIRECT15, FLAT100)
 * plus REFILL10, ONLY where the code is absent (never overwrites an existing
 * row; to change one, use the admin PUT route or delete + re-seed). Mirrors
 * `scripts/seed-config.ts`'s conventions exactly.
 *
 * REFILL10 is different in kind from the other two: it is not a sample, it is a
 * PRODUCTION DEPENDENCY of the approved WhatsApp template
 * `laanya_refill_reminder`, which prints the code in its body. Seed it before
 * enabling `notify.replenishmentTemplate`, never after.
 *
 * The core logic (`seedCouponDefaults`) takes a `Db` and is unit-testable
 * against PGlite; this file's top-level code is just the CLI wrapper that
 * reads `DATABASE_URL` and calls it.
 *
 * Usage: `npm run db:seed-coupons` (tsx + `--env-file-if-exists=.env` picks up
 * DATABASE_URL locally; CI/CD supplies it as an env var).
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { coupons } from '../src/db/schema.js'

/** One default coupon: everything `createCoupon` would otherwise require from an admin. */
export interface CouponDefault {
  code: string
  label: string
  description: string
  discountType: 'flat' | 'percent'
  discountValue: number
  minCartInr: number
  maxDiscountInr: number | null
  /** ISO string, or null for no bound. */
  validFrom: string | null
  validTo: string | null
  sortOrder: number
  /** Waive the delivery fee outright while applied; see `coupons.waives_shipping`. */
  waivesShipping?: boolean
}

/**
 * The two sample coupons from the coupon feature spec — an early-bird 15% off
 * (time-boxed) and a flat ₹100-off-above-₹1000 (open-ended) — plus REFILL10,
 * which the refill-reminder template depends on.
 */
export const COUPON_DEFAULTS: CouponDefault[] = [
  {
    code: 'DIRECT15',
    label: 'Early Bird offer',
    description: '15% off your order.',
    discountType: 'percent',
    discountValue: 15,
    minCartInr: 0,
    maxDiscountInr: null,
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: '2026-08-31T23:59:59.000Z',
    sortOrder: 0,
  },
  {
    code: 'FLAT100',
    label: 'Rs 100 off above Rs 1000',
    description: 'Flat Rs 100 off on orders above Rs 1000.',
    discountType: 'flat',
    discountValue: 100,
    minCartInr: 1000,
    maxDiscountInr: null,
    validFrom: null,
    validTo: null,
    sortOrder: 1,
  },
  {
    // Referenced BY NAME in the approved WhatsApp template
    // `laanya_refill_reminder`, whose body reads "Use Code: *REFILL10* at
    // checkout!". The template is live copy going to real shoppers, so this row
    // is not optional decoration — without it every recipient who follows the
    // reminder hits a rejected code, having been told by us to use it.
    //
    // Owner decision 2026-09-01: seed to production NOW, ahead of the template
    // going live, with a floor and an expiry attached — the code exists in
    // prod months before the message that introduces it, so it is guessable
    // by anyone in that window and must not be open-ended.
    //
    // `minCartInr: 99` is the cheapest ACTIVE catalogue SKU (Daniya Petroleum
    // Jelly 50ml, verified against prod 2026-09-01). Deliberately a floor, not
    // a gate: the reminder says "your {{2}} is running low" about the exact
    // item the shopper already bought, so any threshold ABOVE that item's
    // price would break the promise for precisely the audience targeted. It
    // rejects only degenerate carts, and the message makes no minimum-spend
    // claim, so no shopper meets a condition they were not shown.
    //
    // `validTo` bounds the guessable window instead. It is set far past any
    // reminder that could be in flight — the reminder fires ~60 days after
    // delivery and chains across two Cloud Tasks hops — so no queued send is
    // stranded. Re-extend it when `notify.replenishmentTemplate` is enabled;
    // retire the code by flipping `active`, never by letting it lapse silently
    // while reminders are still landing.
    code: 'REFILL10',
    label: 'Refill reminder — 10% off',
    description: '10% off your refill order.',
    discountType: 'percent',
    discountValue: 10,
    minCartInr: 99,
    // Uncapped, matching the template's unqualified "10% OFF". A cap would be a
    // second unstated condition.
    maxDiscountInr: null,
    validFrom: null,
    validTo: '2027-03-31T23:59:59.000Z',
    // Last in the offers strip: this is a targeted win-back code, not a
    // storefront promotion, and it should not outrank the public offers.
    sortOrder: 2,
    // The template body promises "10% OFF + Free Express Shipping". A percent
    // coupon alone cannot keep the second half: ten of the fourteen active SKUs
    // price below the ₹249 free-delivery tier, so a shopper reordering the item
    // the reminder names would be charged freight after being told it was free.
    waivesShipping: true,
  },
]

/**
 * Insert every default whose code is absent; leave existing codes untouched.
 * Returns the codes actually inserted, in `COUPON_DEFAULTS` order.
 */
export async function seedCouponDefaults(
  db: Db,
  defaults: CouponDefault[] = COUPON_DEFAULTS
): Promise<string[]> {
  const inserted: string[] = []
  for (const entry of defaults) {
    const result = await db
      .insert(coupons)
      .values({
        code: entry.code,
        label: entry.label,
        description: entry.description,
        discountType: entry.discountType,
        discountValue: entry.discountValue,
        minCartInr: entry.minCartInr,
        maxDiscountInr: entry.maxDiscountInr,
        validFrom: entry.validFrom ? new Date(entry.validFrom) : null,
        validTo: entry.validTo ? new Date(entry.validTo) : null,
        active: true,
        sortOrder: entry.sortOrder,
        waivesShipping: entry.waivesShipping ?? false,
      })
      .onConflictDoNothing({ target: coupons.code })
      .returning({ code: coupons.code })
    if (result.length > 0) inserted.push(entry.code)
  }
  return inserted
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-coupons: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    // Fail fast if the coupons table doesn't exist yet (migrations not run).
    await db.execute(sql`select 1 from coupons limit 1`)
    const inserted = await seedCouponDefaults(db)
    if (inserted.length === 0) {
      // eslint-disable-next-line no-console
      console.log('db:seed-coupons: nothing to do, all default codes already present')
    } else {
      // eslint-disable-next-line no-console
      console.log(`db:seed-coupons: inserted ${inserted.length} code(s): ${inserted.join(', ')}`)
    }
  } finally {
    await pool.end()
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
