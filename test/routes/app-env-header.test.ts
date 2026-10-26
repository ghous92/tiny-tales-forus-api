/**
 * X-Laanya-Env: every response carries the environment that actually served it.
 *
 * The admin SPA trusts this header over its own build-time notion of which API
 * it is pointed at, so the guarantee that matters is coverage — a header present
 * only on 2xx would leave exactly the confusing cases (404s, 503s, auth
 * failures) unlabelled.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { createTestApp, createTestDb, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
})

afterEach(async () => {
  await ctx.app.close()
})

describe('X-Laanya-Env', () => {
  it("defaults to 'development' when no appEnv is supplied", async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/livez' })
    expect(res.headers['x-laanya-env']).toBe('development')
  })

  it('is present on 404s', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/no-such-route' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['x-laanya-env']).toBe('development')
  })

  it('is present on unauthenticated 401s', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/addresses' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['x-laanya-env']).toBe('development')
  })

  it('reports the configured environment', async () => {
    const { db } = await createTestDb()
    const app = buildApp({
      db,
      verifyToken: () => Promise.reject(new Error('unused')),
      logger: false,
      appEnv: 'production',
    })
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/livez' })
      expect(res.headers['x-laanya-env']).toBe('production')
    } finally {
      await app.close()
    }
  })
})
