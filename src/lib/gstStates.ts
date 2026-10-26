/**
 * State name → GST state code (docs plan `there-s-a-big-strategy-validated-
 * clover.md` §2.4). B2C goods: place of supply is where the goods are
 * DELIVERED (IGST s.10(1)(a)) — the delivery-address state on
 * `payments.address_snapshot` decides IGST vs CGST+SGST, never the pickup
 * node's state. This is independent of shipping zones (`lib/shipping.ts`
 * `zoneFor()`), which key off the warehouse pincode instead — do not conflate
 * the two.
 *
 * `pincodes.state` / `addresses.state` carry India Post spellings, which
 * differ from the GST portal's for a handful of union territories (Delhi,
 * Puducherry, the merged Dadra & Nagar Haveli / Daman & Diu UT). `ALIASES`
 * below is where those are reconciled — deliberately NOT folded into the
 * canonical map, so the canonical spelling stays the one on the actual GST
 * state-code notification.
 *
 * Only Gujarat is loaded into `pincodes` today (PAN-India import is Phase 4,
 * deferred). The full table is built anyway so PAN-India delivery doesn't
 * require touching this file again — an unrecognised state throws rather than
 * silently resolving to "intra-state", because that would undercharge tax.
 */

const CANONICAL_CODES: Readonly<Record<string, string>> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  haryana: '06',
  delhi: '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  chhattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  // The two former UTs merged on 26 January 2020. GST uses code 26 for the
  // merged territory; code 25 is retained only on historic registrations.
  'dadra and nagar haveli and daman and diu': '26',
  maharashtra: '27',
  'andhra pradesh': '28',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  puducherry: '34',
  'andaman and nicobar islands': '35',
  telangana: '36',
  ladakh: '38',
}

/** India Post / free-text spellings that map onto a canonical key above. */
const ALIASES: Readonly<Record<string, string>> = {
  'nct of delhi': 'delhi',
  'delhi (nct)': 'delhi',
  pondicherry: 'puducherry',
  orissa: 'odisha',
  'jammu & kashmir': 'jammu and kashmir',
  'andaman & nicobar islands': 'andaman and nicobar islands',
  'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
  'dadra & nagar haveli': 'dadra and nagar haveli and daman and diu',
  'daman and diu': 'dadra and nagar haveli and daman and diu',
  'daman & diu': 'dadra and nagar haveli and daman and diu',
  'dadra & nagar haveli and daman & diu': 'dadra and nagar haveli and daman and diu',
}

function normalize(state: string): string {
  return state.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The two-digit GST state code for a state name as it appears in an address
 * (India Post or free-text spelling). Throws — never guesses — for an
 * unrecognised name, since a silent "unknown = intra-state" default would
 * undercharge tax on every order it touched.
 */
export function gstStateCodeFor(state: string): string {
  const key = normalize(state)
  const resolved = ALIASES[key] ?? key
  const code = CANONICAL_CODES[resolved]
  if (!code) {
    throw new Error(`gstStateCodeFor: unrecognised state "${state}" — no GST state code mapping`)
  }
  return code
}

/**
 * Code → the canonical state name, built by inverting {@link CANONICAL_CODES}
 * so the two can never drift. Title-cased with `and`/`of` left lowercase,
 * which is how the GST portal itself spells them ("Jammu and Kashmir",
 * "Andaman and Nicobar Islands").
 *
 * This exists for GSTR-1: `placeOfSupply` on a frozen document carries the
 * ADDRESS spelling (India Post's), and a return has to carry the portal's.
 * Reading it back off the code — the one field of `placeOfSupply` that is
 * already canonical — is what keeps a Pondicherry address filing as
 * Puducherry.
 */
const NAMES_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CANONICAL_CODES).map(([name, code]) => [
    code,
    name
      .split(' ')
      .map((word) =>
        word === 'and' || word === 'of' ? word : word.charAt(0).toUpperCase() + word.slice(1)
      )
      .join(' '),
  ])
)

/**
 * The canonical GST state name for a two-digit code, or `undefined` for a code
 * that is not in the notification. Undefined rather than a throw: this is used
 * by a REPORT over already-frozen documents, and a report that refuses to
 * render because one historic row is odd is worse than one that shows the bare
 * code. `gstStateCodeFor` — which decides how much tax to charge — still
 * throws, for the opposite reason.
 */
export function gstStateNameFor(code: string): string | undefined {
  return NAMES_BY_CODE[code]
}

/**
 * `"20-Jharkhand"` — the place-of-supply format every GSTR-1 table uses. An
 * unrecognised code degrades to the code alone rather than inventing a name.
 */
export function formatPlaceOfSupply(code: string): string {
  const name = gstStateNameFor(code)
  return name ? `${code}-${name}` : code
}

/**
 * True when `deliveryState` is the seller's own registered state — the
 * CGST+SGST branch. False (IGST) otherwise, which is every order today: the
 * seller is registered in Jharkhand and every current customer is in
 * Gujarat.
 */
export function isIntraState(deliveryState: string, registeredStateName: string): boolean {
  return gstStateCodeFor(deliveryState) === gstStateCodeFor(registeredStateName)
}
