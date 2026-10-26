/**
 * `lib/replenishmentTask.ts` — the delayed Cloud Task behind the 60-day refill
 * reminder.
 *
 * The maths is the load-bearing part. Cloud Tasks refuses a `scheduleTime` more
 * than 30 days out, so a 60-day wait is a CHAIN of hops, and the two ways a
 * chain can be wrong are both silent:
 *
 *   - a hop that recomputed "60 days from now" would walk the due date forward
 *     on every hop and never fire — hence `dueAt` travels in the task body as an
 *     absolute timestamp and is asserted to survive a hop unchanged;
 *   - a leg scheduled at the exact ceiling races its own validation, so
 *     `MAX_HORIZON_MS` is 29 days, not 30.
 *
 * Naming is the other property: per-ORDER-and-leg, because two orders delivered
 * in the same minute owe two different reminders and a time-bucketed name (what
 * `lib/tasks.ts` does for sweeps) would silently drop one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createReplenishmentTaskEnqueuer,
  isDue,
  MAX_HORIZON_MS,
  nextLegTime,
  replenishmentTaskName,
  REPLENISHMENT_TASK_PATH,
  requestReplenishmentReminder,
  type ReplenishmentTaskEnqueuer,
} from '../../src/lib/replenishmentTask.js'
import type { CloudTasksConfig } from '../../src/lib/tasks.js'

const CFG: CloudTasksConfig = {
  project: 'laanya-prod',
  location: 'asia-southeast1',
  queue: 'laanya-sweeps',
  targetBaseUrl: 'https://api.laanya.test',
  serviceAccountEmail: 'laanya-scheduler@laanya-prod.iam.gserviceaccount.com',
  audience: 'laanya-sweeps-prod',
}
const PARENT = 'projects/laanya-prod/locations/asia-southeast1/queues/laanya-sweeps'
const NOW = new Date('2026-09-01T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.resetModules()
})

function stubAuth(): void {
  vi.doMock('google-auth-library', () => ({
    GoogleAuth: class {
      getAccessToken(): Promise<string> {
        return Promise.resolve('fake-access-token')
      }
    },
  }))
}

describe('nextLegTime', () => {
  it('schedules the due date directly when it is inside the horizon', () => {
    const due = new Date(NOW.getTime() + 10 * DAY_MS)
    expect(nextLegTime(due, NOW)).toEqual(due)
  })

  it('caps a 60-day wait at the horizon — the first of two hops', () => {
    const due = new Date(NOW.getTime() + 60 * DAY_MS)
    expect(nextLegTime(due, NOW).getTime()).toBe(NOW.getTime() + MAX_HORIZON_MS)
  })

  it('leaves a day of margin under the documented 30-day ceiling', () => {
    expect(MAX_HORIZON_MS).toBe(29 * DAY_MS)
  })

  /**
   * The convergence property, stated directly: hopping with the SAME absolute
   * due date must walk TOWARDS the due date and land on it, not push it further
   * out. A hop that recomputed the delay from "now" would fail this.
   *
   * 60 days is three hops, not two: 29 + 29 leaves 2 days, and the horizon is
   * 29 days precisely so a leg never sits on the ceiling.
   */
  it('converges — a 60-day due date is reached in three hops of at most the horizon', () => {
    const due = new Date(NOW.getTime() + 60 * DAY_MS)
    const legs: Date[] = []
    let at = NOW
    for (let i = 0; i < 10 && at.getTime() < due.getTime(); i += 1) {
      at = nextLegTime(due, at)
      legs.push(at)
    }
    expect(legs.map((d) => d.getTime())).toEqual([
      NOW.getTime() + 29 * DAY_MS,
      NOW.getTime() + 58 * DAY_MS,
      due.getTime(),
    ])
  })

  it('never returns a past time — a due date that has already passed fires now', () => {
    const due = new Date(NOW.getTime() - 5 * DAY_MS)
    expect(nextLegTime(due, NOW)).toEqual(NOW)
  })

  it('treats a due date exactly now as due rather than scheduling it', () => {
    expect(nextLegTime(NOW, NOW)).toEqual(NOW)
  })
})

describe('isDue', () => {
  it('is false before the due date and true at or after it', () => {
    expect(isDue(new Date(NOW.getTime() + 1), NOW)).toBe(false)
    expect(isDue(NOW, NOW)).toBe(true)
    expect(isDue(new Date(NOW.getTime() - 1), NOW)).toBe(true)
  })
})

describe('replenishmentTaskName', () => {
  it('is per order and per leg, so two same-minute deliveries do not collapse', () => {
    const legAt = new Date(NOW.getTime() + 29 * DAY_MS)
    expect(replenishmentTaskName('order_A1', legAt)).not.toBe(
      replenishmentTaskName('order_B2', legAt)
    )
    expect(replenishmentTaskName('order_A1', legAt)).toBe(`replenish-order_A1-${legAt.getTime()}`)
  })

  it('collapses a genuine repeat of the SAME leg', () => {
    const legAt = new Date(NOW.getTime() + 29 * DAY_MS)
    expect(replenishmentTaskName('order_A1', legAt)).toBe(
      replenishmentTaskName('order_A1', new Date(legAt.getTime()))
    )
  })

  it('does not collapse the next hop against the leg that scheduled it', () => {
    const first = new Date(NOW.getTime() + 29 * DAY_MS)
    const second = new Date(NOW.getTime() + 60 * DAY_MS)
    expect(replenishmentTaskName('order_A1', first)).not.toBe(
      replenishmentTaskName('order_A1', second)
    )
  })

  it('sanitises an order id to Cloud Tasks’ [a-zA-Z0-9_-] charset', () => {
    const name = replenishmentTaskName('order/A1:x y', NOW)
    expect(name).toBe(`replenish-order_A1_x_y-${NOW.getTime()}`)
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,500}$/)
  })
})

describe('createReplenishmentTaskEnqueuer', () => {
  it('carries the ABSOLUTE due date in the body while scheduling only the capped leg', async () => {
    stubAuth()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch
    const dueAt = new Date(NOW.getTime() + 60 * DAY_MS).toISOString()

    try {
      await createReplenishmentTaskEnqueuer(CFG, fetchImpl).enqueue({ orderId: 'order_A1', dueAt })
    } finally {
      vi.useRealTimers()
    }

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${PARENT}/tasks`)
    const sent = JSON.parse(String(init.body)) as {
      task: {
        name: string
        scheduleTime: string
        httpRequest: { url: string; body: string }
      }
    }
    // Scheduled 29 days out — the first hop, not the due date.
    expect(sent.task.scheduleTime).toBe(new Date(NOW.getTime() + MAX_HORIZON_MS).toISOString())
    expect(sent.task.httpRequest.url).toBe(`https://api.laanya.test${REPLENISHMENT_TASK_PATH}`)
    // …but the body still says when it is actually due. This is what makes the
    // chain converge instead of walking forward a month per hop.
    const body = JSON.parse(Buffer.from(sent.task.httpRequest.body, 'base64').toString('utf8')) as {
      orderId: string
      dueAt: string
    }
    expect(body).toEqual({ orderId: 'order_A1', dueAt })
    expect(sent.task.name).toBe(
      `${PARENT}/tasks/replenish-order_A1-${NOW.getTime() + MAX_HORIZON_MS}`
    )
  })

  it('schedules a short wait directly, with no hop', async () => {
    stubAuth()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch
    const dueAt = new Date(NOW.getTime() + 3 * DAY_MS).toISOString()

    try {
      await createReplenishmentTaskEnqueuer(CFG, fetchImpl).enqueue({ orderId: 'order_A1', dueAt })
    } finally {
      vi.useRealTimers()
    }

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    const sent = JSON.parse(String(init.body)) as { task: { scheduleTime: string } }
    expect(sent.task.scheduleTime).toBe(dueAt)
  })

  /**
   * A duplicate task name is the debounce working, not a fault: the same leg is
   * already scheduled, so the work IS covered. `enqueueRawCloudTask` swallows
   * the 409, and this asserts the replenishment producer inherits that.
   */
  it('treats a duplicate task name (409) as already scheduled', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response('already exists', { status: 409 })
    ) as unknown as typeof fetch

    await expect(
      createReplenishmentTaskEnqueuer(CFG, fetchImpl).enqueue({
        orderId: 'order_A1',
        dueAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
      })
    ).resolves.toBeUndefined()
  })
})

describe('requestReplenishmentReminder', () => {
  /**
   * Fire and forget: the parcel is delivered and the scan is committed by the
   * time this runs, so failing the carrier's webhook to protect a marketing
   * reminder would be backwards. A lost enqueue costs one reminder.
   */
  it('logs and swallows an enqueue failure rather than rejecting', async () => {
    const error = vi.fn()
    const enqueuer: ReplenishmentTaskEnqueuer = {
      enqueue: () => Promise.reject(new Error('queue down')),
    }

    expect(() =>
      requestReplenishmentReminder(enqueuer, { orderId: 'order_A1', dueAt: NOW.toISOString() }, {
        error,
      } as unknown as Parameters<typeof requestReplenishmentReminder>[2])
    ).not.toThrow()

    await Promise.resolve()
    await Promise.resolve()
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order_A1' }),
      'replenishment reminder task enqueue failed'
    )
  })
})

/**
 * The same task carries the unpaid-order nudge and the review ask. Two
 * properties keep that safe: each kind gets its own name prefix, so an order's
 * refill reminder and review ask never collide as "duplicates"; and a refill
 * task's body stays exactly what it was before `kind` existed.
 */
describe('follow-up kinds', () => {
  it('prefixes the task name per kind, keeping `replenish` for refill reminders', () => {
    expect(replenishmentTaskName('order_A1', NOW, 'replenishment')).toBe(
      `replenish-order_A1-${NOW.getTime()}`
    )
    expect(replenishmentTaskName('order_A1', NOW, 'payment_reminder')).toBe(
      `payremind-order_A1-${NOW.getTime()}`
    )
    expect(replenishmentTaskName('order_A1', NOW, 'review_request')).toBe(
      `reviewask-order_A1-${NOW.getTime()}`
    )
  })

  async function sentBody(kind?: 'replenishment' | 'payment_reminder' | 'review_request') {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch
    const dueAt = new Date(Date.now() + DAY_MS).toISOString()
    await createReplenishmentTaskEnqueuer(CFG, fetchImpl).enqueue({
      orderId: 'order_A1',
      dueAt,
      ...(kind ? { kind } : {}),
    })
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    const sent = JSON.parse(String(init.body)) as {
      task: { name: string; httpRequest: { body: string } }
    }
    return {
      name: sent.task.name,
      body: JSON.parse(Buffer.from(sent.task.httpRequest.body, 'base64').toString('utf8')),
      dueAt,
    }
  }

  it('sends a refill reminder body without `kind`, byte-identical to before', async () => {
    const { body, dueAt } = await sentBody('replenishment')
    expect(body).toEqual({ orderId: 'order_A1', dueAt })
  })

  it('carries `kind` in the body for the other follow-ups', async () => {
    const reminder = await sentBody('payment_reminder')
    expect(reminder.body).toEqual({
      orderId: 'order_A1',
      dueAt: reminder.dueAt,
      kind: 'payment_reminder',
    })
    expect(reminder.name).toContain('/tasks/payremind-order_A1-')

    const review = await sentBody('review_request')
    expect(review.body.kind).toBe('review_request')
    expect(review.name).toContain('/tasks/reviewask-order_A1-')
  })
})
