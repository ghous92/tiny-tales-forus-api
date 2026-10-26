/**
 * Cloud Tasks producer for the replenishment reminder
 * (docs/kb/tasks/TASK-01-whatsapp-retention.md §Backend work 5).
 *
 * ## Why a delayed task and not a cron sweep
 *
 * A reminder is due ~60 days after delivery, which reads like a job for a
 * nightly "find everything due today" query. It is not. Neon bills a 5-minute
 * compute minimum per wake, so a poller costs a fixed amount every night
 * forever — including the nights nothing is due, which at current volume is
 * most of them. That is the exact bill `docs/WIP-NEON-COST.md` was written to
 * kill, and re-adding a sweep here would rebuild it.
 *
 * A task carries its own due date. Zero orders means zero tasks means zero
 * wakes: cost tracks reminders, not calendar days.
 *
 * ## The 30-day ceiling, and why this chains
 *
 * Cloud Tasks will not accept a `scheduleTime` more than 30 days out — the
 * create fails outright, and a 60-day reminder is therefore not expressible as
 * one task. So a long wait is split: schedule at most {@link MAX_HORIZON_MS}
 * ahead, and if the due date is still in the future when the task fires, the
 * handler enqueues the next leg. 60 days becomes two ~30-day hops.
 *
 * The due date travels in the task BODY rather than being recomputed on
 * arrival. A hop that re-derived "60 days from delivery" would be fine; one
 * that re-derived "60 days from now" would walk the reminder forward by a month
 * on every hop and never fire. Carrying the absolute timestamp makes the chain
 * converge by construction.
 *
 * ## Naming and the debounce
 *
 * Unlike `lib/tasks.ts`, where the name is derived from a time bucket so many
 * triggers collapse into one drain, this name is derived from the ORDER and the
 * leg. Per-order is the point here: two orders delivered in the same minute owe
 * two different reminders, and bucketing would silently drop one.
 *
 * Including the leg's scheduled time in the name keeps a re-delivered scan from
 * being rejected as a duplicate of the leg it already scheduled, while a
 * genuine repeat of the SAME leg still collapses — Cloud Tasks refuses a
 * duplicate name for ~1h after completion, and `ops_notifications`' unique
 * dedupe key is the real backstop behind it.
 */

import type { FastifyBaseLogger } from 'fastify'

import type { CloudTasksConfig } from './tasks.js'
import { enqueueRawCloudTask } from './tasks.js'

/** Where a replenishment task calls back into. */
export const REPLENISHMENT_TASK_PATH = '/v1/internal/tasks/replenishment'

/**
 * Longest `scheduleTime` Cloud Tasks accepts, less a day of margin.
 *
 * The documented ceiling is 30 days. Scheduling exactly at it would leave the
 * create racing its own validation — the request is authored slightly before it
 * is evaluated, and a boundary value can tip over between the two. A day of
 * slack costs one extra hop at most and removes the failure mode.
 */
export const MAX_HORIZON_MS = 29 * 24 * 60 * 60 * 1000

/**
 * Which customer follow-up a task is for.
 *
 * The refill reminder was the first delayed, per-order WhatsApp beat; the
 * unpaid-order nudge and the post-delivery review ask are the same shape (one
 * order, one absolute due date, one outbox row at the end), so they ride the
 * same queue, identity, callback path and chaining rather than growing three
 * copies of each. The handler (`routes/internalReplenishment.ts`) dispatches on
 * this field.
 *
 * Optional on the wire, defaulting to `replenishment`: tasks enqueued before
 * the field existed are still sitting in the queue for up to 60 days, and they
 * must keep meaning what they meant when they were scheduled.
 */
export const FOLLOW_UP_KINDS = ['replenishment', 'payment_reminder', 'review_request'] as const
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]

/** What a follow-up task carries. Absolute, so a hop cannot drift — see the header. */
export interface ReplenishmentTaskBody {
  orderId: string
  /** When the follow-up is actually due, ISO 8601. Fixed when scheduled, never recomputed. */
  dueAt: string
  /** Absent ⇒ `replenishment`, the only kind that existed before this field. */
  kind?: FollowUpKind
}

/** Every follow-up uses the replenishment enqueuer; this name says what it is for at call sites. */
export type FollowUpTaskEnqueuer = ReplenishmentTaskEnqueuer

export interface ReplenishmentTaskEnqueuer {
  enqueue(input: ReplenishmentTaskBody): Promise<void>
}

/** No queue configured ⇒ no reminders. There is deliberately no cron backstop; see the header. */
export const noopReplenishmentTaskEnqueuer: ReplenishmentTaskEnqueuer = {
  enqueue: async () => {},
}

/**
 * The next leg's fire time: the due date, or {@link MAX_HORIZON_MS} out,
 * whichever is sooner.
 *
 * Never returns a time in the past — a due date that has already passed
 * schedules immediately rather than asking Cloud Tasks to accept a backdated
 * task, which it will not.
 */
export function nextLegTime(dueAt: Date, now: Date = new Date()): Date {
  const ceiling = new Date(now.getTime() + MAX_HORIZON_MS)
  if (dueAt.getTime() <= now.getTime()) return now
  return dueAt.getTime() < ceiling.getTime() ? dueAt : ceiling
}

/** True when the due date has arrived — the handler sends rather than re-enqueues. */
export function isDue(dueAt: Date, now: Date = new Date()): boolean {
  return dueAt.getTime() <= now.getTime()
}

/**
 * Task-name prefix per kind. `replenish` is frozen: changing it would let a
 * re-delivered delivery scan schedule a second copy of a leg already queued
 * under the old name.
 */
const TASK_NAME_PREFIX: Record<FollowUpKind, string> = {
  replenishment: 'replenish',
  payment_reminder: 'payremind',
  review_request: 'reviewask',
}

/** `<prefix>-<orderId>-<leg epoch ms>`, sanitised to Cloud Tasks' `[a-zA-Z0-9_-]{1,500}`. */
export function replenishmentTaskName(
  orderId: string,
  legAt: Date,
  kind: FollowUpKind = 'replenishment'
): string {
  const safeOrderId = orderId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)
  return `${TASK_NAME_PREFIX[kind]}-${safeOrderId}-${legAt.getTime()}`
}

export function createReplenishmentTaskEnqueuer(
  cfg: CloudTasksConfig,
  fetchImpl: typeof fetch = fetch
): ReplenishmentTaskEnqueuer {
  return {
    async enqueue({ orderId, dueAt, kind }) {
      const due = new Date(dueAt)
      const legAt = nextLegTime(due)
      await enqueueRawCloudTask(
        cfg,
        {
          name: replenishmentTaskName(orderId, legAt, kind),
          scheduleTime: legAt,
          url: `${cfg.targetBaseUrl}${REPLENISHMENT_TASK_PATH}`,
          // `kind` is omitted rather than defaulted for refill reminders, so
          // their body stays byte-identical to what shipped before it existed.
          body: (kind === undefined || kind === 'replenishment'
            ? { orderId, dueAt }
            : { orderId, dueAt, kind }) satisfies ReplenishmentTaskBody,
        },
        fetchImpl
      )
    },
  }
}

/**
 * Fire-and-forget enqueue, for the delivery path.
 *
 * Same trade every post-commit side effect in this codebase makes: the parcel
 * has been delivered and the scan is recorded, so failing the carrier's webhook
 * to protect a marketing reminder would be backwards. A lost enqueue costs one
 * reminder — and unlike the sweep drains there is no cron backstop to recover
 * it, which is the accepted price of not paying for a poller.
 */
export function requestReplenishmentReminder(
  enqueuer: ReplenishmentTaskEnqueuer,
  input: ReplenishmentTaskBody,
  log: FastifyBaseLogger
): void {
  void enqueuer.enqueue(input).catch((err: unknown) => {
    log.error(
      { err, orderId: input.orderId, kind: input.kind ?? 'replenishment' },
      // Message kept from when this was refill-only; dashboards key on it.
      'replenishment reminder task enqueue failed'
    )
  })
}
