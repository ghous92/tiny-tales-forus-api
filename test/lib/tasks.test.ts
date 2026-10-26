/**
 * Cloud Tasks enqueue port (docs/WIP-EVENT-DRIVEN-SWEEPS.md).
 *
 * Three properties carry the weight, and all three fail SILENTLY if broken —
 * the sweeps still run off the backstop cron, so nothing goes red, work just
 * gets slow or expensive:
 *
 * 1. **Boundaries round UP.** A task must never be able to fire mid-bucket. If
 *    it could, a second trigger arriving later in the same bucket would be
 *    de-duplicated away by its name AFTER the only run that could have served
 *    it had already happened, and that row would sit until the daily backstop.
 *
 * 2. **The name is derived from the boundary, not the row.** That is the whole
 *    debounce: fifty failures in one window collapse to one task, hence one
 *    Neon wake. A name that varied per row would buy a compute window each.
 *
 * 3. **409 ALREADY_EXISTS is success.** It is the debounce landing, not a
 *    fault. Treating it as an error would fill the logs with noise generated
 *    by the mechanism working correctly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FastifyBaseLogger } from 'fastify'

import {
  bucketBoundary,
  createCloudTasksEnqueuer,
  DRAIN_BUCKET_MS,
  MINUTE_MS,
  noopTaskEnqueuer,
  RECOVER_BUCKET_MS,
  requestSweep,
  sweepPathFor,
  taskNameFor,
  type TaskEnqueueInput,
  type TaskEnqueuer,
} from '../../src/lib/tasks.js'

/** Enough of a logger for the fire-and-forget path; `error` is the only call. */
function fakeLog(): FastifyBaseLogger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
}

/** Records what would have been enqueued, the way the app's test seam does. */
function recorder(): { enqueuer: TaskEnqueuer; calls: TaskEnqueueInput[] } {
  const calls: TaskEnqueueInput[] = []
  return {
    calls,
    enqueuer: {
      enqueue: async (input) => {
        calls.push(input)
      },
    },
  }
}

/** Settle the `void`-returned promise inside `requestSweep`. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('sweepPathFor', () => {
  it('maps a kind to the EXISTING sweep route, unchanged', () => {
    // The task deliberately carries no row id and no payload: it POSTs the
    // same URL Cloud Scheduler does, so there is exactly one implementation of
    // each sweep body (see routes/internalSweeps.ts's header).
    expect(sweepPathFor('invoice-emails')).toBe('/v1/internal/sweeps/invoice-emails')
    expect(sweepPathFor('ops-notifications')).toBe('/v1/internal/sweeps/ops-notifications')
    expect(sweepPathFor('payments-recover')).toBe('/v1/internal/sweeps/payments-recover')
    expect(sweepPathFor('manifest')).toBe('/v1/internal/sweeps/manifest')
    expect(sweepPathFor('reconcile')).toBe('/v1/internal/sweeps/reconcile')
  })
})

describe('bucketBoundary', () => {
  it('rounds UP to the next boundary', () => {
    const at = new Date('2026-08-23T10:01:30.000Z')
    expect(bucketBoundary(at, DRAIN_BUCKET_MS).toISOString()).toBe('2026-08-23T10:05:00.000Z')
  })

  it('never returns a boundary in the past, however close to one it is called', () => {
    // The load-bearing case. One millisecond past 10:05 must land on 10:10 —
    // rounding to the NEAREST boundary would give 10:05, a task that fires
    // immediately and then de-duplicates away every trigger for the next five
    // minutes without ever running again.
    const at = new Date('2026-08-23T10:05:00.001Z')
    expect(bucketBoundary(at, DRAIN_BUCKET_MS).toISOString()).toBe('2026-08-23T10:10:00.000Z')
  })

  it('leaves an exact boundary alone', () => {
    const at = new Date('2026-08-23T10:05:00.000Z')
    expect(bucketBoundary(at, DRAIN_BUCKET_MS).getTime()).toBe(at.getTime())
  })

  it('buckets the recovery deadline on its own 15-minute grid', () => {
    const at = new Date('2026-08-23T10:01:00.000Z')
    expect(bucketBoundary(at, RECOVER_BUCKET_MS).toISOString()).toBe('2026-08-23T10:15:00.000Z')
  })
})

describe('taskNameFor', () => {
  it('collapses every trigger inside one bucket to ONE name', () => {
    // This is the debounce. Two failures 90 seconds apart in the same window
    // must produce the same name, so the second create is a 409 and Neon is
    // woken once rather than twice.
    const first = bucketBoundary(new Date('2026-08-23T10:01:00.000Z'), DRAIN_BUCKET_MS)
    const second = bucketBoundary(new Date('2026-08-23T10:02:30.000Z'), DRAIN_BUCKET_MS)
    expect(taskNameFor('invoice-emails', first)).toBe(taskNameFor('invoice-emails', second))
  })

  it('keeps separate kinds and separate buckets apart', () => {
    const bucket = bucketBoundary(new Date('2026-08-23T10:01:00.000Z'), DRAIN_BUCKET_MS)
    const next = new Date(bucket.getTime() + DRAIN_BUCKET_MS)
    expect(taskNameFor('invoice-emails', bucket)).not.toBe(taskNameFor('ops-notifications', bucket))
    expect(taskNameFor('invoice-emails', bucket)).not.toBe(taskNameFor('invoice-emails', next))
  })

  it('stays inside the character set Cloud Tasks accepts', () => {
    // Cloud Tasks constrains names to [a-zA-Z0-9_-]{1,500}; a colon or a
    // timestamp with `:` would be rejected at create time, in production only.
    const name = taskNameFor('payments-recover', new Date('2026-08-23T10:15:00.000Z'))
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,500}$/)
  })
})

describe('requestSweep', () => {
  it('asks for the next boundary, named for it', async () => {
    const { enqueuer, calls } = recorder()
    requestSweep(
      enqueuer,
      'invoice-emails',
      fakeLog(),
      DRAIN_BUCKET_MS,
      new Date('2026-08-23T10:01:30.000Z')
    )
    await tick()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.kind).toBe('invoice-emails')
    expect(calls[0]!.scheduleTime.toISOString()).toBe('2026-08-23T10:05:00.000Z')
    expect(calls[0]!.name).toBe(taskNameFor('invoice-emails', calls[0]!.scheduleTime))
  })

  it('swallows an enqueue failure and logs the fallback', async () => {
    // A lost enqueue costs latency, never correctness — the backstop cron
    // still drains. Propagating would put a queue outage into a shopper's
    // payment response, which is the one thing this must never do.
    const log = fakeLog()
    const enqueuer: TaskEnqueuer = { enqueue: () => Promise.reject(new Error('queue down')) }
    expect(() => requestSweep(enqueuer, 'ops-notifications', log, DRAIN_BUCKET_MS)).not.toThrow()
    await tick()
    expect(log.error).toHaveBeenCalled()
  })

  it('does nothing at all with the noop enqueuer', async () => {
    // The unconfigured deploy: no queue, no enqueues, daily cron drains
    // everything. Slower, never lost.
    await expect(
      noopTaskEnqueuer.enqueue({ kind: 'manifest', name: 'x', scheduleTime: new Date(0) })
    ).resolves.toBeUndefined()
  })
})

describe('createCloudTasksEnqueuer', () => {
  const CFG = {
    project: 'laanya-prod',
    location: 'asia-southeast1',
    queue: 'laanya-sweeps',
    targetBaseUrl: 'https://api.laanya.test',
    serviceAccountEmail: 'laanya-scheduler@laanya-prod.iam.gserviceaccount.com',
    audience: 'laanya-sweeps-prod',
  }
  const PARENT = 'projects/laanya-prod/locations/asia-southeast1/queues/laanya-sweeps'

  const INPUT: TaskEnqueueInput = {
    kind: 'invoice-emails',
    name: 'invoice-emails-1755943500000',
    scheduleTime: new Date('2026-08-23T10:05:00.000Z'),
  }

  // Each case installs its own `GoogleAuth`; without this the first dynamic
  // import wins for the whole file and the no-credentials case would silently
  // exercise the happy path instead.
  beforeEach(() => {
    vi.resetModules()
  })

  function stubAuth(): void {
    // `google-auth-library` is imported lazily inside `enqueue`, exactly as
    // plugins/scheduler.ts does, so the module has to be mocked rather than
    // the constructor injected.
    vi.doMock('google-auth-library', () => ({
      GoogleAuth: class {
        getAccessToken(): Promise<string> {
          return Promise.resolve('fake-access-token')
        }
      },
    }))
  }

  it('creates the task against the queue, aimed at the sweep route', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch
    await createCloudTasksEnqueuer(CFG, fetchImpl).enqueue(INPUT)

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${PARENT}/tasks`)
    const body = JSON.parse(String(init.body)) as {
      task: {
        name: string
        scheduleTime: string
        httpRequest: {
          url: string
          httpMethod: string
          oidcToken: { serviceAccountEmail: string; audience: string }
        }
      }
    }
    expect(body.task.name).toBe(`${PARENT}/tasks/${INPUT.name}`)
    expect(body.task.scheduleTime).toBe('2026-08-23T10:05:00.000Z')
    expect(body.task.httpRequest.url).toBe(
      'https://api.laanya.test/v1/internal/sweeps/invoice-emails'
    )
    expect(body.task.httpRequest.httpMethod).toBe('POST')
    // Same identity and audience Cloud Scheduler uses, which is what lets
    // plugins/scheduler.ts verify a task caller with no change at all.
    expect(body.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: CFG.serviceAccountEmail,
      audience: CFG.audience,
    })
  })

  it('treats 409 ALREADY_EXISTS as success — that IS the debounce', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response('already exists', { status: 409 })
    ) as unknown as typeof fetch
    await expect(createCloudTasksEnqueuer(CFG, fetchImpl).enqueue(INPUT)).resolves.toBeUndefined()
  })

  it('throws on any other failure, so the caller logs the cron fallback', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 403 })
    ) as unknown as typeof fetch
    await expect(createCloudTasksEnqueuer(CFG, fetchImpl).enqueue(INPUT)).rejects.toThrow(/403/)
  })

  it('throws when there are no application default credentials', async () => {
    vi.doMock('google-auth-library', () => ({
      GoogleAuth: class {
        getAccessToken(): Promise<null> {
          return Promise.resolve(null)
        }
      },
    }))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(createCloudTasksEnqueuer(CFG, fetchImpl).enqueue(INPUT)).rejects.toThrow(
      /default credentials/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('bucket constants', () => {
  it('drains on Neon’s billing granularity', () => {
    // Not arbitrary: Neon bills a 5-minute compute minimum per wake, so a
    // busy window costs at most one compute window and an idle one costs zero.
    expect(DRAIN_BUCKET_MS).toBe(5 * MINUTE_MS)
  })

  it('paces recovery to the staleness window it drains', () => {
    expect(RECOVER_BUCKET_MS).toBe(15 * MINUTE_MS)
  })
})
