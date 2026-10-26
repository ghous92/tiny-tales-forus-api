/**
 * Credit-note issuance composition. No HTTP surface in this phase — no
 * `FastifyPluginAsyncZod` export here — scope is exactly "the issuing
 * service/hook, wired to the refund transition" (db/schema.ts's `creditNotes`
 * table comment, docs plan §2.6). A shopper/admin-facing GET, HTML rendering
 * and email delivery are a later phase, same as `routes/invoices.ts` grew
 * them incrementally on top of `issueInvoiceForOrder`.
 *
 * Mirrors `routes/invoices.ts`'s composition shape: the service layer
 * (`services/creditNotes.ts`) may not import `services/invoices.ts` or
 * `services/payments.ts` (ARCHITECTURE.md rule 2), so the cross-module read
 * (the order's own invoice) and the hook wiring both live here.
 */

import type { FastifyBaseLogger } from 'fastify'

import type { InvoiceDocument } from '../contracts/invoices.js'
import type { Db } from '../db/client.js'
import type { CreditNoteRow } from '../db/schema.js'
import { buildCreditNoteDocument } from '../lib/creditNoteDocument.js'
import { financialYearOf } from '../lib/invoiceFormat.js'
import { getConfigValues } from '../services/config.js'
import { issueCreditNote } from '../services/creditNotes.js'
import { getInvoiceByOrderId } from '../services/invoices.js'
import type { OrderInvoiceSource, OrderRefundHook } from '../services/payments.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const DEFAULT_NUMBER_PREFIX = 'LAA'
const DEFAULT_FOOTER_NOTE = 'This is a computer-generated invoice and does not require a signature.'

export interface CreditNoteContext {
  numberPrefix: string
  footerNote: string
}

/**
 * Deliberately NOT `resolveInvoiceContext` (routes/invoices.ts) — a credit
 * note is built by REVERSING the frozen invoice, not by re-deriving a seller/
 * manufacturer block from `legal.company`, so it needs neither that config
 * nor `resolveInvoiceContext`'s `invoiceUnavailable` throw on an incomplete
 * one. Coupling credit-note issuance to an unrelated config gap would make a
 * refund's side effect fail for a reason that has nothing to do with the
 * refund. Never throws.
 */
export async function resolveCreditNoteContext(db: Db): Promise<CreditNoteContext> {
  const values = await getConfigValues(db, ['invoice.numberPrefix', 'invoice.footerNote'])
  const asString = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value ? value : fallback
  return {
    numberPrefix: asString(values.get('invoice.numberPrefix'), DEFAULT_NUMBER_PREFIX),
    footerNote: asString(values.get('invoice.footerNote'), DEFAULT_FOOTER_NOTE),
  }
}

export interface IssueCreditNoteForOrderOptions {
  /** Overrides the issue instant — tests pin this the same way invoice tests do. */
  issuedAt?: Date
  /** Pre-resolved context, so a caller that already has it doesn't read config twice. */
  context?: CreditNoteContext
}

/**
 * Issue the credit note reversing one order's invoice, inside the caller's
 * transaction — or return `null` when there is nothing to reverse.
 *
 * `null`, never a thrown error, in both of these cases:
 * - No invoice is on record for this order. A refund always follows a `paid`
 *   order, and the `onOrderPaid` hook mints the invoice inside that same
 *   transition — so this is normally unreachable, but a row that predates
 *   invoicing (or a still-failed backfill) must not turn a refund into a 500.
 * - The invoice is `docVersion: 1` (unregistered seller, or an order that
 *   predates the tax engine): no output tax was charged, so CGST s.34 has
 *   nothing for a credit note to reverse. `buildCreditNoteDocument` enforces
 *   this too; checking `docVersion` here first just avoids a throwaway build.
 *
 * READS AND WRITES BOTH GO THROUGH `tx`, same reasoning as
 * `issueInvoiceForOrder` (routes/invoices.ts) — a second connection for the
 * config read would deadlock a saturated pool exactly when refunds are
 * busiest.
 */
export async function issueCreditNoteForOrder(
  tx: Tx,
  order: OrderInvoiceSource,
  reason: string,
  options: IssueCreditNoteForOrderOptions = {}
): Promise<CreditNoteRow | null> {
  const db = tx as unknown as Db
  const invoiceRow = await getInvoiceByOrderId(db, order.orderId, order.userId)
  if (!invoiceRow) return null

  const invoiceDoc = invoiceRow.document as InvoiceDocument
  if (invoiceDoc.docVersion !== 2) return null

  const context = options.context ?? (await resolveCreditNoteContext(db))
  const issuedAt = options.issuedAt ?? new Date()

  return issueCreditNote(tx, {
    orderId: order.orderId,
    invoiceNumber: invoiceRow.invoiceNumber,
    userId: order.userId,
    fy: financialYearOf(issuedAt),
    issuedAt,
    totalPaise: invoiceRow.totalPaise,
    buildDocument: (fy, seq) => {
      const doc = buildCreditNoteDocument({
        numberPrefix: context.numberPrefix,
        fy,
        seq,
        issuedAt,
        orderId: order.orderId,
        invoice: invoiceDoc,
        reason,
        footerNote: context.footerNote,
      })
      // Unreachable: docVersion===2 (checked above, on the same frozen
      // `invoiceDoc`) is exactly `buildCreditNoteDocument`'s own guard —
      // this just satisfies `buildDocument`'s non-null return type.
      if (!doc) throw new Error('credit note document build unexpectedly returned null')
      return doc
    },
  })
}

/**
 * The `onOrderRefunded` hook that mints the credit note. Wired in
 * `routes/payments.ts` alongside the refund transition, for the same reason
 * `makeInvoiceIssuanceHook` (routes/invoices.ts) is: it must share the
 * transaction that flips the order to `refunded`, and `services/payments.ts`
 * may not import another module to get it.
 *
 * **It swallows everything, deliberately** — same trade the invoice hook
 * makes. By the time it runs the refund has already happened (Razorpay's
 * money, or Razorpay's own webhook telling us so); an exception escaping
 * would roll back a transition that cannot be un-done upstream. A missing
 * credit note is a manual-issue problem for whoever runs GST compliance, not
 * a reason to fail a refund.
 *
 * Runs in a SAVEPOINT so a failure takes the counter increment back with it
 * — same reason `makeInvoiceIssuanceHook` uses one.
 */
export function makeCreditNoteIssuanceHook(opts: { log: FastifyBaseLogger }): OrderRefundHook {
  return async (tx, orderId, order, reason) => {
    try {
      await tx.transaction((inner) => issueCreditNoteForOrder(inner as Tx, order, reason))
    } catch (err) {
      opts.log.error(
        { err, orderId },
        'credit note issuance failed after refund; refund stands, issue manually if GST-registered'
      )
    }
  }
}
