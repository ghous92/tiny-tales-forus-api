/**
 * `canonicalJson` is what config ETag stability rests on — key order must
 * never affect the output.
 */

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../../src/lib/canonical-json.js'

describe('canonicalJson', () => {
  it('sorts top-level keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested object keys recursively', () => {
    const nested1 = { outer: { z: 1, a: 2 } }
    const nested2 = { outer: { a: 2, z: 1 } }
    expect(canonicalJson(nested1)).toBe(canonicalJson(nested2))
  })

  it('preserves array order (arrays are not sorted)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('sorts object keys inside array elements', () => {
    const value = [{ b: 1, a: 2 }]
    expect(canonicalJson(value)).toBe('[{"a":2,"b":1}]')
  })

  it('passes primitives through unchanged', () => {
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(null)).toBe('null')
  })
})
