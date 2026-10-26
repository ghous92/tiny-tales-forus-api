/**
 * /v1/fulfilment — the customer-facing tracking read and the carrier webhook
 * (docs/SPEC-LOGISTICS.md §5, §8).
 *
 * Two child scopes, for the same reason `routes/payments.ts` splits:
 *
 * - **The authed scope** carries `app.authenticate` and serves the shopper.
 * - **The webhook scope** carries NO auth hook, because Delhivery cannot send a
 *   Firebase token. It is protected by a shared secret header instead, and the
 *   encapsulation is what stops that exemption leaking onto the authed routes.
 *
 * Unlike the Razorpay webhook this one needs no raw-body parser: Delhivery
 * signs nothing (FEASIBILITY-LOGISTICS §6.4). That absence is precisely why the
 * webhook is allowed to move fulfilment state and nothing else — it never
 * touches `payments`, stock, or refunds.
 */

import { timingSafeEqual } from 'node:crypto'

import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  TrackingParamsSchema,
  TrackingSchema,
  WebhookAckSchema,
  WebhookScanSchema,
  type Tracking,
} from '../contracts/fulfilment.js'
import type { Db } from '../db/client.js'
import { readWebhookScan } from '../lib/delhivery.js'
import { notFound, validationFailed } from '../lib/errors.js'
import { labelFor, type FulfilmentStatus } from '../lib/fulfilmentStatus.js'
import type { NotificationChannelRegistry } from '../lib/notify/registry.js'
import type { ReplenishmentTaskEnqueuer } from '../lib/replenishmentTask.js'
import type { TaskEnqueuer } from '../lib/tasks.js'
import { getShipmentForUser, ingestScan, trackingUrlFor } from '../services/fulfilment.js'
import { reactToShipmentMilestone } from './customerNotifications.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface FulfilmentRoutesOptions {
  db: Db
  /** `DELHIVERY_WEBHOOK_SECRET`. Absent ⇒ the webhook answers 503 and ingests nothing. */
  webhookSecret?: string | undefined
  /** Resolved from `fulfilment.trackingUrlTemplate`; '' disables the deep link. */
  trackingUrlTemplate?: string | undefined
  /** Display name for the carrier, e.g. "Delhivery Surface". */
  courierLabel?: string | undefined
  /**
   * Producer for the delayed replenishment reminder. Absent ⇒ delivery
   * schedules nothing, which is the behaviour before this existed — there is
   * deliberately no cron backstop (docs/WIP-NEON-COST.md).
   */
  replenishmentTasks?: ReplenishmentTaskEnqueuer | undefined
  /** Present ⇒ milestone messages are sent as the scan lands, not at the daily sweep. */
  channels?: NotificationChannelRegistry | undefined
  /** Retry drain for a milestone send that failed; see `sendPendingOpsNotifications`. */
  tasks?: TaskEnqueuer | undefined
}

/** Constant-time compare that tolerates length mismatch (the naive version leaks length). */
function secretMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * `manifestPayload` is exactly what was declared to the carrier
 * (`ManifestSource`, `routes/fulfilmentAdmin.ts`) — never re-derived from
 * catalog rows, per the frozen-snapshot rule. Dims are optional there (an
 * order manifested before dims wiring shipped has none); weight is always
 * present once manifested. Null pre-manifest and for any malformed payload.
 */
function parcelFrom(
  manifestPayload: unknown
): { weightG: number; lengthCm: number; widthCm: number; heightCm: number } | null {
  if (manifestPayload === null || typeof manifestPayload !== 'object') return null
  const p = manifestPayload as Record<string, unknown>
  const weightG = p.weightG
  const lengthCm = p.lengthCm
  const widthCm = p.widthCm
  const heightCm = p.heightCm
  if (
    typeof weightG !== 'number' ||
    typeof lengthCm !== 'number' ||
    typeof widthCm !== 'number' ||
    typeof heightCm !== 'number'
  ) {
    return null
  }
  return { weightG, lengthCm, widthCm, heightCm }
}

export const fulfilmentRoutes: FastifyPluginAsyncZod<FulfilmentRoutesOptions> = async (
  app,
  { db, webhookSecret, trackingUrlTemplate, courierLabel, replenishmentTasks, channels, tasks }
) => {
  // --- Shopper scope --------------------------------------------------------

  await app.register(async (parent) => {
    const scope = parent.withTypeProvider<ZodTypeProvider>()
    scope.addHook('onRequest', scope.authenticate)

    /**
     * Where is my order.
     *
     * Answers 404 for an order that belongs to someone else — never 403, per
     * the repo's do-not-leak-existence rule — and 404 for a paid order that has
     * no shipment yet only if fulfilment never recorded one; a
     * `pending_manifest` row is a legitimate, renderable state ("Preparing your
     * order").
     */
    scope.get(
      '/orders/:orderId/tracking',
      {
        schema: {
          params: TrackingParamsSchema,
          response: { 200: TrackingSchema, ...errorResponses },
        },
      },
      async (request) => {
        const found = await getShipmentForUser(db, request.user.id, request.params.orderId)
        if (found === null) throw notFound('No shipment found for this order')

        const { shipment, events } = found
        const status = shipment.status as FulfilmentStatus

        const body: Tracking = {
          orderId: shipment.orderId,
          status,
          label: labelFor(status),
          awb: shipment.awb,
          courierLabel: courierLabel ?? shipment.courierCode,
          trackingUrl: trackingUrlFor(
            trackingUrlTemplate ?? '',
            shipment.awb,
            shipment.manualTrackingUrl
          ),
          promisedEtaDays: shipment.promisedEtaDays,
          promisedDeliveryDate: shipment.promisedDeliveryDate,
          estimatedDeliveryAt: shipment.carrierEdd?.toISOString() ?? null,
          parcel: parcelFrom(shipment.manifestPayload),
          manifestedAt: shipment.manifestedAt?.toISOString() ?? null,
          pickedUpAt: shipment.pickedUpAt?.toISOString() ?? null,
          outForDeliveryAt: shipment.outForDeliveryAt?.toISOString() ?? null,
          deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
          deliveryAttempts: shipment.deliveryAttempts,
          ndrReason: shipment.ndrReason,
          timeline: events.map((event) => ({
            status: event.status,
            label: labelFor(event.status),
            location: event.location,
            occurredAt: event.occurredAt.toISOString(),
          })),
        }
        return body
      }
    )
  })

  // --- Carrier scope (no auth hook) -----------------------------------------

  await app.register(async (parent) => {
    const scope = parent.withTypeProvider<ZodTypeProvider>()
    /**
     * Delhivery's push endpoint.
     *
     * Their docs expect a bare `200 OK`, and a carrier push pipeline that keeps
     * receiving 4xx eventually gets switched off — so **once the scan is
     * durably stored, this answers 200 even for an AWB we do not recognise**.
     * The orphan row keeps the only copy of an event nobody can re-request.
     *
     * A 422 `validation_failed` is reserved for a body we genuinely cannot
     * read, where there is nothing to store and a retry might carry something
     * better.
     */
    scope.post(
      '/webhook/delhivery',
      {
        schema: {
          body: WebhookScanSchema,
          response: { 200: WebhookAckSchema, ...errorResponses },
        },
      },
      async (request, reply) => {
        if (webhookSecret === undefined || webhookSecret === '') {
          // Same code as the admin routes use for an unconfigured carrier: an
          // ops filter on `fulfilment_disabled` must catch both halves of "this
          // deploy has no courier", not just the outbound one.
          return reply.code(503).send({
            error: {
              code: 'fulfilment_disabled',
              message: 'Carrier webhook is not configured',
            },
          })
        }

        const provided =
          request.headers['x-delhivery-token'] ?? request.headers['x-webhook-token'] ?? ''
        const token = Array.isArray(provided) ? (provided[0] ?? '') : provided
        if (!secretMatches(webhookSecret, token)) {
          return reply.code(401).send({
            error: { code: 'unauthorized', message: 'Invalid webhook token' },
          })
        }

        const parsed = readWebhookScan(request.body)
        if (parsed === null) {
          // Logged in full: an unreadable scan is a contract change on their
          // side, and the body is the only evidence of what changed.
          request.log.warn({ body: request.body }, 'carrier webhook payload could not be read')
          throw validationFailed('Scan payload is missing an AWB or a usable timestamp')
        }

        const result = await ingestScan(db, parsed.awb, parsed.scan, 'webhook', request.body)

        if (result.unmappedPair !== null) {
          // The loud half of "never guess" (lib/fulfilmentStatus.ts §4.2): the
          // scan is stored as `exception`, and this is what tells us to map it.
          request.log.warn(
            { awb: parsed.awb, pair: result.unmappedPair },
            'unmapped carrier status pair — stored as exception'
          )
        }
        if (!result.matched) {
          request.log.info({ awb: parsed.awb }, 'scan for unknown AWB stored as an orphan')
        }

        // Customer-facing reactions to a milestone. Deliberately AFTER the
        // ingest transaction has committed and never awaited into the response:
        // the carrier is owed a fast 200, and a WhatsApp enqueue that failed
        // must not make Delhivery retry a scan we have already stored.
        //
        // Guarded on `advanced` so only a scan that actually moved `status`
        // counts. Repeats are still expected — Delhivery emits `In Transit`
        // many times across a journey — and are absorbed by the outbox's unique
        // dedupe key rather than by any check here.
        if (result.advanced && result.orderId !== null) {
          void reactToShipmentMilestone(db, {
            orderId: result.orderId,
            status: result.status,
            awb: result.awb,
            courierCode: result.courierCode,
            log: request.log,
            ...(replenishmentTasks ? { replenishmentTasks } : {}),
            ...(channels ? { channels } : {}),
            ...(tasks ? { tasks } : {}),
          }).catch((err: unknown) => {
            request.log.error(
              { err, orderId: result.orderId },
              'customer milestone notification failed'
            )
          })
        }

        return { received: true, matched: result.matched }
      }
    )
  })
}
