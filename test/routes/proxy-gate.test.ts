/**
 * Proxy-gate tests (`src/app.ts`'s `onRequest` hook gated by
 * `proxySharedSecret`). Two independent apps: one built with the gate unset
 * (today's default — open) and one with it set, so each describe block
 * exercises a single, unambiguous configuration rather than toggling state
 * mid-test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auth, createTestApp, USER_A, type TestContext } from '../helpers/app.js'

const SECRET = 'test-proxy-shared-secret-0123456789abcdef'
const HEADER = 'x-tinytales-proxy-auth'

describe('proxy gate unset (default/dev state)', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestApp()
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  it('a normal route works without the header', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(200)
  })

  it('/livez works without the header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/livez' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('/readyz works without the header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('proxy gate set', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestApp({ proxySharedSecret: SECRET })
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  it('rejects a normal route with no proxy-auth header: 404 not_found envelope', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: auth(USER_A.token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
  })

  it('rejects a same-length but wrong header value: 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: { ...auth(USER_A.token), [HEADER]: 'x'.repeat(SECRET.length) },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
  })

  it('rejects a wrong-length header value: 404 (exercises the pre-check ahead of timingSafeEqual)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: { ...auth(USER_A.token), [HEADER]: 'too-short' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
  })

  it('lets the route through with the correct header', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: { ...auth(USER_A.token), [HEADER]: SECRET },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('/livez stays reachable without the header (Cloud Scheduler keepalive hits it directly)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/livez' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('/readyz stays reachable without the header (platform health checks hit it directly)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
