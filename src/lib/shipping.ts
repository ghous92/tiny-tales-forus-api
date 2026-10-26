/**
 * Shipping math — every arithmetic step between "here is a cart and a pincode"
 * and "here is the fee we charge and the cost we pay". Pure: no db, no config,
 * no clock, no imports. The sibling of lib/pricing.ts, and the same promise —
 * DISPLAY == CHARGE only holds if this arithmetic exists in exactly one place.
 *
 * Three ideas run through the whole file.
 *
 * **1. One real cost, one derived price.** `trueCostInr` is what the courier
 * bills us (base freight + fuel + docket + risk + COD + GST — all six
 * components of a real Indian B2C surface rate card). `customerFeeInr` is
 * `trueCostInr` plus `shipping.marginBps` — never a separately hand-typed
 * number, so the price the shopper sees can never drift below (or silently
 * away from) what the courier actually charges. The margin is visible in the
 * admin simulator, but there is nothing else to configure per zone/weight.
 *
 * **2. Zones, with a nationwide estimate when a pincode is not imported.**
 * Indian surface couriers bill on the pincode pair — the (origin, destination)
 * zone — not on distance travelled. Zone A is within the same taluk, Zone B
 * the rest of the state, D the rest of India. For a valid pincode that is not
 * in our reference table we use a coarse postal-region centroid and derive a
 * conservative B/D estimate from distance. That keeps checkout open across
 * India without bulk-importing or remotely looking up every pincode.
 *
 * **3. Missing location data gets an estimate, never accidental free freight.**
 * Missing catalog measurements or inventory still return a reason and no
 * quote. Missing pincode coverage uses the Delhivery distance estimate; only
 * the existing free-delivery policy can waive that fee.
 *
 * All percentages arrive as integer basis points (`1150` = 11.50%) and all
 * money is whole rupees, so the totals a client re-adds always match.
 */

// --- Types -------------------------------------------------------------------

/** Courier zone. Gujarat-only v1 uses A and B; the rest exist so a rate card can be entered whole. */
export type Zone = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

export const ZONES: readonly Zone[] = ['A', 'B', 'C', 'D', 'E', 'F']

/** Why there is no fee. `null` means a fee was quoted normally. */
export type ShippingReason =
  /** `shipping.enabled` is false (or config is missing/malformed). */
  | 'disabled'
  /** No pincode to price against — no address selected and none supplied. */
  | 'no_destination'
  /** Malformed destination or no carrier rate usable for an exact or estimated quote. */
  | 'not_serviceable'
  /** No single pickup node stocks every line (split shipments are out of scope). */
  | 'no_single_node'
  /** At least one line has no measured weight, and `unknownWeightBehavior` is `block`. */
  | 'weight_unknown'
  /** At least one line has no measured carton dimensions. No bypass — dims are always mandatory. */
  | 'dims_unknown'

/** One cart line as shipping sees it: how many, how heavy, how big. */
export interface ShippingLine {
  sku: string
  qty: number
  /** Packed weight in grams; 0 = unmeasured. */
  weightG: number
  /** Carton dimensions in cm; 0 = unmeasured. */
  lengthCm: number
  widthCm: number
  heightCm: number
}

/** India Post reference row. `taluk` is what Zone A is defined on — there is no city column. */
export interface PincodeInfo {
  /** True only for a coarse location substituted for a missing reference row. */
  estimated?: boolean
  pincode: string
  taluk: string
  district: string
  state: string
  lat: number | null
  lng: number | null
}

/** A courier's base freight for one (zone, weight-slab) cell. Whole rupees, pre-fuel, pre-GST. */
export interface RateSlab {
  zone: Zone
  uptoG: number
  rateInr: number
  /** Read from the TOP slab of a zone only — the step size above the table. */
  addlPerG: number
  /** Read from the TOP slab of a zone only — the charge per step above the table. */
  addlRateInr: number
}

/** An inclusive pincode range a courier covers. */
export interface ServiceArea {
  fromPincode: string
  toPincode: string
  isActive: boolean
}

/** Per-pincode serviceability, which OVERRIDES the ranges in both directions. */
export interface ServiceException {
  pincode: string
  serviceable: boolean
}

/** A pickup node as shipping sees it. */
export interface ShippingNode {
  id: string
  code: string
  pincode: string
  lat: number | null
  lng: number | null
  priority: number
  /** Stock allowlist. EMPTY MEANS "stocks everything" — the v1 single-warehouse case. */
  skus: string[]
  /** Daily handover cutoff, IST 'HH:MM' — the boundary {@link estimatedDeliveryDate} ships against. */
  cutoffIst: string
}

/** A courier plus its complete cost formula and coverage. */
export interface ShippingCourier {
  code: string
  name: string
  rateModel: 'weight' | 'distance'
  volumetricDivisor: number
  minChargeableG: number
  fuelBps: number
  gstBps: number
  docketFeeInr: number
  riskBps: number
  riskMinInr: number
  codFlatInr: number
  codBps: number
  slaDaysZoneA: number
  slaDaysZoneB: number
  reliabilityScore: number
  priority: number
  slabs: RateSlab[]
  serviceAreas: ServiceArea[]
  serviceExceptions: ServiceException[]
}

/** A free-shipping threshold that only applies up to a given chargeable weight. */
export interface FreeTier {
  uptoG: number
  freeAboveInr: number
}

/**
 * The resolved shipping knobs, as handed to the cart service — the shape
 * {@link WholesaleRule} has in lib/pricing.ts, for the same reason: the ROUTE
 * reads config, the service takes a plain value.
 */
export interface ShippingRule {
  /** Master switch. False disables shipping fees entirely (totals identical to pre-shipping). */
  enabled: boolean
  /** Weight-tiered free-shipping thresholds. NO MATCHING TIER MEANS NEVER FREE. */
  freeAboveTiers: FreeTier[]
  /** Which subtotal the threshold is measured against. The clamp applies regardless. */
  thresholdBasis: 'preCoupon' | 'postCoupon'
  /** Markup on true courier cost, in basis points (1000 = 10%). What the shopper is charged. */
  marginBps: number
  /**
   * Promotional cut off the shopper fee, in basis points (5000 = half price,
   * 10000 = free), applied after the margin and before the free threshold.
   * A live marketing lever, deliberately separate from `marginBps`: the
   * margin says what delivery is worth, this says how much of it we give away.
   */
  feeDiscountBps: number
  /** Outer packaging weight in grams, added once per cart. */
  tareG: number
  /** Multiplier on the cart's volumetric estimate; 1.0 = the largest single carton. */
  volumetricPackFactor: number
  /** Legacy configuration retained for admin compatibility; it no longer limits delivery. */
  serviceableStates: string[]
  /** What to do with a line whose weight nobody has measured. */
  unknownWeightBehavior: 'block' | 'assume'
  assumedWeightG: number
  /** What to do when no (node, courier) candidate can serve the destination. */
  unserviceableBehavior: 'block' | 'flat'
  fallbackFeeInr: number
  /** Primary ranking key when choosing among candidates. */
  rankBy: 'cost' | 'sla' | 'reliability'
}

/**
 * Shipping off, whatever config says — the safe default whenever a key is
 * missing or malformed. A pricing rule must never switch itself on.
 */
export const SHIPPING_OFF: ShippingRule = {
  enabled: false,
  freeAboveTiers: [],
  thresholdBasis: 'preCoupon',
  marginBps: 0,
  feeDiscountBps: 0,
  tareG: 0,
  volumetricPackFactor: 1,
  serviceableStates: [],
  unknownWeightBehavior: 'block',
  assumedWeightG: 0,
  unserviceableBehavior: 'block',
  fallbackFeeInr: 0,
  rankBy: 'cost',
}

/** One (node, courier) pairing, fully priced. */
export interface Candidate {
  /** A distance-based ballpark rather than a covered lane's rate-card price. */
  estimated: boolean
  nodeId: string
  nodeCode: string
  courierCode: string
  courierName: string
  zone: Zone
  chargeableWeightG: number
  /** Carton dims to declare at manifest time — see {@link cartParcelDims}. All-zero = unmeasured. */
  lengthCm: number
  widthCm: number
  heightCm: number
  /** What the courier bills us, all six components, GST included. `cost.totalInr`. */
  trueCostInr: number
  /** The same bill split the way the courier's tax invoice splits it — the ITC-on-freight input. */
  cost: FreightCost
  /**
   * The same parcel priced WITH the COD component, whatever `SelectInput.isCod`
   * said. Equal to {@link cost} when that was already true.
   *
   * It exists because selection and the shopper's fee must NOT move when an
   * order is paid cash (docs/SPEC-COD.md D8): the courier ranking stays priced
   * prepaid so a payment choice cannot silently reorder carriers mid-checkout,
   * and `customerFeeInr` is derived from `cost`, so charging COD through it
   * would put a delivery surcharge on top of the ₹49 token — two frictions for
   * one risk.
   *
   * But the cost is real and the margin report has to see it, so the ORDER
   * SNAPSHOT stamps this figure instead. Computed here rather than
   * re-derived by the caller because the caller no longer has the slab base
   * this was priced from, and re-deriving it from a rounded `baseInr` would
   * drift.
   */
  codCost: FreightCost
  slaDays: number
  reliabilityScore: number
  /** Haversine km between node and destination centroids; null when either is ungeocoded. */
  distanceKm: number | null
  /** The winning node's handover cutoff, carried through for {@link estimatedDeliveryDate}. */
  nodeCutoffIst: string
}

/** The chosen shipment, or the reason there isn't one. */
export interface Shipment {
  winner: Candidate | null
  /** Every viable candidate, best-first — the admin simulator renders this table. */
  candidates: Candidate[]
  reason: ShippingReason | null
}

// --- Weight ------------------------------------------------------------------

/**
 * Σ(qty × weight) over the lines, plus the outer packaging tare once for the
 * whole cart. Lines with an unmeasured weight contribute whatever the caller
 * already substituted (see {@link resolveLineWeights}) — this function does no
 * substitution of its own.
 */
export function deadWeightG(lines: ShippingLine[], tareG: number): number {
  const sum = lines.reduce((total, line) => total + line.qty * line.weightG, 0)
  return Math.max(0, Math.round(sum + tareG))
}

/**
 * Volumetric weight in GRAMS: `L × W × H (cm) × 1000 / divisor`.
 *
 * The ×1000 is inside the division on purpose. Dividing first and multiplying
 * after rounds to whole kilograms, which silently reports a 15×10×8 cm carton
 * as 0 g — the exact bug this comment exists to prevent from coming back.
 *
 * Any missing dimension makes the volume 0: an unmeasured carton contributes
 * nothing rather than pretending to be small.
 */
export function volumetricG(
  lengthCm: number,
  widthCm: number,
  heightCm: number,
  divisor: number
): number {
  if (!(divisor > 0)) return 0
  if (lengthCm <= 0 || widthCm <= 0 || heightCm <= 0) return 0
  return Math.round((lengthCm * widthCm * heightCm * 1000) / divisor)
}

/**
 * What the courier actually bills on: the greatest of dead weight, volumetric
 * weight, and the carrier's own minimum billable weight. All three matter — a
 * 200 g cream still bills at the 500 g minimum, and a light bulky parcel bills
 * on its volume.
 */
export function chargeableG(deadG: number, volG: number, minG: number): number {
  return Math.max(deadG, volG, minG, 0)
}

/**
 * The cart's volumetric estimate for one courier's divisor: the LARGEST single
 * line's carton, scaled by `packFactor`.
 *
 * This is deliberately approximate and says so. Real 3-D bin packing is out of
 * scope; for a catalog of dense liquids, dead weight dominates and volumetric
 * is a guard rail, not the driver. `packFactor` is the operator's dial for
 * "our boxes run bigger than one product's carton".
 */
export function cartVolumetricG(
  lines: ShippingLine[],
  divisor: number,
  packFactor: number
): number {
  let largest = 0
  for (const line of lines) {
    const v = volumetricG(line.lengthCm, line.widthCm, line.heightCm, divisor)
    if (v > largest) largest = v
  }
  const factor = Number.isFinite(packFactor) && packFactor > 0 ? packFactor : 1
  return Math.round(largest * factor)
}

/**
 * The carton dimensions to declare to the carrier at manifest time: the same
 * largest-single-line carton {@link cartVolumetricG} prices off of, so the
 * dimensions handed to Delhivery are never inconsistent with the volumetric
 * weight the shopper was charged on. All-zero when every line is unmeasured —
 * the caller (manifest) must treat that as "no dims", not "a point-sized box".
 */
export function cartParcelDims(lines: ShippingLine[]): {
  lengthCm: number
  widthCm: number
  heightCm: number
} {
  let best = { lengthCm: 0, widthCm: 0, heightCm: 0 }
  let bestVolume = 0
  for (const line of lines) {
    const volume = line.lengthCm * line.widthCm * line.heightCm
    if (volume > bestVolume) {
      bestVolume = volume
      best = { lengthCm: line.lengthCm, widthCm: line.widthCm, heightCm: line.heightCm }
    }
  }
  return best
}

/**
 * Apply `unknownWeightBehavior` to the cart. Returns the lines to price with,
 * or `null` when a line has no measured weight and the rule says to block —
 * which the caller must surface as `weight_unknown`, never as a free shipment.
 */
export function resolveLineWeights(
  lines: ShippingLine[],
  rule: Pick<ShippingRule, 'unknownWeightBehavior' | 'assumedWeightG'>
): ShippingLine[] | null {
  const unknown = lines.some((line) => line.weightG <= 0)
  if (!unknown) return lines
  if (rule.unknownWeightBehavior !== 'assume') return null
  if (!(rule.assumedWeightG > 0)) return null
  return lines.map((line) =>
    line.weightG > 0 ? line : { ...line, weightG: Math.round(rule.assumedWeightG) }
  )
}

/**
 * Does every line have measured carton dimensions? Unlike weight, there is no
 * `assume`-style bypass: a guessed volumetric weight can quietly underbill a
 * light-but-bulky parcel with no error, so dims are mandatory outright — the
 * caller must surface `dims_unknown`, never fall back to dead weight alone.
 */
export function hasMeasuredDims(lines: ShippingLine[]): boolean {
  return lines.every((line) => line.lengthCm > 0 && line.widthCm > 0 && line.heightCm > 0)
}

// --- Zone --------------------------------------------------------------------

/**
 * States/UTs a flat cross-state Zone-D rate materially undercharges — the
 * Northeast, J&K, Ladakh, and the two island UTs move on genuinely different
 * (air/sea-fed) logistics lanes than the rest of the country. Priced as their
 * own Zone E rather than collapsed into D, which is what Phase 4 flagged as a
 * money-losing default (Guwahati/Srinagar/Port Blair at Zone-D pricing).
 * Canonical India-Post state names, lowercased — matched the same way the
 * state fence itself is (`gstStates.ts`'s CANONICAL_CODES spelling).
 */
/**
 * Matches `pincodes.state` verbatim (lowercased) — the India Post dataset
 * spells these with `&`, not `and` (`"jammu & kashmir"`, not `"jammu and
 * kashmir"`). Ladakh has no rows of its own in the imported dataset; it is
 * still folded into the Jammu & Kashmir pincode range.
 */
const REMOTE_ZONE_STATES: ReadonlySet<string> = new Set([
  'jammu & kashmir',
  'sikkim',
  'arunachal pradesh',
  'nagaland',
  'manipur',
  'mizoram',
  'tripura',
  'meghalaya',
  'assam',
  'andaman & nicobar islands',
  'lakshadweep',
])

/**
 * A coarse centroid for an otherwise-valid Indian pincode without coordinates
 * in `pincodes`. PIN's leading digit identifies a postal region; these centroids
 * intentionally provide only enough precision for a distance-band estimate,
 * not an address lookup. This avoids importing or querying the entire national
 * pincode catalogue merely to offer a PAN-India shipping estimate.
 *
 * Kept as the last resort only: a whole region is too coarse on its own —
 * region 3 spans Rajasthan and Gujarat, so Jaipur measured ~67 km from
 * Ahmedabad. {@link POSTAL_SUBREGION_CENTROIDS} is consulted first.
 */
const POSTAL_REGION_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
  '1': [29.1, 77.2],
  '2': [27.1, 80.0],
  '3': [23.6, 73.6],
  '4': [20.6, 77.4],
  '5': [15.8, 78.0],
  '6': [10.8, 77.1],
  '7': [24.5, 89.4],
  '8': [21.7, 86.6],
  '9': [23.0, 77.0],
}

/**
 * Approximate centroids keyed by the first two PIN digits (the postal
 * sub-region / sorting district). Each point is the main sorting city of that
 * sub-region, accurate to roughly 100–200 km — enough to put a destination in
 * the right distance band, which is all the estimate uses it for.
 */
const POSTAL_SUBREGION_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
  // Delhi, Haryana, Punjab, Himachal, J&K
  '11': [28.6, 77.2],
  '12': [28.9, 76.6],
  '13': [29.7, 76.3],
  '14': [31.0, 75.6],
  '15': [30.3, 74.9],
  '16': [30.7, 76.8],
  '17': [31.6, 77.0],
  '18': [32.9, 74.9],
  '19': [34.1, 74.8],
  // Uttar Pradesh, Uttarakhand
  '20': [27.9, 78.1],
  '21': [25.6, 81.8],
  '22': [26.6, 81.6],
  '23': [25.3, 83.0],
  '24': [29.5, 78.4],
  '25': [28.6, 78.3],
  '26': [29.6, 79.6],
  '27': [26.8, 83.4],
  '28': [26.2, 78.5],
  // Rajasthan
  '30': [26.9, 75.8],
  '31': [26.0, 74.6],
  '32': [25.2, 75.8],
  '33': [28.0, 73.3],
  '34': [26.3, 73.0],
  // Gujarat
  '36': [22.3, 70.8],
  '37': [23.2, 69.7],
  '38': [23.0, 72.6],
  '39': [21.7, 73.0],
  // Maharashtra, Goa
  '40': [19.1, 72.9],
  '41': [18.5, 73.9],
  '42': [20.0, 74.0],
  '43': [19.9, 75.3],
  '44': [21.1, 79.1],
  // Madhya Pradesh, Chhattisgarh
  '45': [22.7, 75.9],
  '46': [23.3, 77.4],
  '47': [26.2, 78.2],
  '48': [23.2, 79.9],
  '49': [21.3, 81.6],
  // Telangana, Andhra Pradesh
  '50': [17.4, 78.5],
  '51': [15.0, 78.0],
  '52': [16.4, 80.5],
  '53': [17.7, 83.2],
  // Karnataka
  '56': [13.0, 77.6],
  '57': [12.3, 76.6],
  '58': [15.4, 75.1],
  '59': [15.8, 74.5],
  // Tamil Nadu, Puducherry
  '60': [13.1, 80.3],
  '61': [11.0, 79.3],
  '62': [9.9, 78.1],
  '63': [11.7, 78.1],
  '64': [11.0, 77.0],
  // Kerala, Lakshadweep
  '67': [11.3, 75.8],
  '68': [9.9, 76.3],
  '69': [8.5, 76.9],
  // West Bengal, Andaman & Nicobar (744 is handled below)
  '70': [22.6, 88.4],
  '71': [22.6, 88.2],
  '72': [22.8, 87.3],
  '73': [26.3, 88.6],
  '74': [22.6, 88.0],
  // Odisha
  '75': [20.3, 85.8],
  '76': [19.3, 84.8],
  '77': [21.5, 84.0],
  // Assam, North-East
  '78': [26.1, 91.7],
  '79': [25.6, 93.6],
  // Bihar, Jharkhand
  '80': [25.6, 85.1],
  '81': [25.2, 86.9],
  '82': [23.8, 86.4],
  '83': [23.3, 85.3],
  '84': [26.1, 85.4],
  '85': [25.8, 87.5],
}

/** Island and high-altitude prefixes far from their sub-region's sorting city. */
const POSTAL_DISTRICT_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
  '194': [34.2, 77.6], // Ladakh
  '744': [11.7, 92.7], // Andaman & Nicobar
}

function postalCentroid(pincode: string): readonly [number, number] | null {
  return (
    POSTAL_DISTRICT_CENTROIDS[pincode.slice(0, 3)] ??
    POSTAL_SUBREGION_CENTROIDS[pincode.slice(0, 2)] ??
    POSTAL_REGION_CENTROIDS[pincode[0]!] ??
    null
  )
}

/** Best-effort reference row for a valid pincode absent from our local table. */
export function estimatedPincodeInfo(pincode: string): PincodeInfo | null {
  if (!/^[1-9][0-9]{5}$/.test(pincode)) return null
  const centroid = postalCentroid(pincode)
  if (!centroid) return null
  return {
    estimated: true,
    pincode,
    taluk: '',
    district: '',
    // Empty deliberately: this is a distance estimate, not an invented state.
    state: '',
    lat: centroid[0],
    lng: centroid[1],
  }
}

/**
 * The (origin, destination) zone, or `null` when the shipment cannot be priced
 * at all.
 *
 * `null` is returned — and MUST be treated as not-serviceable, never as free —
 * only when the pincode is malformed or neither a reference row nor a coarse
 * postal-region estimate is available. Valid Indian pincodes are not rejected
 * because we have not imported their individual reference rows.
 *
 * Zone A is same-taluk rather than same-district: district equality
 * over-counts badly across the rural stretches of the Ahmedabad and Surat
 * districts. Taluk comparison is scoped by state and ignores blanks, so two
 * un-populated taluk fields never collapse a cross-state shipment into Zone A.
 *
 * `serviceableStates` is deliberately ignored. It remains an argument while
 * existing admin/config callers migrate, but it is no longer an order or quote
 * restriction: Laanya ships PAN India.
 */
export function zoneFor(
  originPincode: string,
  destPincode: string,
  index: ReadonlyMap<string, PincodeInfo>,
  _serviceableStates: string[]
): Zone | null {
  const dest = index.get(destPincode) ?? estimatedPincodeInfo(destPincode)
  if (!dest) return null
  const destState = dest.state.trim().toLowerCase()

  if (originPincode === destPincode) return 'A'

  const origin = index.get(originPincode) ?? estimatedPincodeInfo(originPincode)
  if (!origin) return null

  const originState = origin.state.trim().toLowerCase()
  const sameState = originState !== '' && originState === destState && destState !== ''

  // Unknown reference rows carry an empty state and a coarse regional
  // centroid. Use only a broad local-vs-national distance band; quote rates
  // remain an estimate until Delhivery's real pincode rate is available.
  if (originState === '' || destState === '') {
    if (origin.lat != null && origin.lng != null && dest.lat != null && dest.lng != null) {
      return haversineKm(origin.lat, origin.lng, dest.lat, dest.lng) <= 300 ? 'B' : 'D'
    }
    return 'D'
  }

  // Remoteness of the DESTINATION overrides the ordinary same/cross-state
  // split — a Gujarat-to-Guwahati parcel is Zone E regardless of same-taluk
  // logic, which only ever applies within a single non-remote state today.
  if (!sameState && REMOTE_ZONE_STATES.has(destState)) return 'E'
  if (!sameState) return 'D'

  const originTaluk = origin.taluk.trim().toLowerCase()
  const destTaluk = dest.taluk.trim().toLowerCase()
  if (originTaluk !== '' && originTaluk === destTaluk) return 'A'

  return 'B'
}

/** Great-circle distance in km. Ranking tie-break only — never a price input. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// --- Serviceability ----------------------------------------------------------

/** Six-digit pincode → number, or null when it isn't one. */
function pinValue(pincode: string): number | null {
  if (!/^[1-9][0-9]{5}$/.test(pincode)) return null
  return Number(pincode)
}

/**
 * Does this courier serve this pincode? An exception row is the truth and wins
 * in BOTH directions (it can carve a hole in a covered range, or add a pincode
 * outside every range). Otherwise any active range containing it counts. No
 * range and no exception means no.
 */
export function serviceable(
  pincode: string,
  areas: ServiceArea[],
  exceptions: ServiceException[]
): boolean {
  const exception = exceptions.find((e) => e.pincode === pincode)
  if (exception) return exception.serviceable

  const pin = pinValue(pincode)
  if (pin === null) return false

  return areas.some((area) => {
    if (!area.isActive) return false
    const from = pinValue(area.fromPincode)
    const to = pinValue(area.toPincode)
    if (from === null || to === null) return false
    return pin >= from && pin <= to
  })
}

// --- Slab lookup -------------------------------------------------------------

/**
 * Generic slab lookup shared by the courier rate card and the customer price
 * list, because they are the same shape and must not drift apart.
 *
 * Returns the smallest slab whose ceiling covers the weight. Above the top
 * slab it extrapolates with the TOP row's step
 * (`top + ceil((g − topUptoG)/perG) × perStep`).
 *
 * Returns `null` — never 0 — when the zone has no rows at all, and also when
 * the weight exceeds the table but no positive per-step charge is configured.
 * A rate card that stops at 5 kg genuinely cannot price a 7 kg parcel, and
 * quoting the 5 kg price for it would be a silent giveaway.
 */
function lookupSlab(
  rows: Array<{ uptoG: number; amountInr: number }>,
  weightG: number,
  addl: { perG: number; amountInr: number } | undefined
): number | null {
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => a.uptoG - b.uptoG)

  const match = sorted.find((row) => weightG <= row.uptoG)
  if (match) return match.amountInr

  const top = sorted[sorted.length - 1]!
  const step = addl ?? { perG: 0, amountInr: 0 }
  if (!(step.perG > 0) || !(step.amountInr > 0)) return null

  const over = weightG - top.uptoG
  return top.amountInr + Math.ceil(over / step.perG) * step.amountInr
}

/** Base freight (pre-fuel, pre-GST) for a courier at this zone and weight; null = cannot price. */
export function baseFreightInr(slabs: RateSlab[], zone: Zone, weightG: number): number | null {
  const inZone = slabs.filter((slab) => slab.zone === zone)
  if (inZone.length === 0) return null
  const top = [...inZone].sort((a, b) => a.uptoG - b.uptoG)[inZone.length - 1]!
  return lookupSlab(
    inZone.map((slab) => ({ uptoG: slab.uptoG, amountInr: slab.rateInr })),
    weightG,
    { perG: top.addlPerG, amountInr: top.addlRateInr }
  )
}

/**
 * Price a nationwide estimate from a usable local slab and distance when the
 * exact lane has not been loaded yet. The requested zone remains on the quote;
 * this only supplies a non-zero ballpark cost rather than rejecting a valid
 * Indian pincode or accidentally shipping it free.
 */
export function estimatedBaseFreightInr(
  slabs: RateSlab[],
  weightG: number,
  distanceKm: number
): number | null {
  // Anchor the estimate to a local slab at this parcel's weight. Distance
  // bands are intentionally coarse: <=300 km 1x, <=1000 km 1.25x,
  // <=2000 km 1.5x, farther 1.75x. These are estimates, not carrier tariffs.
  const multiplier =
    distanceKm <= 300 ? 1 : distanceKm <= 1000 ? 1.25 : distanceKm <= 2000 ? 1.5 : 1.75
  for (const fallback of ['B', 'A', 'D', 'E', 'C', 'F'] as const) {
    const estimate = baseFreightInr(slabs, fallback, weightG)
    if (estimate !== null && estimate > 0) return Math.ceil(estimate * multiplier)
  }
  return null
}

/**
 * What the shopper is charged: true courier cost plus a flat markup
 * (`marginBps`, basis points — 1000 = 10%), applied uniformly across every
 * zone and weight tier. Replaces the old hand-typed customer slab ladder
 * (SPEC-SHIPPING D4) with a number that is provably >= true cost and tracks
 * the real rate card automatically — no separately-maintained table to drift
 * out of sync with what the courier actually bills.
 */
export function customerFeeInr(trueCostInr: number, marginBps: number): number {
  return Math.round((Math.max(0, trueCostInr) * (10_000 + Math.max(0, marginBps))) / 10_000)
}

/**
 * A fee after the promotional `feeDiscountBps` cut (5000 = half). Clamped to
 * 0–100% so a typo can neither raise the fee nor turn it into a credit.
 */
export function discountedFeeInr(feeInr: number, feeDiscountBps: number): number {
  const bps = Math.min(10_000, Math.max(0, feeDiscountBps))
  return Math.round((Math.max(0, feeInr) * (10_000 - bps)) / 10_000)
}

/** True courier cost → what the shopper is quoted: margin on, then the discount off. */
export function shopperFeeInr(
  trueCostInr: number,
  rule: Pick<ShippingRule, 'marginBps' | 'feeDiscountBps'>
): number {
  return discountedFeeInr(customerFeeInr(trueCostInr, rule.marginBps), rule.feeDiscountBps)
}

// --- True cost ---------------------------------------------------------------

/** The cost inputs of a courier — the subset {@link trueCostInr} reads. */
export type CostInputs = Pick<
  ShippingCourier,
  'fuelBps' | 'gstBps' | 'docketFeeInr' | 'riskBps' | 'riskMinInr' | 'codFlatInr' | 'codBps'
>

/**
 * The courier's bill, split the way the courier's own tax invoice splits it.
 * Whole rupees; `preTaxInr + gstInr === totalInr` exactly, by construction.
 *
 * The GST line is the reason this exists rather than just {@link trueCostInr}:
 * freight is an input service, its tax is claimable as ITC, and a report cannot
 * back that figure out of a GST-INCLUSIVE rounded total without inventing
 * rupees. So the split is computed once, here, and frozen onto the order
 * (`services/shipping.ts` `ShippingSnapshot`) — same discipline as the tax on
 * an invoice line.
 */
export interface FreightCost {
  baseInr: number
  fuelInr: number
  docketInr: number
  riskInr: number
  codInr: number
  /** base + fuel + docket + risk + COD, rounded. */
  preTaxInr: number
  /** The rate used, in basis points — frozen so a later rate-card edit cannot restate a filed period. */
  gstBps: number
  gstInr: number
  totalInr: number
}

/**
 * The frozen rate a {@link FreightCost} was charged at, in basis points. The
 * sole accessor for callers outside this module and `services/shipping.ts` —
 * `test/arch/shipping-containment.test.ts` keeps the cost formula's own field
 * names out of every other file, so a reporting module (ITC-on-freight) reads
 * the rate through here rather than naming the field itself.
 */
export function freightRateBps(cost: FreightCost): number {
  return cost.gstBps
}

/**
 * What the courier actually bills us, split into its components:
 *
 *   base + fuel(% of base) + docket + risk + COD + GST(% of everything above)
 *
 * All six components of a real Indian surface rate card. Omitting docket and
 * risk understates every shipment by a fixed amount and makes the customer
 * slab table look more profitable than it is, so they are folded in pre-GST
 * where the carrier puts them.
 *
 * Risk and COD are `max(flat minimum, percentage of declared value)` — the
 * shape carriers actually publish, not a plain percentage.
 *
 * **`totalInr` is rounded ONCE**, from the unrounded sum — intermediate
 * rounding drifts, and this number is compared against the customer fee to
 * report a margin. `gstInr` is then taken as the REMAINDER against a rounded
 * `preTaxInr`, not rounded independently, so the two components always sum to
 * the total and a reconciliation can never be off by a rupee that came from
 * nowhere.
 */
export function freightCost(
  courier: CostInputs,
  baseInr: number,
  declaredValueInr: number,
  isCod: boolean
): FreightCost {
  const base = Math.max(0, baseInr)
  const fuel = (base * Math.max(0, courier.fuelBps)) / 10_000
  const docket = Math.max(0, courier.docketFeeInr)
  const risk =
    courier.riskBps > 0
      ? Math.max(courier.riskMinInr, (Math.max(0, declaredValueInr) * courier.riskBps) / 10_000)
      : 0
  const cod = isCod
    ? Math.max(
        courier.codFlatInr,
        (Math.max(0, declaredValueInr) * Math.max(0, courier.codBps)) / 10_000
      )
    : 0
  const gstBps = Math.max(0, courier.gstBps)
  const preTax = base + fuel + docket + risk + cod
  const gst = (preTax * gstBps) / 10_000

  const totalInr = Math.round(preTax + gst)
  const preTaxInr = Math.round(preTax)
  return {
    baseInr: Math.round(base),
    fuelInr: Math.round(fuel),
    docketInr: Math.round(docket),
    riskInr: Math.round(risk),
    codInr: Math.round(cod),
    preTaxInr,
    gstBps,
    gstInr: totalInr - preTaxInr,
    totalInr,
  }
}

/**
 * The courier's bill as a single number — the selection and margin path, which
 * has no use for the split. Byte-identical to what this returned before
 * {@link freightCost} existed: same inputs, same single rounding.
 */
export function trueCostInr(
  courier: CostInputs,
  baseInr: number,
  declaredValueInr: number,
  isCod: boolean
): number {
  return freightCost(courier, baseInr, declaredValueInr, isCod).totalInr
}

// --- Free shipping -----------------------------------------------------------

/**
 * The free-shipping tier that applies at this chargeable weight: the first
 * tier whose ceiling covers it.
 *
 * `null` when the cart is heavier than every tier, and that means NEVER FREE.
 * A single value threshold applied to a heavy cart is how a ₹249 order ends up
 * paying ₹425 of freight; the weight ceiling is what stops that.
 */
export function freeTierFor(tiers: FreeTier[], weightG: number): FreeTier | null {
  const sorted = [...tiers].sort((a, b) => a.uptoG - b.uptoG)
  return sorted.find((tier) => weightG <= tier.uptoG) ?? null
}

/**
 * Has this cart earned free delivery? Reaching the threshold EXACTLY qualifies
 * (`>=`), matching `qualifiesForWholesale` — "spend ₹249 to unlock" has to
 * trigger at ₹249. A missing tier or a non-positive threshold never qualifies.
 */
export function qualifiesForFreeShipping(basisInr: number, tier: FreeTier | null): boolean {
  if (!tier) return false
  if (!(tier.freeAboveInr > 0)) return false
  return basisInr >= tier.freeAboveInr
}

/** The fee outcome for one threshold basis — see {@link resolveFee} for the clamp. */
export interface FeeOutcome {
  feeInr: number
  freeApplied: boolean
  /** The threshold for THIS cart's weight tier; 0 when no tier applies. */
  freeAboveInr: number
  /** How much more spend unlocks free delivery; 0 once free (or when unreachable). */
  remainingInr: number
  /**
   * The waiver came from an applied coupon rather than from clearing the
   * threshold. Separate from `freeApplied` (which is true either way) purely so
   * client copy can be truthful: "Free delivery with REFILL10" is a different
   * sentence from "You cleared ₹249", and offering "spend ₹130 more for free
   * delivery" to someone already getting it is the bug this distinguishes.
   */
  waivedByCoupon: boolean
}

/**
 * Apply the threshold to a gross fee under BOTH bases and take the cheaper.
 *
 * The clamp is not a nicety. With a post-coupon basis and no guard, a ₹260
 * cart that ships free becomes a ₹240 basis the moment a ₹20 coupon is
 * applied, drops below the ₹249 threshold, and re-acquires the fee — so
 * applying a discount RAISES the amount due. Pricing both bases and keeping
 * the lower fee makes that arithmetically impossible under either setting,
 * which is why the clamp lives here rather than in a caller.
 *
 * `couponWaivesShipping` short-circuits all of it. A coupon carrying
 * `waivesShipping` was promised as free delivery in the message that handed the
 * code out, so it cannot be subject to a threshold the recipient was never
 * shown — it wins over every basis and every tier, including the "heavier than
 * any tier, so NEVER free" case that `freeTierFor` returns `null` for.
 */
export function resolveFee(
  grossFeeInr: number,
  chargeableWeightG: number,
  preCouponInr: number,
  postCouponInr: number,
  rule: Pick<ShippingRule, 'freeAboveTiers' | 'thresholdBasis'>,
  couponWaivesShipping = false
): FeeOutcome {
  const tier = freeTierFor(rule.freeAboveTiers, chargeableWeightG)
  const chosenBasis = rule.thresholdBasis === 'postCoupon' ? postCouponInr : preCouponInr

  if (couponWaivesShipping) {
    return {
      feeInr: 0,
      freeApplied: true,
      // The tier is still REPORTED — the cart screen keeps showing what the
      // ordinary threshold is — but `remainingInr` is 0 because there is
      // nothing left to unlock.
      freeAboveInr: tier?.freeAboveInr ?? 0,
      remainingInr: 0,
      waivedByCoupon: true,
    }
  }

  const outcomeFor = (basisInr: number): FeeOutcome => {
    const free = qualifiesForFreeShipping(basisInr, tier)
    return {
      feeInr: free ? 0 : grossFeeInr,
      freeApplied: free,
      freeAboveInr: tier?.freeAboveInr ?? 0,
      remainingInr: free || !tier ? 0 : Math.max(0, tier.freeAboveInr - basisInr),
      waivedByCoupon: false,
    }
  }

  const chosen = outcomeFor(chosenBasis)
  if (chosen.freeApplied) return chosen

  // The clamp: never charge more than the pre-coupon basis would have.
  const preCoupon = outcomeFor(preCouponInr)
  return preCoupon.feeInr < chosen.feeInr ? preCoupon : chosen
}

// --- Selection ---------------------------------------------------------------

/** Everything {@link selectShipment} needs, all of it plain data. */
export interface SelectInput {
  lines: ShippingLine[]
  destPincode: string
  nodes: ShippingNode[]
  couriers: ShippingCourier[]
  pincodeIndex: ReadonlyMap<string, PincodeInfo>
  rule: ShippingRule
  /** Goods value for the risk/COD components. */
  declaredValueInr: number
  isCod: boolean
}

/** Does this node stock every sku in the cart? Zero allowlist rows means yes. */
function nodeStocksEveryLine(node: ShippingNode, lines: ShippingLine[]): boolean {
  if (node.skus.length === 0) return true
  const stocked = new Set(node.skus)
  return lines.every((line) => stocked.has(line.sku))
}

/** SLA for a zone. Zones beyond B have no seeded SLA, so Zone-B days are the floor estimate. */
function slaDaysFor(courier: ShippingCourier, zone: Zone): number {
  return zone === 'A' ? courier.slaDaysZoneA : courier.slaDaysZoneB
}

/**
 * Rank two priced candidates. The primary key follows `rule.rankBy`; the rest
 * of the chain is fixed, and ends in code comparisons so the winner is
 * DETERMINISTIC — an unstable winner would mean a quote token that stops
 * matching between the cart screen and checkout.
 */
function compareCandidates(a: Candidate, b: Candidate, rankBy: ShippingRule['rankBy']): number {
  // Prefer a covered lane's published rate to a ballpark whenever available.
  if (a.estimated !== b.estimated) return a.estimated ? 1 : -1
  const byCost = a.trueCostInr - b.trueCostInr
  const bySla = a.slaDays - b.slaDays
  const byReliability = b.reliabilityScore - a.reliabilityScore
  const chain =
    rankBy === 'sla'
      ? [bySla, byCost, byReliability]
      : rankBy === 'reliability'
        ? [byReliability, byCost, bySla]
        : [byCost, bySla, byReliability]

  for (const step of chain) if (step !== 0) return step

  const aKm = a.distanceKm ?? Number.POSITIVE_INFINITY
  const bKm = b.distanceKm ?? Number.POSITIVE_INFINITY
  if (aKm !== bKm) return aKm - bKm
  return a.nodeCode.localeCompare(b.nodeCode) || a.courierCode.localeCompare(b.courierCode)
}

/**
 * Price every viable (node, courier) pairing and pick the best.
 *
 * Chargeable weight is computed INSIDE the loop, not once for the cart: the
 * volumetric divisor and the minimum billable weight are per-courier, so two
 * carriers legitimately disagree about how heavy the same parcel is, and that
 * disagreement can change who wins. The chosen candidate's weight is what the
 * contract reports.
 *
 * When nothing is viable the `reason` distinguishes the causes, in the order
 * that makes them actionable: an unweighed or undimensioned sku is a catalog
 * problem, a cart no node stocks is an inventory problem, and everything else
 * is coverage. None of them is a free shipment.
 */
export function selectShipment(input: SelectInput): Shipment {
  const { rule } = input

  if (input.lines.length === 0) return { winner: null, candidates: [], reason: null }
  if (!input.destPincode) return { winner: null, candidates: [], reason: 'no_destination' }

  const lines = resolveLineWeights(input.lines, rule)
  if (!lines) return { winner: null, candidates: [], reason: 'weight_unknown' }
  if (!hasMeasuredDims(lines)) return { winner: null, candidates: [], reason: 'dims_unknown' }

  const stockingNodes = input.nodes.filter((node) => nodeStocksEveryLine(node, lines))
  if (stockingNodes.length === 0) {
    return { winner: null, candidates: [], reason: 'no_single_node' }
  }

  const dest = input.pincodeIndex.get(input.destPincode) ?? estimatedPincodeInfo(input.destPincode)
  if (!dest) return { winner: null, candidates: [], reason: 'not_serviceable' }
  const destCoords =
    dest.lat != null && dest.lng != null ? dest : estimatedPincodeInfo(input.destPincode)
  const dead = deadWeightG(lines, rule.tareG)
  const parcelDims = cartParcelDims(lines)
  const candidates: Candidate[] = []

  for (const node of stockingNodes) {
    const origin = input.pincodeIndex.get(node.pincode) ?? estimatedPincodeInfo(node.pincode)
    const originCoords =
      node.lat != null && node.lng != null
        ? node
        : origin?.lat != null && origin.lng != null
          ? origin
          : estimatedPincodeInfo(node.pincode)
    const distanceKm =
      originCoords?.lat != null &&
      originCoords.lng != null &&
      destCoords?.lat != null &&
      destCoords.lng != null
        ? Math.round(
            haversineKm(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng) * 10
          ) / 10
        : null
    for (const courier of input.couriers) {
      // v1 prices weight-based rate cards only; a distance-model courier is a
      // declared seam (couriers.rateModel), not a silently mispriced quote.
      if (courier.rateModel !== 'weight') continue
      const covered =
        serviceable(node.pincode, courier.serviceAreas, courier.serviceExceptions) &&
        serviceable(input.destPincode, courier.serviceAreas, courier.serviceExceptions)
      const canEstimate = courier.code.toLowerCase() === 'delhivery'
      if (!covered && !canEstimate) continue

      const zone = zoneFor(
        node.pincode,
        input.destPincode,
        input.pincodeIndex,
        rule.serviceableStates
      )
      if (!zone) continue

      const vol = cartVolumetricG(lines, courier.volumetricDivisor, rule.volumetricPackFactor)
      const weight = chargeableG(dead, vol, courier.minChargeableG)

      const exactBase = baseFreightInr(courier.slabs, zone, weight)
      const estimated =
        !covered || dest.estimated === true || origin?.estimated === true || exactBase === null
      if (estimated && !canEstimate) continue
      const base = estimated
        ? distanceKm === null
          ? null
          : estimatedBaseFreightInr(courier.slabs, weight, distanceKm)
        : exactBase
      if (base === null) continue

      // One computation, two readers: the selection path takes the total, the
      // ITC report takes the split. Calling both entry points would price the
      // same parcel twice and invite them to disagree.
      const cost = freightCost(courier, base, input.declaredValueInr, input.isCod)
      // Same inputs, COD forced on — see `Candidate.codCost`. Pure arithmetic
      // on numbers already in hand; no second lookup, no second rate read.
      const codCost = input.isCod ? cost : freightCost(courier, base, input.declaredValueInr, true)

      candidates.push({
        estimated,
        nodeId: node.id,
        nodeCode: node.code,
        courierCode: courier.code,
        courierName: courier.name,
        zone,
        chargeableWeightG: weight,
        lengthCm: parcelDims.lengthCm,
        widthCm: parcelDims.widthCm,
        heightCm: parcelDims.heightCm,
        trueCostInr: cost.totalInr,
        cost,
        codCost,
        slaDays: estimated
          ? Math.max(slaDaysFor(courier, zone), 2 + Math.ceil((distanceKm ?? 1000) / 500))
          : slaDaysFor(courier, zone),
        reliabilityScore: courier.reliabilityScore,
        nodeCutoffIst: node.cutoffIst,
        distanceKm,
      })
    }
  }

  if (candidates.length === 0) return { winner: null, candidates: [], reason: 'not_serviceable' }

  const ranked = [...candidates].sort((a, b) => compareCandidates(a, b, rule.rankBy))
  return { winner: ranked[0]!, candidates: ranked, reason: null }
}

// --- Estimated delivery date --------------------------------------------------

/** IST is UTC+5:30, fixed — India does not observe DST. */
const IST_OFFSET_MIN = 330

/**
 * The calendar date a shipment is expected to land, in IST, as `YYYY-MM-DD`.
 *
 * Two clocks matter. Whether `nowMs` falls before or after the winning node's
 * daily handover cutoff decides whether the parcel ships TODAY or TOMORROW —
 * a cutoff crossed at 3:05pm books the courier's next pickup, not today's, and
 * quoting the same date on both sides of that boundary would promise a date
 * the node cannot make. From that ship date, `slaDays` calendar days land the
 * estimate — the same count `winner.slaDays` already reports, just resolved
 * onto a calendar a shopper can hold a receipt against.
 *
 * Deliberately CALENDAR days, not business days: `slaDaysZoneA/B` are seeded
 * against network transit time, not a courier's working-week, and inventing a
 * business-day rule here would be a policy this file was never told. A
 * malformed `cutoffIst` falls back to 15:00, the same default the node table
 * itself uses, rather than failing the whole quote over a display refinement.
 *
 * `nowMs` is a caller-supplied timestamp, never read internally — this module
 * touches no clock of its own (see file header).
 */
export function estimatedDeliveryDate(nowMs: number, cutoffIst: string, slaDays: number): string {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(cutoffIst)
  const cutoffMinOfDay = match ? Number(match[1]) * 60 + Number(match[2]) : 15 * 60

  const ist = new Date(nowMs + IST_OFFSET_MIN * 60_000)
  const nowMinOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  const shipOffsetDays = nowMinOfDay < cutoffMinOfDay ? 0 : 1

  const totalOffsetDays = shipOffsetDays + Math.max(0, Math.round(slaDays))
  const delivery = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + totalOffsetDays)
  )

  const yyyy = delivery.getUTCFullYear()
  const mm = String(delivery.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(delivery.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
