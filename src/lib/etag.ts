/**
 * `If-None-Match` matching for the two public snapshot routes (`/v1/catalog`,
 * `/v1/config`), whose ETag is just the resource's monotonic version counter.
 *
 * WHY THIS IS NOT A ONE-LINE `replace(/"/g, '')`
 *
 * The routes emit a STRONG validator (`ETag: "7"`), but the client almost never
 * sends that value back verbatim. Cloudflare sits in front of the API and, when
 * it compresses a response (brotli/gzip), it rewrites the validator to its WEAK
 * form — `W/"7"` — because the compressed bytes are no longer octet-identical to
 * what the origin produced. RFC 9110 §8.8.3 requires exactly that. The app then
 * stores `W/"7"` and echoes it on the next request.
 *
 * The previous `unquote()` helper stripped only the surrounding quotes, so
 * `W/"7"` reduced to `W/"7` — never equal to `7`. Result: the 304 path was dead
 * in production and every launch, every pull-to-refresh, and every screen mount
 * re-downloaded the whole snapshot. Verified against prod before the fix:
 *
 *   If-None-Match: "1"    -> 304, 0 bytes
 *   If-None-Match: W/"1"  -> 200, 7191 bytes   <- what the app actually sent
 *
 * `If-None-Match` on a conditional GET uses the WEAK comparison function (RFC
 * 9110 §13.1.2), which ignores the `W/` prefix entirely — so treating both forms
 * as a match is not a leniency hack, it is the specified behaviour.
 *
 * The header is also a comma-separated LIST and may be the wildcard `*`, both of
 * which the old helper mishandled. Fastify collapses repeated headers into one
 * comma-joined string, so the list form reaches us even from a well-behaved
 * client that sent separate headers.
 */

/**
 * Whether a client's `If-None-Match` header matches `version` (the bare counter
 * value, e.g. `"7"` — no quotes, no `W/`).
 *
 * Accepts every shape a real client or intermediary produces:
 *   `"7"` · `W/"7"` · `7` · `W/"6", W/"7"` · `*`
 *
 * `undefined`/empty means the client sent no validator, which is never a match
 * (the caller must send the full body).
 */
export function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  version: string
): boolean {
  if (header === undefined) return false
  // Node lowercases header names but can hand back an array for repeated ones.
  const raw = Array.isArray(header) ? header.join(',') : header

  return raw.split(',').some((candidate) => {
    const trimmed = candidate.trim()
    if (trimmed === '') return false
    // `*` matches any existing representation — and this route always has one.
    if (trimmed === '*') return true
    return normalizeEtag(trimmed) === version
  })
}

/** Reduces one entity-tag to its bare opaque value: drops `W/` then the quotes. */
function normalizeEtag(entityTag: string): string {
  return entityTag.replace(/^W\//i, '').replace(/^"(.*)"$/, '$1')
}
