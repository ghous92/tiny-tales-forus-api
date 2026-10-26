/**
 * Zod contracts for the GSTR-1 returns feed. Imports only `zod`, same rule as
 * every other contracts file.
 *
 * ## What this is, and what it deliberately is not
 *
 * `GET /v1/admin/invoices/gstr1.csv` produces the rate-wise figures a CA needs
 * to file GSTR-1 for one period. It is **input for a human filing a return**,
 * not a drop-in upload for the GST offline tool: column names track the
 * portal's tables so the mapping is obvious, but the amount columns the portal
 * derives (CGST/SGST/IGST) are printed here rather than left implicit, because
 * the person reading this file needs to tie it back to the sales register.
 *
 * ## Why these four reports and no others
 *
 * Adix sells B2C on its own website. CBIC FAQ 24 treats a seller using its own
 * website as an ECO; FAQ 25 says its own-account resale does not attract
 * section 52 TCS. The channel is classified as e-commerce in Table 7, while
 * no TCS / GSTR-8 applies to these own supplies. Adix holds no customer GSTINs.
 * That rules out most of GSTR-1:
 *
 * - **`b2cs`** — Table 7, the actual filing figure. B2C supplies aggregated by
 *   place of supply × rate. There is no B2B table because there are no
 *   registered buyers, and no B2CL table because B2CL is inter-state supplies
 *   above ₹2.5 lakh to unregistered persons — a single cosmetics order does not
 *   reach it. If one ever does, it must be pulled OUT of Table 7 and filed
 *   invoice-wise; `invoices` below is what makes that visible.
 * - **`hsn`** — Table 12, mandatory HSN summary.
 * - **`docs`** — Table 13, the document series issued in the period.
 * - **`invoices`** — not a GSTR-1 table at all: the document-level backing
 *   detail, one row per document per rate band, so every figure in the three
 *   summaries can be traced to the invoices behind it.
 *
 * Two further sections are not GSTR-1 at all, but are built from the same
 * frozen documents so that the three returns agree by construction instead of
 * by a human copying figures between them:
 *
 * - **`3b`** — GSTR-3B Tables 3.1(a) and 3.2, the monthly summary. Table 4
 *   (ITC) is deliberately absent: ITC comes from purchase invoices reconciled
 *   against GSTR-2B, which this system has never seen, and a confidently
 *   under-stated Table 4 would get filed.
 * - **`annual`** — the GSTR-9 reconciliation input: one row per month over the
 *   requested range plus a total, so an annual return can be tied back to the
 *   twelve monthly filings without re-running and re-typing twelve exports.
 *   Pass `fy` (`"26-27"`) to get a whole financial year in one call.
 *
 * GSTR-9 itself is **optional below ₹2 crore aggregate turnover**, which is
 * where this seller is today — the section is kept because that waiver is
 * renewed by notification each financial year rather than being a permanent
 * threshold, and because the month-by-month reconciliation is the fastest way
 * to see GSTR-1 and GSTR-3B agree. GSTR-1 and GSTR-3B stay mandatory at zero
 * turnover: a nil return is still a return.
 *
 * There is no CDNUR section. CDNUR covers credit notes against B2CL and export
 * supplies; a credit note against a B2CS supply is **netted into Table 7**, and
 * that is exactly what `b2cs` and `hsn` do here. Emitting a CDNUR file as well
 * would double-count every refund.
 *
 * ## One return, one supplier
 *
 * Since `invoice.sellerOfRecord` exists, historical documents may identify
 * Adix or the manufacturer as supplier. Those are two taxable persons filing
 * two returns. A period spanning the
 * switch therefore holds documents belonging to both, and the export
 * **refuses** it with a 409 naming the GSTINs present rather than aggregating
 * them — a merged Table 7 would be wrong for both entities and traceable to
 * neither. Pass `gstin` to say which return is being filed.
 *
 * ## Netting and period boundaries
 *
 * An invoice belongs to the period it was ISSUED in; a credit note belongs to
 * the period IT was issued in, which is frequently a later one. So a refund
 * never retroactively edits a filed month — it reduces the month it happened
 * in, and Table 7 net figures may legitimately go negative when a quiet month
 * carries refunds for a busy one. Nothing here clamps that to zero.
 *
 * Only `docVersion: 2` documents carry tax. A `docVersion: 1` invoice inside a
 * registered period contributes nothing to `b2cs`/`hsn` — it has no tax to
 * report — but it is NOT silently dropped: it appears in `invoices` with an
 * empty rate band and `Doc Version` 1, so an unexplained gap between the sales
 * register and the return is visible rather than invisible.
 */

import { z } from 'zod'

/** Which section to render. See the class doc for why the list is this short. */
export const Gstr1ReportSchema = z.enum(['b2cs', 'hsn', 'docs', 'invoices', '3b', 'annual'])

/**
 * `GET /v1/admin/invoices/gstr1.csv` query.
 *
 * `month` (`YYYY-MM`) is the ordinary way to ask, because GSTR-1 is filed
 * monthly and hand-typing the last day of February is how a period gets
 * silently truncated. `from`/`to` remain available for a quarter or an audit
 * slice, and are inclusive `YYYY-MM-DD` calendar bounds in IST — the same
 * convention `InvoiceListQuerySchema` uses.
 *
 * Passing `month` together with `from`/`to` is rejected rather than resolved by
 * precedence: the two disagree about the period, and a return filed for the
 * wrong period is not an error worth guessing at.
 */
export const Gstr1ExportQuerySchema = z
  .strictObject({
    report: Gstr1ReportSchema.optional(),
    /**
     * Which supplier's return this is. Optional, and only ever needed when a
     * period spans two of them — which became possible the day
     * `invoice.sellerOfRecord` did, because a document issued under vendor
     * fulfilment is the MANUFACTURER's outward supply, not Adix's. A GSTR-1
     * belongs to one GSTIN, so the export refuses a mixed period rather than
     * merging two entities' supplies into one unfileable return.
     */
    gstin: z
      .string()
      .regex(
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/,
        'gstin must be a 15-character GSTIN'
      )
      .optional(),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /**
     * An Indian financial year, `"26-27"` — 1 April to 31 March, the same
     * form the invoice number series uses (`LAA/26-27/000142`). Shorthand for
     * the `from`/`to` pair, and the ordinary way to ask for `report=annual`:
     * hand-typing `2026-04-01`/`2027-03-31` is how a year quietly loses its
     * first or last day.
     */
    fy: z
      .string()
      .regex(/^\d{2}-\d{2}$/, 'fy must be YY-YY, e.g. 26-27')
      .optional(),
  })
  .refine((q) => [q.month, q.fy, q.from ?? q.to].filter(Boolean).length <= 1, {
    message: 'pass exactly one of month, fy, or from/to',
    path: ['month'],
  })

export type Gstr1Report = z.infer<typeof Gstr1ReportSchema>
export type Gstr1ExportQuery = z.infer<typeof Gstr1ExportQuerySchema>
