/**
 * /v1/invoices — the shopper's own invoices, plus the COMPOSITION helpers the
 * rest of the system issues invoices through.
 *
 * Issuing an invoice needs four modules at once: `payments` (the order),
 * `catalog` (product names and their Legal Metrology declarations), `config`
 * (the seller and manufacturer entities), and `invoices` (the numbering and the
 * table). ARCHITECTURE.md puts exactly that kind of cross-module wiring in the
 * ROUTE layer, which is why {@link issueInvoiceForOrder} lives here and not in
 * `services/invoices.ts`. Two other callers reuse it rather than re-deriving
 * it: `routes/payments.ts` (via {@link makeInvoiceIssuanceHook}) and
 * `scripts/backfill-invoices.ts`.
 *
 * Read `contracts/invoices.ts` for why this document is an INVOICE and not a
 * "Tax Invoice"; this file implements that, it does not restate it.
 *
 * Two plugins, mirroring the public/admin split every other module uses:
 * - `invoiceRoutes` (mounted at `/v1/invoices`) — authed shopper routes.
 * - the admin side lives in `routes/invoicesAdmin.ts`.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  InvoiceOrderParamsSchema,
  InvoiceResponseSchema,
  type InvoiceCopy,
  type InvoiceDocument,
  type InvoiceSellerBlock,
} from '../contracts/invoices.js'
import type { Db } from '../db/client.js'
import type { InvoiceRow } from '../db/schema.js'
import { sendTransactionalEmail, type EmailSenderConfig } from '../lib/email.js'
import { invoiceUnavailable, notFound } from '../lib/errors.js'
import { buildInvoiceDocument, type ProductLegalInfo } from '../lib/invoiceDocument.js'
import { financialYearOf } from '../lib/invoiceFormat.js'
import { requestSweep, type TaskEnqueuer } from '../lib/tasks.js'
import {
  invoiceEmailSubject,
  renderInvoiceEmailHtml,
  renderInvoicePrintHtml,
} from '../lib/invoiceHtml.js'
import { getItemsBySkus } from '../services/catalog.js'
import { getProductLegalInfo } from '../services/catalogRead.js'
import { getConfigValues } from '../services/config.js'
import {
  claimInvoiceEmail,
  getInvoiceByNumber,
  getInvoiceByOrderId,
  issueInvoice,
  recordEmailAttempt,
  MAX_EMAIL_ATTEMPTS,
} from '../services/invoices.js'
import type { OrderInvoiceSource, OrderPaidHook } from '../services/payments.js'
import { getProfile } from '../services/profile.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Fallbacks for the three `invoice.*` config keys, used when a key isn't seeded. */
const DEFAULT_NUMBER_PREFIX = 'LAA'
const DEFAULT_FOOTER_NOTE = 'This is a computer-generated invoice and does not require a signature.'

/**
 * The entity/wording context every invoice is issued against, resolved from
 * config so none of it is hardcoded twice. One batched read (`getConfigValues`)
 * rather than five round trips — this runs inside the payment transaction.
 */
export interface InvoiceContext {
  seller: InvoiceSellerBlock
  jurisdiction: { city: string; state: string }
  /** `legal.company.registeredStateName` — see `lib/invoiceDocument.ts` `BuildInvoiceDocumentInput.registeredStateName`. */
  registeredStateName: string
  defaultManufacturer: { legalName: string; address: string; licence: string }
  numberPrefix: string
  footerNote: string
  /** `invoice.emailEnabled` — an operator kill switch for the customer copy. Absent ⇒ enabled. */
  emailEnabled: boolean
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback
}

/**
 * Resolve the seller of record and everything printed alongside it.
 *
 * Throws 503 `invoice_unavailable` when `legal.company` has no legalName or
 * address — the same refusal `routes/payments.ts` has always made. Issuing a
 * document with a blank seller would be worse than issuing none: it would look
 * official and name nobody.
 */
export async function resolveInvoiceContext(db: Db): Promise<InvoiceContext> {
  const values = await getConfigValues(db, [
    'legal.company',
    'legal.manufacturer',
    'invoice.sellerOfRecord',
    'invoice.numberPrefix',
    'invoice.footerNote',
    'invoice.emailEnabled',
  ])

  const company = (values.get('legal.company') ?? {}) as Record<string, unknown>
  const manufacturer = (values.get('legal.manufacturer') ?? {}) as Record<string, unknown>

  // Current model: Adix buys per order from Saman and resells to the shopper;
  // Saman's GSTIN is used on its separate B2B invoice to Adix. Keep the legacy
  // manufacturer-seller branch for already-issued documents and explicit
  // historical configuration. Any unset or misspelt value defaults to Adix.
  const sellsAsManufacturer = values.get('invoice.sellerOfRecord') === 'manufacturer'
  const sellerRow = sellsAsManufacturer ? manufacturer : company

  const legalName = asString(sellerRow.legalName)
  const address = asString(sellerRow.address)
  if (!legalName || !address) throw invoiceUnavailable()

  return {
    seller: {
      legalName,
      // The brand on the box is Tiny Tales whoever the supplier is, so this stays
      // on `legal.company` in both models.
      brand: asString(company.brand, legalName),
      address,
      // Both must be true together — a `gstin` string with the flag off, or the
      // reverse, is a half-configured state that must NOT print as registered.
      // `legal.manufacturer` carries no `gstRegistered` flag: a manufacturer
      // row that has a GSTIN at all is a registered supplier, which is the
      // whole premise of naming them the seller.
      gstRegistered: sellsAsManufacturer
        ? Boolean(asString(manufacturer.gstin))
        : company.gstRegistered === true && Boolean(asString(company.gstin)),
      gstin: asString(sellerRow.gstin),
      // Support is Tiny Tales's in both models — the shopper writes to us, not to
      // the manufacturer, whoever's name is on the supply.
      supportEmail: asString(company.supportEmail),
    },
    // Dispute venue is a matter for the Terms. A jurisdiction sentence is not
    // a Rule 46 tax-invoice particular and should not be copied into a goods
    // invoice from the platform config, regardless of which entity sells.
    jurisdiction: { city: '', state: '' },
    // The SELLER's own GST state — decides CGST/SGST vs IGST against the
    // delivery address, so it must follow whoever is selling. Jharkhand when
    // Adix sells, Gujarat when the manufacturer does.
    registeredStateName: asString(sellerRow.registeredStateName),
    defaultManufacturer: {
      legalName: asString(manufacturer.legalName),
      address: asString(manufacturer.address),
      licence: asString(manufacturer.licence),
    },
    numberPrefix: asString(values.get('invoice.numberPrefix'), DEFAULT_NUMBER_PREFIX),
    footerNote: asString(values.get('invoice.footerNote'), DEFAULT_FOOTER_NOTE),
    emailEnabled: values.get('invoice.emailEnabled') !== false,
  }
}

/** The shopper's contact email, or null. A missing profile is not an error here — it just means no copy is mailed. */
async function resolveBuyerEmail(db: Db, userId: string): Promise<string | null> {
  try {
    const profile = await getProfile(db, userId)
    return profile.email ?? null
  } catch {
    return null
  }
}

export interface IssueInvoiceForOrderOptions {
  /** Overrides the issue instant — the backfill script passes the order's own paid time. */
  issuedAt?: Date
  /**
   * `skipped_backfill` for retroactively-issued documents, which are
   * deliberately never mailed: a shopper receiving an invoice for a months-old
   * order reads it as a fresh charge.
   */
  backfill?: boolean
  /** Pre-resolved context, so a bulk issuer reads config once instead of once per order. */
  context?: InvoiceContext
}

/**
 * Issue the invoice for one order, inside the caller's transaction. Idempotent:
 * an order that already has an invoice gets its existing one back, and no
 * number is consumed (see `services/invoices.ts` on why that matters).
 *
 * READS AND WRITES BOTH GO THROUGH `tx`. Routing the reads (config, catalog,
 * profile) around it via the pool handle instead would be a deadlock: the
 * transaction holds one connection while the reads wait for another, and under
 * a saturated pool — exactly when payments are busiest — the waiters can never
 * be served because the holders are blocked on them. The same shape hangs
 * outright on the tests' single-connection PGlite. The reads are cheap indexed
 * lookups; keeping them on the transaction's own connection costs nothing.
 *
 * `tx` is cast to {@link Db} for the read helpers, the same way the stock hook
 * in `routes/payments.ts` does it — the query surface is identical.
 */
export async function issueInvoiceForOrder(
  tx: Tx,
  order: OrderInvoiceSource,
  options: IssueInvoiceForOrderOptions = {}
): Promise<InvoiceRow> {
  const db = tx as unknown as Db
  const context = options.context ?? (await resolveInvoiceContext(db))
  const issuedAt = options.issuedAt ?? new Date()

  const skus = order.lines.map((line) => line.sku)
  const [catalogItems, buyerEmail] = await Promise.all([
    getItemsBySkus(db, skus),
    resolveBuyerEmail(db, order.userId),
  ])
  const catalogBySku = new Map(catalogItems.map((item) => [item.sku, item]))

  const productIds = [...new Set(catalogItems.map((item) => item.productId))]
  const legalRows = await getProductLegalInfo(db, productIds)
  const productLegal = new Map<string, ProductLegalInfo>(
    legalRows.map((row) => [
      row.productId,
      {
        manufacturerName: row.manufacturerName,
        manufacturerAddress: row.manufacturerAddress,
        manufacturerLicence: row.manufacturerLicence,
        countryOfOrigin: row.countryOfOrigin,
        consumerCareContact: row.consumerCareContact,
      },
    ])
  )

  const address = order.address
  const lines = order.lines.map((line) => {
    const item = catalogBySku.get(line.sku)
    return {
      sku: line.sku,
      // A sku the catalog no longer knows still has to appear on the document
      // it was bought on — falling back to the sku itself is honest, and losing
      // the line would make Σ(lines) disagree with the total.
      productId: item?.productId ?? '',
      name: item?.name ?? line.sku,
      size: item?.size ?? '',
      imageUrl: item?.imageUrl,
      qty: line.qty,
      priceInr: line.priceInr,
      hsn: line.hsn,
      gstRatePct: line.gstRatePct,
    }
  })

  return issueInvoice(tx, {
    orderId: order.orderId,
    userId: order.userId,
    fy: financialYearOf(issuedAt),
    issuedAt,
    totalPaise: order.amountPaise,
    emailTo: buyerEmail,
    emailStatus: options.backfill
      ? 'skipped_backfill'
      : buyerEmail
        ? 'pending'
        : 'skipped_no_email',
    buildDocument: (fy, seq) =>
      buildInvoiceDocument({
        numberPrefix: context.numberPrefix,
        fy,
        seq,
        issuedAt,
        seller: context.seller,
        jurisdiction: context.jurisdiction,
        registeredStateName: context.registeredStateName,
        defaultManufacturer: context.defaultManufacturer,
        productLegal,
        footerNote: context.footerNote,
        order: {
          orderId: order.orderId,
          status: order.status,
          createdAt: order.createdAt,
          paidAt: order.paidAt,
          paymentReference: order.paymentReference,
          buyer: {
            name: String(address.name ?? ''),
            phone: String(address.phone ?? ''),
            houseNumber: String(address.houseNumber ?? ''),
            roadArea: String(address.roadArea ?? ''),
            city: String(address.city ?? ''),
            state: String(address.state ?? ''),
            pincode: String(address.pincode ?? ''),
          },
          lines,
          goodsInr: order.goodsInr,
          couponDiscountInr: order.couponDiscountInr,
          shippingFeeInr: order.shippingFeeInr,
          totalInr: order.totalInr,
        },
      }),
  })
}

/**
 * Where a request stashes the invoices its payments just minted, so the route
 * can mail them AFTER the transaction commits. An array because the recover
 * sweep transitions many orders in one call; the verify and webhook paths fill
 * it with exactly one.
 */
export interface InvoiceCapture {
  invoiceNumbers: string[]
}

/** A fresh, empty capture — one per request. */
export function newInvoiceCapture(): InvoiceCapture {
  return { invoiceNumbers: [] }
}

/**
 * The `onOrderPaid` hook that mints the invoice. Wired in `routes/payments.ts`
 * alongside the stock decrement, for the same reason: it must share the
 * transaction that flips the order to `paid`, and `services/payments.ts` may not
 * import another module to get it.
 *
 * **It swallows everything, deliberately** — the same trade the stock hook
 * makes. By the time it runs the money is captured; an exception escaping would
 * roll back a transition Razorpay has already made, leaving a shopper who paid
 * for an order that does not exist. A missing invoice is recoverable
 * (`scripts/backfill-invoices.ts` issues it later, idempotently); a missing
 * order is not.
 *
 * The issuance runs in a SAVEPOINT so a failure takes the counter increment
 * back with it. Without that, a failed insert would leave a consumed sequence
 * number nothing points at — precisely the gap in the series that the whole
 * numbering design exists to prevent.
 */
export function makeInvoiceIssuanceHook(opts: {
  capture: InvoiceCapture
  log: FastifyBaseLogger
}): OrderPaidHook {
  return async (tx, orderId, _lines, order) => {
    try {
      const row = await tx.transaction((inner) => issueInvoiceForOrder(inner as Tx, order))
      opts.capture.invoiceNumbers.push(row.invoiceNumber)
    } catch (err) {
      opts.log.error(
        { err, orderId },
        'invoice issuance failed after capture; payment stands, run db:backfill-invoices to issue it'
      )
    }
  }
}

/**
 * Send (or resend) the customer's copy and record the outcome. Best-effort by
 * contract: every failure is caught, written to the row and logged. An email
 * failure must never fail a payment — the money is captured and the invoice is
 * already committed by the time this runs.
 *
 * `overrideTo` is the admin panel's "send to a different address" — it does NOT
 * rewrite the invoice (which is immutable), only the address this send went to.
 *
 * ## Claim before send
 *
 * The row is claimed (`email_status = 'sending'`) before Brevo is called, so the
 * post-commit sender and the retry sweep — which can hold the same invoice at
 * the same instant — cannot both mail it. Losing that claim returns the row
 * untouched with nothing sent; see `claimInvoiceEmail` for why that is a
 * compare-and-swap rather than a row lock.
 *
 * `force` is the admin resend: a human re-mailing a copy that already went. It
 * bypasses the "still owed a send" predicate but not a live claim.
 *
 * Both no-attempt outcomes are resolved BEFORE the claim, because a claim spends
 * an attempt and neither of them tried anything: no address on file is terminal
 * `skipped_no_email`, and an unconfigured Brevo sender leaves the row exactly as
 * it was so a later configured deploy still picks it up.
 */
export async function sendInvoiceEmail(
  db: Db,
  invoiceNumber: string,
  email: EmailSenderConfig | undefined,
  emailFetchImpl: typeof fetch | undefined,
  log: FastifyBaseLogger,
  overrideTo?: string,
  force = false
): Promise<InvoiceRow | undefined> {
  const existing = await getInvoiceByNumber(db, invoiceNumber)
  if (!existing) return undefined

  const to = overrideTo ?? existing.emailTo
  if (!to)
    return (await recordEmailAttempt(db, invoiceNumber, { status: 'skipped_no_email' })) ?? existing

  if (!email) {
    log.warn({ invoiceNumber }, 'invoice email skipped: no Brevo sender configured')
    return existing
  }

  const row = await claimInvoiceEmail(db, invoiceNumber, force)
  if (!row) {
    // Another sender holds it, or its attempt budget is spent. Both are normal.
    // Reported as `undefined` — the same value an unknown invoice yields —
    // because both mean "this call sent nothing", which is exactly how the
    // sweep should count it. Returning the stale row instead would let a row
    // that was already `failed` be tallied as a failure of THIS run.
    log.info({ invoiceNumber }, 'invoice email skipped: row is claimed or out of attempts')
    return undefined
  }

  const doc = row.document as InvoiceDocument
  try {
    await sendTransactionalEmail(
      email,
      {
        to: [{ email: to, name: doc.buyer.name }],
        subject: invoiceEmailSubject(doc),
        html: renderInvoiceEmailHtml(doc),
      },
      emailFetchImpl
    )
    return (await recordEmailAttempt(db, invoiceNumber, { status: 'sent', to })) ?? row
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    log.error({ err: caught, invoiceNumber }, 'invoice email send failed')
    return (
      (await recordEmailAttempt(db, invoiceNumber, { status: 'failed', to, error: message })) ?? row
    )
  }
}

/**
 * Mail the invoices a just-committed payment minted. Called AFTER the
 * transaction commits (never inside it) and deliberately NOT awaited by the
 * request: the shopper's payment confirmation must not wait on Brevo, and a
 * failed send is already recorded on the row for the retry sweep to pick up.
 */
export function sendCapturedInvoiceEmails(
  db: Db,
  capture: InvoiceCapture,
  email: EmailSenderConfig | undefined,
  emailFetchImpl: typeof fetch | undefined,
  log: FastifyBaseLogger,
  /**
   * Absent ⇒ a failed send waits for the daily backstop cron, i.e. exactly
   * today's behaviour. See `lib/tasks.ts` for why unconfigured degrades rather
   * than closes.
   */
  tasks?: TaskEnqueuer
): void {
  if (capture.invoiceNumbers.length === 0) return
  void (async () => {
    let owed = false
    try {
      const context = await resolveInvoiceContext(db)
      // Operator kill switch: issuance still happens (the document is the legal
      // record), only the customer's emailed copy is held back.
      if (!context.emailEnabled) return
      for (const invoiceNumber of capture.invoiceNumbers) {
        const row = await sendInvoiceEmail(db, invoiceNumber, email, emailFetchImpl, log)
        if (row && stillOwedAnEmail(row)) owed = true
      }
    } catch (err) {
      log.error({ err, invoiceNumbers: capture.invoiceNumbers }, 'invoice email dispatch failed')
      // A throw here means we do not know the row states, and the most likely
      // cause (Neon or Brevo down) is exactly when a retry is owed. Ask for one.
      owed = true
    }
    // Only now, once every inline attempt has been made and recorded: asking
    // earlier would schedule a drain for work this call was about to finish.
    if (owed && tasks) requestSweep(tasks, 'invoice-emails', log)
  })()
}

/**
 * Whether the retry sweep would still pick this row up — the SAME predicate
 * `countInvoicesNeedingEmail` selects on, deliberately, so a task is never
 * enqueued for a row the sweep will not look at (an exhausted attempt budget,
 * `skipped_no_email`, or a copy already sent). Enqueuing on those would buy a
 * guaranteed-empty Neon wake, which is the entire cost this mechanism exists
 * to avoid.
 */
function stillOwedAnEmail(row: InvoiceRow): boolean {
  return (
    (row.emailStatus === 'pending' || row.emailStatus === 'failed') &&
    row.emailAttempts < MAX_EMAIL_ATTEMPTS
  )
}

export interface InvoiceRoutesOptions {
  db: Db
}

/** Authed shopper routes: read the invoice for one of the caller's own orders. */
export const invoiceRoutes: FastifyPluginAsyncZod<InvoiceRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/orders/:orderId',
    {
      schema: {
        params: InvoiceOrderParamsSchema,
        response: { 200: InvoiceResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      // User-scoped read: another shopper's order — and an order that has no
      // invoice yet — both read as 404. Never leak either.
      const row = await getInvoiceByOrderId(db, request.params.orderId, request.user.id)
      if (!row) throw notFound('Invoice not found')
      return {
        invoiceNumber: row.invoiceNumber,
        issuedAt: row.issuedAt.toISOString(),
        document: row.document as InvoiceDocument,
      }
    }
  )

  /**
   * The printable page, as `text/html` — this is what the app's invoice screen
   * loads into a WebView, and what a shopper prints or saves as PDF. Always the
   * CUSTOMER copy: the delivery copy is a packing document and belongs to the
   * admin side only.
   */
  app.get(
    '/orders/:orderId/html',
    // No `response` schema on purpose: this route replies `text/html`, and a
    // declared response schema puts the zod serializer in the path, which would
    // try to JSON-encode the page. Errors still come out of the central handler
    // in the standard envelope.
    { schema: { params: InvoiceOrderParamsSchema } },
    async (request, reply) => {
      const row = await getInvoiceByOrderId(db, request.params.orderId, request.user.id)
      if (!row) throw notFound('Invoice not found')
      const copy: InvoiceCopy = 'customer'
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderInvoicePrintHtml(row.document as InvoiceDocument, { copy }))
    }
  )
}
