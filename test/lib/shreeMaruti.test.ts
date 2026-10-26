/**
 * The Shree Maruti tracking adapter's parsing and its identity check.
 *
 * The fixture is trimmed from a live payload (AWB 26086200759188, 2026-10-20).
 * The wrong-AWB cases matter most: their endpoint answers for any waybill,
 * including a stranger's delivered parcel, so a typo must fail loudly rather
 * than deliver our order.
 */

import { describe, expect, it, vi } from 'vitest'

import { mapScan } from '../../src/lib/fulfilmentStatus.js'
import {
  createShreeMarutiTracker,
  isShreeMarutiCourierName,
  readShreeMarutiTrackingBody,
  ShreeMarutiError,
  shreeMarutiTrackingUrl,
} from '../../src/lib/shreeMaruti.js'

const LIVE = {
  orderInformation: {
    trackingId: '26086200759188',
    destinationLocation: { city: 'GANDHIDHAM', state: 'GUJARAT', pincode: '370240' },
  },
  // Newest first, exactly as they send it.
  statuses: [
    {
      status: 'out_for_delivery',
      location: 'GANDHIDHAM-VARSANA CHOKDI',
      statusTimestamp: 1792475733000,
      category: 'OUT_FOR_DELIVERY',
      subcategory: 'Shipment is out for delivery',
    },
    {
      status: 'inscan_at_hub',
      location: 'KUTCH HUB',
      statusTimestamp: 1792465586000,
      category: 'IN_TRANSIT',
      subcategory: 'Shipment being processed at the InTransit Hub KUTCH HUB ',
    },
    {
      status: 'READY_FOR_DISPATCH',
      location: '',
      statusTimestamp: 1792417442000,
      category: 'READY_FOR_DISPATCH',
      subcategory: 'Order is ready to be dispatched',
    },
    {
      status: 'order_confirmed',
      location: 'AHMEDABAD',
      statusTimestamp: 1792407083000,
      category: 'ORDER_CONFIRMED',
      subcategory: 'Order Has been Confirmed',
    },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('readShreeMarutiTrackingBody', () => {
  it('returns scans oldest first, on the carrier clock', () => {
    const { scans, expectedDeliveryDate } = readShreeMarutiTrackingBody(LIVE)
    expect(scans.map((s) => s.status)).toEqual([
      'ORDER_CONFIRMED',
      'READY_FOR_DISPATCH',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
    ])
    expect(scans[3]?.scannedAt.toISOString()).toBe('2026-10-20T05:55:33.000Z')
    expect(scans[3]?.nslCode).toBe('out_for_delivery')
    expect(scans[2]?.instructions).toBe('Shipment being processed at the InTransit Hub KUTCH HUB')
    expect(scans[1]?.scanLocation).toBeUndefined()
    expect(expectedDeliveryDate).toBeNull()
  })

  it('maps every category seen live to a canonical status', () => {
    const { scans } = readShreeMarutiTrackingBody(LIVE)
    expect(scans.map((s) => mapScan(s).status)).toEqual([
      'manifested',
      'manifested',
      'in_transit',
      'out_for_delivery',
    ])
    expect(scans.every((s) => !mapScan(s).unmapped)).toBe(true)
  })

  it('maps DELIVERED to delivered', () => {
    const { scans } = readShreeMarutiTrackingBody({
      ...LIVE,
      statuses: [{ status: 'delivered', statusTimestamp: 1792490000000, category: 'DELIVERED' }],
    })
    expect(mapScan(scans[0]!).status).toBe('delivered')
  })

  it('sends a category nobody has seen to exception, not to a healthy neighbour', () => {
    const { scans } = readShreeMarutiTrackingBody({
      ...LIVE,
      statuses: [{ status: 'x', statusTimestamp: 1792490000000, category: 'UNDELIVERED' }],
    })
    expect(mapScan(scans[0]!)).toEqual({ status: 'exception', unmapped: true, isNdr: false })
  })

  it('skips rows with no timestamp or category instead of inventing one', () => {
    const { scans } = readShreeMarutiTrackingBody({
      ...LIVE,
      statuses: [{ category: 'IN_TRANSIT' }, { statusTimestamp: 1792490000000 }, null],
    })
    expect(scans).toEqual([])
  })

  it('throws on a body that is not a tracking response', () => {
    expect(() => readShreeMarutiTrackingBody('<html>')).toThrow(ShreeMarutiError)
    expect(() => readShreeMarutiTrackingBody({ message: 'oops' })).toThrow(ShreeMarutiError)
  })

  it("accepts the parcel when it is bound for the order's pincode", () => {
    const { scans } = readShreeMarutiTrackingBody(LIVE, { destinationPincode: '370240' })
    expect(scans).toHaveLength(4)
  })

  it('rejects a parcel bound somewhere else — a mistyped AWB', () => {
    expect(() => readShreeMarutiTrackingBody(LIVE, { destinationPincode: '380001' })).toThrow(
      /wrong AWB/
    )
  })

  it('rejects a parcel with no destination at all (orderInformation: null)', () => {
    // What `00000000000000` really returns: a stranger's DELIVERED scans, no order info.
    const junk = {
      orderInformation: null,
      statuses: [{ status: 'delivered', statusTimestamp: 1788948740000, category: 'DELIVERED' }],
    }
    expect(() => readShreeMarutiTrackingBody(junk, { destinationPincode: '370240' })).toThrow(
      ShreeMarutiError
    )
  })
})

describe('createShreeMarutiTracker', () => {
  it('GETs the waybill path and parses the body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LIVE))
    const tracker = createShreeMarutiTracker({ fetchImpl, baseUrl: 'https://example.test/v2/' })
    const { scans } = await tracker.track('26086200759188', { destinationPincode: '370240' })
    expect(scans).toHaveLength(4)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/v2/26086200759188')
    expect(init.method).toBe('GET')
  })

  it('treats a non-2xx answer as a failure to retry', async () => {
    const tracker = createShreeMarutiTracker({
      fetchImpl: async () => jsonResponse({ error: 'down' }, 502),
    })
    await expect(tracker.track('26086200759188')).rejects.toThrow(/502/)
  })
})

describe('isShreeMarutiCourierName', () => {
  it.each(['Shree Maruti', 'SHREE MARUTI COURIER', 'shree-maruti', ' Shree  Maruti Courier Pvt '])(
    'recognises %j',
    (name) => {
      expect(isShreeMarutiCourierName(name)).toBe(true)
    }
  )

  it.each(['DTDC', 'Maruti', 'Shree Anjani'])('does not claim %j', (name) => {
    expect(isShreeMarutiCourierName(name)).toBe(false)
  })
})

describe('shreeMarutiTrackingUrl', () => {
  it('deep-links their public page', () => {
    expect(shreeMarutiTrackingUrl('26086200759188')).toBe(
      'https://tracking.shreemaruti.com/?shipmentNo=26086200759188'
    )
  })
})
