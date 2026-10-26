/**
 * Wire contract for the scheduled sweeps (`routes/internalSweeps.ts`).
 *
 * Deliberately NOT the admin sweep contracts (`SweepResultSchema`,
 * `InvoiceEmailSweepResponseSchema`, `OpsNotificationSweepResponseSchema`).
 * Those describe a human pressing a button and getting a result or an error.
 * This one has to describe a THIRD outcome the admin routes express as a 503:
 * "the sweep ran, found the feature switched off, and correctly did nothing".
 *
 * That distinction is the whole design. Cloud Scheduler treats a non-2xx as a
 * failed run and retries it, so answering 503 while `fulfilment.enabled` is
 * false — the state prod deliberately sits in for weeks at a time — would
 * produce a permanent retry storm and a permanently red job. The operator then
 * learns to ignore the red, which is exactly when a REAL failure stops being
 * visible.
 *
 * So a disabled sweep is `200 { ran: false, reason: 'fulfilment_disabled' }`:
 * green to the scheduler, explicit in the payload, and paired with a structured
 * `warn` log line that Loki can alert on. Silence is never the answer — but the
 * loudness belongs in the observability pipe, not in a retry counter.
 */

import { z } from 'zod'

/**
 * Why a sweep declined to do any work. Every value here is a CONFIGURATION
 * state an operator can fix, never a fault — faults throw and become 5xx, which
 * is what Cloud Scheduler should retry.
 */
export const SweepSkipReasonSchema = z.enum([
  /** `fulfilment.enabled` is false. */
  'fulfilment_disabled',
  /** No `DELHIVERY_API_TOKEN`/`DELHIVERY_BASE_URL` on this deploy — no carrier adapter was built. */
  'carrier_unconfigured',
  /** `fulfilment.pickupLocationName` is empty; the carrier rejects every manifest without it. */
  'pickup_location_unset',
  /** `fulfilment.mode` is `manual`; parcels are driven by hand and no carrier call belongs here. */
  'manual_mode',
  /**
   * No Razorpay keys on this deploy, or `payments.enabled` is false — the
   * payment recovery sweep has no gateway to ask. A 503 here would make the job
   * permanently red on every deploy that legitimately has no keys.
   */
  'payments_disabled',
])

export type SweepSkipReason = z.infer<typeof SweepSkipReasonSchema>

/**
 * One sweep's outcome. `ran: false` carries a `reason` and zero counters;
 * `ran: true` carries the counters and no reason.
 *
 * Counters are a union of what the four sweeps each report rather than four
 * separate response shapes — one Cloud Scheduler job definition, one log shape,
 * one Grafana panel. Unused counters are simply absent.
 */
export const InternalSweepResponseSchema = z.object({
  /** Which sweep this was, echoed so a log line is self-describing. */
  sweep: z.enum([
    'manifest',
    'reconcile',
    'invoice-emails',
    'ops-notifications',
    'payments-recover',
  ]),
  /** False ⇒ configuration says do nothing; see `reason`. Still a 200. */
  ran: z.boolean(),
  reason: SweepSkipReasonSchema.nullable(),
  /** Rows the sweep looked at. Zero on a skip. */
  scanned: z.int(),
  /** Rows that reached their goal — manifested, ingested, emailed, sent. */
  succeeded: z.int(),
  /** Rows that tried and failed. These stay eligible for the next sweep. */
  failed: z.int(),
  /** Rows deliberately not attempted (e.g. `skipped_unconfigured`). */
  skipped: z.int(),
  /**
   * `payments-recover` only: orders where Razorpay reports captured money that
   * does NOT match the stored amount/currency.
   *
   * Its own counter rather than folded into `failed` because the two demand
   * opposite responses. A `failed` row is retried by the next sweep and needs
   * nobody. A `mismatched` row is deliberately left `pending` forever — real
   * money exists that the system cannot reconcile — and only a human closes it.
   * Counting it as a failure would bury the one number that must page someone.
   */
  mismatched: z.int().optional(),
  /**
   * `payments-recover` only: rows aged past `RECOVER_EXPIRE_AFTER_MS` with no
   * captured payment, moved `pending` → `failed`.
   *
   * NOT reported in `failed`, which every other sweep uses for "tried and did
   * not work, will retry". These are abandoned checkouts being tidied up: the
   * expected, healthy majority of what this sweep touches. Counting them as
   * failures would make a normal run look broken on the shared dashboard and
   * train an operator to ignore the panel.
   */
  expired: z.int().optional(),
})

export type InternalSweepResponse = z.infer<typeof InternalSweepResponseSchema>

/**
 * What `GET /v1/internal/sweeps/readiness` (and its admin twin) answers.
 *
 * The direct fix for the failure this whole module exists to prevent: config
 * that is wrong in a way nothing reports. `parseFulfilmentRule` is
 * all-or-nothing — one missing or malformed key collapses the entire rule to
 * `FULFILMENT_OFF` — and until now the only way to observe that was to place an
 * order and watch nothing happen. This endpoint states the RESOLVED rule, not
 * the stored keys, so what it reports is what the sweeps will actually do.
 */
export const FulfilmentReadinessSchema = z.object({
  /** True only when a sweep would do carrier work right now. */
  ready: z.boolean(),
  /** Present when `ready` is false — the first gate that is shut. */
  blockedBy: SweepSkipReasonSchema.nullable(),
  /** The rule as `parseFulfilmentRule` resolved it, not as `app_config` stores it. */
  rule: z.object({
    enabled: z.boolean(),
    mode: z.enum(['carrier', 'manual']),
    carrier: z.string(),
    autoManifest: z.boolean(),
    pickupLocationName: z.string(),
    manifestMaxAttempts: z.int(),
    reconcileStaleMinutes: z.int(),
    reconcileBatchSize: z.int(),
  }),
  /**
   * Whether THIS process built a carrier adapter. Config can be perfect while
   * the deploy has no `DELHIVERY_*` env — the exact split that made every
   * fulfilment route 503 before commit `1cc692b`, invisibly.
   */
  carrierConfigured: z.boolean(),
  /** Whether a WhatsApp channel exists on this process (ops alerts). */
  notificationsConfigured: z.boolean(),
  /** Whether this process would accept a Cloud Scheduler call at all. */
  schedulerConfigured: z.boolean(),
  /** Work currently waiting — the numbers that should be zero on a healthy day. */
  backlog: z.object({
    /** Shipments in `pending_manifest` under the attempt cap. */
    pendingManifest: z.int(),
    /** Shipments in `pending_manifest` that have exhausted `manifestMaxAttempts`. */
    manifestExhausted: z.int(),
    /** In-flight shipments whose last scan is older than `reconcileStaleMinutes`. */
    staleTracking: z.int(),
    /** `ops_notifications` rows still owed a send. */
    opsNotificationsOwed: z.int(),
    /** Invoices still owed a customer email copy. */
    invoiceEmailsOwed: z.int(),
    /** Oldest `pending_manifest` shipment's age in hours, or null when there are none. */
    oldestPendingManifestHours: z.number().nullable(),
  }),
})

export type FulfilmentReadiness = z.infer<typeof FulfilmentReadinessSchema>
