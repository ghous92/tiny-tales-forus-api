/**
 * Unit tests for the auth identity cache. Time is injected rather than faked,
 * so these assert the expiry arithmetic directly with no timer plumbing.
 */

import { describe, expect, it } from 'vitest'

import { createAuthCache, type CachedUser } from '../../src/lib/authCache.js'

const USER: CachedUser = {
  id: '00000000-0000-0000-0000-000000000001',
  phone: '+919876543210',
  role: 'customer',
  consentAccepted: true,
}

/** A cache whose clock the test drives. */
function withClock(ttlMs: number, maxEntries?: number) {
  let t = 1_000
  const cache = createAuthCache({
    ttlMs,
    now: () => t,
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  })
  return { cache, advance: (ms: number) => (t += ms) }
}

describe('createAuthCache', () => {
  it('returns a stored entry inside the TTL', () => {
    const { cache, advance } = withClock(30_000)
    cache.set('uid-a', USER)
    advance(29_999)
    expect(cache.get('uid-a')).toEqual(USER)
  })

  it('misses once the TTL has elapsed', () => {
    const { cache, advance } = withClock(30_000)
    cache.set('uid-a', USER)
    advance(30_000)
    expect(cache.get('uid-a')).toBeUndefined()
    // Expiry is exactly at the boundary, not merely eventually.
    expect(cache.size()).toBe(0)
  })

  it('is inert when the TTL is 0, so nothing can ever be stale', () => {
    const { cache } = withClock(0)
    cache.set('uid-a', USER)
    expect(cache.get('uid-a')).toBeUndefined()
    expect(cache.size()).toBe(0)
  })

  it('drops a single uid on delete, leaving others alone', () => {
    const { cache } = withClock(30_000)
    cache.set('uid-a', USER)
    cache.set('uid-b', USER)
    cache.delete('uid-a')
    expect(cache.get('uid-a')).toBeUndefined()
    expect(cache.get('uid-b')).toEqual(USER)
  })

  it('evicts oldest-first at the entry ceiling', () => {
    const { cache } = withClock(30_000, 2)
    cache.set('uid-a', USER)
    cache.set('uid-b', USER)
    cache.set('uid-c', USER)

    expect(cache.size()).toBe(2)
    expect(cache.get('uid-a')).toBeUndefined()
    expect(cache.get('uid-b')).toEqual(USER)
    expect(cache.get('uid-c')).toEqual(USER)
  })

  it('re-setting an entry refreshes both its expiry and its eviction order', () => {
    const { cache, advance } = withClock(30_000, 2)
    cache.set('uid-a', USER)
    cache.set('uid-b', USER)

    advance(20_000)
    cache.set('uid-a', USER) // uid-a is now the NEWEST, so uid-b evicts next
    cache.set('uid-c', USER)

    expect(cache.get('uid-b')).toBeUndefined()
    expect(cache.get('uid-a')).toEqual(USER)

    // …and its clock restarted: 20s after the refresh it is still live.
    advance(20_000)
    expect(cache.get('uid-a')).toEqual(USER)
  })

  it('reports size after pruning expired entries', () => {
    const { cache, advance } = withClock(30_000)
    cache.set('uid-a', USER)
    advance(10_000)
    cache.set('uid-b', USER)

    advance(20_001) // uid-a expired, uid-b not yet
    expect(cache.size()).toBe(1)
  })
})
