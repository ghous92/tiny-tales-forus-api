/**
 * Ops notification outbox business rules (docs/SPEC-MANUAL-FULFILMENT.md §4A).
 * This module owns `ops_notifications` and NOTHING else — it never reads
 * `app_config`, never calls a channel adapter, never imports `lib/notify/*`'s
 * HTTP-calling code. Same split ARCHITECTURE.md draws for `invoices`: the
 * table + its invariants live here, the cross-module wiring (payments hook,
 * the actual WhatsApp send) lives at the ROUTE layer in
 * `routes/opsNotifications.ts`.
 *
 * ## The one hard invariant: exactly-once enqueue
 *
 * A paid order can be transitioned by verify, the Razorpay webhook, or the
 * recover sweep — any one of which might enqueue a notification for it. The
 * unique `dedupe_key` (`${kind}:${orderId}:${channel}:${target}`), not the
 * caller, is what guarantees a repeat enqueue is a no-op: `onConflictDoNothing`
 * turns a race into idempotency rather than a duplicate WhatsApp message.
 *
 * ## The second hard invariant: exactly-once SEND
 *
 * Exactly-once enqueue says nothing about delivery. Two things can hold the
 * same enqueued row at the same moment: the inline post-commit sender
 * (`sendPendingOpsNotifications`, fired the instant a payment commits) and the
 * scheduled drain (`runOpsNotificationSweep`) — and two sweeps can overlap with
 * each other, because Cloud Scheduler retries a run that passes its 300s attempt
 * deadline while Cloud Run leaves the original handler running.
 *
 * {@link claimOpsNotification} is what closes that. A sender takes the row with
 * a guarded UPDATE *before* it calls the channel; the loser matches zero rows
 * and sends nothing. The `attempts` increment moved onto the claim for the same
 * reason — a try that is counted only after the provider answers is not counted
 * at all when the provider never does.
 */

import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { opsNotifications, type OpsNotificationRow } from '../db/schema.js'
import type { NotificationMessage } from '../lib/notify/types.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Runner = Db | Tx

/** Rows past this many failed sends stop being retried by the retry sweep. */
export const MAX_OPS_NOTIFICATION_ATTEMPTS = 5

/**
 * How long a row may sit claimed (`sending`) before {@link reapStuckOpsNotifications}
 * takes it back.
 *
 * Must exceed the worst realistic channel round trip by a wide margin: reaping a
 * send that is merely slow re-creates the duplicate this whole mechanism exists
 * to prevent. 15 minutes against a WhatsApp Cloud API call measured in seconds
 * is that margin, and it is still inside the 30-minute sweep cadence, so a row
 * abandoned by a crashed instance is retried on the next pass but one rather
 * than sitting stuck until somebody notices.
 */
export const OPS_NOTIFICATION_CLAIM_STALE_MS = 15 * 60 * 1000

/**
 * The statuses a row can be picked up from. ONE definition, shared by the sweep
 * predicate, the readiness counter and {@link claimOpsNotification} — three
 * places that must agree, and where disagreement is silent: a row the sweep
 * selects but the claim rejects is a permanent no-op, and a row the sweep never
 * selects is simply never sent.
 *
 * `skipped_unconfigured` belongs here, and its absence was a real bug. It is the
 * state EVERY row lands in while WhatsApp has no credentials or Meta has
 * `order_paid_ops` in PENDING — the inline post-commit sender writes it seconds
 * after the payment commits. Excluded from this list it is terminal in practice,
 * which quietly falsified the whole point of the `ops-notifications` job
 * (SPEC-SWEEP-AUTOMATION.md §4): that the backlog delivers itself the moment
 * approval lands, with no deploy and nobody watching for the email. It cannot
 * strand rows the way `sent` or an exhausted `attempts` does, because nothing
 * was ever attempted — `recordOpsNotificationAttempt` deliberately does not
 * count it, so such a row keeps its full retry budget however long the outage
 * lasts.
 */
export const OPS_NOTIFICATION_SENDABLE_STATUSES = [
  'pending',
  'failed',
  'skipped_unconfigured',
] as const

/** `${kind}:${orderId}:${channel}:${target}` — exported so tests can assert on it directly. */
export function opsNotificationDedupeKey(
  kind: string,
  orderId: string,
  channel: string,
  target: string
): string {
  return `${kind}:${orderId}:${channel}:${target}`
}

export interface EnqueueOpsNotificationInput {
  kind: string
  orderId: string
  channel: string
  target: string
  message: NotificationMessage
}

/**
 * Enqueue one row, or return null if it already exists (idempotent replay).
 * MUST be called inside the same transaction as the `paid` transition it
 * belongs to — same rule `createShipmentIntent` follows — so it rolls back
 * with the money if the transaction does, and rows exist for exactly the
 * orders that are durably paid.
 */
export async function enqueueOpsNotification(
  tx: Runner,
  input: EnqueueOpsNotificationInput
): Promise<OpsNotificationRow | null> {
  const dedupeKey = opsNotificationDedupeKey(input.kind, input.orderId, input.channel, input.target)
  const inserted = await tx
    .insert(opsNotifications)
    .values({
      kind: input.kind,
      orderId: input.orderId,
      channel: input.channel,
      target: input.target,
      payload: input.message,
      dedupeKey,
    })
    .onConflictDoNothing({ target: opsNotifications.dedupeKey })
    .returning()
  return inserted[0] ?? null
}

/** The outcome of one send attempt, as {@link recordOpsNotificationAttempt} records it. */
export type OpsNotificationOutcome =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'failed'; error: string }
  /** The channel adapter isn't configured — nothing was tried, so this does NOT count as an attempt. */
  | { status: 'skipped_unconfigured' }
  /**
   * A MARKETING row whose recipient declined or opted out. Also not an attempt
   * — but unlike `skipped_unconfigured` this one is TERMINAL, because it is
   * absent from {@link OPS_NOTIFICATION_SENDABLE_STATUSES}. Nothing re-examines
   * the row; withdrawn consent is not a transient condition.
   */
  | { status: 'skipped_no_consent' }

/**
 * Take a row for sending, or return undefined if somebody else already has it.
 *
 * The whole point is the WHERE clause: {@link OPS_NOTIFICATION_SENDABLE_STATUSES}
 * is checked and replaced in ONE statement, so of two callers racing the same
 * row exactly one gets a returned row and the other gets nothing. That is a
 * compare-and-swap, the same shape `markPaid` uses to make the payment
 * transition safe against verify/webhook/recover — not a lock. No transaction
 * is held open across the channel call, which matters: a `SELECT ... FOR UPDATE`
 * spanning a third-party HTTP round trip would pin a Neon compute awake for the
 * entire sweep loop (docs/WIP-NEON-COST.md).
 *
 * `attempts` is incremented HERE rather than at the terminal write, so a send
 * that never comes back still burns its budget. Counting only completed
 * attempts is what lets one poisonous row be retried forever.
 *
 * The attempt cap is re-checked in the predicate rather than trusted from the
 * caller's earlier `listOpsNotificationsNeedingSend`: the row may have been
 * attempted several times between that read and this claim.
 */
export async function claimOpsNotification(
  db: Db,
  id: string
): Promise<OpsNotificationRow | undefined> {
  const [row] = await db
    .update(opsNotifications)
    .set({
      status: 'sending',
      attempts: sql`${opsNotifications.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(opsNotifications.id, id),
        inArray(opsNotifications.status, [...OPS_NOTIFICATION_SENDABLE_STATUSES]),
        lt(opsNotifications.attempts, MAX_OPS_NOTIFICATION_ATTEMPTS)
      )
    )
    .returning()
  return row
}

/**
 * Return rows abandoned mid-send to the retry pool, and report how many.
 *
 * A claimed row whose sender died — instance evicted, deploy mid-sweep, Cloud
 * Run killing a handler whose scheduler attempt deadline passed — is stuck in
 * `sending` forever, and `sending` appears in no sweep predicate. Without this
 * the safety mechanism would quietly become a way to lose notifications.
 *
 * Reaped to `failed`, deliberately, not to `pending`. `failed` is the state
 * meaning "tried, didn't land", which is exactly what is known: the claim was
 * taken, so the channel call may well have gone out and been delivered. Both
 * states are equally eligible for retry, but only `failed` reads honestly on the
 * admin table, and the incremented `attempts` from the claim still bounds it —
 * a row that keeps dying mid-send exhausts its budget instead of looping.
 */
export async function reapStuckOpsNotifications(
  db: Db,
  now: Date = new Date(),
  staleMs: number = OPS_NOTIFICATION_CLAIM_STALE_MS
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs)
  const rows = await db
    .update(opsNotifications)
    .set({
      status: 'failed',
      lastError: 'send abandoned mid-flight; reclaimed by the retry sweep',
      updatedAt: sql`now()`,
    })
    .where(and(eq(opsNotifications.status, 'sending'), lt(opsNotifications.updatedAt, cutoff)))
    .returning({ id: opsNotifications.id })
  return rows.length
}

/**
 * Record how one send attempt went, closing out a {@link claimOpsNotification}.
 *
 * `attempts` is NOT touched here — the claim already counted the try. The one
 * outcome that reaches this function without a claim is `skipped_unconfigured`
 * (resolved before claiming, because nothing is attempted and it must not burn
 * the retry budget), exactly the same rule `recordEmailAttempt` applies to
 * `skipped_no_email`.
 */
export async function recordOpsNotificationAttempt(
  db: Db,
  id: string,
  outcome: OpsNotificationOutcome
): Promise<OpsNotificationRow | undefined> {
  const patch =
    outcome.status === 'sent'
      ? {
          status: 'sent' as const,
          sentAt: sql`now()`,
          providerMessageId: outcome.providerMessageId,
          lastError: null,
        }
      : outcome.status === 'failed'
        ? {
            status: 'failed' as const,
            lastError: outcome.error.slice(0, 500),
          }
        : outcome.status === 'skipped_no_consent'
          ? {
              // Written into `last_error` because it is the column the admin
              // table renders, and "why is this row not going out" is the only
              // question anyone opens it to ask. Not an error in any other sense.
              status: 'skipped_no_consent' as const,
              lastError: 'recipient has not opted in to WhatsApp marketing',
            }
          : { status: 'skipped_unconfigured' as const }

  const [row] = await db
    .update(opsNotifications)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(opsNotifications.id, id))
    .returning()
  return row
}

/**
 * Rows still owed a send — {@link OPS_NOTIFICATION_SENDABLE_STATUSES} under the
 * attempt cap. What `POST /v1/admin/notifications/dispatch` retries.
 *
 * That includes `skipped_unconfigured`, which is the resting state of the entire
 * outbox while WhatsApp is unwired or Meta has the template in PENDING — see the
 * constant for why excluding it made those rows terminal and broke the sweep's
 * reason for existing.
 */
export async function listOpsNotificationsNeedingSend(
  db: Db,
  limit = 100
): Promise<OpsNotificationRow[]> {
  return db
    .select()
    .from(opsNotifications)
    .where(
      and(
        inArray(opsNotifications.status, [...OPS_NOTIFICATION_SENDABLE_STATUSES]),
        lt(opsNotifications.attempts, MAX_OPS_NOTIFICATION_ATTEMPTS)
      )
    )
    .orderBy(asc(opsNotifications.enqueuedAt))
    .limit(limit)
}

/**
 * How many rows {@link listOpsNotificationsNeedingSend} would return, uncapped
 * by the sweep limit. Readiness only — same predicate, no `limit`, so a backlog
 * larger than one sweep still reports its true size.
 */
export async function countOpsNotificationsNeedingSend(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opsNotifications)
    .where(
      and(
        inArray(opsNotifications.status, [...OPS_NOTIFICATION_SENDABLE_STATUSES]),
        lt(opsNotifications.attempts, MAX_OPS_NOTIFICATION_ATTEMPTS)
      )
    )
  return row?.n ?? 0
}

/**
 * Everything still `pending` for one order — what the post-commit
 * fire-and-forget sender picks up right after its own transition enqueued it.
 * Deliberately not scoped to "rows this request just inserted": picking up any
 * still-pending row for the order is harmless (each is sent at most once,
 * still governed by its own attempt cap) and self-heals a case where an
 * earlier commit's post-commit send never got the chance to run.
 */
export async function listPendingOpsNotificationsForOrder(
  db: Db,
  orderId: string
): Promise<OpsNotificationRow[]> {
  return db
    .select()
    .from(opsNotifications)
    .where(and(eq(opsNotifications.orderId, orderId), eq(opsNotifications.status, 'pending')))
}
