/**
 * Builds a {@link CreditNoteDocument} by REVERSING an already-issued,
 * already-frozen `docVersion: 2` invoice. Pure: no DB, no config reads, no
 * clock — same discipline as `lib/invoiceDocument.ts`.
 *
 * Deliberately NOT a re-run of `buildInvoiceDocument` against the order: the
 * invoice it reverses is the legal record of what was actually charged, and
 * recomputing from the order risks disagreeing with it (a rate change, a
 * catalog edit) between issue and refund. Reading the frozen document instead
 * makes "the credit note reverses exactly the invoice" true by construction.
 */

import type { CreditNoteDocument, CreditNoteLine, CreditNoteRateWise } from '../contracts/creditNotes.js'
import type { InvoiceDocument } from '../contracts/invoices.js'
import { amountInWords, formatCreditNoteNumber } from './invoiceFormat.js'

export interface BuildCreditNoteDocumentInput {
  /** From `invoice.numberPrefix` config, e.g. "LAA" — same prefix the invoice used. */
  numberPrefix: string
  fy: string
  seq: number
  issuedAt: Date
  orderId: string
  /** The frozen invoice this note reverses. */
  invoice: InvoiceDocument
  /** Shopper-facing reason the refund happened. */
  reason: string
  /** From `invoice.footerNote` config — reused verbatim, same wording convention as the invoice. */
  footerNote: string
}

function toLines(invoice: InvoiceDocument): CreditNoteLine[] {
  return invoice.lines.map((line) => ({
    sku: line.sku,
    name: line.name,
    size: line.size,
    qty: line.qty,
    unitPriceInr: line.unitPriceInr,
    lineTotalInr: line.lineTotalInr,
    hsn: line.hsn ?? '',
    gstRatePct: line.gstRatePct ?? 0,
    taxableValuePaise: line.taxableValuePaise ?? 0,
    cgstPaise: line.cgstPaise ?? 0,
    sgstPaise: line.sgstPaise ?? 0,
    igstPaise: line.igstPaise ?? 0,
  }))
}

function toRateWise(invoice: InvoiceDocument): CreditNoteRateWise[] {
  return (invoice.totals.rateWise ?? []).map((band) => ({ ...band }))
}

/**
 * Build the credit note that reverses `input.invoice` in full.
 *
 * Returns `null` — never throws — when `input.invoice.docVersion !== 2`: an
 * unregistered-seller or pre-tax-engine invoice carried no output tax, so
 * CGST s.34 has nothing for this document to reverse. Callers (the refund
 * transition hook) treat `null` as "no credit note needed", exactly the same
 * shape `resolveGstBreakdown` uses for "no docVersion 2 possible" — a refund
 * must never be blocked by this check either way.
 */
export function buildCreditNoteDocument(input: BuildCreditNoteDocumentInput): CreditNoteDocument | null {
  const { invoice } = input
  if (invoice.docVersion !== 2 || !invoice.placeOfSupply) return null

  return {
    docVersion: 2,
    title: 'CREDIT NOTE',
    creditNoteNumber: formatCreditNoteNumber(input.numberPrefix, input.fy, input.seq),
    issuedAt: input.issuedAt.toISOString(),
    orderId: input.orderId,
    originalInvoiceNumber: invoice.invoiceNumber,
    originalInvoiceIssuedAt: invoice.issuedAt,
    reason: input.reason,
    currency: 'INR',
    seller: {
      legalName: invoice.seller.legalName,
      brand: invoice.seller.brand,
      address: invoice.seller.address,
      gstin: invoice.seller.gstin,
    },
    buyer: invoice.buyer,
    lines: toLines(invoice),
    totals: {
      goodsInr: invoice.totals.goodsInr,
      couponDiscountInr: invoice.totals.couponDiscountInr,
      shippingFeeInr: invoice.totals.shippingFeeInr,
      totalInr: invoice.totals.totalInr,
      amountInWords: amountInWords(invoice.totals.totalInr),
      taxableValuePaise: invoice.totals.taxableValuePaise ?? 0,
      cgstPaise: invoice.totals.cgstPaise ?? 0,
      sgstPaise: invoice.totals.sgstPaise ?? 0,
      igstPaise: invoice.totals.igstPaise ?? 0,
      totalTaxPaise: invoice.totals.totalTaxPaise ?? 0,
      rateWise: toRateWise(invoice),
    },
    notes: {
      footer: input.footerNote,
      jurisdiction: invoice.notes.jurisdiction,
    },
    placeOfSupply: invoice.placeOfSupply,
  }
}
