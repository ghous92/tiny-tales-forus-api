/**
 * Pure formatting for invoices — money, dates, the Indian financial year, and
 * the document number itself. No I/O, no DB, no zod: both the document builder
 * (`services/invoices.ts`) and the two renderers (`lib/invoiceHtml.ts`) depend
 * on these, and neither should have to depend on the other to get them.
 *
 * Everything here is deterministic. Nothing reads the clock; callers pass the
 * instant in. That is what makes an issued invoice reproducible from its stored
 * document years later.
 *
 * **Everything is IST.** An invoice is an Indian commercial document: its date,
 * and the financial year its number belongs to, are the ones a reader in India
 * would write down. `2026-03-31T20:00:00Z` is already 1 April in Ahmedabad, and
 * it must land in FY 26-27, not 25-26. India has observed no DST since 1945, so
 * a fixed +05:30 offset is exact rather than an approximation — and it avoids
 * depending on the host's ICU timezone data being present.
 */

/** IST is UTC+05:30, with no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** Shift an instant into IST wall-clock time, readable through the `getUTC*` accessors. */
function toIst(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS)
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * The Indian financial year an instant falls in, as `"26-27"` — 1 April to
 * 31 March. The invoice series restarts every FY, which is the convention an
 * Indian accountant and the income-tax return both expect.
 */
export function financialYearOf(date: Date): string {
  const ist = toIst(date)
  const year = ist.getUTCFullYear()
  // getUTCMonth is 0-based: April is 3.
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1
  const two = (y: number): string => String(y % 100).padStart(2, '0')
  return `${two(startYear)}-${two(startYear + 1)}`
}

/**
 * IST midnight opening a `YYYY-MM-DD` day — an admin's "5 August" means the
 * Indian day, not the host's. Used for every date bound the operator surfaces
 * accept (the sales register's `from`/`to`, GSTR-1's period).
 */
export function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`)
}

/**
 * Half-open `[start, end)` for a `YYYY-MM` month in IST. Half-open rather than
 * an inclusive last-day bound because "the last instant of the month" has no
 * exact representation — `23:59:59.999` silently drops the final millisecond,
 * and a return that omits a sale is worse than one computed on a clean
 * boundary. December rolls to January of the next year.
 */
export function istMonthBounds(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split('-').map(Number) as [number, number]
  const nextYear = mon === 12 ? year + 1 : year
  const nextMon = mon === 12 ? 1 : mon + 1
  return {
    start: istDayStart(`${month}-01`),
    end: istDayStart(`${nextYear}-${String(nextMon).padStart(2, '0')}-01`),
  }
}

/**
 * Half-open `[1 April, 1 April)` for an Indian financial year written the way
 * `financialYearOf` writes it (`"26-27"`), in IST.
 *
 * Two-digit years are resolved into the 2000s, which is the same assumption
 * the invoice number series already bakes in — `LAA/26-27/000142` is not
 * ambiguous to anyone reading it, and a series that outlives the century has
 * larger problems than this function.
 */
export function istFyBounds(fy: string): { start: Date; end: Date } {
  const [startTwo] = fy.split('-') as [string]
  const startYear = 2000 + Number(startTwo)
  return {
    start: istDayStart(`${startYear}-04-01`),
    end: istDayStart(`${startYear + 1}-04-01`),
  }
}

/** IST midnight opening the day AFTER `day` — the exclusive end of an inclusive `to` bound. */
export function istDayAfter(day: string): Date {
  return new Date(istDayStart(day).getTime() + 24 * 60 * 60 * 1000)
}

/**
 * `"LAA/26-27/000142"`. Zero-padded to six digits so the series sorts
 * lexicographically for its whole plausible life and every number is the same
 * width on a printed page.
 */
export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(6, '0')}`
}

/**
 * `"LAA/CN/26-27/000001"`. Own series (`credit_note_counters`), so its
 * sequence has no relation to the invoice numbered in the same fy.
 */
export function formatCreditNoteNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/CN/${fy}/${String(seq).padStart(6, '0')}`
}

/** "05 Aug 2026" (IST). */
export function formatInvoiceDate(iso: string | Date): string {
  const ist = toIst(typeof iso === 'string' ? new Date(iso) : iso)
  const day = String(ist.getUTCDate()).padStart(2, '0')
  return `${day} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`
}

/** "05 Aug 2026, 18:12 IST" — 24-hour, so there is nothing to misread. */
export function formatInvoiceDateTime(iso: string | Date): string {
  const ist = toIst(typeof iso === 'string' ? new Date(iso) : iso)
  const hh = String(ist.getUTCHours()).padStart(2, '0')
  const mm = String(ist.getUTCMinutes()).padStart(2, '0')
  return `${formatInvoiceDate(iso)}, ${hh}:${mm} IST`
}

/** "YYYY-MM-DD" in IST — the calendar day an admin's date filter means. */
export function istCalendarDate(date: Date): string {
  const ist = toIst(date)
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const d = String(ist.getUTCDate()).padStart(2, '0')
  return `${ist.getUTCFullYear()}-${m}-${d}`
}

/** Indian digit grouping: 1234567 → "12,34,567" (last three, then pairs). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

/**
 * "₹1,400.00". Amounts in this system are whole rupees end to end (see
 * lib/pricing.ts), so the paise are always `.00` — printed rather than dropped
 * because a money column on an invoice with a ragged right edge reads as a
 * mistake.
 */
export function formatMoneyINR(inr: number): string {
  const n = Math.trunc(Math.abs(inr))
  return `${inr < 0 ? '-' : ''}₹${groupIndian(String(n))}.00`
}

/**
 * "₹423.73" — for the tax columns (`lib/gstTax.ts` works in paise, unlike the
 * rest of the invoice, because a rounded-to-the-rupee taxable value would
 * fail the document's own Σ(taxable+tax) === total invariant). Everything
 * ELSE on the document stays whole-rupee `formatMoneyINR`; this exists only
 * for `docVersion: 2`'s HSN/taxable/tax columns and the rate-wise summary.
 */
export function formatMoneyFromPaise(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.trunc(Math.abs(paise))
  const rupees = Math.floor(abs / 100)
  const remainderPaise = String(abs % 100).padStart(2, '0')
  return `${sign}₹${groupIndian(String(rupees))}.${remainderPaise}`
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const

/** 0..99 → words. */
function below100(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const tens = TENS[Math.floor(n / 10)] ?? ''
  const ones = ONES[n % 10] ?? ''
  return ones ? `${tens} ${ones}` : tens
}

/** 0..999 → words. */
function below1000(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`)
  if (rest > 0) parts.push(below100(rest))
  return parts.join(' ')
}

/** Indian scale: crore (10^7), lakh (10^5), thousand — not million/billion. */
function indianWords(value: number): string {
  if (value === 0) return 'Zero'
  let n = value
  const parts: string[] = []

  const crore = Math.floor(n / 10_000_000)
  n %= 10_000_000
  const lakh = Math.floor(n / 100_000)
  n %= 100_000
  const thousand = Math.floor(n / 1_000)
  n %= 1_000

  // Recursive for crore so absurd-but-valid amounts (100+ crore) still read correctly.
  if (crore > 0) parts.push(`${indianWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${below100(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${below100(thousand)} Thousand`)
  if (n > 0) parts.push(below1000(n))

  return parts.join(' ')
}

/**
 * "Rupees One Thousand Four Hundred Only" — the customary amount-in-words line
 * every Indian invoice carries, and the reason a tampered figure in the money
 * column is easy to spot. Whole rupees only (there are no paise to spell).
 */
export function amountInWords(inr: number): string {
  const n = Math.max(0, Math.trunc(inr))
  return `Rupees ${indianWords(n)} Only`
}
