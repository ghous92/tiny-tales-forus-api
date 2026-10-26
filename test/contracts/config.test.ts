/**
 * Contract unit tests: config key regex accept/reject and the 16 KB value
 * cap (SPEC-V2.md §7 bullet 4).
 */

import { describe, expect, it } from 'vitest'

import {
  CONFIG_KEY,
  ConfigKeyParamsSchema,
  ConfigUpsertSchema,
  MAX_VALUE_BYTES,
} from '../../src/contracts/config.js'

describe('CONFIG_KEY regex', () => {
  it.each(['checkout.mode', 'a', 'pdp.deliveryPromise', 'app.minSupportedVersion', 'a1.b2.c3'])(
    'accepts valid key %s',
    (key) => expect(CONFIG_KEY.test(key)).toBe(true)
  )

  it.each([
    '', // empty
    'Checkout.mode', // leading uppercase segment
    '.checkout', // leading dot
    'checkout.', // trailing dot
    'checkout..mode', // double dot
    'checkout mode', // space
    'checkout-mode', // hyphen
    '1checkout', // leading digit
    'checkout.1mode', // segment leading digit
  ])('rejects invalid key %s', (key) => expect(CONFIG_KEY.test(key)).toBe(false))
})

describe('ConfigUpsertSchema', () => {
  it('parses a valid body with a string value', () => {
    const parsed = ConfigUpsertSchema.parse({ value: 'whatsapp' })
    expect(parsed.value).toBe('whatsapp')
    expect(parsed.description).toBeUndefined()
  })

  it('accepts any JSON value type (object, array, number, boolean, null)', () => {
    expect(ConfigUpsertSchema.safeParse({ value: { a: 1 } }).success).toBe(true)
    expect(ConfigUpsertSchema.safeParse({ value: [1, 2, 3] }).success).toBe(true)
    expect(ConfigUpsertSchema.safeParse({ value: 42 }).success).toBe(true)
    expect(ConfigUpsertSchema.safeParse({ value: true }).success).toBe(true)
    expect(ConfigUpsertSchema.safeParse({ value: null }).success).toBe(true)
  })

  it('accepts an optional description', () => {
    const parsed = ConfigUpsertSchema.parse({ value: 1, description: 'a note' })
    expect(parsed.description).toBe('a note')
  })

  it('rejects unknown fields (strict)', () => {
    expect(ConfigUpsertSchema.safeParse({ value: 1, extra: true }).success).toBe(false)
  })

  it('rejects a value whose JSON serialization exceeds 16 KB', () => {
    const big = 'x'.repeat(MAX_VALUE_BYTES + 1)
    expect(ConfigUpsertSchema.safeParse({ value: big }).success).toBe(false)
  })

  it('accepts a value right at the 16 KB boundary', () => {
    // JSON.stringify wraps a string in quotes (+2 bytes), so pad to exactly hit the cap.
    const atCap = 'x'.repeat(MAX_VALUE_BYTES - 2)
    expect(Buffer.byteLength(JSON.stringify(atCap))).toBe(MAX_VALUE_BYTES)
    expect(ConfigUpsertSchema.safeParse({ value: atCap }).success).toBe(true)
  })
})

describe('ConfigKeyParamsSchema', () => {
  it('accepts a valid key and rejects an invalid one', () => {
    expect(ConfigKeyParamsSchema.safeParse({ key: 'checkout.mode' }).success).toBe(true)
    expect(ConfigKeyParamsSchema.safeParse({ key: 'Checkout.Mode' }).success).toBe(false)
  })

  it('rejects a key over 100 characters', () => {
    const longKey = 'a'.repeat(101)
    expect(ConfigKeyParamsSchema.safeParse({ key: longKey }).success).toBe(false)
  })
})
