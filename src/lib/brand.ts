/**
 * The storefront's identity, in one place. Everything customer-facing that
 * names the store, its domain or its wire headers reads from here, so a
 * rename is one edit rather than a grep across routes, templates and logs.
 *
 * Deliberately constants rather than env: these values are part of the
 * contract with the web client and the edge Worker (header names, the
 * `notes.store` tag on Razorpay orders), and a misconfigured env var that
 * silently renamed a header would be far harder to spot than a code change.
 */

/** Display name, as shoppers see it in emails, invoices and support copy. */
export const BRAND_NAME = 'Tiny Tales'

/** Canonical storefront origin (no trailing slash). */
export const SITE_ORIGIN = 'https://www.tinytalesforus.com'

/** Apex origin, kept for CORS and links minted before the www redirect. */
export const APEX_ORIGIN = 'https://tinytalesforus.com'

/** Structured-logging service name and the alert subject suffix. */
export const SERVICE_NAME = 'tinytales-api'

/** Response header carrying the deployment the server says it is. */
export const ENV_HEADER = 'X-TinyTales-Env'

/** Header the edge Worker injects to prove a request came through it. */
export const PROXY_AUTH_HEADER = 'X-TinyTales-Proxy-Auth'

/**
 * Value of `notes.store` on every Razorpay order this API creates. The
 * Razorpay account is shared with another storefront, so both webhooks see
 * every event; this tag is how each side recognises its own orders.
 */
export const RAZORPAY_STORE_TAG = 'tinytales'

/** Prefix for human-facing ids: invoices `TT/…`, complaints and claims `TT-…`. */
export const ID_PREFIX = 'TT'

/** Fallback author name for reviews left without a display name. */
export const ANONYMOUS_REVIEWER = 'Tiny Tales customer'

/** Download filename stem for admin CSV exports. */
export const EXPORT_FILE_STEM = 'tinytales'
