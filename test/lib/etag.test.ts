/**
 * Unit tests for `If-None-Match` matching. Pure string work (no DB), and the
 * guard on the regression that killed 304s in production: Cloudflare rewrites
 * the origin's strong `"7"` to the weak `W/"7"` whenever it compresses, and the
 * old helper compared that literally and never matched.
 */

import { describe, expect, it } from 'vitest'

import { ifNoneMatchSatisfied } from '../../src/lib/etag.js'

describe('ifNoneMatchSatisfied', () => {
  it('matches the strong quoted form the origin emits', () => {
    expect(ifNoneMatchSatisfied('"7"', '7')).toBe(true)
  })

  it('matches the WEAK form Cloudflare rewrites to when it compresses', () => {
    // The production regression: this returned false and every client
    // re-downloaded the full snapshot on every request.
    expect(ifNoneMatchSatisfied('W/"7"', '7')).toBe(true)
    expect(ifNoneMatchSatisfied('w/"7"', '7')).toBe(true)
  })

  it('matches a bare unquoted value', () => {
    expect(ifNoneMatchSatisfied('7', '7')).toBe(true)
  })

  it('matches when any entry of a comma-separated list matches', () => {
    expect(ifNoneMatchSatisfied('W/"5", W/"6", W/"7"', '7')).toBe(true)
    expect(ifNoneMatchSatisfied('"7","8"', '7')).toBe(true)
  })

  it('matches the wildcard, which means "any current representation"', () => {
    expect(ifNoneMatchSatisfied('*', '7')).toBe(true)
    expect(ifNoneMatchSatisfied('*', '0')).toBe(true)
  })

  it('joins a repeated header handed back as an array', () => {
    expect(ifNoneMatchSatisfied(['W/"6"', 'W/"7"'], '7')).toBe(true)
  })

  it('does not match a stale version', () => {
    expect(ifNoneMatchSatisfied('"6"', '7')).toBe(false)
    expect(ifNoneMatchSatisfied('W/"6"', '7')).toBe(false)
    expect(ifNoneMatchSatisfied('W/"5", W/"6"', '7')).toBe(false)
  })

  it('does not match on a missing or empty validator', () => {
    expect(ifNoneMatchSatisfied(undefined, '7')).toBe(false)
    expect(ifNoneMatchSatisfied('', '7')).toBe(false)
    expect(ifNoneMatchSatisfied('  ', '7')).toBe(false)
    expect(ifNoneMatchSatisfied(',,', '7')).toBe(false)
  })

  it('does not match a version that is merely a prefix or substring', () => {
    // "1" must not satisfy a request holding "17" (or vice versa) — a plain
    // `includes()` implementation would get this wrong.
    expect(ifNoneMatchSatisfied('"17"', '1')).toBe(false)
    expect(ifNoneMatchSatisfied('"1"', '17')).toBe(false)
  })

  it('does not treat the W/ prefix as part of the value', () => {
    expect(ifNoneMatchSatisfied('"W/7"', '7')).toBe(false)
  })
})
