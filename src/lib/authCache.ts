/**
 * In-process identity cache for `plugins/auth.ts`.
 *
 * Every authed request has to resolve a Firebase uid to the caller's `users`
 * row. That was a write transaction, then (after the read-first fast path) a
 * single indexed SELECT. This removes even that for repeat callers inside a
 * short window — the app fires several authed calls per screen, all carrying
 * the same token.
 *
 * Deliberately NOT Redis. This is a plain bounded Map, per Cloud Run instance,
 * with no network hop and no infrastructure to pay for or operate. The
 * trade-off it accepts is the reason the TTL must stay short:
 *
 *   - Entries are per-instance. An invalidation on instance A is invisible to
 *     instance B; the TTL is the only cross-instance backstop.
 *   - `users.role` is promoted/demoted by manual SQL (SPEC-V2.md §1), which
 *     this process never observes. A demoted admin keeps `role: 'admin'` until
 *     their entry expires. That window IS the TTL — do not raise it to chase a
 *     hit rate.
 *
 * Set the TTL to 0 to disable caching entirely (`AUTH_CACHE_TTL_MS=0`); the
 * auth hook then behaves exactly as it does without this module. The test
 * harness runs with it disabled by default for that reason.
 */

import type { UserRole } from '../plugins/auth.js'

/** The subset of the caller's `users` row that `request.user` is built from. */
export interface CachedUser {
  id: string
  phone: string
  role: UserRole
  consentAccepted: boolean
  /** See `users.tokensValidAfter`. */
  tokensValidAfter?: Date | null
}

export interface AuthCache {
  /** The live entry for `uid`, or undefined when absent, expired, or disabled. */
  get: (uid: string) => CachedUser | undefined
  /** Store (or refresh) `uid`'s entry. A no-op when disabled. */
  set: (uid: string, value: CachedUser) => void
  /** Drop `uid` — call whenever the underlying row stops being what was cached. */
  delete: (uid: string) => void
  /** Drop everything. Used by tests; there is no production caller. */
  clear: () => void
  /** Live entry count, after pruning expired entries. Tests assert on this. */
  size: () => number
}

export interface AuthCacheOptions {
  /**
   * Entry lifetime. 0 (or negative) disables the cache — `get` always misses
   * and `set` stores nothing, so no staleness is possible.
   */
  ttlMs?: number
  /**
   * Hard entry ceiling, evicting oldest-inserted first. Bounds memory against
   * a long-lived instance seeing many distinct uids; at the default this is a
   * couple of MB, well inside Cloud Run's 512Mi.
   */
  maxEntries?: number
  /** Clock seam — tests advance time without fake timers. */
  now?: () => number
}

interface Entry {
  value: CachedUser
  expiresAt: number
}

/** Default entry lifetime. See the module docs before raising this. */
export const DEFAULT_AUTH_CACHE_TTL_MS = 30_000

export function createAuthCache(options: AuthCacheOptions = {}): AuthCache {
  const ttlMs = options.ttlMs ?? DEFAULT_AUTH_CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? 10_000
  const now = options.now ?? Date.now
  const enabled = ttlMs > 0

  // Insertion-ordered, which is what makes the overflow eviction below O(1):
  // `keys().next()` is the oldest key. Re-inserting on `set` keeps a refreshed
  // entry from being evicted as though it were stale.
  const entries = new Map<string, Entry>()

  const get = (uid: string): CachedUser | undefined => {
    if (!enabled) return undefined
    const hit = entries.get(uid)
    if (!hit) return undefined
    if (hit.expiresAt <= now()) {
      entries.delete(uid)
      return undefined
    }
    return hit.value
  }

  return {
    get,
    set: (uid, value) => {
      if (!enabled) return
      entries.delete(uid)
      entries.set(uid, { value, expiresAt: now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },
    delete: (uid) => {
      entries.delete(uid)
    },
    clear: () => {
      entries.clear()
    },
    size: () => {
      for (const [uid, entry] of entries) {
        if (entry.expiresAt <= now()) entries.delete(uid)
      }
      return entries.size
    },
  }
}
