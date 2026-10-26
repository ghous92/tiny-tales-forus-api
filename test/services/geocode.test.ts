/**
 * Reverse-geocode service tests. No database and no network: a fake `fetch`
 * stands in for Google, so what is proved here is the parsing (the India-shaped
 * address_components ordering and the Address Descriptors landmark rule), the
 * cache behaviour, and the graceful-degrade paths.
 *
 * The fixtures below are REAL responses captured from the Geocoding API on
 * 2026-07-19, not invented shapes — the parsing rules they pin down (society in
 * `sublocality_level_2`, sector in `level_1`, every descriptor landmark being a
 * passing POI) were only discovered by making the live calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../src/lib/errors.js'
import { clearGeocodeCache, reverseGeocode } from '../../src/services/geocode.js'

const KEY = 'test-key'

/** Noida Sector 76 — a dense residential coordinate, the case that motivated this module. */
const LAT = 28.5705
const LNG = 77.3805

interface GoogleStub {
  status?: string
  results?: unknown[]
  address_descriptor?: unknown
}

/** A fake `fetch` that answers every call with `body`, recording the URLs hit. */
function stubFetch(body: GoogleStub, ok = true) {
  const calls: string[] = []
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    return { ok, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/**
 * VERBATIM live response for 28.5705,77.3805 (Noida). Note that every landmark
 * is a nearby shop or petrol pump — the society "Amarpali Silicon City" appears
 * only as `sublocality_level_2`. That asymmetry is the reason the parser reads
 * components for the area line and treats landmarks as a display hint.
 */
function noidaResponse(): GoogleStub {
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
          { long_name: 'Gautam Buddha Nagar', types: ['administrative_area_level_3', 'political'] },
          { long_name: 'Uttar Pradesh', types: ['administrative_area_level_1', 'political'] },
          { long_name: 'India', types: ['country', 'political'] },
          { long_name: '201316', types: ['postal_code'] },
        ],
      },
    ],
    address_descriptor: {
      landmarks: [
        {
          display_name: { text: 'Spectrum Metro Mall', language_code: 'en' },
          types: ['establishment', 'shopping_mall'],
          spatial_relationship: 'NEAR',
          straight_line_distance_meters: 340,
        },
        {
          display_name: { text: 'Patanjali Mega Store', language_code: 'en' },
          types: ['establishment', 'grocery_or_supermarket'],
          spatial_relationship: 'NEAR',
          straight_line_distance_meters: 136,
        },
      ],
      areas: [
        { display_name: { text: 'Amarpali Silicon City' }, containment: 'WITHIN' },
        { display_name: { text: 'Sector 76' }, containment: 'WITHIN' },
      ],
    },
  }
}

/** VERBATIM live response for 28.5480,77.3900 — sub-locality levels run 3/2/1. */
function salarpurResponse(): GoogleStub {
  return {
    status: 'OK',
    results: [
      {
        formatted_address:
          'Metro Station, 165, near Sector 81, opp. Metro Piller, Sector 102, Block A, Salarpur, Noida, Uttar Pradesh 201304, India',
        address_components: [
          { long_name: 'Metro Station', types: ['premise'] },
          { long_name: 'Sector 81', types: ['landmark'] },
          { long_name: 'Sector 102', types: ['political', 'sublocality', 'sublocality_level_3'] },
          { long_name: 'Block A', types: ['political', 'sublocality', 'sublocality_level_2'] },
          { long_name: 'Salarpur', types: ['political', 'sublocality', 'sublocality_level_1'] },
          { long_name: 'Noida', types: ['locality', 'political'] },
          { long_name: 'Uttar Pradesh', types: ['administrative_area_level_1', 'political'] },
          { long_name: '201304', types: ['postal_code'] },
        ],
      },
    ],
    // Every area is OUTSKIRTS here — WITHIN is not guaranteed to exist.
    address_descriptor: {
      landmarks: [],
      areas: [
        { display_name: { text: 'Salarpur' }, containment: 'OUTSKIRTS' },
        { display_name: { text: 'Sector 102' }, containment: 'OUTSKIRTS' },
      ],
    },
  }
}

beforeEach(() => {
  clearGeocodeCache()
})

describe('reverseGeocode', () => {
  it('builds the area line block-first, then society, then sector', async () => {
    const { impl } = stubFetch(noidaResponse())
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(result?.area).toBe('T-BLOCK, Amarpali Silicon City, Sector 76')
    expect(result?.city).toBe('Noida')
    expect(result?.state).toBe('Uttar Pradesh')
    expect(result?.pincode).toBe('201316')
  })

  it('never lets a nearby POI into the area line', async () => {
    const { impl } = stubFetch(noidaResponse())
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    // The 136m Patanjali store is the nearest landmark; naming it as the
    // shopper's address is the exact bug a distance threshold would cause.
    expect(result?.area).not.toContain('Patanjali')
    expect(result?.area).not.toContain('Spectrum')
    // NEAR-only descriptors mean no containing landmark exists.
    expect(result?.landmark).toBe('')
  })

  it('orders sub-locality levels most-specific-first regardless of depth', async () => {
    const { impl } = stubFetch(salarpurResponse())
    const result = await reverseGeocode(28.548, 77.39, { apiKey: KEY, fetchImpl: impl })

    expect(result?.area).toBe('Metro Station, Sector 102, Block A, Salarpur')
  })

  it('reports a landmark only when the coordinate is WITHIN it', async () => {
    const body = noidaResponse()
    ;(body.address_descriptor as { landmarks: unknown[] }).landmarks = [
      {
        display_name: { text: 'Amarpali Silicon City' },
        spatial_relationship: 'WITHIN',
        straight_line_distance_meters: 12,
      },
    ]
    const { impl } = stubFetch(body)
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(result?.landmark).toBe('Amarpali Silicon City')
  })

  it('requests address descriptors, in English, biased to India', async () => {
    const { impl, calls } = stubFetch(noidaResponse())
    await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    const url = calls[0] ?? ''
    expect(url).toContain('extra_computations=ADDRESS_DESCRIPTORS')
    expect(url).toContain('language=en')
    expect(url).toContain('region=in')
    expect(url).toContain(`latlng=${LAT}%2C${LNG}`)
  })

  it('falls back through the admin-area levels when locality is absent', async () => {
    const body = noidaResponse()
    ;(body.results as { address_components: unknown[] }[])[0]!.address_components = [
      { long_name: 'Gautam Buddha Nagar', types: ['administrative_area_level_3', 'political'] },
      { long_name: 'Uttar Pradesh', types: ['administrative_area_level_1', 'political'] },
      { long_name: '201316', types: ['postal_code'] },
    ]
    const { impl } = stubFetch(body)
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(result?.city).toBe('Gautam Buddha Nagar')
  })

  it('uses a WITHIN descriptor area only when components carry no sub-locality', async () => {
    const body = noidaResponse()
    ;(body.results as { address_components: unknown[] }[])[0]!.address_components = [
      { long_name: 'Noida', types: ['locality', 'political'] },
      { long_name: 'Uttar Pradesh', types: ['administrative_area_level_1', 'political'] },
    ]
    const { impl } = stubFetch(body)
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(result?.area).toBe('Amarpali Silicon City')
  })

  it('never repeats the city, state or pincode inside the area line', async () => {
    const { impl } = stubFetch(noidaResponse())
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(result?.area).not.toContain('Noida')
    expect(result?.area).not.toContain('Uttar Pradesh')
    expect(result?.area).not.toContain('201316')
  })

  it('serves a second nearby lookup from cache without calling upstream again', async () => {
    const { impl } = stubFetch(noidaResponse())
    await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })
    // ~5m away: inside the same grid cell, so it must not cost a second call.
    await reverseGeocode(LAT + 0.00004, LNG, { apiKey: KEY, fetchImpl: impl })

    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('calls upstream again once the entry has expired', async () => {
    const { impl } = stubFetch(noidaResponse())
    const start = 1_000_000
    await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl, now: () => start })
    await reverseGeocode(LAT, LNG, {
      apiKey: KEY,
      fetchImpl: impl,
      now: () => start + 24 * 60 * 60 * 1000 + 60_000,
    })

    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('throws geocoding_disabled when no key is configured', async () => {
    const { impl } = stubFetch(noidaResponse())
    await expect(reverseGeocode(LAT, LNG, { apiKey: undefined, fetchImpl: impl })).rejects.toThrow(
      ApiError
    )
    expect(impl).not.toHaveBeenCalled()
  })

  it('reports no answer rather than handing back a Plus Code', async () => {
    // Verified live at 15.0,87.0 (Bay of Bengal): Google answers 200 OK with no
    // address components and a Plus Code as `formatted_address`. Prefilling
    // that into the shopper's Road/Area field is worse than leaving it blank.
    const { impl } = stubFetch({
      status: 'OK',
      results: [{ formatted_address: '7M792222+22', address_components: [] }],
    })
    await expect(reverseGeocode(15, 87, { apiKey: KEY, fetchImpl: impl })).resolves.toBeNull()
  })

  it('returns null (not an error) on ZERO_RESULTS so the client can fall back', async () => {
    const { impl } = stubFetch({ status: 'ZERO_RESULTS', results: [] })
    await expect(reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })).resolves.toBeNull()
  })

  it('returns null when the upstream call fails outright', async () => {
    const impl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    await expect(reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: impl })).resolves.toBeNull()
  })

  it('does not cache a failed lookup', async () => {
    const failing = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: failing })

    const { impl: succeeding } = stubFetch(noidaResponse())
    const result = await reverseGeocode(LAT, LNG, { apiKey: KEY, fetchImpl: succeeding })
    expect(result?.area).toBe('T-BLOCK, Amarpali Silicon City, Sector 76')
  })
})
