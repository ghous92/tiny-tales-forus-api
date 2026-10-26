/**
 * Shree Maruti tracking adapter — track-only. Parcels go to Shree Maruti by
 * hand (booked at their counter or through a 3PL, then recorded with
 * `POST …/shipments/:id/dispatch`), so there is nothing to manifest, cancel or
 * label through us. What we DO need is the scans, so a hand-booked parcel
 * reaches `out_for_delivery`/`delivered` — and fires the customer messages —
 * without an operator watching it.
 *
 * No DB imports, no config imports, same as `lib/delhivery.ts`.
 *
 * Traps encoded here so no caller has to remember them:
 *
 * - **There is no credentialed API.** This is the endpoint their own public
 *   tracking page (`tracking.shreemaruti.com`, run by Innofulfill "hubops")
 *   calls from the browser. It is unauthenticated and keyed on the AWB alone.
 *   It is not a contract they have made with us, so an unreadable body is a
 *   failure for the sweep to retry — never an empty "no scans" success that
 *   would leave a parcel frozen while looking healthy.
 * - **`statuses` is newest first.** Sorted oldest-first here, which is the
 *   order `TrackingResult` promises.
 * - **`statusTimestamp` is epoch MILLISECONDS** — the carrier's clock, and the
 *   ordering key. `createdAt` is when their system recorded it; never used.
 * - **`category` is the coarse, stable field** (`IN_TRANSIT`,
 *   `OUT_FOR_DELIVERY` …) and is what gets mapped. The granular `status`
 *   (`inscan_at_hub`, `outscan_at_hub` …) is carried through as `nslCode` for
 *   forensics, exactly as Delhivery's NSL code is.
 * - **No delivery estimate is published**, so `expectedDeliveryDate` is null.
 */

import type { CarrierScan } from './fulfilmentStatus.js'
import type { FetchLike, TrackingResult } from './delhivery.js'

/** `shipments.courier_code` for a parcel Shree Maruti is carrying. */
export const SHREE_MARUTI_COURIER_CODE = 'shree_maruti'

/**
 * Value of {@link CarrierScan.statusType} on every Shree Maruti scan. It is the
 * namespace that keeps their `category` words from colliding with Delhivery's
 * pairs in `fulfilmentStatus.ts`'s map.
 */
export const SHREE_MARUTI_STATUS_TYPE = 'SM'

export const SHREE_MARUTI_TRACKING_BASE_URL = 'https://apis-hubops.innofulfill.com/tracking/v2'

/** Public tracking page for a shopper; `?shipmentNo=` is the param the page itself reads. */
export function shreeMarutiTrackingUrl(awb: string): string {
  return `https://tracking.shreemaruti.com/?shipmentNo=${encodeURIComponent(awb)}`
}

/**
 * Whether an operator-typed courier name means Shree Maruti. Free text from the
 * dispatch form, so it is normalised: "Shree Maruti", "SHREE MARUTI COURIER",
 * "shree-maruti" all qualify.
 */
export function isShreeMarutiCourierName(name: string): boolean {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .startsWith('shreemaruti')
}

/** What the parcel must match for its scans to be believed. */
export interface TrackExpectation {
  /** The order's delivery pincode. */
  destinationPincode?: string | undefined
}

/** The one capability the reconcile sweep needs from a carrier. */
export interface CarrierTracker {
  track(waybill: string, expect?: TrackExpectation): Promise<TrackingResult>
}

export class ShreeMarutiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message)
    this.name = 'ShreeMarutiError'
  }
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Body → scans. Throws when the body is not a tracking response at all — see
 * the module note on why that must not read as "no scans yet".
 *
 * Also throws when the parcel is not going where the order is. The endpoint
 * answers for ANY waybill, including ones that are not ours: a mistyped AWB
 * (even `00000000000000`) returns a stranger's real parcel, complete with a
 * `DELIVERED` scan. Believing it would mark our order delivered and message
 * the shopper. So the destination pincode is the identity check, and a body
 * without one (`orderInformation: null`) cannot pass it.
 */
export function readShreeMarutiTrackingBody(
  body: unknown,
  expect: TrackExpectation = {}
): TrackingResult {
  const root = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (root === null || !Array.isArray(root.statuses)) {
    throw new ShreeMarutiError('Shree Maruti tracking response had no statuses', 200, body)
  }

  if (expect.destinationPincode !== undefined) {
    const info = root.orderInformation
    const destination =
      info !== null && typeof info === 'object'
        ? (info as Record<string, unknown>).destinationLocation
        : undefined
    const pincode =
      destination !== null && typeof destination === 'object'
        ? str((destination as Record<string, unknown>).pincode)
        : undefined
    if (pincode !== expect.destinationPincode.trim()) {
      throw new ShreeMarutiError(
        `Shree Maruti parcel is bound for pincode ${pincode ?? 'unknown'}, not the order's ${expect.destinationPincode} — wrong AWB?`,
        200,
        body
      )
    }
  }

  const out: CarrierScan[] = []
  for (const entry of root.statuses as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const ms = typeof row.statusTimestamp === 'number' ? row.statusTimestamp : Number.NaN
    const category = str(row.category)
    if (!Number.isFinite(ms) || category === undefined) continue
    out.push({
      statusType: SHREE_MARUTI_STATUS_TYPE,
      status: category,
      nslCode: str(row.status),
      scanLocation: str(row.location),
      instructions: str(row.subcategory),
      scannedAt: new Date(ms),
    })
  }
  out.sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime())
  return { scans: out, expectedDeliveryDate: null }
}

export interface ShreeMarutiTrackerOptions {
  fetchImpl?: FetchLike | undefined
  baseUrl?: string | undefined
  timeoutMs?: number | undefined
}

export function createShreeMarutiTracker(options: ShreeMarutiTrackerOptions = {}): CarrierTracker {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? 15_000
  const base = (options.baseUrl ?? SHREE_MARUTI_TRACKING_BASE_URL).replace(/\/+$/, '')

  return {
    async track(waybill, expect) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${base}/${encodeURIComponent(waybill)}`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            // The endpoint serves their tracking page; present as it does.
            Origin: 'https://tracking.shreemaruti.com',
            Referer: 'https://tracking.shreemaruti.com/',
          },
        })
        const text = await res.text()
        let body: unknown = text
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          // Keep the text so the failure says what came back.
        }
        if (!res.ok) {
          throw new ShreeMarutiError(
            `Shree Maruti tracking answered ${res.status}`,
            res.status,
            body
          )
        }
        return readShreeMarutiTrackingBody(body, expect)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
