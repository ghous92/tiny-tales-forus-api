/**
 * Contract unit tests: the Zod schemas ARE the API's validation, so these
 * pin the regexes (byte-identical to mobile's AddressForm), the strictness
 * (unknown keys rejected), bounds, and defaults.
 */

import { describe, expect, it } from 'vitest'

import {
  AddressCreateSchema,
  AddressParamsSchema,
  AddressUpdateSchema,
  INDIAN_MOBILE,
  PINCODE,
} from '../../src/contracts/address.js'
import { validAddress } from '../helpers/app.js'

describe('validation regexes (byte-identical to mobile AddressForm)', () => {
  it('matches the mobile source exactly', () => {
    expect(INDIAN_MOBILE.source).toBe('^[6-9]\\d{9}$')
    expect(PINCODE.source).toBe('^[1-9][0-9]{5}$')
  })

  it.each(['6000000000', '9876543210', '7123456789', '8999999999'])(
    'accepts valid mobile %s',
    (phone) => expect(INDIAN_MOBILE.test(phone)).toBe(true)
  )

  it.each(['5876543210', '987654321', '98765432100', '98765abc10', '', '+919876543210'])(
    'rejects invalid mobile %s',
    (phone) => expect(INDIAN_MOBILE.test(phone)).toBe(false)
  )

  it.each(['560001', '110001', '999999'])('accepts valid pincode %s', (pin) =>
    expect(PINCODE.test(pin)).toBe(true)
  )

  it.each(['060001', '56001', '5600011', '56000a', ''])('rejects invalid pincode %s', (pin) =>
    expect(PINCODE.test(pin)).toBe(false)
  )
})

describe('AddressCreateSchema', () => {
  it('parses a valid body', () => {
    const parsed = AddressCreateSchema.parse(validAddress())
    expect(parsed.name).toBe('Asha Rao')
    expect(parsed.isDefault).toBe(false)
  })

  it('defaults city/state to "" and isDefault to false when omitted', () => {
    const body = validAddress()
    delete body.city
    delete body.state
    delete body.isDefault
    const parsed = AddressCreateSchema.parse(body)
    expect(parsed.city).toBe('')
    expect(parsed.state).toBe('')
    expect(parsed.isDefault).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(AddressCreateSchema.safeParse(validAddress({ landmark: 'near park' })).success).toBe(
      false
    )
  })

  it.each([
    ['phone starting with 5', { phone: '5876543210' }],
    ['9-digit phone', { phone: '987654321' }],
    ['11-digit phone', { phone: '98765432101' }],
    ['pincode with leading zero', { pincode: '060001' }],
    ['5-digit pincode', { pincode: '56001' }],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['name over 100 chars', { name: 'x'.repeat(101) }],
    ['empty houseNumber', { houseNumber: '' }],
    ['houseNumber over 200 chars', { houseNumber: 'x'.repeat(201) }],
    ['empty roadArea', { roadArea: '' }],
    ['roadArea over 200 chars', { roadArea: 'x'.repeat(201) }],
    ['non-boolean isDefault', { isDefault: 'yes' }],
  ])('rejects %s', (_label, override) => {
    expect(AddressCreateSchema.safeParse(validAddress(override)).success).toBe(false)
  })

  it('rejects a body missing required fields', () => {
    expect(AddressCreateSchema.safeParse({ phone: '9876543210' }).success).toBe(false)
  })
})

describe('AddressUpdateSchema', () => {
  it('accepts any subset of fields', () => {
    expect(AddressUpdateSchema.safeParse({ city: 'Mysuru' }).success).toBe(true)
    expect(AddressUpdateSchema.safeParse({ isDefault: true }).success).toBe(true)
    expect(AddressUpdateSchema.safeParse({}).success).toBe(true)
  })

  it('applies the same per-field rules as create', () => {
    expect(AddressUpdateSchema.safeParse({ phone: '5876543210' }).success).toBe(false)
    expect(AddressUpdateSchema.safeParse({ pincode: '060001' }).success).toBe(false)
    expect(AddressUpdateSchema.safeParse({ name: '  ' }).success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(AddressUpdateSchema.safeParse({ useAsDefault: true }).success).toBe(false)
  })
})

describe('AddressParamsSchema', () => {
  it('accepts a uuid and rejects garbage', () => {
    expect(
      AddressParamsSchema.safeParse({ id: '4f9c2f6a-1c8e-4b8e-9f3a-2b1d5c7e8a90' }).success
    ).toBe(true)
    expect(AddressParamsSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })
})
