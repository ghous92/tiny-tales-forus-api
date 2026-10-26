/**
 * `scripts/config-doctor.ts` — the pure diff, unit tested rather than
 * reproduced against three live databases.
 *
 * The claim that matters is the one about the ALLOWLIST, not the one about
 * spotting differences. Declaring a key by-design is a silencer, and a silencer
 * that works in both directions is worse than no report at all: `prod: true,
 * dev: false` and `prod: false, dev: false` are the same shape, and only one of
 * them means fulfilment quietly went off in production. Pins are what keep the
 * exemption pointed in one direction.
 */

import { describe, expect, it } from 'vitest'

import {
  diffEnvironments,
  undeclaredDrift,
  type ConfigSnapshot,
} from '../../scripts/config-doctor.js'

/** Only the keys under test count as "known", so unrelated defaults stay out. */
const KNOWN = new Set([
  'cart.maxLines',
  'fulfilment.enabled',
  'fulfilment.mode',
  'shipping.serviceableStates',
])

function env(name: string, entries: Record<string, unknown>): { name: string; config: ConfigSnapshot } {
  return {
    name,
    config: new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)])),
  }
}

describe('diffEnvironments', () => {
  it('says nothing when the environments agree', () => {
    const drift = diffEnvironments(
      [env('prod', { 'cart.maxLines': 40 }), env('dev', { 'cart.maxLines': 40 })],
      new Set(['cart.maxLines'])
    )
    expect(drift).toEqual([])
  })

  it('reports a key present in one environment and absent in another', () => {
    const drift = diffEnvironments(
      [env('prod', { 'cart.maxLines': 40 }), env('dev', {})],
      new Set(['cart.maxLines'])
    )
    expect(drift).toMatchObject([{ key: 'cart.maxLines', kind: 'missing' }])
    expect(undeclaredDrift(drift)).toHaveLength(1)
  })

  it('reports a default that no environment has yet', () => {
    // The case an environment-to-environment diff alone cannot see: a key
    // shipped in CONFIG_DEFAULTS and never seeded anywhere reads as "no drift"
    // if you only compare databases with each other.
    const drift = diffEnvironments([env('prod', {}), env('dev', {})], new Set(['cart.maxLines']))
    expect(drift).toMatchObject([{ key: 'cart.maxLines', kind: 'missing' }])
  })

  it('reports a key in the database that no longer exists in the defaults', () => {
    const drift = diffEnvironments([env('prod', { 'cart.maxLnies': 40 })], new Set(['cart.maxLines']))
    // A typo is inert forever and looks exactly like a working setting.
    expect(drift).toMatchObject([
      { key: 'cart.maxLines', kind: 'missing' },
      { key: 'cart.maxLnies', kind: 'unknown' },
    ])
  })

  it('reports disagreeing values', () => {
    const drift = diffEnvironments(
      [env('prod', { 'cart.maxLines': 40 }), env('dev', { 'cart.maxLines': 5 })],
      new Set(['cart.maxLines'])
    )
    expect(drift).toMatchObject([{ key: 'cart.maxLines', kind: 'value' }])
    expect(drift[0]!.expected).toBeUndefined()
    expect(undeclaredDrift(drift)).toHaveLength(1)
  })

  it('exempts a declared divergence with no pin, whatever the values are', () => {
    const drift = diffEnvironments(
      [
        env('prod', { 'shipping.serviceableStates': ['Gujarat'] }),
        env('dev', { 'shipping.serviceableStates': ['Gujarat', 'Kerala'] }),
      ],
      new Set(['shipping.serviceableStates'])
    )
    const fence = drift.find((d) => d.key === 'shipping.serviceableStates')
    expect(fence?.expected).toContain('legal scope fence')
    expect(undeclaredDrift(drift)).toEqual([])
  })

  it('exempts a pinned divergence while every pin still holds', () => {
    const drift = diffEnvironments(
      [
        env('prod', { 'fulfilment.enabled': true, 'fulfilment.mode': 'carrier' }),
        env('dev', { 'fulfilment.enabled': false, 'fulfilment.mode': 'manual' }),
      ],
      new Set(['fulfilment.enabled', 'fulfilment.mode'])
    )
    expect(undeclaredDrift(drift)).toEqual([])
  })

  it('REPORTS a pinned key once an environment drifts off its pin', () => {
    // The regression the pins exist for: fulfilment quietly off in production
    // is still `prod !== dev`, and a blanket exemption would call that expected.
    const drift = diffEnvironments(
      [
        env('prod', { 'fulfilment.enabled': false, 'fulfilment.mode': 'carrier' }),
        env('dev', { 'fulfilment.enabled': true, 'fulfilment.mode': 'manual' }),
      ],
      KNOWN
    )
    const enabled = drift.find((d) => d.key === 'fulfilment.enabled')
    expect(enabled?.expected).toBeUndefined()
    expect(undeclaredDrift(drift).map((d) => d.key)).toContain('fulfilment.enabled')
  })

  it('leaves an environment the pin does not name unconstrained', () => {
    // A pin lists prod/staging/dev; a one-off branch compared on its own must
    // not fail merely for being unlisted.
    const drift = diffEnvironments(
      [
        env('prod', { 'fulfilment.enabled': true }),
        env('preview-42', { 'fulfilment.enabled': false }),
      ],
      new Set(['fulfilment.enabled'])
    )
    expect(undeclaredDrift(drift)).toEqual([])
  })
})
