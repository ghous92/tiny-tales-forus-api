/**
 * Unit tests for the Razorpay client seam (src/lib/razorpay.ts): `mode`
 * derivation from the key prefix, graceful-degrade when any secret is absent,
 * and the LAZY SDK init — proved by `vi.mock('razorpay')` so no real SDK/
 * network is touched (SPEC-PAYMENTS.md: mock the Razorpay SDK with vi.mock).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPaymentsGateway, modeFromKeyId } from '../../src/lib/razorpay.js'

const RazorpayCtor = vi.fn()

// The lazy client does `import('razorpay')` and uses the default export.
vi.mock('razorpay', () => ({
  default: class {
    constructor(config: unknown) {
      RazorpayCtor(config)
    }
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('modeFromKeyId', () => {
  it('maps rzp_test_ → test and rzp_live_ → live', () => {
    expect(modeFromKeyId('rzp_test_abc')).toBe('test')
    expect(modeFromKeyId('rzp_live_abc')).toBe('live')
  })

  it('defaults to test for anything that is not a live key (never assume live)', () => {
    expect(modeFromKeyId('weird')).toBe('test')
    expect(modeFromKeyId('')).toBe('test')
  })
})

describe('createPaymentsGateway', () => {
  it('returns undefined when any secret is missing', () => {
    expect(createPaymentsGateway({})).toBeUndefined()
    expect(createPaymentsGateway({ keyId: 'rzp_test_x' })).toBeUndefined()
    expect(
      createPaymentsGateway({ keyId: 'rzp_test_x', keySecret: 's' })
    ).toBeUndefined()
  })

  it('builds a gateway with a derived mode and does NOT construct the SDK eagerly', () => {
    const gw = createPaymentsGateway({
      keyId: 'rzp_live_x',
      keySecret: 's',
      webhookSecret: 'w',
    })
    expect(gw).toBeDefined()
    expect(gw?.config.mode).toBe('live')
    expect(gw?.config.keyId).toBe('rzp_live_x')
    // Lazy: nothing constructed until client() is called.
    expect(RazorpayCtor).not.toHaveBeenCalled()
  })

  it('lazily constructs the SDK once, on first client() call', async () => {
    const gw = createPaymentsGateway({
      keyId: 'rzp_test_x',
      keySecret: 's',
      webhookSecret: 'w',
    })
    const first = await gw!.client()
    const second = await gw!.client()
    expect(RazorpayCtor).toHaveBeenCalledTimes(1)
    expect(RazorpayCtor).toHaveBeenCalledWith({ key_id: 'rzp_test_x', key_secret: 's' })
    // Memoized — same instance.
    expect(first).toBe(second)
  })
})
