/**
 * The Delhivery adapter's parsing and encoding (docs/SPEC-LOGISTICS.md §6).
 *
 * Every case here is a documented trap from their API rather than a synthetic
 * edge: 200-with-an-error-body, the mandatory form encoding, the banned
 * characters, and the timezone-less timestamps that would otherwise shift every
 * scan by five and a half hours.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createDelhiveryAdapter,
  modeFromBaseUrl,
  parseCarrierDate,
  readManifestBody,
  readTrackingBody,
  readWebhookScan,
  sanitizeText,
  type CarrierConfig,
} from '../../src/lib/delhivery.js'

const CONFIG: CarrierConfig = {
  baseUrl: 'https://staging-express.delhivery.com',
  apiToken: 'test-token',
  clientName: 'TINYTALES',
  mode: 'staging',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('modeFromBaseUrl', () => {
  it('recognises staging', () => {
    expect(modeFromBaseUrl('https://staging-express.delhivery.com')).toBe('staging')
  })

  it('treats anything else as LIVE — never assume staging', () => {
    // Getting this backwards would let a misconfigured deploy create real
    // shipments while believing it was in UAT.
    expect(modeFromBaseUrl('https://track.delhivery.com')).toBe('live')
    expect(modeFromBaseUrl('https://typo.example.com')).toBe('live')
  })
})

describe('parseCarrierDate', () => {
  it('pins a zone-less timestamp to IST, not UTC', () => {
    // Their sample: "2019-01-09T17:10:42.767" with no zone. Read as UTC it
    // lands 5h30m early and corrupts the scan ordering the whole status model
    // depends on.
    const parsed = parseCarrierDate('2019-01-09T17:10:42.767')
    expect(parsed?.toISOString()).toBe('2019-01-09T11:40:42.767Z')
  })

  it('respects an explicit zone when one is present', () => {
    expect(parseCarrierDate('2019-01-09T17:10:42.767Z')?.toISOString()).toBe(
      '2019-01-09T17:10:42.767Z'
    )
  })

  it('returns null rather than an Invalid Date', () => {
    expect(parseCarrierDate('not a date')).toBeNull()
    expect(parseCarrierDate('')).toBeNull()
    expect(parseCarrierDate(undefined)).toBeNull()
  })
})

describe('sanitizeText', () => {
  it('strips the characters their parser rejects', () => {
    expect(sanitizeText('A & B #4 50% ; back\\slash')).toBe('A B 4 50 back slash')
  })

  it('collapses the whitespace it leaves behind', () => {
    expect(sanitizeText('  Flat 2 &&& Block C  ')).toBe('Flat 2 Block C')
  })
})

describe('readManifestBody — 200 does not mean success', () => {
  it('reads a waybill out of a successful response', () => {
    const result = readManifestBody({
      success: true,
      packages: [{ waybill: '1234567890', status: 'Success' }],
    })
    expect(result.ok).toBe(true)
    expect(result.awb).toBe('1234567890')
  })

  it('fails on success:false even with HTTP 200', () => {
    const result = readManifestBody({
      success: false,
      packages: [{ remarks: ['ClientWarehouse matching query does not exist'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.remark).toContain('ClientWarehouse')
  })

  it('fails when no waybill came back, whatever else the body says', () => {
    // No waybill means nothing shipped. This is the case that would otherwise
    // mark an order as manifested with a null AWB.
    expect(readManifestBody({ success: true, packages: [{ status: 'Success' }] }).ok).toBe(false)
    expect(readManifestBody({}).ok).toBe(false)
  })

  it('fails on a per-package Fail status', () => {
    const result = readManifestBody({
      packages: [{ waybill: '999', status: 'Fail', remarks: ['pincode not serviceable'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.remark).toBe('pincode not serviceable')
  })

  it('keeps the raw body for forensics', () => {
    const body = { success: false, weird: true }
    expect(readManifestBody(body).raw).toBe(body)
  })
})

describe('readWebhookScan', () => {
  it('reads their documented sample payload', () => {
    const parsed = readWebhookScan({
      Shipment: {
        Status: {
          Status: 'Manifested',
          StatusDateTime: '2019-01-09T17:10:42.767',
          StatusType: 'UD',
          StatusLocation: 'Chandigarh_Raiprkln_C (Chandigarh)',
          Instructions: 'Manifest uploaded',
        },
        PickUpDate: '2019-01-09T17:10:42.543',
        NSLCode: 'X-UCI',
        Sortcode: 'IXC/MDP',
        ReferenceNo: '28',
        AWB: '1234567890',
      },
    })
    expect(parsed?.awb).toBe('1234567890')
    expect(parsed?.referenceNo).toBe('28')
    expect(parsed?.scan.statusType).toBe('UD')
    expect(parsed?.scan.nslCode).toBe('X-UCI')
    expect(parsed?.scan.scannedAt.toISOString()).toBe('2019-01-09T11:40:42.767Z')
  })

  it('returns null — never throws — on a body it cannot read', () => {
    // The caller owes Delhivery a decision, not an exception.
    expect(readWebhookScan({})).toBeNull()
    expect(readWebhookScan(null)).toBeNull()
    expect(readWebhookScan({ Shipment: { Status: {} } })).toBeNull()
    expect(readWebhookScan({ Shipment: { AWB: '123' } })).toBeNull()
  })
})

describe('readTrackingBody', () => {
  it('flattens nested scans and sorts them oldest first', () => {
    const { scans } = readTrackingBody({
      ShipmentData: [
        {
          Shipment: {
            Scans: [
              {
                ScanDetail: {
                  Scan: 'Dispatched',
                  StatusType: 'UD',
                  StatusDateTime: '2026-08-03T09:00:00',
                  ScannedLocation: 'Surat',
                  StatusCode: 'EOD-74',
                },
              },
              {
                ScanDetail: {
                  Scan: 'Manifested',
                  StatusType: 'UD',
                  StatusDateTime: '2026-08-01T09:00:00',
                },
              },
            ],
          },
        },
      ],
    })
    expect(scans.map((s) => s.status)).toEqual(['Manifested', 'Dispatched'])
    expect(scans[1]?.statusCode).toBe('EOD-74')
    expect(scans[1]?.scanLocation).toBe('Surat')
  })

  it('reads statusType from ScanType when StatusType is absent — the real tracking-pull shape', () => {
    // Confirmed against a live prod poll payload: ScanDetail carries its type
    // as `ScanType`, not `StatusType` (that key only lives on the sibling
    // `Shipment.Status` block). Falling back on it is what fixes a poll scan
    // that used to map to `exception` for want of a status type.
    const { scans } = readTrackingBody({
      ShipmentData: [
        {
          Shipment: {
            Scans: [
              {
                ScanDetail: {
                  Scan: 'Manifested',
                  ScanType: 'UD',
                  StatusDateTime: '2026-08-01T09:00:00',
                },
              },
            ],
          },
        },
      ],
    })
    expect(scans[0]?.statusType).toBe('UD')
  })

  it('drops scans with no usable timestamp instead of inventing one', () => {
    const { scans } = readTrackingBody({
      ShipmentData: [{ Shipment: { Scans: [{ ScanDetail: { Scan: 'Manifested' } }] } }],
    })
    expect(scans).toEqual([])
  })

  it('returns an empty list for an empty or malformed body', () => {
    expect(readTrackingBody({})).toEqual({ scans: [], expectedDeliveryDate: null })
    expect(readTrackingBody(null)).toEqual({ scans: [], expectedDeliveryDate: null })
  })

  it('reads ExpectedDeliveryDate as IST wall-clock, and leaves it null when absent', () => {
    const withEdd = readTrackingBody({
      ShipmentData: [{ Shipment: { ExpectedDeliveryDate: '2026-08-20T18:00:00', Scans: [] } }],
    })
    expect(withEdd.expectedDeliveryDate?.toISOString()).toBe('2026-08-20T12:30:00.000Z')

    const withoutEdd = readTrackingBody({
      ShipmentData: [{ Shipment: { ExpectedDeliveryDate: null, Scans: [] } }],
    })
    expect(withoutEdd.expectedDeliveryDate).toBeNull()
  })
})

describe('manifest request encoding', () => {
  it('sends format=json&data= form encoding, not a JSON body', async () => {
    // Their single most common integration failure, and it is silent: a JSON
    // body is accepted at the HTTP level and rejected at the parser.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, packages: [{ waybill: 'AWB1', status: 'Success' }] })
    )
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })

    await adapter.manifest({
      referenceNo: 'order_1',
      pickupLocationName: 'TT-AHM',
      consigneeName: 'Asha Rao',
      consigneePhone: '9876543210',
      address: '12B Sunrise, MG Road',
      city: 'Surat',
      state: 'Gujarat',
      pincode: '395003',
      declaredValueInr: 299,
      weightG: 320,
      productDescription: 'Body Cream 100ml',
      quantity: 1,
      fragile: true,
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://staging-express.delhivery.com/api/cmu/create.json')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    )
    expect((init.headers as Record<string, string>).Authorization).toBe('Token test-token')

    const form = new URLSearchParams(init.body as string)
    expect(form.get('format')).toBe('json')
    const payload = JSON.parse(form.get('data') ?? '{}')
    expect(payload.pickup_location.name).toBe('TT-AHM')
    expect(payload.shipments[0].payment_mode).toBe('Prepaid')
    expect(payload.shipments[0].cod_amount).toBe('0')
    expect(payload.shipments[0].fragile_shipment).toBe(true)
  })

  it('manifests a COD parcel with the BALANCE, not the order total', async () => {
    // docs/SPEC-COD.md: the ₹49 token already cleared through Razorpay, so the
    // agent collects ₹651 of a ₹700 order. Sending the total here would
    // double-charge the shopper on their own doorstep.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, packages: [{ waybill: 'AWB3', status: 'Success' }] })
    )
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    await adapter.manifest({
      referenceNo: 'order_cod',
      pickupLocationName: 'TT-AHM',
      consigneeName: 'Asha Rao',
      consigneePhone: '9876543210',
      address: '12B Sunrise, MG Road',
      city: 'Surat',
      state: 'Gujarat',
      pincode: '395003',
      declaredValueInr: 700,
      weightG: 320,
      productDescription: 'Bhringraj Hair Oil 500ml',
      quantity: 1,
      codAmountInr: 651,
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(new URLSearchParams(init.body as string).get('data') ?? '{}')
    expect(payload.shipments[0].payment_mode).toBe('COD')
    expect(payload.shipments[0].cod_amount).toBe('651')
    // The DECLARED value is the goods value on both modes — it drives risk
    // cover and the e-waybill threshold, not what the agent collects.
    expect(payload.shipments[0].total_amount).toBe('700')
  })

  it('stays Prepaid when there is nothing to collect', async () => {
    // One source of truth: the amount decides the mode, so a shipment can never
    // be COD with nothing to collect, or Prepaid while the agent takes cash.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, packages: [{ waybill: 'AWB4', status: 'Success' }] })
    )
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    await adapter.manifest({
      referenceNo: 'order_zero',
      pickupLocationName: 'W',
      consigneeName: 'A',
      consigneePhone: '9000000000',
      address: 'x',
      city: 'c',
      state: 's',
      pincode: '395003',
      declaredValueInr: 10,
      weightG: 100,
      productDescription: 'p',
      quantity: 1,
      codAmountInr: 0,
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(new URLSearchParams(init.body as string).get('data') ?? '{}')
    expect(payload.shipments[0].payment_mode).toBe('Prepaid')
    expect(payload.shipments[0].cod_amount).toBe('0')
  })

  it('omits fragile_shipment entirely when the parcel is not fragile', async () => {
    // Their docs: "If any Shipment is not applicable then don't pass this key".
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, packages: [{ waybill: 'AWB2', status: 'Success' }] })
    )
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    await adapter.manifest({
      referenceNo: 'order_2',
      pickupLocationName: 'W',
      consigneeName: 'A',
      consigneePhone: '9000000000',
      address: 'x',
      city: 'c',
      state: 's',
      pincode: '395003',
      declaredValueInr: 10,
      weightG: 100,
      productDescription: 'p',
      quantity: 1,
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(new URLSearchParams(init.body as string).get('data') ?? '{}')
    expect('fragile_shipment' in payload.shipments[0]).toBe(false)
  })

  it('throws a CarrierError on a rejected token rather than reporting a normal failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: 'Invalid token' }, 401))
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    await expect(adapter.track('AWB1')).rejects.toThrow(/token/i)
  })
})

describe('cancel and serviceability', () => {
  it('sends cancellation as the string "true", which is what their API wants', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: true }))
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    const result = await adapter.cancel('AWB1')
    expect(result.ok).toBe(true)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ waybill: 'AWB1', cancellation: 'true' })
  })

  it('reads Y/N serviceability flags and treats anything else as not serviceable', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        delivery_codes: [
          { postal_code: { pin: 395003, pre_paid: 'Y', cod: 'N', district: 'Surat' } },
          { postal_code: { pin: 999999, pre_paid: '', cod: null } },
        ],
      })
    )
    const adapter = createDelhiveryAdapter(CONFIG, { fetchImpl })
    const rows = await adapter.serviceability()
    expect(rows[0]).toMatchObject({ pincode: '395003', prepaid: true, cod: false })
    // An over-optimistic read here ships a parcel into a black hole.
    expect(rows[1]).toMatchObject({ pincode: '999999', prepaid: false, cod: false })
  })
})

describe('readWebhookScan — identifier types', () => {
  it('accepts an AWB that arrives as a JSON number', () => {
    // Their payload is negotiable per client and AWBs are digit strings, so a
    // numeric one turns up. Rejecting it over a type would drop a real scan —
    // and the webhook contract accepts both, so the parser must too.
    const parsed = readWebhookScan({
      Shipment: {
        Status: { Status: 'Delivered', StatusType: 'DL', StatusDateTime: '2026-08-05T10:00:00' },
        AWB: 18000000001,
        ReferenceNo: 28,
      },
    })
    expect(parsed?.awb).toBe('18000000001')
    expect(parsed?.referenceNo).toBe('28')
  })
})
