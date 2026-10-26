/**
 * WhatsApp MARKETING consent — the one gate the replenishment reminder passes
 * through (docs/kb/tasks/TASK-01-whatsapp-retention.md §Consent).
 *
 * ## Why this is its own module
 *
 * Two records describe consent and they answer different questions. Keeping
 * them apart is the entire point of this file:
 *
 *   `payments.consent_snapshot`  — EVIDENCE. What the shopper agreed to at the
 *     instant this order was created, frozen with a server timestamp, never
 *     rewritten. It is what you show a regulator. It is NOT consultable for
 *     "may I send this", because it describes a moment that has passed.
 *
 *   `users.marketing_whatsapp_opt_in` — STATE. What is true right now. An
 *     opt-out flips it, and every pending reminder for every past order of
 *     theirs stops. This is the only field a send may read.
 *
 * Reading the snapshot to decide a send would mean a shopper who opted out
 * last week still receives the reminder scheduled against an order from
 * March — the snapshot for that order still says yes, and always will. That is
 * precisely the failure DPDP's withdrawal right exists to prevent.
 *
 * UTILITY templates (order confirmed, order shipped) never come here. They are
 * transactional, tied to an order the shopper placed, and gating them on a
 * marketing checkbox would withhold a delivery update from someone who simply
 * did not want offers.
 */

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { payments, users } from '../db/schema.js'

/**
 * Whether marketing may be sent to the shopper behind an order.
 *
 * Three-valued because two of the three "no"s are different facts, and the
 * caller writes a different terminal state for each — see
 * `users.marketingWhatsappOptIn`.
 */
export type MarketingConsentState =
  /** Opted in. Send. */
  | 'granted'
  /** Explicitly declined or later opted out. Terminal — never ask again. */
  | 'declined'
  /**
   * Never asked: the opt-in UI has not shipped, or this shopper predates it.
   * Recoverable — a row parked on this delivers itself if they opt in later.
   *
   * Also what an order whose user cannot be resolved gets. A missing user is
   * not consent, and defaulting the unknown case to "granted" is the one
   * mistake in this file that would be a compliance incident rather than a bug.
   */
  | 'unknown'

/**
 * Resolve current marketing consent for an order's shopper.
 *
 * One indexed join, on `payments.user_id` → `users.id`. Called from the send
 * path BEFORE the claim, so it must stay cheap: it runs once per replenishment
 * row per sweep pass, including for rows that will be skipped.
 */
export async function marketingConsentForOrder(
  db: Db,
  orderId: string
): Promise<MarketingConsentState> {
  const [row] = await db
    .select({ optIn: users.marketingWhatsappOptIn })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.userId))
    .where(eq(payments.orderId, orderId))
    .limit(1)

  if (row === undefined) return 'unknown'
  if (row.optIn === null) return 'unknown'
  return row.optIn ? 'granted' : 'declined'
}

/**
 * Record an opt-in or opt-out, stamping when it changed.
 *
 * Both directions go through here so the timestamp can never drift from the
 * flag — a withdrawal whose date is unknown is not much of a record. The write
 * is unconditional rather than compare-and-set: re-affirming an existing
 * choice is legitimate (the shopper ticked the box on a second order) and
 * moving the timestamp forward is the correct outcome.
 */
export async function setMarketingWhatsappOptIn(
  db: Db,
  userId: string,
  optIn: boolean
): Promise<void> {
  await db
    .update(users)
    .set({
      marketingWhatsappOptIn: optIn,
      marketingWhatsappOptInAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
}

/**
 * Persist the shopper's current ad-audience consent — see
 * `users.adAudienceOptIn`. Same unconditional write and same-statement
 * timestamp as {@link setMarketingWhatsappOptIn}.
 */
export async function setAdAudienceOptIn(db: Db, userId: string, optIn: boolean): Promise<void> {
  await db
    .update(users)
    .set({ adAudienceOptIn: optIn, adAudienceOptInAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId))
}

/**
 * Whether the shopper behind an order currently consents to ad-audience
 * sharing — the gate on sending their hashed identifiers to an ad platform.
 *
 * Collapses to a boolean because the caller has only one safe reading of the
 * two "no"s: never asked and declined both mean "send nothing identifying".
 * Reads the live `users` row, never the order's snapshot, so a withdrawal
 * stops identifiers on every later event, including for older orders.
 */
export async function adAudienceConsentForOrder(db: Db, orderId: string): Promise<boolean> {
  const [row] = await db
    .select({ optIn: users.adAudienceOptIn })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.userId))
    .where(eq(payments.orderId, orderId))
    .limit(1)
  return row?.optIn === true
}
