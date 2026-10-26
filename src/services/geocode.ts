/**
 * Reverse geocoding via the Google Geocoding API, with Address Descriptors.
 *
 * WHY THIS EXISTS — the mobile app used to reverse-geocode on-device via
 * expo-location, which delegates to CLGeocoder (iOS) / android.location.Geocoder
 * (Android). Neither queries a POI index, so in Indian residential areas they
 * resolve to a road at best and never name the society the shopper lives in.
 * Google's Address Descriptors (`extra_computations=ADDRESS_DESCRIPTORS`, GA
 * across India since April 2025, no extra charge on top of the geocode call)
 * return ranked nearby landmarks with a spatial relationship, which is exactly
 * the "Mahagun Mirabella, Sector 79" line an Indian address needs.
 *
 * WHY IT IS A SERVER PROXY rather than a direct client call:
 *  - the Maps server key stays out of the app bundle and can be IP-restricted;
 *  - one code path serves both platforms;
 *  - the cache below collapses repeat lookups, which keeps us inside the
 *    Geocoding API's 10k-free-calls/month Essentials tier in practice.
 *
 * PRIVACY / COMPLIANCE — read before changing the cache:
 *  - The cache is keyed ONLY by a rounded coordinate grid cell. No user id, no
 *    device id, no request id, no timestamp-per-caller is stored or derivable.
 *    A grid cell -> address-string mapping is geographic reference data, not
 *    personal data under the DPDP Act 2023; keying it by user, or logging
 *    coordinates next to a caller identity, WOULD make it personal data and is
 *    therefore forbidden here. Nothing in this file logs a coordinate.
 *  - Google Maps Platform ToS s3.2.3 caps caching of geocoding content at 30
 *    days. `CACHE_TTL_MS` is 24h and must stay well under that.
 */

import { geocodingDisabled } from '../lib/errors.js'
import type { ReverseGeocodeResult } from '../contracts/geocode.js'

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

/** Upstream timeout. Google is usually <300ms; this is a stall guard, not a budget. */
const UPSTREAM_TIMEOUT_MS = 5_000

/**
 * Cache lifetime. MUST stay under Google's 30-day caching cap (ToS s3.2.3).
 * 24h also means a newly-mapped society appears within a day.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Grid size for the cache key, in degrees. 0.0005 deg is ~55m of latitude —
 * fine enough that two points in the cell share a society, coarse enough that
 * a shopper standing still doesn't miss on every GPS jitter. Rounding also
 * means the stored key is not the caller's exact position.
 */
const CACHE_GRID_DEG = 0.0005

/** Hard cap on cache entries, so a scripted sweep of coordinates can't grow it without bound. */
const CACHE_MAX_ENTRIES = 10_000

/** Mirrors the mobile form's `LINE_MAX` — never hand back more than it will accept. */
const AREA_MAX_LEN = 200

// --- Minimal shape of the Google Geocoding response we read. -----------------

interface GoogleAddressComponent {
  long_name?: string
  short_name?: string
  types?: string[]
}

interface GoogleDisplayName {
  text?: string
  language_code?: string
}

interface GoogleLandmark {
  display_name?: GoogleDisplayName
  types?: string[]
  spatial_relationship?: string
  straight_line_distance_meters?: number
}

interface GoogleArea {
  display_name?: GoogleDisplayName
  containment?: string
}

interface GoogleAddressDescriptor {
  landmarks?: GoogleLandmark[]
  areas?: GoogleArea[]
}

interface GoogleGeocodeResult {
  address_components?: GoogleAddressComponent[]
  formatted_address?: string
}

interface GoogleGeocodeResponse {
  status?: string
  error_message?: string
  results?: GoogleGeocodeResult[]
  address_descriptor?: GoogleAddressDescriptor
}

/** Forward geocoding reads `geometry.location`, which the reverse path ignores. */
interface GoogleForwardResponse {
  status?: string
  results?: (GoogleGeocodeResult & {
    geometry?: { location?: { lat?: number; lng?: number } }
  })[]
}

// --- Cache -------------------------------------------------------------------

interface CacheEntry {
  value: ReverseGeocodeResult
  expiresAt: number
}

/**
 * Process-local cache. Cloud Run runs several instances, so this is a
 * best-effort cost damper, not a coherent shared cache — which is fine: a miss
 * is just one more upstream call, never a wrong answer.
 */
const cache = new Map<string, CacheEntry>()

/** Snap a coordinate to the grid, so nearby lookups share one key (and one upstream call). */
function cacheKey(lat: number, lng: number): string {
  const snap = (n: number): string => (Math.round(n / CACHE_GRID_DEG) * CACHE_GRID_DEG).toFixed(4)
  return `${snap(lat)},${snap(lng)}`
}

function cacheGet(key: string, now: number): ReverseGeocodeResult | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= now) {
    cache.delete(key)
    return null
  }
  // Re-insert so Map iteration order approximates LRU for the eviction below.
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key: string, value: ReverseGeocodeResult, now: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the least recently used.
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
}

/** Test seam — drops every entry. Never called in production. */
export function clearGeocodeCache(): void {
  cache.clear()
}

// --- Parsing -----------------------------------------------------------------

function componentValue(components: GoogleAddressComponent[], ...types: string[]): string {
  for (const type of types) {
    const match = components.find((c) => Array.isArray(c.types) && c.types.includes(type))
    const name = match?.long_name
    if (typeof name === 'string' && name.trim().length > 0) return name.trim()
  }
  return ''
}

/**
 * Pick the landmark that answers "what am I standing IN?" — and nothing looser.
 *
 * ONLY `WITHIN` counts. Verified against live responses in Noida: at a
 * residential coordinate every `NEAR` landmark was a passing POI — a shopping
 * mall at 340m, a petrol pump at 230m, a Patanjali store at 136m. A
 * distance threshold does not separate those from a real building, so any
 * "nearest within N metres" rule reliably names a grocery store as the
 * shopper's society. The society itself comes from `address_components`
 * (see `parseResponse`), not from here.
 *
 * This is therefore a display hint only — it never enters the area line.
 */
function pickLandmark(descriptor: GoogleAddressDescriptor | undefined): string {
  const within = (descriptor?.landmarks ?? []).find(
    (l) =>
      l.spatial_relationship === 'WITHIN' &&
      typeof l.display_name?.text === 'string' &&
      l.display_name.text.trim().length > 0
  )
  return within?.display_name?.text?.trim() ?? ''
}

/**
 * Every sub-locality level, MOST SPECIFIC FIRST.
 *
 * The levels are not semantically fixed across India — verified live:
 *  - Noida Sector 76: level_2 = "Amarpali Silicon City" (the society),
 *    level_1 = "Sector 76" (the sector)
 *  - Noida Salarpur:  level_3 = "Sector 102", level_2 = "Block A",
 *    level_1 = "Salarpur"
 *  - New Delhi:       level_1 = "Kartavya Path" only
 *
 * What IS consistent is that a higher level number is more specific, so
 * descending order puts the society ahead of the sector every time. Reading
 * only level_1 (the obvious choice) returns the sector and drops the society —
 * which is the whole thing this endpoint exists to fix.
 */
function sublocalities(components: GoogleAddressComponent[]): string[] {
  return [
    componentValue(components, 'sublocality_level_3'),
    componentValue(components, 'sublocality_level_2'),
    componentValue(components, 'sublocality_level_1'),
    // Bare `sublocality` / `neighborhood` for the rare response carrying no
    // numbered level at all.
    componentValue(components, 'sublocality'),
    componentValue(components, 'neighborhood'),
  ].filter((part) => part.length > 0)
}

/** The containing area (sector / colony), used when address_components has no sub-locality. */
function pickArea(descriptor: GoogleAddressDescriptor | undefined): string {
  const areas = descriptor?.areas ?? []
  const within = areas.find(
    (a) => a.containment === 'WITHIN' && typeof a.display_name?.text === 'string'
  )
  const text = within?.display_name?.text
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * Join the parts of the Road/Area line, dropping blanks, case-insensitive
 * duplicates, and anything already shown in the City/State/Pincode fields —
 * otherwise the line reads "…, Noida, Uttar Pradesh, 201307" next to three
 * inputs saying exactly that.
 */
function buildAreaLine(parts: string[], drop: string[]): string {
  const blocked = new Set(drop.map((d) => d.toLowerCase()).filter((d) => d.length > 0))
  const seen = new Set<string>()
  const kept: string[] = []

  for (const raw of parts) {
    const part = raw.trim()
    if (part.length === 0) continue
    const lower = part.toLowerCase()
    if (blocked.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    kept.push(part)
  }

  return kept.join(', ').slice(0, AREA_MAX_LEN)
}

function parseResponse(body: GoogleGeocodeResponse): ReverseGeocodeResult | null {
  const result = body.results?.[0]
  if (!result) return null

  const components = result.address_components ?? []
  const descriptor = body.address_descriptor

  // India rarely populates `locality` outside the metros — fall through the
  // admin-area levels rather than leaving City blank.
  const city = componentValue(
    components,
    'locality',
    'administrative_area_level_3',
    'administrative_area_level_2'
  )
  const state = componentValue(components, 'administrative_area_level_1')
  const pincode = componentValue(components, 'postal_code')

  const landmark = pickLandmark(descriptor)
  // The tower/block, e.g. "T-BLOCK" — the most specific part Google will give
  // for a coordinate, and the one that tells a delivery rider where to stop.
  const premise = componentValue(components, 'premise')
  const route = componentValue(components, 'route')

  // Most specific first: block, then society, then sector, then road. The
  // descriptor's WITHIN areas only stand in when the components carry no
  // sub-locality at all — they duplicate it whenever both are present.
  const subs = sublocalities(components)
  const area = buildAreaLine(
    [premise, ...(subs.length > 0 ? subs : [pickArea(descriptor)]), route],
    [city, state, pincode]
  )

  // Nothing usable: a point in the sea or deep countryside still returns 200
  // OK from Google, but with no components and a Plus Code standing in for
  // `formatted_address` (e.g. "7M792222+22"). Falling back to that string
  // would prefill the shopper's Road/Area field with a Plus Code, which is
  // worse than leaving it blank — report "no answer" instead and let the
  // client fall back to its on-device geocoder.
  if (area.length === 0 && city.length === 0 && pincode.length === 0) return null

  return {
    pincode,
    city,
    state,
    // Only reachable with a real city/pincode alongside, so this is a genuine
    // address line rather than a Plus Code.
    area: area.length > 0 ? area : (result.formatted_address ?? '').slice(0, AREA_MAX_LEN),
    landmark,
    formattedAddress: result.formatted_address ?? '',
  }
}

// --- Public API --------------------------------------------------------------

export interface ReverseGeocodeDeps {
  /** Google Maps server key. Absent => the route degrades to 503 `geocoding_disabled`. */
  apiKey?: string | undefined
  /** Test seam: injected fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Test seam: injected clock. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Resolve a coordinate to an address. Throws `geocodingDisabled` when no key is
 * configured; returns `null` when the upstream has no answer (ZERO_RESULTS, a
 * transport failure, or a non-OK status) so the caller can 404 and the client
 * can fall back to its on-device geocoder rather than showing an error.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
  deps: ReverseGeocodeDeps
): Promise<ReverseGeocodeResult | null> {
  const apiKey = deps.apiKey
  if (!apiKey) throw geocodingDisabled()

  const doFetch = deps.fetchImpl ?? fetch
  const now = (deps.now ?? Date.now)()

  const key = cacheKey(lat, lng)
  const cached = cacheGet(key, now)
  if (cached) return cached

  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    key: apiKey,
    language: 'en',
    region: 'in',
    // The whole point of this module — see the file header.
    extra_computations: 'ADDRESS_DESCRIPTORS',
  })

  let body: GoogleGeocodeResponse
  try {
    const response = await doFetch(`${GEOCODE_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) return null
    body = (await response.json()) as GoogleGeocodeResponse
  } catch {
    // Timeout / DNS / TLS — indistinguishable from "no answer" to the caller.
    return null
  }

  // ZERO_RESULTS is a legitimate empty answer; every other non-OK status is a
  // key/quota/config fault worth surfacing in logs, which the route does (it
  // owns the logger). Either way the shopper gets the on-device fallback.
  if (body.status !== 'OK') return null

  const parsed = parseResponse(body)
  if (!parsed) return null

  cacheSet(key, parsed, now)
  return parsed
}

/**
 * Resolve address TEXT to a coordinate — the opposite direction, for placing a
 * pickup node from an admin-typed address.
 *
 * Three differences from `reverseGeocode`, all deliberate:
 *
 * 1. **Admin-only at the route** (`POST /v1/admin/shipping/geocode/forward`).
 *    Reverse geocoding needs a coordinate the caller already has; forward
 *    geocoding turns arbitrary strings into coordinates, which is a
 *    general-purpose lookup service running on our Google quota.
 * 2. **Not cached.** An operator places a node a handful of times ever, so a
 *    cache would carry the privacy and staleness cost of storing typed
 *    addresses for no measurable saving.
 * 3. **No Address Descriptors.** The caller wants a point and a pincode, not
 *    a landmark sentence.
 *
 * The pincode is returned alongside the coordinate because the ZONE is derived
 * from the pincode, not the point — a node saved with a coordinate that
 * disagrees with its typed pincode would quote from one place and ship from
 * another, so the admin form shows both and makes the operator reconcile them.
 */
export async function forwardGeocode(
  address: string,
  deps: ReverseGeocodeDeps
): Promise<{ lat: number; lng: number; pincode: string; formattedAddress: string } | null> {
  const apiKey = deps.apiKey
  if (!apiKey) throw geocodingDisabled()

  const doFetch = deps.fetchImpl ?? fetch
  const params = new URLSearchParams({
    address,
    key: apiKey,
    language: 'en',
    // Bias, not a fence: `region` nudges ambiguous names toward India without
    // rejecting a legitimate result elsewhere.
    region: 'in',
    components: 'country:IN',
  })

  let body: GoogleForwardResponse
  try {
    const response = await doFetch(`${GEOCODE_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) return null
    body = (await response.json()) as GoogleForwardResponse
  } catch {
    return null
  }

  if (body.status !== 'OK') return null

  const result = body.results?.[0]
  const location = result?.geometry?.location
  if (!result || typeof location?.lat !== 'number' || typeof location.lng !== 'number') return null

  const pincode =
    result.address_components?.find((component) => component.types?.includes('postal_code'))
      ?.long_name ?? ''

  return {
    lat: location.lat,
    lng: location.lng,
    pincode,
    formattedAddress: result.formatted_address ?? '',
  }
}
