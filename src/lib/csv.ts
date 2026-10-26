/**
 * CSV rendering for the operator exports — the sales register
 * (`routes/invoicesAdmin.ts` `/export.csv`) and the GSTR-1 returns feed
 * (`services/gstr1.ts`). Pure: no db, no config, no clock.
 *
 * Every one of these files is opened by a human in Excel or Google Sheets,
 * which is why both rules below exist. Neither is optional.
 */

/**
 * RFC 4180 quoting. A leading `=`/`+`/`-`/`@` is additionally prefixed with a
 * single quote: an address or product name starting with one of those is
 * executed as a FORMULA when the file is opened in Excel or Sheets. The whole
 * point of these exports is that an accountant opens them in exactly those.
 *
 * The guard runs on the raw value BEFORE quoting, so a negative number
 * (`-12.00`, ordinary in a credit-note row) is emitted as `'-12.00` — visibly
 * text rather than silently a formula. That is the intended trade: a figure
 * that must be re-typed beats a cell that evaluates to something else.
 */
export function csvCell(value: string | number): string {
  const raw = String(value)
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return `"${guarded.replace(/"/g, '""')}"`
}

/**
 * A whole file from a header row plus body rows. CRLF per RFC 4180, and a
 * UTF-8 BOM (escaped, not literal — a raw BOM in source is invisible and
 * lint-flagged) so Excel on Windows reads non-ASCII names correctly instead of
 * as mojibake.
 */
export function csvDocument(header: readonly string[], rows: readonly (string | number)[][]) {
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/**
 * Paise → the rupees-with-2-decimals string every GST return expects
 * (`123456` → `"1234.56"`). Takes an integer paise amount and divides once at
 * the very end, so no intermediate float is ever summed — the same discipline
 * `lib/gstTax.ts` keeps internally.
 *
 * Negative input is fine and is what a credit-note row carries.
 */
export function paiseToRupeeString(paise: number): string {
  return (paise / 100).toFixed(2)
}
