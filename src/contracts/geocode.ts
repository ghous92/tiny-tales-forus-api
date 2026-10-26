/**
 * Zod contracts for the reverse-geocoding proxy. Imports only `zod` so it can
 * be shared with the mobile repo later, same rule as `contracts/address.ts`.
 *
 * The response is STRINGS ONLY and deliberately mirrors the mobile address
 * form's fields — the client never sees raw Google payloads, and no coordinate
 * is ever echoed back.
 */

import { z } from 'zod'

/**
 * `GET /v1/geocode/reverse` query. Coerced from strings because query params
 * always arrive as text; bounds are the real WGS84 ranges so a junk value is a
 * 422 rather than a wasted upstream call.
 */
export const ReverseGeocodeQuerySchema = z.strictObject({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
})

export type ReverseGeocodeQuery = z.infer<typeof ReverseGeocodeQuerySchema>

/**
 * Resolved address, shaped for the address form. Every field is present and
 * may be an empty string — the client decides what to keep, and an empty
 * string always means "upstream had nothing", never "field missing".
 */
export const ReverseGeocodeResultSchema = z.object({
  /** 6-digit pincode, or '' when the point has no postal code. */
  pincode: z.string(),
  /** City/town — locality, falling back through the admin-area levels. */
  city: z.string(),
  /** State — administrative_area_level_1. */
  state: z.string(),
  /**
   * The Road/Area/Colony line, most specific first: block/tower, society,
   * sector, road — e.g. "T-BLOCK, Amarpali Silicon City, Sector 76". Built
   * from `address_components`, never from nearby POIs.
   */
  area: z.string(),
  /**
   * A place the coordinate is literally inside (Address Descriptors, `WITHIN`
   * only), for the map card's headline. Usually '' — most points have no
   * containing landmark, and merely NEARBY POIs are deliberately excluded
   * (a petrol pump 230m away is not the shopper's address).
   */
  landmark: z.string(),
  /** Google's own one-line rendering — last-resort fallback for the client. */
  formattedAddress: z.string(),
})

export type ReverseGeocodeResult = z.infer<typeof ReverseGeocodeResultSchema>
