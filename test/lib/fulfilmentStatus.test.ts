/**
 * The carrier status mapping (docs/SPEC-LOGISTICS.md §4.2, DoD 2 and 3).
 *
 * These are the tests that decide whether a customer is told the truth about
 * where their parcel is, so they are written against Delhivery's documented
 * vocabulary rather than against the implementation.
 */

import { describe, expect, it } from 'vitest'

import {
  FULFILMENT_STATUSES,
  isNdrAct,
  isPickupFailureCode,
  isTerminal,
  labelFor,
  mapScan,
  milestoneFor,
  NDR_STATUS_CODES,
  rankOf,
  type CarrierScan,
} from '../../src/lib/fulfilmentStatus.js'

function scan(over: Partial<CarrierScan> = {}): CarrierScan {
  return {
    statusType: 'UD',
    status: 'Manifested',
    scannedAt: new Date('2026-08-01T10:00:00.000Z'),
    ...over,
  }
}

describe('mapScan — the documented forward flow', () => {
  it.each([
    ['UD', 'Manifested', 'manifested'],
    ['UD', 'Not Picked', 'manifested'],
    ['UD', 'In Transit', 'in_transit'],
    ['UD', 'Pending', 'in_transit'],
    ['UD', 'Dispatched', 'out_for_delivery'],
    ['DL', 'Delivered', 'delivered'],
  ] as const)('%s / %s → %s', (statusType, status, expected) => {
    const result = mapScan(scan({ statusType, status }))
    expect(result.status).toBe(expected)
    expect(result.unmapped).toBe(false)
  })

  it('maps the whole return leg to the RTO states', () => {
    expect(mapScan(scan({ statusType: 'RT', status: 'In Transit' })).status).toBe('rto_in_transit')
    expect(mapScan(scan({ statusType: 'RT', status: 'Pending' })).status).toBe('rto_in_transit')
    expect(mapScan(scan({ statusType: 'RT', status: 'Dispatched' })).status).toBe('rto_in_transit')
    expect(mapScan(scan({ statusType: 'DL', status: 'RTO' })).status).toBe('rto_delivered')
  })

  it('treats a cancelled PREPAID order arriving as "Returned" as cancelled', () => {
    // The documented trap: Delhivery's cancel API lands prepaid/COD shipments on
    // "Returned", not "Cancelled". Reading that as an RTO would tell a shopper
    // their parcel bounced when in fact they cancelled it.
    expect(mapScan(scan({ statusType: 'UD', status: 'Returned' })).status).toBe('cancelled')
  })

  it('survives their soft hyphen in "In­ Transit"', () => {
    // Delhivery's own sample payload ships a soft hyphen inside the word.
    expect(mapScan(scan({ statusType: 'UD', status: 'In­ Transit' })).status).toBe('in_transit')
  })

  it('is case- and punctuation-insensitive', () => {
    expect(mapScan(scan({ statusType: 'ud', status: 'in transit' })).status).toBe('in_transit')
    expect(mapScan(scan({ statusType: 'Ud', status: 'IN-TRANSIT' })).status).toBe('in_transit')
  })
})

describe('mapScan — never guess (DoD 2)', () => {
  it('maps an unknown pair to exception and flags it, rather than picking a neighbour', () => {
    const result = mapScan(scan({ statusType: 'ZZ', status: 'Teleported' }))
    expect(result.status).toBe('exception')
    expect(result.unmapped).toBe(true)
  })

  it('does not silently absorb an unknown status into in_transit', () => {
    // The specific failure this guards: a lost parcel reading as healthy.
    const result = mapScan(scan({ statusType: 'UD', status: 'Something New' }))
    expect(result.status).not.toBe('in_transit')
    expect(result.status).toBe('exception')
  })

  it('reports an empty scan as unmapped rather than defaulting', () => {
    expect(mapScan(scan({ statusType: '', status: '' })).unmapped).toBe(true)
  })
})

describe('mapScan — NDR overrides the base table (DoD 3)', () => {
  it.each([...NDR_STATUS_CODES])('%s on a Pending scan reads as ndr, not in_transit', (code) => {
    const result = mapScan(scan({ statusType: 'UD', status: 'Pending', statusCode: code }))
    expect(result.status).toBe('ndr')
    expect(result.isNdr).toBe(true)
  })

  it('overrides Dispatched too — a failed attempt is not "out for delivery"', () => {
    const result = mapScan(scan({ statusType: 'UD', status: 'Dispatched', statusCode: 'EOD-74' }))
    expect(result.status).toBe('ndr')
  })

  it('does NOT override a delivered scan', () => {
    // A parcel that once carried an NDR code and then got delivered is
    // delivered. Letting the code win here would un-deliver it.
    const result = mapScan(
      scan({ statusType: 'DL', status: 'Delivered', statusCode: 'EOD-74' })
    )
    expect(result.status).toBe('delivered')
    expect(result.isNdr).toBe(false)
  })

  it('ignores a status code that is not in the actionable set', () => {
    const result = mapScan(scan({ statusType: 'UD', status: 'Pending', statusCode: 'EOD-999' }))
    expect(result.status).toBe('in_transit')
    expect(result.isNdr).toBe(false)
  })

  it('overrides a first-mile pickup failure too — FMEOD-* is not a plain manifested scan', () => {
    // Confirmed live from a real Delhivery poll payload: a failed pickup
    // attempt arrives as a Manifested/UD scan carrying FMEOD-103.
    const result = mapScan(
      scan({ statusType: 'UD', status: 'Manifested', statusCode: 'FMEOD-103' })
    )
    expect(result.status).toBe('ndr')
    expect(result.isNdr).toBe(true)
  })

  it('overrides FMPUR-* the same way', () => {
    const result = mapScan(scan({ statusType: 'UD', status: 'Open', statusCode: 'FMPUR-1' }))
    expect(result.status).toBe('ndr')
    expect(result.isNdr).toBe(true)
  })

  it('isPickupFailureCode matches only the FMPUR-/FMEOD- families', () => {
    expect(isPickupFailureCode('FMEOD-103')).toBe(true)
    expect(isPickupFailureCode('FMPUR-1')).toBe(true)
    expect(isPickupFailureCode('EOD-74')).toBe(false)
    expect(isPickupFailureCode('')).toBe(false)
  })

  it('is not fooled by casing or padding on the code', () => {
    expect(mapScan(scan({ statusType: 'UD', status: 'Pending', statusCode: ' eod-74 ' })).status).toBe(
      'ndr'
    )
  })
})

describe('rank, terminality and milestones', () => {
  it('ranks the happy path monotonically', () => {
    expect(rankOf('manifested')).toBeLessThan(rankOf('in_transit'))
    expect(rankOf('in_transit')).toBeLessThan(rankOf('out_for_delivery'))
    expect(rankOf('out_for_delivery')).toBeLessThan(rankOf('delivered'))
  })

  it('treats delivered, rto_delivered and cancelled as terminal', () => {
    expect(isTerminal('delivered')).toBe(true)
    expect(isTerminal('rto_delivered')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
  })

  it('does NOT treat exception as terminal', () => {
    // `exception` means "we do not know". Giving up on it is how a lost parcel
    // stops being chased.
    expect(isTerminal('exception')).toBe(false)
  })

  it('establishes pickup from an in_transit scan', () => {
    // Delhivery emits no distinct "picked up" status; movement is the evidence.
    expect(milestoneFor('in_transit')).toBe('pickedUpAt')
    expect(milestoneFor('delivered')).toBe('deliveredAt')
    expect(milestoneFor('pending_manifest')).toBeNull()
  })

  it('gives every status a rank and a shopper-facing label', () => {
    for (const status of FULFILMENT_STATUSES) {
      expect(typeof rankOf(status)).toBe('number')
      expect(labelFor(status).length).toBeGreaterThan(0)
    }
  })

  it('does not describe an unmapped status as lost to the shopper', () => {
    // The customer-facing half of "never guess": we do not alarm someone over a
    // code we simply have not mapped yet.
    expect(labelFor('exception').toLowerCase()).not.toContain('lost')
  })
})

describe('NDR act validation', () => {
  it('accepts exactly the three documented verbs', () => {
    expect(isNdrAct('DEFER_DLV')).toBe(true)
    expect(isNdrAct('EDIT_DETAILS')).toBe(true)
    expect(isNdrAct('RE-ATTEMPT')).toBe(true)
    expect(isNdrAct('REATTEMPT')).toBe(false)
    expect(isNdrAct('anything')).toBe(false)
  })
})
