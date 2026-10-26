/**
 * X-Request-Id: the correlation id that joins a Cloudflare edge log record, this
 * API's pino lines, and a client crash report (docs/OBSERVABILITY.md P1).
 *
 * Two guarantees are load-bearing and neither is obvious from reading the config:
 *
 *   1. COVERAGE — echoed on every response, errors included. A 500 is precisely
 *      when an operator needs the id, so a header present only on 2xx would miss
 *      the case it exists for.
 *   2. VALIDATION — an upstream id is adopted only if it looks like one. Fastify
 *      stamps `request.id` onto every log line for the request, so a raw
 *      caller-controlled header is a log-bloat vector. The edge Worker overwrites
 *      it on the proxied path, but this service is also reachable directly on its
 *      *.run.app host, and the proxy-secret gate runs in `onRequest` — after the
 *      id is assigned and the "incoming request" line is already logged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('X-Request-Id', () => {
  it('is present on a 2xx and is a generated uuid when no upstream id is sent', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/livez' })
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
  })

  it('is present on 404s', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/no-such-route' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
  })

  it('is present on unauthenticated 401s', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/addresses' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
  })

  it('adopts a CF-Ray-shaped upstream id', async () => {
    // What edge/worker.js actually sends: the hex half of `CF-Ray`, which is
    // also the RayID field in Cloudflare Logpush — the join key on that side.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': '8f1c2d3e4f5a6b7c' },
    })
    expect(res.headers['x-request-id']).toBe('8f1c2d3e4f5a6b7c')
  })

  it('adopts an upstream uuid (local/dev caller with no edge in front)', async () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const res = await ctx.app.inject({ method: 'GET', url: '/livez', headers: { 'x-request-id': id } })
    expect(res.headers['x-request-id']).toBe(id)
  })

  it.each([
    ['too long', 'a'.repeat(65)],
    ['too short', 'abc'],
    ['newline injection', 'abcdefgh\n{"level":50,"msg":"forged"}'],
    ['punctuation outside the charset', 'abcdefgh; DROP TABLE'],
    ['empty', ''],
  ])('replaces a rejected upstream id (%s) with a fresh uuid', async (_label, value) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': value },
    })
    // Replaced wholesale, never sanitized in place: a rewritten id would look
    // legitimate while silently failing to join the edge log.
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
    expect(res.headers['x-request-id']).not.toBe(value)
  })
})
