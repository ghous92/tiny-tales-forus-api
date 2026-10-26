/**
 * Unit tests for the state → GST code lookup. Pure (no DB) — the guard on the
 * one thing that must never silently guess: an unrecognised state must throw,
 * not resolve to "intra-state" and undercharge tax.
 */

import { describe, expect, it } from 'vitest'

import { gstStateCodeFor, isIntraState } from '../../src/lib/gstStates.js'

describe('gstStateCodeFor', () => {
  it('resolves the canonical spellings used in this codebase', () => {
    expect(gstStateCodeFor('Gujarat')).toBe('24')
    expect(gstStateCodeFor('Jharkhand')).toBe('20')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(gstStateCodeFor('  gujarat  ')).toBe('24')
    expect(gstStateCodeFor('GUJARAT')).toBe('24')
  })

  it('resolves India-Post-vs-GST-portal spelling aliases', () => {
    expect(gstStateCodeFor('NCT of Delhi')).toBe('07')
    expect(gstStateCodeFor('Pondicherry')).toBe('34')
    expect(gstStateCodeFor('Orissa')).toBe('21')
    expect(gstStateCodeFor('Daman and Diu')).toBe('26')
    expect(gstStateCodeFor('Dadra & Nagar Haveli')).toBe('26')
  })

  it('throws on an unrecognised state rather than guessing', () => {
    expect(() => gstStateCodeFor('Narnia')).toThrow(/unrecognised state/)
    expect(() => gstStateCodeFor('')).toThrow(/unrecognised state/)
  })
})

describe('isIntraState', () => {
  it('is true when delivery state equals the registered state', () => {
    expect(isIntraState('Jharkhand', 'Jharkhand')).toBe(true)
  })

  it('is false for the live path today: seller in Jharkhand, buyer in Gujarat', () => {
    expect(isIntraState('Gujarat', 'Jharkhand')).toBe(false)
  })

  it('treats matching aliases as the same state', () => {
    expect(isIntraState('NCT of Delhi', 'Delhi')).toBe(true)
  })
})
