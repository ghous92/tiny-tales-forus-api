/**
 * GSTR-1 returns feed — the rate-wise figures a CA needs to file one period,
 * rendered as CSV. See `contracts/gstr1.ts` for which four reports exist and
 * why the list is that short.
 *
 * **This module only reads frozen documents.** Every figure comes out of
 * `invoices.document` / `credit_notes.document`, which were computed once by
 * `lib/gstTax.ts` at issue time and can never change. Nothing here recomputes
 * tax: a return must agree with the document the customer holds, and the only
 * way to guarantee that is to never do the arithmetic twice. The one thing
 * this module does compute is sums, and it sums integer paise, converting to
 * rupees exactly once per cell at render (`lib/csv.ts` `paiseToRupeeString`).
 *
 * **Credit notes are netted, not listed separately** (see the contract's note
 * on CDNUR): a refund of a B2CS supply reduces Table 7 in the period the note
 * was ISSUED. So every aggregate here carries a sign — `+1` for an invoice,
 * `-1` for a credit note — and a quiet month carrying refunds for a busy one
 * legitimately reports negative figures. Nothing clamps that; a clamped
 * negative is an under-declared credit, which is the CA's problem to see, not
 * this module's to hide.
 */

import { and, gte, lt, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { CreditNoteDocument } from '../contracts/creditNotes.js'
import type { Gstr1ExportQuery, Gstr1Report } from '../contracts/gstr1.js'
import type { InvoiceDocument } from '../contracts/invoices.js'
import type { Db } from '../db/client.js'
import { creditNotes, invoices } from '../db/schema.js'
import { csvDocument, paiseToRupeeString } from '../lib/csv.js'
import { conflict } from '../lib/errors.js'
import { formatPlaceOfSupply } from '../lib/gstStates.js'
import {
  formatInvoiceDate,
  istDayAfter,
  istFyBounds,
  istDayStart,
  istMonthBounds,
} from '../lib/invoiceFormat.js'

/**
 * The UQC (unit quantity code) every line reports in Table 12. The catalogue
 * is bottles, jars and tubes sold as countable units, so "NOS" (numbers) is
 * correct for all of it today. It is a constant rather than a per-product
 * field because inventing a per-sku UQC column that nobody maintains would
 * produce a *confidently wrong* return; when a product ships by weight or
 * volume this becomes a catalogue field and this constant goes away.
 */
const UQC = 'NOS'

/**
 * Table 7's supply type: `E` = supplied through e-commerce. CBIC FAQ 24 says
 * a person selling its own products through its own website is an ECO; FAQ 25
 * says own-account reseller sales do not attract section 52 TCS. Report the
 * channel as e-commerce while keeping TCS/GSTR-8 off these own supplies.
 */
const SUPPLY_TYPE = 'E'

/** One rate band of one document, sign-carrying. Paise throughout. */
interface Band {
  gstRatePct: number
  taxableValuePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
}

/** One line of one document, sign-carrying — Table 12 needs HSN, which lives per line. */
interface LineBand extends Band {
  hsn: string
  description: string
  qty: number
}

/**
 * An invoice or a credit note, normalised. `sign` is the only thing that
 * distinguishes their arithmetic, which is the point: a credit note is a
 * negative supply, not a different kind of record.
 */
interface Movement {
  docType: 'Invoice' | 'Credit Note'
  docNumber: string
  /**
   * WHOSE SUPPLY THIS IS — the GSTIN frozen onto the document at issue time,
   * empty on a `docVersion: 1` document issued before registration.
   *
   * Not decoration. Since `invoice.sellerOfRecord` exists, two documents in
   * one period can belong to two different suppliers (Adix selling as
   * principal, and the manufacturer selling under vendor fulfilment). A GSTR-1
   * is filed by ONE GSTIN and must contain only that GSTIN's outward supplies,
   * so `exportGstr1Csv` refuses to aggregate a period that spans two rather
   * than silently merging them into one unfileable return.
   */
  sellerGstin: string
  sellerLegalName: string
  issuedAt: Date
  docVersion: 1 | 2
  posCode: string
  totalPaise: number
  status: string
  sign: 1 | -1
  bands: Band[]
  lines: LineBand[]
}

/** The resolved reporting window. Both bounds optional — absent means unbounded on that side. */
interface Period {
  /** Explicit `| undefined`, not a bare `?`: the project runs `exactOptionalPropertyTypes`. */
  start?: Date | undefined
  /** Exclusive. See `istMonthBounds` for why the end bound is never an inclusive instant. */
  end?: Date | undefined
}

/**
 * `month` → that calendar month in IST. `from`/`to` → inclusive calendar
 * bounds. Neither → everything ever issued, which is what an auditor asking
 * for the whole history wants and what a first run before any filing produces.
 *
 * The contract rejects `month` together with `from`/`to` before this is
 * reached, so there is no precedence rule to get wrong here.
 */
export function resolvePeriod(query: Gstr1ExportQuery): Period {
  if (query.month) return istMonthBounds(query.month)
  if (query.fy) return istFyBounds(query.fy)
  return {
    start: query.from ? istDayStart(query.from) : undefined,
    end: query.to ? istDayAfter(query.to) : undefined,
  }
}

/**
 * `issued_at` window for either document table. Undefined ⇒ no predicate.
 *
 * Typed as the bare `PgColumn` rather than `typeof invoices.issuedAt`: drizzle
 * bakes the table name into a column's type, so the narrower form would only
 * accept `invoices` and reject the identically-shaped `credit_notes.issued_at`.
 */
function periodWhere(column: PgColumn, period: Period): SQL | undefined {
  const clauses: SQL[] = []
  if (period.start) clauses.push(gte(column, period.start))
  if (period.end) clauses.push(lt(column, period.end))
  if (clauses.length === 0) return undefined
  return clauses.length === 1 ? clauses[0] : and(...clauses)
}

/** Frozen invoice document → the normalised movement. */
function invoiceMovement(doc: InvoiceDocument, issuedAt: Date, totalPaise: number): Movement {
  const bands: Band[] = (doc.totals.rateWise ?? []).map((band) => ({
    gstRatePct: band.gstRatePct,
    taxableValuePaise: band.taxableValuePaise,
    cgstPaise: band.cgstPaise,
    sgstPaise: band.sgstPaise,
    igstPaise: band.igstPaise,
  }))

  // A docVersion 1 line has no hsn/rate at all, so it contributes no Table 12
  // row — but the document still surfaces in the `invoices` report. See the
  // contract's closing note on why it is not silently dropped.
  const lines: LineBand[] = doc.lines
    .filter((line) => line.hsn !== undefined && line.gstRatePct !== undefined)
    .map((line) => ({
      hsn: line.hsn as string,
      description: line.name,
      qty: line.qty,
      gstRatePct: line.gstRatePct as number,
      taxableValuePaise: line.taxableValuePaise ?? 0,
      cgstPaise: line.cgstPaise ?? 0,
      sgstPaise: line.sgstPaise ?? 0,
      igstPaise: line.igstPaise ?? 0,
    }))

  return {
    docType: 'Invoice',
    docNumber: doc.invoiceNumber,
    sellerGstin: doc.seller.gstin ?? '',
    sellerLegalName: doc.seller.legalName,
    issuedAt,
    docVersion: doc.docVersion,
    posCode: doc.placeOfSupply?.code ?? '',
    totalPaise,
    status: doc.status,
    sign: 1,
    bands,
    lines,
  }
}

/** Frozen credit-note document → the normalised movement, sign `-1`. */
function creditNoteMovement(doc: CreditNoteDocument, issuedAt: Date, totalPaise: number): Movement {
  return {
    docType: 'Credit Note',
    docNumber: doc.creditNoteNumber,
    sellerGstin: doc.seller.gstin ?? '',
    sellerLegalName: doc.seller.legalName,
    issuedAt,
    docVersion: 2,
    posCode: doc.placeOfSupply.code,
    totalPaise,
    status: 'refunded',
    sign: -1,
    bands: doc.totals.rateWise.map((band) => ({
      gstRatePct: band.gstRatePct,
      taxableValuePaise: band.taxableValuePaise,
      cgstPaise: band.cgstPaise,
      sgstPaise: band.sgstPaise,
      igstPaise: band.igstPaise,
    })),
    lines: doc.lines.map((line) => ({
      hsn: line.hsn,
      description: line.name,
      qty: line.qty,
      gstRatePct: line.gstRatePct,
      taxableValuePaise: line.taxableValuePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
    })),
  }
}

/** Every document issued in the window, invoices and credit notes together, oldest first. */
export async function loadMovements(db: Db, period: Period): Promise<Movement[]> {
  const invoiceWhere = periodWhere(invoices.issuedAt, period)
  const creditWhere = periodWhere(creditNotes.issuedAt, period)

  const [invoiceRows, creditRows] = await Promise.all([
    invoiceWhere
      ? db.select().from(invoices).where(invoiceWhere).orderBy(invoices.issuedAt)
      : db.select().from(invoices).orderBy(invoices.issuedAt),
    creditWhere
      ? db.select().from(creditNotes).where(creditWhere).orderBy(creditNotes.issuedAt)
      : db.select().from(creditNotes).orderBy(creditNotes.issuedAt),
  ])

  const movements = [
    ...invoiceRows.map((row) =>
      invoiceMovement(row.document as InvoiceDocument, row.issuedAt, row.totalPaise)
    ),
    ...creditRows.map((row) =>
      creditNoteMovement(row.document as CreditNoteDocument, row.issuedAt, row.totalPaise)
    ),
  ]
  return movements.sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
}

/** Running paise totals for one aggregation bucket. */
interface Accum {
  taxableValuePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  qty: number
  description: string
}

function emptyAccum(description = ''): Accum {
  return {
    taxableValuePaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    qty: 0,
    description,
  }
}

function addBand(into: Accum, band: Band, sign: 1 | -1): void {
  into.taxableValuePaise += sign * band.taxableValuePaise
  into.cgstPaise += sign * band.cgstPaise
  into.sgstPaise += sign * band.sgstPaise
  into.igstPaise += sign * band.igstPaise
}

/** Total tax of a bucket — exactly one of (cgst+sgst) or igst is non-zero, but summing all three is correct either way. */
function totalTaxPaise(accum: Accum): number {
  return accum.cgstPaise + accum.sgstPaise + accum.igstPaise
}

/**
 * **Table 7 — B2CS.** Aggregated by seller GSTIN × place of supply × rate,
 * credit notes netted in. The seller is also the ECO for this own-website
 * model, so its GSTIN is included. Cess remains empty.
 */
export function buildB2csRows(movements: Movement[]): (string | number)[][] {
  const buckets = new Map<string, Accum>()

  for (const movement of movements) {
    for (const band of movement.bands) {
      const key = `${movement.sellerGstin}|${movement.posCode}|${band.gstRatePct}`
      const accum = buckets.get(key) ?? emptyAccum()
      addBand(accum, band, movement.sign)
      buckets.set(key, accum)
    }
  }

  // Sorted on the PARSED key, not the composite string: `'12' < '5'`
  // lexicographically, which would print the 12% band above the 5% one and
  // read like a mistake on a filed return.
  return [...buckets.entries()]
    .map(([key, accum]) => {
      const [sellerGstin = '', posCode = '', rate = '0'] = key.split('|')
      return { sellerGstin, posCode, rate: Number(rate), accum }
    })
    .sort(
      (a, b) =>
        a.sellerGstin.localeCompare(b.sellerGstin) ||
        a.posCode.localeCompare(b.posCode) ||
        a.rate - b.rate
    )
    .map(({ sellerGstin, posCode, rate, accum }) => {
      return [
        SUPPLY_TYPE,
        formatPlaceOfSupply(posCode),
        rate,
        paiseToRupeeString(accum.taxableValuePaise),
        paiseToRupeeString(accum.igstPaise),
        paiseToRupeeString(accum.cgstPaise),
        paiseToRupeeString(accum.sgstPaise),
        '',
        sellerGstin,
      ]
    })
}

/**
 * **GSTR-3B — Tables 3.1(a) and 3.2.** The monthly summary return, derived
 * from the same frozen documents GSTR-1 is, so the two agree by construction
 * rather than by a human copying figures between them (a 3B that disagrees
 * with the 1 for the same month is the most common notice trigger there is).
 *
 * Two tables, one file, separated by a labelled band row:
 *
 * - **3.1(a)** Outward taxable supplies (other than zero-rated, nil-rated and
 *   exempted) — one line, all rates summed. That is what the portal asks for:
 *   a single taxable value and a single figure per tax head.
 * - **3.2** Of the supplies in 3.1(a), inter-state supplies made to
 *   UNREGISTERED persons, broken out by place of supply. A subset of 3.1(a),
 *   not an addition to it — the portal validates it that way, and adding the
 *   two is the classic double-count.
 *
 * **Table 4 (ITC) is deliberately absent.** ITC is claimed off the supplier's
 * own purchase invoices reconciled against GSTR-2B, and this system has never
 * seen a purchase invoice. The closest thing it holds is
 * `services/itcFreight.ts`, which is an ESTIMATE of freight tax, not a credit
 * claim. The eligible recipient is determined by the actual courier invoice
 * and ordinary ITC conditions. Emitting a Table 4 that confidently
 * under-states ITC would be worse than emitting none: an operator would file
 * it.
 */
export function buildGstr3bRows(movements: Movement[]): (string | number)[][] {
  const total = emptyAccum()
  const interStateByPos = new Map<string, Accum>()

  for (const movement of movements) {
    for (const band of movement.bands) {
      addBand(total, band, movement.sign)
      // Inter-state is decided by the frozen split, not re-derived: IGST is
      // non-zero on exactly the supplies that were inter-state at issue time.
      // Every buyer here is B2C and unregistered (no customer GSTIN is ever
      // collected), so an inter-state supply IS a 3.2 supply.
      if (band.igstPaise === 0) continue
      const accum = interStateByPos.get(movement.posCode) ?? emptyAccum()
      addBand(accum, band, movement.sign)
      interStateByPos.set(movement.posCode, accum)
    }
  }

  const rows: (string | number)[][] = [
    [
      '3.1(a) Outward taxable supplies (other than zero rated, nil rated and exempted)',
      '',
      paiseToRupeeString(total.taxableValuePaise),
      paiseToRupeeString(total.igstPaise),
      paiseToRupeeString(total.cgstPaise),
      paiseToRupeeString(total.sgstPaise),
      '',
    ],
    ['', '', '', '', '', '', ''],
    ['3.2 Of the above, inter-state supplies to unregistered persons', '', '', '', '', '', ''],
  ]

  const interState = [...interStateByPos.entries()].sort(([a], [b]) => a.localeCompare(b))
  if (interState.length === 0) {
    rows.push(['(none — every supply in this period was intra-state)', '', '', '', '', '', ''])
  }
  for (const [posCode, accum] of interState) {
    rows.push([
      '',
      formatPlaceOfSupply(posCode),
      paiseToRupeeString(accum.taxableValuePaise),
      paiseToRupeeString(accum.igstPaise),
      '',
      '',
      '',
    ])
  }

  rows.push(['', '', '', '', '', '', ''])
  rows.push([
    'Table 4 (ITC) is NOT derivable here — it comes from purchase invoices reconciled against GSTR-2B, which this system has never seen. See services/itcFreight.ts for the freight estimate and why it is a reconciliation input, not a claim.',
    '',
    '',
    '',
    '',
    '',
    '',
  ])
  return rows
}

/**
 * **GSTR-9 — the annual reconciliation input.** One row per calendar month in
 * the period, plus a total, carrying the figures Tables 4/9 of the annual
 * return are built from.
 *
 * The point is NOT to produce a filed annual return — GSTR-9 is reconciled
 * against the books and against what was ACTUALLY filed in each GSTR-1 and
 * GSTR-3B, and this system knows neither. The point is that the annual return
 * has to be tied back to twelve monthly filings, and doing that by re-running
 * a monthly export twelve times and re-typing the totals is where the
 * differences get introduced. Pass `?fy=26-27` and the whole financial year
 * comes out month by month, netted for credit notes exactly as each month's
 * own return was.
 *
 * GSTR-9 is optional below ₹2 crore aggregate turnover, which is where this
 * seller is. This is kept anyway: the waiver is renewed by notification each
 * financial year rather than being permanent, and the month-by-month view is
 * the fastest way to see that GSTR-1 and GSTR-3B agree.
 *
 * Months with no documents are omitted rather than printed as zeroes: a gap in
 * this file is a month with no supplies, which is a question worth asking, and
 * a zero row reads as an answer.
 */
export function buildAnnualRows(movements: Movement[]): (string | number)[][] {
  const byMonth = new Map<string, Accum & { docs: number }>()
  const total = { ...emptyAccum(), docs: 0 }

  for (const movement of movements) {
    // IST, matching `istMonthBounds` — a document issued 23:30 on the 31st
    // belongs to the month the seller filed it in, not to UTC's next one.
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
    }).format(movement.issuedAt)
    const accum = byMonth.get(month) ?? { ...emptyAccum(), docs: 0 }
    accum.docs += 1
    total.docs += 1
    for (const band of movement.bands) {
      addBand(accum, band, movement.sign)
      addBand(total, band, movement.sign)
    }
    byMonth.set(month, accum)
  }

  const rows = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, accum]) => [
      month,
      accum.docs,
      paiseToRupeeString(accum.taxableValuePaise),
      paiseToRupeeString(accum.igstPaise),
      paiseToRupeeString(accum.cgstPaise),
      paiseToRupeeString(accum.sgstPaise),
      paiseToRupeeString(totalTaxPaise(accum)),
    ])

  rows.push([
    'TOTAL',
    total.docs,
    paiseToRupeeString(total.taxableValuePaise),
    paiseToRupeeString(total.igstPaise),
    paiseToRupeeString(total.cgstPaise),
    paiseToRupeeString(total.sgstPaise),
    paiseToRupeeString(totalTaxPaise(total)),
  ])
  return rows
}

const B2CS_COLUMNS = [
  'Type',
  'Place Of Supply',
  'Rate',
  'Taxable Value',
  'Integrated Tax',
  'Central Tax',
  'State/UT Tax',
  'Cess Amount',
  'E-Commerce GSTIN',
] as const

/**
 * **Table 12 — HSN summary.** Grouped by HSN × rate, credit notes netted
 * (which also nets the quantity, so a fully refunded month reports zero of
 * that sku rather than a phantom sale). `Total Value` is taxable + tax, the
 * invoice value attributable to the band.
 */
export function buildHsnRows(movements: Movement[]): (string | number)[][] {
  const buckets = new Map<string, Accum>()

  for (const movement of movements) {
    for (const line of movement.lines) {
      const key = `${line.hsn}|${line.gstRatePct}`
      const accum = buckets.get(key) ?? emptyAccum(line.description)
      addBand(accum, line, movement.sign)
      accum.qty += movement.sign * line.qty
      buckets.set(key, accum)
    }
  }

  // Parsed-key sort, same reason as Table 7's — see `buildB2csRows`.
  return [...buckets.entries()]
    .map(([key, accum]) => {
      const [hsn = '', rate = '0'] = key.split('|')
      return { hsn, rate: Number(rate), accum }
    })
    .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
    .map(({ hsn, rate, accum }) => {
      const totalValue = accum.taxableValuePaise + totalTaxPaise(accum)
      return [
        hsn,
        accum.description,
        UQC,
        accum.qty,
        paiseToRupeeString(totalValue),
        rate,
        paiseToRupeeString(accum.taxableValuePaise),
        paiseToRupeeString(accum.igstPaise),
        paiseToRupeeString(accum.cgstPaise),
        paiseToRupeeString(accum.sgstPaise),
        '',
      ]
    })
}

const HSN_COLUMNS = [
  'HSN',
  'Description',
  'UQC',
  'Total Quantity',
  'Total Value',
  'Rate',
  'Taxable Value',
  'Integrated Tax',
  'Central Tax',
  'State/UT Tax',
  'Cess Amount',
] as const

/**
 * **Table 13 — documents issued.** One row per series per nature of document.
 * Split by series prefix (everything up to the last `/`) rather than one row
 * per nature, so a period that straddles 31 March reports FY 26-27 and 27-28
 * as the two separate series they legally are instead of one impossible range.
 *
 * `Cancelled` is hard `0`: an issued document is immutable here and there is
 * no cancellation path (see the module note on `routes/invoicesAdmin.ts`). The
 * column exists because the portal expects it.
 */
export function buildDocsRows(movements: Movement[]): (string | number)[][] {
  const series = new Map<string, { nature: string; numbers: string[] }>()

  for (const movement of movements) {
    const prefix = movement.docNumber.slice(0, movement.docNumber.lastIndexOf('/'))
    const nature = movement.docType === 'Invoice' ? 'Invoices for outward supply' : 'Credit Note'
    const key = `${nature}|${prefix}`
    const entry = series.get(key) ?? { nature, numbers: [] }
    entry.numbers.push(movement.docNumber)
    series.set(key, entry)
  }

  return [...series.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => {
      const sorted = [...entry.numbers].sort()
      return [entry.nature, sorted[0] ?? '', sorted[sorted.length - 1] ?? '', sorted.length, 0]
    })
}

const DOCS_COLUMNS = [
  'Nature of Document',
  'Sr. No. From',
  'Sr. No. To',
  'Total Number',
  'Cancelled',
] as const

/**
 * **Backing detail** — not a GSTR-1 table. One row per document per rate band,
 * so every figure in the three summaries can be traced to the documents behind
 * it. A `docVersion: 1` invoice appears here with an empty rate band, which is
 * what makes an unexplained gap between the sales register and the return
 * visible.
 *
 * Amounts are printed with the document's own sign, so a credit note's row
 * reads `-1180.00` and sums with the invoice rows above it.
 */
export function buildInvoiceDetailRows(movements: Movement[]): (string | number)[][] {
  const rows: (string | number)[][] = []

  for (const movement of movements) {
    const base = [
      movement.docType,
      movement.docNumber,
      formatInvoiceDate(movement.issuedAt),
      movement.docVersion,
      movement.posCode ? formatPlaceOfSupply(movement.posCode) : '',
    ]
    const docTotal = paiseToRupeeString(movement.sign * movement.totalPaise)

    if (movement.bands.length === 0) {
      rows.push([...base, '', '', '', '', '', docTotal, movement.status])
      continue
    }

    for (const band of movement.bands) {
      const signed = (paise: number): string => paiseToRupeeString(movement.sign * paise)
      rows.push([
        ...base,
        band.gstRatePct,
        signed(band.taxableValuePaise),
        signed(band.igstPaise),
        signed(band.cgstPaise),
        signed(band.sgstPaise),
        docTotal,
        movement.status,
      ])
    }
  }

  return rows
}

/**
 * Two GSTR-3B tables share one file, so the header is generic — the label
 * column says which table each band of rows belongs to. `Nature` carries the
 * place of supply for 3.2 and is blank on the 3.1(a) line, which has none.
 */
const ANNUAL_COLUMNS = [
  'Month',
  'Documents',
  'Taxable Value',
  'IGST',
  'CGST',
  'SGST/UTGST',
  'Total Tax',
] as const

const GSTR3B_COLUMNS = [
  'Table',
  'Nature',
  'Taxable Value',
  'IGST',
  'CGST',
  'SGST/UTGST',
  'Cess',
] as const

const INVOICE_DETAIL_COLUMNS = [
  'Doc Type',
  'Doc No',
  'Doc Date',
  'Doc Version',
  'Place Of Supply',
  'Rate',
  'Taxable Value',
  'Integrated Tax',
  'Central Tax',
  'State/UT Tax',
  'Doc Total',
  'Status',
] as const

const REPORTS: Record<
  Gstr1Report,
  { columns: readonly string[]; build: (movements: Movement[]) => (string | number)[][] }
> = {
  b2cs: { columns: B2CS_COLUMNS, build: buildB2csRows },
  hsn: { columns: HSN_COLUMNS, build: buildHsnRows },
  docs: { columns: DOCS_COLUMNS, build: buildDocsRows },
  invoices: { columns: INVOICE_DETAIL_COLUMNS, build: buildInvoiceDetailRows },
  '3b': { columns: GSTR3B_COLUMNS, build: buildGstr3bRows },
  annual: { columns: ANNUAL_COLUMNS, build: buildAnnualRows },
}

/** The rendered file plus what the caller needs to name and qualify it. */
export interface Gstr1Export {
  csv: string
  /**
   * The GSTIN this file is a return for. Empty only when the period holds
   * nothing but pre-registration `docVersion: 1` documents. The route puts it
   * in the filename — a CA holding two entities' exports must be able to tell
   * them apart without opening either.
   */
  sellerGstin: string
  sellerLegalName: string
  /** The section actually rendered, after the `b2cs` default is applied — the route puts it in the filename. */
  report: Gstr1Report
  /** Documents in the period, both natures. */
  events: number
  /**
   * How many of those carry no tax at all — `docVersion: 1` invoices. Inside a
   * registered period that is a supply the return does not account for, and
   * the summaries cannot say so on their own: `b2cs` and `hsn` simply have
   * nothing to add for such a document. Reported so the route can log it,
   * rather than left for someone to notice by reconciling row counts.
   */
  untaxed: number
}

/**
 * Render one GSTR-1 section for one period. Defaults to `b2cs` — the table
 * that is actually filed, and so the one an operator who passes no `report`
 * means.
 *
 * Naming the download is the route's job: the period is already validated
 * there, and a service that formats filenames is a service that has started
 * caring about HTTP.
 */
export async function exportGstr1Csv(db: Db, query: Gstr1ExportQuery): Promise<Gstr1Export> {
  const report: Gstr1Report = query.report ?? 'b2cs'
  const all = await loadMovements(db, resolvePeriod(query))

  // One return, one supplier. A period spanning the vendor-fulfilment switch
  // holds documents issued by two different GSTINs; aggregating them would
  // produce a Table 7 that is wrong for both entities and traceable to
  // neither. Fail closed and make the caller say which one they are filing.
  //
  // `docVersion: 1` documents carry no GSTIN (issued before registration) and
  // are not a second supplier — they ride along with whichever GSTIN is
  // selected, exactly as they did before, so the untaxed count still surfaces
  // them.
  const registered = all.filter((movement) => movement.sellerGstin !== '')
  const sellers = [...new Set(registered.map((movement) => movement.sellerGstin))].sort()

  if (query.gstin && !sellers.includes(query.gstin) && registered.length > 0) {
    throw conflict(
      `No documents in this period were issued under GSTIN ${query.gstin}. ` +
        `Documents present: ${sellers.join(', ')}.`
    )
  }
  if (!query.gstin && sellers.length > 1) {
    throw conflict(
      `This period spans ${sellers.length} sellers (${sellers.join(', ')}). ` +
        'A GSTR-1 is filed by one GSTIN — pass ?gstin= to pick which return this is.'
    )
  }

  const sellerGstin = query.gstin ?? sellers[0] ?? ''
  const movements = sellerGstin
    ? all.filter((movement) => movement.sellerGstin === sellerGstin || movement.sellerGstin === '')
    : all
  const { columns, build } = REPORTS[report]

  return {
    csv: csvDocument(columns, build(movements)),
    report,
    sellerGstin,
    sellerLegalName:
      movements.find((movement) => movement.sellerGstin === sellerGstin)?.sellerLegalName ?? '',
    events: movements.length,
    untaxed: movements.filter((movement) => movement.docVersion === 1).length,
  }
}
