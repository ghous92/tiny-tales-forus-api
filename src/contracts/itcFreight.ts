/**
 * Zod contracts for the ITC-on-freight report. Imports only `zod`, same rule as
 * every other contracts file.
 *
 * `GET /v1/admin/invoices/itc-freight.csv` — what freight tax we MODELLED for a
 * period, so the CA can reconcile it against the courier's tax invoice and
 * GSTR-2B. It is not the claimable figure and is not a GSTR-3B input; see the
 * class doc on `services/itcFreight.ts` for why that distinction is the whole
 * point of the report, and for the three things it deliberately under-reports.
 *
 * Two sections:
 *
 * - **`summary`** (default) — per courier × frozen GST rate: parcels, taxable
 *   freight, tax. The reconciliation figure.
 * - **`detail`** — one row per manifested parcel, INCLUDING the ones that
 *   contribute nothing, with the reason in an `Excluded` column. A summary that
 *   quietly covers 40 of 52 parcels is how a gap gets blamed on the courier.
 *
 * The period is anchored on `shipments.manifested_at`, not on when the order
 * was paid: freight is incurred when the parcel leaves.
 */

import { z } from 'zod'

export const ItcFreightReportSchema = z.enum(['summary', 'detail'])

/**
 * Same period vocabulary as the GSTR-1 feed, deliberately — an operator pulling
 * both files for one month should not have to remember two conventions.
 * `month` (`YYYY-MM`) is the ordinary form; `from`/`to` are inclusive
 * `YYYY-MM-DD` calendar bounds in IST. Passing both is rejected rather than
 * resolved by precedence.
 */
export const ItcFreightExportQuerySchema = z
  .strictObject({
    report: ItcFreightReportSchema.optional(),
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
  })
  .refine((q) => !(q.month && (q.from || q.to)), {
    message: 'pass either month or from/to, not both',
    path: ['month'],
  })

export type ItcFreightReport = z.infer<typeof ItcFreightReportSchema>
export type ItcFreightExportQuery = z.infer<typeof ItcFreightExportQuerySchema>
