/**
 * Cloud Tasks enqueue port — the event-driven trigger for the background sweeps
 * (docs/WIP-EVENT-DRIVEN-SWEEPS.md).
 *
 * ## Why this exists
 *
 * Neon bills a 5-minute compute minimum every time anything opens a connection,
 * so the sweep bill tracks *how many distinct 5-minute windows we poke*, not
 * query count. Cloud Scheduler polls on wall-clock, which means at zero order
 * volume every poll pays full price to find nothing: two half-hourly jobs cost ~4h/day
 * of Neon compute floor for work that does not exist.
 *
 * The first delivery attempt is already event-driven — `routes/payments.ts` runs
 * the whole hook chain inline, post-commit, on all three paid entry points. The
 * sweeps only drain *failures*, and a failure is an event too: we learn about it
 * inside a request, with Neon already awake. Nothing about that needs a poller.
 *
 * So: cron cost scales with wall-clock, queue cost scales with work.
 *
 * ## The task carries nothing
 *
 * No row id, no payload. A task means only "there is work; go drain", and it
 * POSTs the EXISTING sweep URL unchanged. There is deliberately no
 * `/v1/internal/retry/:id` route: a per-row path would be a second
 * implementation of every sweep body, bypassing the `sending`-claim guard, the
 * `dedupeKey` unique index and `RECOVER_MAX_BATCH` — exactly the drift
 * `routes/internalSweeps.ts`'s header forbids. The queue decides WHEN; the sweep
 * still decides WHAT, once, in one place.
 *
 * ## Debounce is the task name
 *
 * Cloud Tasks refuses a duplicate task name (409 ALREADY_EXISTS) for roughly an
 * hour after that name's task completes. Names here are derived from the fire
 * time, not from the row, so fifty failures inside one window collapse to one
 * task — one Neon wake. ALREADY_EXISTS is therefore a SUCCESS, not an error.
 *
 * Note for anyone reusing this pattern: named tasks cost throughput, because
 * de-duplication needs an index scan. Google documents a materially lower create
 * rate for them. Irrelevant at our volume, wrong on a hot path.
 *
 * ## Absent configuration degrades to cron
 *
 * Unlike `plugins/scheduler.ts` — which is CLOSED when unconfigured, because
 * there the absent credential IS the lock — an unconfigured queue here is
 * harmless: the daily `0 4 * * *` Cloud Scheduler jobs remain provisioned as the
 * backstop floor, so no-enqueue means slower, never lost. That backstop is not
 * optional and must not be deleted; see the doc.
 *
 * No new dependency: Cloud Tasks' REST API plus `google-auth-library` (already
 * present for OIDC verification) rather than `@google-cloud/tasks`.
 */

import type { FastifyBaseLogger } from 'fastify'

/**
 * Which sweep a task drains. The value IS the last path segment of the sweep
 * route, so a caller cannot point a task at the wrong endpoint by mistyping a
 * path — see {@link sweepPathFor}.
 */
export type SweepTaskKind =
  | 'invoice-emails'
  | 'ops-notifications'
  | 'manifest'
  | 'payments-recover'
  | 'reconcile'

/** The route a task of this kind POSTs. Single source of truth for the mapping. */
export function sweepPathFor(kind: SweepTaskKind): string {
  return `/v1/internal/sweeps/${kind}`
}

export interface TaskEnqueueInput {
  kind: SweepTaskKind
  /**
   * Deterministic, and derived from `scheduleTime` rather than from the row that
   * triggered it — that is what makes it a debounce rather than a per-row job.
   * Cloud Tasks constrains this to `[a-zA-Z0-9_-]{1,500}`.
   */
  name: string
  /** When the task may run. Always a bucket boundary — see {@link bucketBoundary}. */
  scheduleTime: Date
}

/**
 * Injected the way `emailFetchImpl` is, so tests assert enqueue intent without
 * touching GCP and an unconfigured environment gets {@link noopTaskEnqueuer}.
 */
export interface TaskEnqueuer {
  /** Resolves on success AND on ALREADY_EXISTS. Never throws — see the impls. */
  enqueue(input: TaskEnqueueInput): Promise<void>
}

/** Used when no queue is configured: the backstop cron is what runs the sweeps. */
export const noopTaskEnqueuer: TaskEnqueuer = {
  enqueue: async () => {},
}

// ── Bucketing ──────────────────────────────────────────────────────────────
//
// Every task fires ON a bucket boundary, and is NAMED for that same boundary.
// Rounding UP (never down) is load-bearing: if a task could fire mid-bucket,
// a second trigger arriving later in the same bucket would be de-duplicated
// away by its name AFTER the only run that could have served it had already
// happened — the row would then sit until the daily backstop. Firing at the
// boundary means nothing sharing a name can be missed.
//
// The 5-minute drain bucket is not arbitrary: it is exactly Neon's billing
// granularity, so a busy window can cost at most one compute window per bucket,
// and an idle one costs nothing at all.

export const MINUTE_MS = 60_000
/** Drains (`invoice-emails`, `ops-notifications`, `manifest`) — one Neon window. */
export const DRAIN_BUCKET_MS = 5 * MINUTE_MS
/** `payments-recover` — must not fire before `RECOVER_STALE_AFTER_MS` (15 min). */
export const RECOVER_BUCKET_MS = 15 * MINUTE_MS
/** `reconcile` — paced under `reconcileStaleMinutes` (180). */
export const RECONCILE_BUCKET_MS = 60 * MINUTE_MS

/** The first bucket boundary at or after `at`. */
export function bucketBoundary(at: Date, bucketMs: number): Date {
  return new Date(Math.ceil(at.getTime() / bucketMs) * bucketMs)
}

/** `<kind>-<boundary epoch ms>` — same input, same name, hence the debounce. */
export function taskNameFor(kind: SweepTaskKind, boundary: Date): string {
  return `${kind}-${boundary.getTime()}`
}

/**
 * Ask for a drain of `kind`, at the next bucket boundary.
 *
 * Fire-and-forget by design: callers are post-commit side effects that must not
 * be slowed or failed by the queue. A lost enqueue costs latency (the backstop
 * cron still drains), never correctness — which is why this returns `void` and
 * swallows, rather than propagating into a shopper's payment response.
 */
export function requestSweep(
  enqueuer: TaskEnqueuer,
  kind: SweepTaskKind,
  log: FastifyBaseLogger,
  bucketMs: number = DRAIN_BUCKET_MS,
  notBefore: Date = new Date()
): void {
  const boundary = bucketBoundary(notBefore, bucketMs)
  void enqueuer
    .enqueue({ kind, name: taskNameFor(kind, boundary), scheduleTime: boundary })
    .catch((err: unknown) => {
      log.error({ err, kind }, 'sweep task enqueue failed; falling back to the backstop cron')
    })
}

// ── The real enqueuer ──────────────────────────────────────────────────────

export interface CloudTasksConfig {
  project: string
  /** Queue location — `asia-southeast1`, same as Cloud Run and Cloud Scheduler. */
  location: string
  queue: string
  /** Base URL of the API the task will call back into, no trailing slash. */
  targetBaseUrl: string
  /**
   * The identity the task authenticates AS — `laanya-scheduler@…`, the same one
   * Cloud Scheduler uses, so `plugins/scheduler.ts` verifies task callers with
   * no change at all: same allowlist, same audience, same hook.
   */
  serviceAccountEmail: string
  /** Must equal `SCHEDULER_OIDC_AUDIENCE`; an arbitrary stable string, not a URL. */
  audience: string
}

/** A Cloud Tasks HTTP task, already resolved to a concrete callback URL and body. */
export interface RawCloudTaskInput {
  /** Deterministic — see {@link TaskEnqueueInput.name}. */
  name: string
  scheduleTime: Date
  /** Full callback URL the task will POST to. */
  url: string
  /** JSON-serialized as the task's request body, if present. */
  body?: unknown
}

/**
 * Cloud Tasks v2 REST, authenticated with ADC (on Cloud Run: the runtime service
 * account). `fetchImpl` is injected for the same reason `emailFetchImpl` is.
 *
 * Requires two IAM bindings that are easy to miss, because only one of them
 * mentions the queue:
 *
 *   1. runtime SA → `roles/cloudtasks.enqueuer` on the queue
 *   2. runtime SA → `roles/iam.serviceAccountUser` ON `serviceAccountEmail`
 *
 * Without (2) this fails at runtime with a PERMISSION_DENIED naming a service
 * account rather than the queue, which reads as an unrelated problem.
 *
 * Shared by every Cloud Tasks producer in this codebase — {@link createCloudTasksEnqueuer}
 * (bare debounce triggers) and `lib/alertEmailTask.ts` (task bodies carrying an
 * actual payload) both call this rather than talking to the REST API directly.
 */
export async function enqueueRawCloudTask(
  cfg: CloudTasksConfig,
  input: RawCloudTaskInput,
  fetchImpl: typeof fetch = fetch,
  auth?: { getAccessToken: () => Promise<string | null | undefined> }
): Promise<void> {
  const parent = `projects/${cfg.project}/locations/${cfg.location}/queues/${cfg.queue}`
  let client = auth
  if (client === undefined) {
    const { GoogleAuth } = await import('google-auth-library')
    client = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }) as unknown as { getAccessToken: () => Promise<string | null | undefined> }
  }
  const token = await client.getAccessToken()
  if (!token) throw new Error('Cloud Tasks: no application default credentials')

  const res = await fetchImpl(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      task: {
        name: `${parent}/tasks/${input.name}`,
        scheduleTime: input.scheduleTime.toISOString(),
        httpRequest: {
          url: input.url,
          httpMethod: 'POST',
          ...(input.body !== undefined
            ? { body: Buffer.from(JSON.stringify(input.body)).toString('base64') }
            : {}),
          headers: input.body !== undefined ? { 'content-type': 'application/json' } : undefined,
          oidcToken: {
            serviceAccountEmail: cfg.serviceAccountEmail,
            audience: cfg.audience,
          },
        },
      },
    }),
  })

  // The whole debounce lands here: a name already taken means an identical
  // task is already scheduled for this window, so the work IS covered.
  // Treating it as an error would turn the mechanism into noise.
  if (res.status === 409) return
  if (!res.ok) {
    throw new Error(`Cloud Tasks create failed: ${res.status} ${await res.text()}`)
  }
}

/**
 * Cloud Tasks-backed {@link TaskEnqueuer} for the bucketed sweep debounce.
 * Lazily builds and caches one `GoogleAuth` client across calls, mirroring how
 * `plugins/scheduler.ts` and `plugins/auth.ts` defer their Google clients —
 * the library is only paid for in an environment that actually enqueues.
 */
export function createCloudTasksEnqueuer(
  cfg: CloudTasksConfig,
  fetchImpl: typeof fetch = fetch
): TaskEnqueuer {
  let auth: { getAccessToken: () => Promise<string | null | undefined> } | undefined

  return {
    async enqueue({ kind, name, scheduleTime }) {
      if (auth === undefined) {
        const { GoogleAuth } = await import('google-auth-library')
        auth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        }) as unknown as { getAccessToken: () => Promise<string | null | undefined> }
      }
      await enqueueRawCloudTask(
        cfg,
        { name, scheduleTime, url: `${cfg.targetBaseUrl}${sweepPathFor(kind)}` },
        fetchImpl,
        auth
      )
    },
  }
}
