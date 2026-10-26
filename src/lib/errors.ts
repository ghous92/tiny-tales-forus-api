/**
 * Typed API errors. Services and plugins throw these; the central error
 * handler in `app.ts` converts them into the response envelope
 * `{ "error": { "code": "...", "message": "..." } }` with the right status.
 * Anything that is NOT an ApiError becomes a 500 `internal` (full error
 * logged server-side, generic message to the client).
 */

/** Every error code the API can emit — mirrored in docs/CONTRACTS.md. */
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'limit_exceeded'
  | 'default_required'
  | 'payments_disabled'
  | 'fulfilment_disabled'
  | 'invoice_unavailable'
  | 'geocoding_disabled'
  | 'scheduler_disabled'
  | 'signature_invalid'
  | 'conflict'
  | 'shipping_unserviceable'
  | 'shipping_quote_stale'
  | 'out_of_service_area'
  | 'cod_unavailable'
  | 'internal'

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 401 — missing/malformed/failed Bearer token. */
export function unauthorized(message = 'Authentication required'): ApiError {
  return new ApiError(401, 'unauthorized', message)
}

/** 403 — authenticated but not authorized (admin-only routes). Role failures only; cross-user *resource* access stays 404. */
export function forbidden(message = 'You do not have permission to do that'): ApiError {
  return new ApiError(403, 'forbidden', message)
}

/** 404 — resource absent OR owned by another user (never 403; do not leak existence). */
export function notFound(message = 'Address not found'): ApiError {
  return new ApiError(404, 'not_found', message)
}

/** 422 — attempt to unset the default while other addresses still exist. */
export function defaultRequired(
  message = 'One address must remain the default. Set another address as default instead.'
): ApiError {
  return new ApiError(422, 'default_required', message)
}

/** 422 — creating past a resource cap. Callers pass an explicit message for their own resource (default text is addresses, v1 behavior unchanged). */
export function limitExceeded(message = 'Address limit reached (max 50 per user)'): ApiError {
  return new ApiError(422, 'limit_exceeded', message)
}

/**
 * 429 — a per-IP (or similar) rate limit was exceeded. Distinct status from
 * {@link limitExceeded} (which is always 422, for a hard resource CAP) even
 * though both use the `limit_exceeded` code: the code names the concept
 * ("you've hit a limit"), the status distinguishes "this is a permanent cap
 * on the resource" (422) from "try again shortly" (429). Introduced for
 * `routes/clientErrors.ts`'s per-IP limiter; `routes/geocode.ts` predates
 * this helper and replies inline instead — no need to touch it.
 */
export function rateLimitExceeded(message = 'Too many requests. Try again shortly.'): ApiError {
  return new ApiError(429, 'limit_exceeded', message)
}

/** 422 — request-shaped failure a service must raise itself (e.g. a sku that has gone inactive). Callers pass an explicit message. */
export function validationFailed(message: string): ApiError {
  return new ApiError(422, 'validation_failed', message)
}

/** 503 — payments are not configured (Razorpay keys absent, or `payments.enabled` off). */
export function paymentsDisabled(message = 'Payments are currently unavailable'): ApiError {
  return new ApiError(503, 'payments_disabled', message)
}

/**
 * 503 — the carrier is not wired up: no `DELHIVERY_API_TOKEN`/`DELHIVERY_BASE_URL`,
 * or `fulfilment.enabled` is off. Deliberately 503 and not 500, because an
 * unconfigured carrier is a deploy state rather than a fault — the same posture
 * that let payments ship before Razorpay keys existed.
 */
export function fulfilmentDisabled(
  message = 'Shipping and fulfilment are currently unavailable'
): ApiError {
  return new ApiError(503, 'fulfilment_disabled', message)
}

/**
 * 503 — the background-sweep gate has no audience or no allowlisted service
 * account, so `/v1/internal/*` accepts nobody.
 *
 * Note this 503 means the OPPOSITE of its siblings above. `payments_disabled`
 * and `fulfilment_disabled` say "a capability is switched off, and off is a
 * safe place to sit". This one says "a lock has no key cut for it yet", and the
 * safe reading is that scheduled work is silently not happening — see the
 * readiness endpoint, which is what surfaces that rather than leaving it to a
 * 503 nobody is looking at.
 */
export function schedulerDisabled(message = 'Scheduled sweeps are not configured'): ApiError {
  return new ApiError(503, 'scheduler_disabled', message)
}

/** 503 — reverse geocoding is not configured (no Google Maps server key). Clients fall back to the on-device geocoder. */
export function geocodingDisabled(message = 'Address lookup is currently unavailable'): ApiError {
  return new ApiError(503, 'geocoding_disabled', message)
}

/** 503 — invoices are unavailable because `legal.company` config isn't seeded yet. */
export function invoiceUnavailable(message = 'Invoices are currently unavailable'): ApiError {
  return new ApiError(503, 'invoice_unavailable', message)
}

/** 400 — a payment signature (verify body or webhook header) failed HMAC verification. */
export function signatureInvalid(message = 'Payment signature verification failed'): ApiError {
  return new ApiError(400, 'signature_invalid', message)
}

/** 409 — the request conflicts with another row in a way that can't be resolved by retrying. */
/**
 * 422 — we cannot deliver to this address, so the order is refused rather than
 * created with free shipping and discovered by the warehouse.
 */
export function shippingUnserviceable(message = 'We cannot deliver to this address yet'): ApiError {
  return new ApiError(422, 'shipping_unserviceable', message)
}

/**
 * 409 — the delivery quote the client is holding no longer matches what the
 * server computes for this order. The client must re-read the cart and show the
 * shopper the new number; it must never silently re-price.
 */
export function shippingQuoteStale(
  message = 'Delivery charges changed. Please review your order.'
): ApiError {
  return new ApiError(409, 'shipping_quote_stale', message)
}

/**
 * 422 — the order's destination is outside the states we are legally scoped to
 * sell into (different-state destinations carry different GST treatment). This
 * is a HARD legal fence, independent of `shipping.enabled`/delivery pricing:
 * it must refuse the order even when shipping fees are switched off, and it is
 * never bypassed by the `shipping.unserviceableBehavior: 'flat'` fallback that
 * exists for ordinary logistics gaps. See services/shipping.ts
 * `checkOrderDestination`.
 */
export function outOfServiceArea(message = "We can't deliver to this pincode yet."): ApiError {
  return new ApiError(422, 'out_of_service_area', message)
}

/**
 * 422 — the client asked to pay cash on delivery for an order that is not
 * eligible for it. Distinct from `validation_failed` because the body is
 * perfectly well formed: it is the POLICY that refuses, and the client should
 * re-read the cart's `cod` block (which carries the machine reason) and fall
 * back to prepaid rather than treat the request as a bug.
 */
export function codUnavailable(
  message = 'Cash on delivery is not available for this order'
): ApiError {
  return new ApiError(422, 'cod_unavailable', message)
}

export function conflict(message = 'This request conflicts with existing data'): ApiError {
  return new ApiError(409, 'conflict', message)
}
