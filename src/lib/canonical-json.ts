/**
 * Deterministic JSON serialization — object keys sorted recursively so the
 * same logical value always produces the same byte string, regardless of
 * insertion order. Used by `services/config.ts` to compute a stable ETag
 * (sha256 of the canonical JSON) over the config snapshot's `values` record.
 */

/** Recursively sort object keys; arrays keep their order, primitives pass through untouched. */
function sortKeysDeep(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortKeysDeep)
  if (input !== null && typeof input === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(input as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((input as Record<string, unknown>)[k])
    }
    return sorted
  }
  return input
}

/** `JSON.stringify` with every nested object's keys sorted — stable across insertion order. */
export function canonicalJson(input: unknown): string {
  return JSON.stringify(sortKeysDeep(input))
}
