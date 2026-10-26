/**
 * Contract unit tests: payments contracts parse/reject samples — pins the
 * shapes documented in `src/contracts/payment.ts` (SPEC-PAYMENTS.md v3:
 * `addressId` in the create body, `mode` in the order response).
 */

import { describe, expect, it } from 'vitest'

import {
  PaymentOrderCreateSchema,
  PaymentOrderSchema,
  PaymentStatusSchema,
  PaymentVerifySchema,
} from '../../src/contracts/payment.js'

describe('PaymentOrderCreateSchema', () => {
  it('accepts a body with just addressId (uuid) — consent lives on the user row now', () => {
    expect(
      PaymentOrderCreateSchema.safeParse({
        addressId: '4b4bb28e-1b1f-4f5e-9a8e-2b6d1a2c3d4e',
      }).success
    ).toBe(true)
  })

  it('rejects a missing addressId (physical goods need a shipping address)', () => {
    expect(PaymentOrderCreateSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a non-uuid addressId', () => {
    expect(PaymentOrderCreateSchema.safeParse({ addressId: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects any extra field (amount is server-computed, never client-sent)', () => {
    expect(
      PaymentOrderCreateSchema.safeParse({
        addressId: '4b4bb28e-1b1f-4f5e-9a8e-2b6d1a2c3d4e',
        amountInr: 100,
      }).success
    ).toBe(false)
  })
})

describe('PaymentOrderSchema', () => {
  const sample = {
    orderId: 'order_ABC123',
    keyId: 'rzp_test_abc123',
    amountInr: 499,
    amountPaise: 49900,
    currency: 'INR',
    status: 'pending',
    mode: 'test',
    // The gateway pair above is the TOKEN on a COD order; these three are the
    // order as the shopper sees it. Required on both modes, so a client cannot
    // render an amount without knowing which of the two it has.
    paymentMode: 'prepaid',
    orderTotalInr: 499,
    codAmountInr: 0,
  }

  it('parses a valid sample', () => {
    expect(PaymentOrderSchema.safeParse(sample).success).toBe(true)
  })

  it.each(['test', 'live'])('accepts mode %s', (mode) => {
    expect(PaymentOrderSchema.safeParse({ ...sample, mode }).success).toBe(true)
  })

  it('rejects a missing mode (clients need it for the TEST-MODE banner)', () => {
    const rest = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'mode'))
    expect(PaymentOrderSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an unknown mode', () => {
    expect(PaymentOrderSchema.safeParse({ ...sample, mode: 'sandbox' }).success).toBe(false)
  })

  it('rejects a currency other than INR', () => {
    expect(PaymentOrderSchema.safeParse({ ...sample, currency: 'USD' }).success).toBe(false)
  })

  it('rejects an invalid status', () => {
    expect(PaymentOrderSchema.safeParse({ ...sample, status: 'cancelled' }).success).toBe(false)
  })

  it('rejects non-integer amounts', () => {
    expect(PaymentOrderSchema.safeParse({ ...sample, amountPaise: 499.5 }).success).toBe(false)
  })
})

describe('PaymentVerifySchema', () => {
  const sample = {
    razorpayOrderId: 'order_ABC123',
    razorpayPaymentId: 'pay_XYZ789',
    razorpaySignature: 'deadbeef',
  }

  it('parses a valid sample', () => {
    expect(PaymentVerifySchema.safeParse(sample).success).toBe(true)
  })

  it.each(['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'] as const)(
    'rejects a missing %s',
    (field) => {
      const rest = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== field))
      expect(PaymentVerifySchema.safeParse(rest).success).toBe(false)
    }
  )

  it.each(['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'])(
    'rejects an empty %s',
    (field) => {
      expect(PaymentVerifySchema.safeParse({ ...sample, [field]: '' }).success).toBe(false)
    }
  )

  it('rejects unknown fields (strict)', () => {
    expect(PaymentVerifySchema.safeParse({ ...sample, extra: true }).success).toBe(false)
  })
})

describe('PaymentStatusSchema', () => {
  it.each(['pending', 'paid', 'failed', 'refunded'])('accepts %s', (status) =>
    expect(PaymentStatusSchema.safeParse(status).success).toBe(true)
  )

  it('rejects an unknown status', () => {
    expect(PaymentStatusSchema.safeParse('cancelled').success).toBe(false)
  })
})

/**
 * "How did you hear about us?" — the checkout survey.
 *
 * The shape these tests pin is deliberately narrower than `attribution`'s: the
 * UTMs are opaque strings we echo back, this is a closed set that has to be
 * countable in a roll-up, so an unknown value is rejected rather than stored.
 */
describe('PaymentOrderCreateSchema — heardAbout', () => {
  const addressId = '4b4bb28e-1b1f-4f5e-9a8e-2b6d1a2c3d4e'

  it.each([
    'google_search',
    'instagram',
    'facebook',
    'youtube',
    'whatsapp',
    'amazon',
    'friend_family',
    'other',
  ])('accepts %s', (heardAbout) => {
    const body = {
      addressId,
      heardAbout,
      ...(heardAbout === 'other' ? { heardAboutOther: 'Saw it at a chemist' } : {}),
    }
    expect(PaymentOrderCreateSchema.safeParse(body).success).toBe(true)
  })

  it('is optional — the question is skippable at checkout by design', () => {
    expect(PaymentOrderCreateSchema.safeParse({ addressId }).success).toBe(true)
  })

  it('rejects a value outside the pick-list', () => {
    expect(PaymentOrderCreateSchema.safeParse({ addressId, heardAbout: 'tiktok' }).success).toBe(
      false
    )
  })

  it("rejects free text without heardAbout: 'other' — the DB says the same thing", () => {
    expect(
      PaymentOrderCreateSchema.safeParse({
        addressId,
        heardAbout: 'instagram',
        heardAboutOther: 'a reel',
      }).success
    ).toBe(false)
  })

  it('rejects free text with no choice at all', () => {
    expect(
      PaymentOrderCreateSchema.safeParse({ addressId, heardAboutOther: 'a reel' }).success
    ).toBe(false)
  })

  it('rejects empty and over-long free text', () => {
    expect(
      PaymentOrderCreateSchema.safeParse({ addressId, heardAbout: 'other', heardAboutOther: '' })
        .success
    ).toBe(false)
    expect(
      PaymentOrderCreateSchema.safeParse({
        addressId,
        heardAbout: 'other',
        heardAboutOther: 'x'.repeat(201),
      }).success
    ).toBe(false)
  })
})
