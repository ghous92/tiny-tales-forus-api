/**
 * /v1/admin/notifications — the ops notification outbox's retry sweep
 * (docs/SPEC-MANUAL-FULFILMENT.md §4A step 3, §6).
 *
 * Gated `authenticate` + `requireAdmin` — this is the HUMAN surface, the button
 * an operator presses in the admin SPA.
 *
 * The scheduled caller is a different route on a different gate:
 * `POST /v1/internal/sweeps/ops-notifications`, behind Cloud Scheduler OIDC
 * (`plugins/scheduler.ts`, docs/SPEC-SWEEP-AUTOMATION.md). Both call
 * {@link runOpsNotificationSweep}, so the work is defined once and only the
 * authentication differs. The follow-up this module's docstring used to name as
 * open — "wire Cloud Scheduler + OIDC for all of them together" — is that file.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  OpsNotificationSweepResponseSchema,
} from '../contracts/notifications.js'
import type { Db } from '../db/client.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import {
  listOpsNotificationsNeedingSend,
  reapStuckOpsNotifications,
} from '../services/opsNotifications.js'
import { sendOpsNotification } from './opsNotifications.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** How many rows one sweep of `POST /dispatch` will attempt — same cap as the invoice retry sweep. */
const SWEEP_LIMIT = 100

/** `{ scanned, sent, failed, skipped }` — the shape both ops-notification callers return. */
export interface OpsNotificationSweepOutcome {
  scanned: number
  sent: number
  failed: number
  skipped: number
}

/**
 * Drain the outbox: every `pending`/`failed` row under the attempt cap. Shared
 * by the admin button (`POST /dispatch`) and the scheduled sweep
 * (`routes/internalSweeps.ts`).
 *
 * `skipped` counts `skipped_unconfigured` — the state every row lands in while
 * WhatsApp has no credentials, or while Meta has the template in `PENDING`.
 * That is a supported resting state, not a failure, and rows stay eligible so a
 * later sweep picks them up once approval lands.
 *
 * It also counts rows whose claim was lost to a concurrent sender, which is a
 * normal outcome now that `sendOpsNotification` claims before it sends —
 * "somebody else is delivering this" is not work this run failed to do.
 *
 * Reaps abandoned claims first, in the same run. It is one bounded UPDATE
 * touching only rows already stuck in `sending`, so it rides the compute wake
 * this sweep was going to cause anyway (docs/WIP-NEON-COST.md) — and it must
 * happen before the select, or a row a dead instance was holding stays
 * invisible to this pass as well as the last one.
 */
export async function runOpsNotificationSweep(
  db: Db,
  channels: NotificationChannelRegistry,
  log: FastifyBaseLogger,
  limit = SWEEP_LIMIT
): Promise<OpsNotificationSweepOutcome> {
  const reaped = await reapStuckOpsNotifications(db)
  if (reaped > 0) {
    log.warn({ reaped }, 'ops notification sweep reclaimed rows abandoned mid-send')
  }

  const owed = await listOpsNotificationsNeedingSend(db, limit)
  let sent = 0
  let failed = 0
  let skipped = 0
  for (const row of owed) {
    const updated = await sendOpsNotification(db, row, channels, log)
    if (updated?.status === 'sent') sent += 1
    else if (updated?.status === 'failed') failed += 1
    else skipped += 1
  }
  return { scanned: owed.length, sent, failed, skipped }
}

export interface NotificationsAdminRoutesOptions {
  db: Db
  /** Channel name -> adapter. Empty/absent entries resolve every send to `skipped_unconfigured`. */
  channels: NotificationChannelRegistry
}

export const notificationsAdminRoutes: FastifyPluginAsyncZod<
  NotificationsAdminRoutesOptions
> = async (app, { db, channels }) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  /**
   * Retry everything still owed a send — `pending` and `failed` rows under the
   * attempt cap. Idempotent and safe to call on a schedule, the same shape as
   * `POST /v1/admin/invoices/retry-emails` and `POST /v1/admin/fulfilment/reconcile`.
   */
  app.post(
    '/dispatch',
    { schema: { response: { 200: OpsNotificationSweepResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      return reply.send(await runOpsNotificationSweep(db, channels, request.log))
    }
  )
}
