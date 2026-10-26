/**
 * Health endpoints: /livez never touches the DB, /readyz answers 503 the
 * moment the database stops responding.
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

describe('GET /livez', () => {
  it('answers 200 { ok: true } without auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/livez' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('GET /readyz', () => {
  it('answers 200 { ok: true } without auth while the DB is reachable', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('answers 503 with the error envelope when the DB is down', async () => {
    await ctx.pglite.close()
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: { code: 'internal', message: 'Database unreachable' },
    })
  })
})

describe('unknown routes', () => {
  it('answer 404 with the error envelope', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
  })
})
