/**
 * HTTP-layer tests for `POST /v1/client-errors`: the 202 happy path (no auth
 * required), Zod validation, the per-IP rate limit, that the route hands
 * accepted events off to the injected `ErrorAlerter` test seam untouched, and
 * that it degrades gracefully (still 202s) with no alerter configured at all.
 */

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ErrorAlerter } from '../../src/lib/alerts.js'
import { clearClientErrorsRateLimits } from '../../src/routes/clientErrors.js'
import { createTestApp } from '../helpers/app.js'

/** Lightweight fake conforming to the seam the route actually uses — no real Brevo/GitHub calls. */
function createFakeAlerter() {
  const notifyClientEvents = vi.fn()
  const notifyServerError = vi.fn()
  const alerter = { notifyClientEvents, notifyServerError } as unknown as ErrorAlerter
  return { alerter, notifyClientEvents, notifyServerError }
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'mobile',
    events: [{ type: 'error', message: 'Something broke' }],
    ...overrides,
  }
}

let app: FastifyInstance

beforeEach(() => {
  clearClientErrorsRateLimits()
})

afterEach(async () => {
  await app?.close()
})

describe('POST /v1/client-errors', () => {
  it('202s with the accepted count for a valid batch', async () => {
    const { alerter } = createFakeAlerter()
    ;({ app } = await createTestApp({ alerter }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/client-errors',
      payload: validBody({
        events: [
          { type: 'error', message: 'a' },
          { type: 'memory', message: 'b' },
        ],
      }),
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 2 })
  })

  it('is publicly reachable — no Authorization header required', async () => {
    ;({ app } = await createTestApp())
    const res = await app.inject({ method: 'POST', url: '/v1/client-errors', payload: validBody() })
    expect(res.statusCode).toBe(202)
  })

  it('hands the accepted events and request context off to the injected alerter untouched', async () => {
    const { alerter, notifyClientEvents } = createFakeAlerter()
    ;({ app } = await createTestApp({ alerter }))

    const events = [
      {
        type: 'error',
        message: 'crash',
        stack: 'Error: crash\n    at x (/app/foo.js:1:1)',
        url: '/checkout',
      },
      { type: 'console.error', message: 'warn', meta: { screen: 'Home' } },
    ]
    const res = await app.inject({
      method: 'POST',
      url: '/v1/client-errors',
      headers: { 'user-agent': 'test-agent/1.0' },
      payload: { source: 'web', events },
    })

    expect(res.statusCode).toBe(202)
    expect(notifyClientEvents).toHaveBeenCalledTimes(1)
    const [receivedEvents, ctx] = notifyClientEvents.mock.calls[0] as [
      unknown,
      { source: string; ip: string; userAgent?: string },
    ]
    expect(receivedEvents).toEqual(events)
    expect(ctx.source).toBe('web')
    expect(ctx.userAgent).toBe('test-agent/1.0')
    expect(typeof ctx.ip).toBe('string')
  })

  it('works with no alerter configured — still 202s (graceful degrade)', async () => {
    ;({ app } = await createTestApp())
    const res = await app.inject({ method: 'POST', url: '/v1/client-errors', payload: validBody() })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 1 })
  })

  it.each([
    ['missing events', { source: 'mobile' }],
    ['empty events array', validBody({ events: [] })],
    [
      'too many events (>20)',
      validBody({ events: Array.from({ length: 21 }, () => ({ type: 'error', message: 'x' })) }),
    ],
    ['bad type enum', validBody({ events: [{ type: 'bogus', message: 'x' }] })],
    ['empty message', validBody({ events: [{ type: 'error', message: '' }] })],
    ['bad source', validBody({ source: 'desktop' })],
    ['unknown top-level field', validBody({ extra: true })],
    ['unknown event field', validBody({ events: [{ type: 'error', message: 'x', foo: 'bar' }] })],
  ])('422 validation_failed for %s', async (_label, payload) => {
    ;({ app } = await createTestApp())
    const res = await app.inject({ method: 'POST', url: '/v1/client-errors', payload })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('429 limit_exceeded after exceeding the per-IP rate limit (10/min)', async () => {
    ;({ app } = await createTestApp())

    let limited = false
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/client-errors',
        payload: validBody(),
      })
      if (res.statusCode === 429) {
        limited = true
        expect(res.json().error.code).toBe('limit_exceeded')
        break
      }
    }
    expect(limited).toBe(true)
  })
})
