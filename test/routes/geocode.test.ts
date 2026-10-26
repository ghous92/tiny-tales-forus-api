/**
 * HTTP-layer tests for `GET /v1/geocode/reverse`: query validation, the
 * no-key degrade, the not-found path clients fall back on, the per-IP limiter,
 * and — the one that matters for compliance — that no coordinate is echoed
 * back in the response body.
 */

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearGeocodeRateLimits } from '../../src/routes/geocode.js'
import { clearGeocodeCache } from '../../src/services/geocode.js'
import { createTestApp } from '../helpers/app.js'

const LAT = 28.5705
const LNG = 77.3805

/** Trimmed from the live 28.5705,77.3805 response — see test/services/geocode.test.ts. */
function googleOk(): unknown {
  return {
    status: 'OK',
    results: [
      {
        formatted_address:
          'T-BLOCK, Amarpali Silicon City, Sector 76, Noida, Uttar Pradesh 201316, India',
        address_components: [
          { long_name: 'T-BLOCK', types: ['premise'] },
          {
            long_name: 'Amarpali Silicon City',
            types: ['political', 'sublocality', 'sublocality_level_2'],
          },
          { long_name: 'Sector 76', types: ['political', 'sublocality', 'sublocality_level_1'] },
          { long_name: 'Noida', types: ['locality', 'political'] },
          { long_name: 'Uttar Pradesh', types: ['administrative_area_level_1', 'political'] },
          { long_name: '201316', types: ['postal_code'] },
        ],
      },
    ],
    address_descriptor: {
      landmarks: [
        {
          display_name: { text: 'Patanjali Mega Store' },
          spatial_relationship: 'NEAR',
          straight_line_distance_meters: 136,
        },
      ],
      areas: [{ display_name: { text: 'Amarpali Silicon City' }, containment: 'WITHIN' }],
    },
  }
}

/** Replaces global fetch for the duration of a test. */
function stubGoogle(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }) as Response)
  )
}

let app: FastifyInstance

beforeEach(() => {
  clearGeocodeCache()
  clearGeocodeRateLimits()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app?.close()
})

describe('GET /v1/geocode/reverse', () => {
  it('resolves a coordinate to a society-level address', async () => {
    stubGoogle(googleOk())
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({
      method: 'GET',
      url: `/v1/geocode/reverse?lat=${LAT}&lng=${LNG}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      pincode: '201316',
      city: 'Noida',
      state: 'Uttar Pradesh',
      area: 'T-BLOCK, Amarpali Silicon City, Sector 76',
      // NEAR-only descriptors: the 136m Patanjali store is not the address.
      landmark: '',
      formattedAddress:
        'T-BLOCK, Amarpali Silicon City, Sector 76, Noida, Uttar Pradesh 201316, India',
    })
  })

  it('never echoes the caller’s coordinate back in the response', async () => {
    stubGoogle(googleOk())
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({
      method: 'GET',
      url: `/v1/geocode/reverse?lat=${LAT}&lng=${LNG}`,
    })

    // The privacy contract in services/geocode.ts depends on this staying true.
    expect(res.body).not.toContain(String(LAT))
    expect(res.body).not.toContain(String(LNG))
  })

  it('is publicly reachable — no Authorization header required', async () => {
    stubGoogle(googleOk())
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({
      method: 'GET',
      url: `/v1/geocode/reverse?lat=${LAT}&lng=${LNG}`,
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects an out-of-range coordinate with validation_failed', async () => {
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({ method: 'GET', url: '/v1/geocode/reverse?lat=99&lng=77' })

    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('rejects a non-numeric coordinate', async () => {
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({ method: 'GET', url: '/v1/geocode/reverse?lat=abc&lng=77' })
    expect(res.statusCode).toBe(422)
  })

  it('answers 503 geocoding_disabled when no key is configured', async () => {
    ;({ app } = await createTestApp())

    const res = await app.inject({
      method: 'GET',
      url: `/v1/geocode/reverse?lat=${LAT}&lng=${LNG}`,
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('geocoding_disabled')
  })

  it('answers 404 when the upstream has no address for the point', async () => {
    stubGoogle({ status: 'ZERO_RESULTS', results: [] })
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    const res = await app.inject({ method: 'GET', url: '/v1/geocode/reverse?lat=0&lng=0' })

    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('rate-limits a caller hammering the endpoint', async () => {
    stubGoogle(googleOk())
    ;({ app } = await createTestApp({ googleMapsServerKey: 'test-key' }))

    let limited = false
    // 61 distinct coordinates, so the service cache can't mask the limiter.
    for (let i = 0; i < 61; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/geocode/reverse?lat=${LAT + i * 0.01}&lng=${LNG}`,
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
