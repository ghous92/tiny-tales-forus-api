/**
 * Delhivery carrier adapter — the fulfilment module's ONLY door to a carrier
 * (docs/SPEC-LOGISTICS.md §6). No DB imports, no config imports: credentials
 * arrive as plain values from the ROUTE layer, exactly as `lib/razorpay.ts`
 * takes its keys.
 *
 * Everything is expressed through {@link CarrierAdapter} rather than as free
 * functions, because FEASIBILITY-LOGISTICS §5.2 committed to carrier
 * pluggability: the cost row in the scorecard is soft, and if a second carrier
 * ever quotes materially cheaper the answer must be "write a second adapter",
 * not "re-plumb fulfilment".
 *
 * Delhivery-specific traps encoded here so no caller has to remember them:
 *
 * - **Auth is `Authorization: Token <key>`**, not Bearer.
 * - **Manifest is form-encoded, not JSON.** The body is literally
 *   `format=json&data=<json>` — documented as "a must to have in the payload
 *   JSON body" and the single most common integration failure.
 * - **`pickup_location.name` is exact and case-sensitive.** A mismatch is a
 *   hard error from their side, so it comes from config rather than being
 *   derived from our own `pickup_nodes.name`.
 * - **Their APIs answer 200 with an error body.** `{"success": false, …}` and
 *   per-package `rmk` strings both mean failure at HTTP 200, so success is
 *   read out of the body, never out of the status line.
 * - **Rate limits differ per endpoint** — tracking 750/5min/IP, invoice
 *   40/min, waybill 50k/5min. The reconcile sweep is batched against the
 *   tightest one that matters (SPEC-LOGISTICS §5.2).
 */

import type { CarrierScan } from './fulfilmentStatus.js'

/** Resolved carrier credentials for one request path. */
export interface CarrierConfig {
  /** `https://staging-express.delhivery.com` (UAT) → `https://track.delhivery.com` (prod). */
  baseUrl: string
  /** The 12–16 char API token issued per account, per environment. */
  apiToken: string
  /** Registered client/HQ name. Some endpoints key off it. */
  clientName: string
  /** 'staging' when baseUrl points at staging-express — surfaced so ops can never confuse the two. */
  mode: 'staging' | 'live'
}

/** `staging-express` → 'staging'; anything else is treated as live (never assume staging). */
export function modeFromBaseUrl(baseUrl: string): 'staging' | 'live' {
  return baseUrl.includes('staging-express') ? 'staging' : 'live'
}

/** One parcel we are asking the carrier to move. Built from FROZEN order snapshots. */
export interface ManifestRequest {
  /** Our `payments.order_id` — their `order_id`, and what comes back as `ReferenceNo` on scans. */
  referenceNo: string
  /** Exact, case-sensitive registered warehouse name. */
  pickupLocationName: string
  consigneeName: string
  consigneePhone: string
  /** Single-line address; their parser rejects `& # % ; \` unescaped. */
  address: string
  city: string
  state: string
  pincode: string
  /** Whole rupees. Declared value — drives risk cover and the e-waybill threshold. */
  declaredValueInr: number
  weightG: number
  lengthCm?: number | undefined
  widthCm?: number | undefined
  heightCm?: number | undefined
  /** Free-text contents line for the label. */
  productDescription: string
  /** PACKAGE count, not units. Delhivery bills freight per package. */
  quantity: number
  /** Optional: pre-allocated from the waybill pool. Omitted ⇒ Delhivery assigns one. */
  waybill?: string | undefined
  sellerGstTin?: string | undefined
  hsnCode?: string | undefined
  /** Liquids. Passed ONLY when true — their docs say to omit the key otherwise. */
  fragile?: boolean | undefined
  /**
   * Whole rupees the DELIVERY AGENT must collect at the door. 0 ⇒ a prepaid
   * shipment, which is what every caller written before COD existed sends.
   *
   * On a partial-prepaid order this is the BALANCE, not the order total: the
   * ₹49 token already cleared through Razorpay, and asking the agent to
   * collect the full ₹700 would double-charge the shopper on their doorstep.
   */
  codAmountInr?: number | undefined
}

export interface ManifestResult {
  ok: boolean
  awb?: string | undefined
  /** Their remark / error text, verbatim, for `shipments.manifest_error`. */
  remark?: string | undefined
  /** The untouched response, for forensics. */
  raw: unknown
}

export interface PickupRequest {
  pickupLocationName: string
  /** `YYYY-MM-DD`. */
  pickupDate: string
  /** `HH:MM:SS`, IST. */
  pickupTime: string
  expectedPackageCount: number
}

export interface PickupResult {
  ok: boolean
  pickupId?: string | undefined
  remark?: string | undefined
  raw: unknown
}

export interface ServiceabilityRow {
  pincode: string
  prepaid: boolean
  cod: boolean
  district?: string | undefined
  state?: string | undefined
}

/** One weight point to price on a real (origin, destination) lane. */
export interface InvoiceChargeRequest {
  originPincode: string
  destPincode: string
  weightG: number
  isCod: boolean
}

/**
 * `null` when the lane could not be priced (no data, malformed body, or a
 * status they flagged as unbillable) — never 0. `chargeInr` is pre-fuel,
 * pre-GST base freight only, the same figure `SLAB_SEEDS`' comment in
 * `scripts/seed-shipping.ts` calls out as `charge_DL` — it maps straight onto
 * `courier_rate_slabs.rate_inr`, not onto `trueCostInr`/`freightCost`'s fuel
 * or GST components.
 */
export interface InvoiceChargeResult {
  chargeInr: number | null
  raw: unknown
}

export interface NdrRequest {
  waybill: string
  act: string
  /** `YYYY-MM-DD`, only for DEFER_DLV. */
  deferredDate?: string | undefined
  /** Only for EDIT_DETAILS. */
  name?: string | undefined
  phone?: string | undefined
  address?: string | undefined
}

export interface NdrResult {
  ok: boolean
  /** Their asynchronous handle. The API returns this instead of a result. */
  uplId?: string | undefined
  remark?: string | undefined
  raw: unknown
}

export interface SimpleResult {
  ok: boolean
  remark?: string | undefined
  raw: unknown
}

/**
 * The carrier-facing capability set the fulfilment SERVICE depends on.
 * Tests inject a fake; production gets {@link createDelhiveryAdapter}.
 */
export interface CarrierAdapter {
  readonly code: string
  readonly config: CarrierConfig
  manifest(req: ManifestRequest): Promise<ManifestResult>
  /** All scans the carrier holds for a waybill, oldest first, plus their delivery estimate. */
  track(waybill: string): Promise<TrackingResult>
  createPickup(req: PickupRequest): Promise<PickupResult>
  /** Their packing slip is JSON; rendering to PDF is ours to do. */
  label(waybill: string): Promise<SimpleResult>
  cancel(waybill: string): Promise<SimpleResult>
  ndrAction(req: NdrRequest): Promise<NdrResult>
  serviceability(pincode?: string): Promise<ServiceabilityRow[]>
  /**
   * Kinko rate-check — documented by Delhivery as *approximate*, capped at
   * 40 req/min (see the file-header comment). NEVER call this from the cart
   * read path (ADR D3, docs/SPEC-LOGISTICS.md §6.4) — it exists only for
   * `scripts/sync-delhivery-rates.ts` to propose `courier_rate_slabs` rows
   * for an operator to review and `--apply`.
   */
  invoiceCharges(req: InvoiceChargeRequest): Promise<InvoiceChargeResult>
}

/** Anything the carrier said that we could not turn into a result. */
export class CarrierError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message)
    this.name = 'CarrierError'
  }
}

/** Injected so tests drive the adapter without a network, and so timeouts are testable. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface AdapterOptions {
  fetchImpl?: FetchLike | undefined
  /** Per-request ceiling. A carrier hanging must not hold a sweep open. */
  timeoutMs?: number | undefined
}

/**
 * Their parser rejects `& # % ; \` in payload strings. Stripping is the right
 * move rather than escaping: these characters carry no meaning in an Indian
 * postal address, and a rejected manifest is a parcel that does not ship.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(/[&#%;\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read success out of a Delhivery body. They answer HTTP 200 for failures, so
 * the status line proves nothing; `success: false` and a per-package `rmk` are
 * both failure signals and they do not always appear together.
 */
export function readManifestBody(body: unknown): ManifestResult {
  const root = (body ?? {}) as Record<string, unknown>
  const packages = Array.isArray(root.packages) ? (root.packages as Record<string, unknown>[]) : []
  const first = packages[0] ?? {}
  const waybill = typeof first.waybill === 'string' ? first.waybill : undefined
  const remarkRaw = first.remarks ?? first.rmk ?? root.rmk ?? root.error
  const remark = Array.isArray(remarkRaw)
    ? remarkRaw.filter((r) => typeof r === 'string' && r.trim() !== '').join('; ')
    : typeof remarkRaw === 'string'
      ? remarkRaw
      : undefined

  // `success` is authoritative when present. When it is absent, a waybill is
  // the only evidence the parcel exists — no waybill means nothing shipped,
  // whatever else the body says.
  const successFlag = typeof root.success === 'boolean' ? root.success : undefined
  const packageStatus = typeof first.status === 'string' ? first.status.toLowerCase() : ''
  const ok =
    successFlag !== false &&
    waybill !== undefined &&
    waybill !== '' &&
    packageStatus !== 'fail' &&
    packageStatus !== 'failure'

  return {
    ok,
    awb: waybill,
    ...(remark !== undefined && remark !== '' ? { remark } : {}),
    raw: body,
  }
}

/**
 * Their tracking response nests scans at
 * `ShipmentData[].Shipment.Scans[].ScanDetail`, with the sibling `Shipment`
 * carrying the current status. Both shapes are tolerated because the pull API
 * and the push webhook disagree about casing in the wild, and their own docs
 * tell integrators not to apply hard checks.
 */
export interface TrackingResult {
  scans: CarrierScan[]
  /**
   * Delhivery's own `Shipment.ExpectedDeliveryDate` — null before pickup (they
   * do not estimate one for a parcel still on our shelf) and null whenever the
   * field itself is absent/unparseable. Never guessed from `PromisedDeliveryDate`
   * or any other field — this is the one their own docs call the estimate.
   */
  expectedDeliveryDate: Date | null
}

export function readTrackingBody(body: unknown): TrackingResult {
  const root = (body ?? {}) as Record<string, unknown>
  const data = Array.isArray(root.ShipmentData)
    ? (root.ShipmentData as Record<string, unknown>[])
    : []
  const out: CarrierScan[] = []
  let expectedDeliveryDate: Date | null = null

  for (const entry of data) {
    const shipment = (entry.Shipment ?? {}) as Record<string, unknown>
    const edd = parseCarrierDate(shipment.ExpectedDeliveryDate)
    if (edd !== null) expectedDeliveryDate = edd
    const scans = Array.isArray(shipment.Scans) ? (shipment.Scans as Record<string, unknown>[]) : []
    for (const scan of scans) {
      const detail = (scan.ScanDetail ?? scan) as Record<string, unknown>
      const when = parseCarrierDate(detail.StatusDateTime ?? detail.ScanDateTime)
      if (when === null) continue
      out.push({
        // Confirmed against a live prod tracking-pull payload (2026-08): each
        // `ScanDetail` carries its type as `ScanType`, not `StatusType` — that
        // key only appears on the sibling `Shipment.Status` block. Reading
        // `StatusType` here silently returned '' on every polled scan.
        statusType: str(detail.StatusType ?? detail.ScanType) ?? '',
        status: str(detail.Scan ?? detail.Status) ?? '',
        nslCode: str(detail.NSLCode),
        statusCode: str(detail.StatusCode),
        scanLocation: str(detail.ScannedLocation ?? detail.StatusLocation),
        instructions: str(detail.Instructions),
        scannedAt: when,
      })
    }
  }
  out.sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime())
  return { scans: out, expectedDeliveryDate }
}

/**
 * The webhook's single-scan shape (SPEC-LOGISTICS §5.1). Returns null rather
 * than throwing on a body we cannot read: the caller owes Delhivery a 200 and
 * a decision, not an exception.
 */
export function readWebhookScan(
  body: unknown
): { awb: string; referenceNo: string | undefined; scan: CarrierScan } | null {
  const root = (body ?? {}) as Record<string, unknown>
  const shipment = (root.Shipment ?? root.shipment) as Record<string, unknown> | undefined
  if (!shipment) return null

  const statusBlock = (shipment.Status ?? {}) as Record<string, unknown>
  // AWBs are digit strings, but they arrive as JSON numbers often enough that
  // rejecting one would drop a real scan over a type. Coerced, not refused.
  const awb = idLike(shipment.AWB ?? shipment.awb)
  if (awb === undefined || awb === '') return null

  const when = parseCarrierDate(statusBlock.StatusDateTime)
  if (when === null) return null

  return {
    awb,
    referenceNo: idLike(shipment.ReferenceNo),
    scan: {
      statusType: str(statusBlock.StatusType) ?? '',
      status: str(statusBlock.Status) ?? '',
      nslCode: str(shipment.NSLCode),
      statusCode: str(statusBlock.StatusCode),
      scanLocation: str(statusBlock.StatusLocation),
      instructions: str(statusBlock.Instructions),
      scannedAt: when,
    },
  }
}

/**
 * Their invoice/charges response is a bare JSON array (not `{data: [...]}`),
 * one entry per priced leg — a single-pincode-pair, single-weight request
 * still comes back wrapped in an array. `charge_DL` is documented as the
 * pre-fuel, pre-GST base freight (confirmed against the prod values recorded
 * in `scripts/seed-shipping.ts`'s `SLAB_SEEDS` comment). A non-numeric or
 * missing field, or an empty array, means "could not price" — read as `null`,
 * never coerced to 0.
 */
export function readInvoiceChargesBody(body: unknown): InvoiceChargeResult {
  const list = Array.isArray(body) ? body : []
  const first = (list[0] ?? {}) as Record<string, unknown>
  const raw = first.charge_DL
  const chargeInr = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  return { chargeInr, raw: body }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An identifier that may arrive as a JSON string or a JSON number. */
function idLike(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

/**
 * Their timestamps are IST wall-clock with no zone suffix
 * ("2019-01-09T17:10:42.767"). Parsing that with `new Date()` yields UTC and
 * silently shifts every scan 5h30m earlier — which would corrupt the scan
 * ordering that §4.3's out-of-order rule depends on. So a bare timestamp is
 * pinned to +05:30 explicitly.
 */
export function parseCarrierDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
  const parsed = new Date(hasZone ? raw : `${raw}+05:30`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function createDelhiveryAdapter(
  config: CarrierConfig,
  options: AdapterOptions = {}
): CarrierAdapter {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? 15_000
  const base = config.baseUrl.replace(/\/+$/, '')

  async function call(
    path: string,
    init: RequestInit & { method: string }
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Token ${config.apiToken}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        // Their error pages are HTML. Keep the text so the operator sees it.
      }
      if (res.status === 401 || res.status === 403) {
        throw new CarrierError('Delhivery rejected the API token', res.status, body)
      }
      return { status: res.status, body }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    code: 'delhivery',
    config,

    async manifest(req) {
      // The amount to collect drives the mode — one source of truth, so a
      // shipment can never be manifested as COD with nothing to collect, or as
      // prepaid while the agent is told to take cash.
      const codAmountInr = Math.max(0, Math.round(req.codAmountInr ?? 0))
      const shipment: Record<string, unknown> = {
        name: sanitizeText(req.consigneeName),
        order: req.referenceNo,
        payment_mode: codAmountInr > 0 ? 'COD' : 'Prepaid',
        add: sanitizeText(req.address),
        city: sanitizeText(req.city),
        state: sanitizeText(req.state),
        country: 'India',
        phone: req.consigneePhone,
        pin: req.pincode,
        products_desc: sanitizeText(req.productDescription),
        quantity: String(req.quantity),
        // 0 on a prepaid shipment. On a COD one this is the BALANCE due at the
        // door, never the order total — see `ManifestRequest.codAmountInr`.
        // `total_amount` stays the DECLARED value that risk cover and the ₹50k
        // e-waybill rule key off, which is the goods value on both modes.
        cod_amount: String(codAmountInr),
        total_amount: String(req.declaredValueInr),
        weight: String(req.weightG),
        shipment_width: req.widthCm !== undefined ? String(req.widthCm) : undefined,
        shipment_height: req.heightCm !== undefined ? String(req.heightCm) : undefined,
        shipment_length: req.lengthCm !== undefined ? String(req.lengthCm) : undefined,
        waybill: req.waybill,
        seller_gst_tin: req.sellerGstTin,
        hsn_code: req.hsnCode,
      }
      // Their docs are explicit: omit `fragile_shipment` entirely unless true.
      if (req.fragile === true) shipment.fragile_shipment = true

      const payload = {
        shipments: [prune(shipment)],
        pickup_location: { name: req.pickupLocationName },
      }

      // NOT JSON. `format=json&data=<json>` form encoding is mandatory here.
      const form = new URLSearchParams()
      form.set('format', 'json')
      form.set('data', JSON.stringify(payload))

      const { body } = await call('/api/cmu/create.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
      return readManifestBody(body)
    },

    async track(waybill) {
      const { body } = await call(`/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`, {
        method: 'GET',
      })
      return readTrackingBody(body)
    },

    async createPickup(req) {
      const { body } = await call('/fm/request/new/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup_location: req.pickupLocationName,
          pickup_date: req.pickupDate,
          pickup_time: req.pickupTime,
          expected_package_count: req.expectedPackageCount,
        }),
      })
      const root = (body ?? {}) as Record<string, unknown>
      const pickupId =
        root.pickup_id !== undefined && root.pickup_id !== null ? String(root.pickup_id) : undefined
      const remark = str(root.error ?? root.prs ?? root.message)
      return {
        ok: pickupId !== undefined,
        pickupId,
        ...(remark !== undefined ? { remark } : {}),
        raw: body,
      }
    },

    async label(waybill) {
      const { body } = await call(
        `/api/p/packing_slip?wbns=${encodeURIComponent(waybill)}&pdf=false`,
        { method: 'GET' }
      )
      const root = (body ?? {}) as Record<string, unknown>
      const packages = Array.isArray(root.packages) ? root.packages : []
      return { ok: packages.length > 0, raw: body }
    },

    async cancel(waybill) {
      const { body } = await call('/api/p/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Their API takes the string "true", not a boolean.
        body: JSON.stringify({ waybill, cancellation: 'true' }),
      })
      const root = (body ?? {}) as Record<string, unknown>
      const remark = str(root.remark ?? root.rmk ?? root.error)
      return {
        ok: root.status === true || root.status === 'Success',
        ...(remark !== undefined ? { remark } : {}),
        raw: body,
      }
    },

    async ndrAction(req) {
      const entry = prune({
        waybill: req.waybill,
        act: req.act,
        deferred_date: req.deferredDate,
        name: req.name !== undefined ? sanitizeText(req.name) : undefined,
        phone: req.phone,
        add: req.address !== undefined ? sanitizeText(req.address) : undefined,
      })
      const { body } = await call('/api/p/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [entry] }),
      })
      const root = (body ?? {}) as Record<string, unknown>
      // Asynchronous by design: a UPL id is a receipt, not a result.
      const uplId = str(root.upl_id ?? root.request_id ?? root.UPL)
      const remark = str(root.error ?? root.message)
      return {
        ok: uplId !== undefined,
        uplId,
        ...(remark !== undefined ? { remark } : {}),
        raw: body,
      }
    },

    async serviceability(pincode) {
      const query = pincode !== undefined ? `?filter_codes=${encodeURIComponent(pincode)}` : ''
      const { body } = await call(`/c/api/pin-codes/json/${query}`, { method: 'GET' })
      const root = (body ?? {}) as Record<string, unknown>
      const list = Array.isArray(root.delivery_codes)
        ? (root.delivery_codes as Record<string, unknown>[])
        : []
      const rows: ServiceabilityRow[] = []
      for (const item of list) {
        const codes = (item.postal_code ?? {}) as Record<string, unknown>
        const pin = codes.pin !== undefined && codes.pin !== null ? String(codes.pin) : undefined
        if (pin === undefined) continue
        rows.push({
          pincode: pin,
          // "Y"/"N" flags. Anything that is not an explicit yes is treated as
          // no — an over-optimistic serviceability read ships into a black hole.
          prepaid: yes(codes.pre_paid),
          cod: yes(codes.cod),
          district: str(codes.district),
          state: str(codes.state_code),
        })
      }
      return rows
    },

    async invoiceCharges(req) {
      const params = new URLSearchParams({
        md: 'S',
        ss: 'Delivered',
        o_pin: req.originPincode,
        d_pin: req.destPincode,
        cgm: String(req.weightG),
        pt: req.isCod ? 'COD' : 'Pre-paid',
      })
      const { body } = await call(`/api/kinko/v1/invoice/charges/.json?${params.toString()}`, {
        method: 'GET',
      })
      return readInvoiceChargesBody(body)
    },
  }
}

function yes(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === 'Y'
}

/** Drop undefined keys — their parser treats a null differently from an absent key. */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
