/**
 * /v1/admin/invoices — the operator's sales register: find any sale, read the
 * exact document that was issued for it, print a customer or delivery copy, and
 * (re)send the customer's emailed copy.
 *
 * Gated by `authenticate` + `requireAdmin`, the same two hooks every other
 * admin plugin uses (see `routes/complaints.ts`'s admin plugin).
 *
 * Everything here READS the frozen `invoices.document`. There is no edit path
 * and there will not be one: the customer already holds a copy of every
 * document in this table, so "correcting" one would produce two different
 * invoices bearing the same number. A wrong invoice is corrected the way paper
 * ones are — by a fresh document, not by rewriting history.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { Gstr1ExportQuerySchema } from '../contracts/gstr1.js'
import { ItcFreightExportQuerySchema } from '../contracts/itcFreight.js'
import {
  ErrorEnvelopeSchema,
  InvoiceAdminDetailSchema,
  InvoiceCopySchema,
  InvoiceEmailRequestSchema,
  InvoiceEmailResultSchema,
  InvoiceEmailSweepResponseSchema,
  InvoiceHtmlQuerySchema,
  InvoiceListQuerySchema,
  InvoiceListResponseSchema,
  InvoiceNumberParamsSchema,
  type InvoiceCopy,
  type InvoiceDocument,
  type InvoiceEmailStatus,
  type InvoiceSummary,
} from '../contracts/invoices.js'
import type { Db } from '../db/client.js'
import { csvDocument } from '../lib/csv.js'
import type { EmailSenderConfig } from '../lib/email.js'
import { notFound } from '../lib/errors.js'
import { formatInvoiceDate } from '../lib/invoiceFormat.js'
import { renderInvoicePrintHtml } from '../lib/invoiceHtml.js'
import { exportGstr1Csv } from '../services/gstr1.js'
import { exportItcFreightCsv } from '../services/itcFreight.js'
import {
  getInvoiceByNumber,
  listInvoices,
  listInvoicesForExport,
  listInvoicesNeedingEmail,
  reapStuckInvoiceEmails,
  toInvoiceAdminDetail,
} from '../services/invoices.js'
import { sendInvoiceEmail } from './invoices.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** How many rows one sweep of `POST /retry-emails` will attempt. */
const RETRY_SWEEP_LIMIT = 50

const CSV_COLUMNS = [
  'Invoice No',
  'Invoice Date',
  'Order No',
  'Customer',
  'Phone',
  'City',
  'State',
  'Items Total',
  'Discount',
  'Delivery',
  'Grand Total',
  'Status',
  'Email Status',
] as const

function toCsv(rows: InvoiceSummary[]): string {
  return csvDocument(
    CSV_COLUMNS,
    rows.map((row) => [
      row.invoiceNumber,
      formatInvoiceDate(row.issuedAt),
      row.orderId,
      row.buyerName,
      row.buyerPhone,
      row.buyerCity,
      row.buyerState,
      row.goodsInr,
      row.couponDiscountInr,
      row.shippingFeeInr,
      row.totalInr,
      row.status,
      row.emailStatus,
    ])
  )
}

/** `{ scanned, sent, failed, skipped }` — the shape both invoice-email callers return. */
export interface InvoiceEmailSweepOutcome {
  scanned: number
  sent: number
  failed: number
  skipped: number
}

/**
 * Retry every customer copy still owed one. Shared verbatim by the admin button
 * (`POST /retry-emails`) and the scheduled sweep (`routes/internalSweeps.ts`),
 * so the two can never drift on the attempt cap or the outcome tally.
 *
 * Never throws for a single row: `sendInvoiceEmail` records its own failure on
 * the row, and one unsendable address must not abandon the other 49.
 */
export async function runInvoiceEmailSweep(
  db: Db,
  email: EmailSenderConfig | undefined,
  emailFetchImpl: typeof fetch | undefined,
  log: FastifyBaseLogger,
  limit = RETRY_SWEEP_LIMIT
): Promise<InvoiceEmailSweepOutcome> {
  // Reap abandoned claims before selecting, not after: a row a dead instance
  // was holding is in `sending`, which appears in no sweep predicate, so
  // reaping afterwards would leave it invisible to this pass too. One bounded
  // UPDATE over rows already stuck in `sending`, riding the compute wake this
  // sweep causes anyway (docs/WIP-NEON-COST.md).
  const reaped = await reapStuckInvoiceEmails(db)
  if (reaped > 0) {
    log.warn({ reaped }, 'invoice email sweep reclaimed rows abandoned mid-send')
  }

  const owed = await listInvoicesNeedingEmail(db, limit)
  let sent = 0
  let failed = 0
  let skipped = 0
  for (const row of owed) {
    const updated = await sendInvoiceEmail(db, row.invoiceNumber, email, emailFetchImpl, log)
    const status = updated?.emailStatus as InvoiceEmailStatus | undefined
    if (status === 'sent') sent += 1
    else if (status === 'failed') failed += 1
    else skipped += 1
  }
  return { scanned: owed.length, sent, failed, skipped }
}

export interface AdminInvoiceRoutesOptions {
  db: Db
  /** Brevo sender identity — absent means the resend endpoint reports back without sending. */
  email?: EmailSenderConfig
  /** Test seam: injected fetch for the Brevo call. */
  emailFetchImpl?: typeof fetch
}

export const adminInvoiceRoutes: FastifyPluginAsyncZod<AdminInvoiceRoutesOptions> = async (
  app,
  opts
) => {
  const { db, email, emailFetchImpl } = opts
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    {
      schema: {
        querystring: InvoiceListQuerySchema,
        response: { 200: InvoiceListResponseSchema, ...errorResponses },
      },
    },
    async (request) => listInvoices(db, request.query)
  )

  /**
   * The flat sales register an accountant opens in a spreadsheet. Honours the
   * same filters as the list, so "export what I'm looking at" is one click and
   * not a different query.
   */
  app.get(
    '/export.csv',
    // No `response` schema: this replies `text/csv`, and a declared response
    // schema would route the body through the zod JSON serializer.
    { schema: { querystring: InvoiceListQuerySchema } },
    async (request, reply) => {
      const rows = await listInvoicesForExport(db, request.query)
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="laanya-invoices.csv"')
        .send(toCsv(rows))
    }
  )

  /**
   * The GSTR-1 returns feed — what the CA files from, as opposed to
   * `/export.csv`'s flat sales register, which carries no tax at all.
   * `?report=` picks the section (`b2cs` by default, plus `hsn`, `docs` and the
   * `invoices` backing detail); `?month=YYYY-MM` picks the period. See
   * `contracts/gstr1.ts` for why those four sections and no CDNUR.
   *
   * Deliberately NOT filtered by the register's `q`/`status`/`emailStatus`: a
   * return covers a period in full, and "export what I'm looking at" — the
   * right behaviour for the register — is how a filing quietly loses a
   * refunded order.
   */
  app.get(
    '/gstr1.csv',
    // No `response` schema: `text/csv`, same reason as `export.csv`.
    { schema: { querystring: Gstr1ExportQuerySchema } },
    async (request, reply) => {
      const { csv, report, sellerGstin, sellerLegalName, events, untaxed } = await exportGstr1Csv(
        db,
        request.query
      )

      // A docVersion 1 document inside a registered period is a supply the
      // return does not account for. It shows up in the `invoices` detail with
      // an empty rate band, but an operator exporting `b2cs` never opens that
      // file, so the count is stated here too.
      if (untaxed > 0) {
        request.log.warn(
          { report, events, untaxed, sellerGstin },
          'gstr1 export spans docVersion 1 documents — those carry no tax to report'
        )
      }

      // Which taxable person this file belongs to. Logged because a return
      // filed under the wrong GSTIN is the one mistake here that cannot be
      // undone by re-exporting, and the answer must be recoverable afterwards.
      request.log.info({ report, events, sellerGstin, sellerLegalName }, 'gstr1 export rendered')

      // These files are mailed to a CA and pile up in a downloads folder, where
      // four identically-named exports are indistinguishable — so the report
      // and the period both go in the name. Every part is enum- or
      // regex-validated in the contract, so nothing user-supplied can put a
      // quote or a path separator into the header.
      const period =
        request.query.month ??
        request.query.fy ??
        [request.query.from, request.query.to].filter(Boolean).join('_')
      const suffix = period ? `-${period}` : ''
      // The GSTIN goes in the name too: two entities now issue documents
      // through this system, and a CA holding both exports must be able to
      // tell them apart without opening either. Regex-validated in the
      // contract, so it cannot carry a quote or a path separator.
      const who = sellerGstin ? `-${sellerGstin}` : ''
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="laanya-gstr1-${report}${who}${suffix}.csv"`
        )
        .send(csv)
    }
  )

  /**
   * The other half of the CA's monthly pack: input tax credit on freight.
   * GSTR-1 declares output tax; this is the input tax that offsets it.
   *
   * It sits on this plugin because it is a tax report sharing the period and
   * CSV machinery, not because freight is an invoice — the data comes from
   * `shipments` joined to the frozen shipping snapshot. See
   * `services/itcFreight.ts` for why the figure is a reconciliation input
   * rather than a claimable one.
   */
  app.get(
    '/itc-freight.csv',
    // No `response` schema: `text/csv`, same reason as `export.csv`.
    { schema: { querystring: ItcFreightExportQuerySchema } },
    async (request, reply) => {
      const result = await exportItcFreightCsv(db, request.query)
      const excludedTotal = Object.values(result.excluded).reduce((sum, n) => sum + n, 0)

      // Every excluded parcel is a gap between this report and the courier's
      // invoice. The detail file names them per row; this is so the operator
      // who only pulled the summary still knows they exist.
      if (excludedTotal > 0) {
        request.log.warn(
          { report: result.report, shipments: result.shipments, excluded: result.excluded },
          'itc-freight export excludes manifested shipments — see the detail report'
        )
      }

      const period =
        request.query.month ?? [request.query.from, request.query.to].filter(Boolean).join('_')
      const suffix = period ? `-${period}` : ''
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="laanya-itc-freight-${result.report}${suffix}.csv"`
        )
        .send(result.csv)
    }
  )

  /**
   * Retry the customer copies that are still owed one — `pending` and `failed`
   * rows under the attempt cap. Idempotent and safe to call on a schedule, the
   * same shape as `POST /v1/payments/recover`.
   */
  app.post(
    '/retry-emails',
    { schema: { response: { 200: InvoiceEmailSweepResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      return reply.send(await runInvoiceEmailSweep(db, email, emailFetchImpl, request.log))
    }
  )

  app.get(
    '/:invoiceNumber',
    {
      schema: {
        params: InvoiceNumberParamsSchema,
        response: { 200: InvoiceAdminDetailSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await getInvoiceByNumber(db, request.params.invoiceNumber)
      if (!row) throw notFound('Invoice not found')
      return toInvoiceAdminDetail(row)
    }
  )

  /**
   * The print view. `?copy=delivery` is the sheet that travels in the parcel —
   * banded so a packer can never confuse the two, with a tear-off address block.
   */
  app.get(
    '/:invoiceNumber/html',
    {
      // No `response` schema — `text/html`, same reason as `export.csv` above.
      schema: {
        params: InvoiceNumberParamsSchema,
        querystring: InvoiceHtmlQuerySchema,
      },
    },
    async (request, reply) => {
      const row = await getInvoiceByNumber(db, request.params.invoiceNumber)
      if (!row) throw notFound('Invoice not found')
      const copy: InvoiceCopy = InvoiceCopySchema.catch('customer').parse(request.query.copy)
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderInvoicePrintHtml(row.document as InvoiceDocument, { copy }))
    }
  )

  /**
   * (Re)send the customer's copy. `to` overrides the stored address for this
   * send only — the document itself is immutable, so this records where a copy
   * went, it does not change who the invoice is addressed to.
   */
  app.post(
    '/:invoiceNumber/email',
    {
      schema: {
        params: InvoiceNumberParamsSchema,
        body: InvoiceEmailRequestSchema,
        response: { 200: InvoiceEmailResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      const existing = await getInvoiceByNumber(db, request.params.invoiceNumber)
      if (!existing) throw notFound('Invoice not found')

      const row = await sendInvoiceEmail(
        db,
        request.params.invoiceNumber,
        email,
        emailFetchImpl,
        request.log,
        request.body?.to,
        // `force`: an operator pressing resend means it, and the row is usually
        // already `sent` (or past the retry cap) — the states the sweep's
        // "still owed a send" claim predicate deliberately excludes. A claim
        // held by a live sender is still respected.
        true
      )
      const result = row ?? existing
      return {
        invoiceNumber: result.invoiceNumber,
        emailStatus: result.emailStatus as InvoiceEmailStatus,
        emailTo: result.emailTo,
        emailedAt: result.emailedAt ? result.emailedAt.toISOString() : null,
        emailAttempts: result.emailAttempts,
        lastEmailError: result.lastEmailError,
      }
    }
  )
}
