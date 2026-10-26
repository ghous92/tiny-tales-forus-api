/**
 * Zod contracts for the credit-notes module. Imports only `zod`, same rule as
 * every other contracts file (shareable with mobile and the admin SPA).
 *
 * ## What this document is, legally
 *
 * A credit note is the CGST s.34 reversal document a refund requires once the
 * original sale carried real output tax: it cancels, line for line, the tax
 * an already-issued `docVersion: 2` TAX INVOICE charged, so GSTR-1 Table 9B
 * can report the reversal in the period it happened rather than silently
 * understating the original invoice.
 *
 * A refund against a `docVersion: 1` INVOICE (unregistered seller, or an
 * order predating the tax engine) has no output tax to reverse — s.34 does not
 * apply, and no credit note is issued for it. `docVersion` on this document is
 * therefore always `2`: this type only ever describes a real reversal, never a
 * bookkeeping placeholder. See `lib/creditNoteDocument.ts` for the builder that
 * enforces this by returning `null` rather than a `docVersion: 1` cousin.
 *
 * ## Immutability
 *
 * Frozen at issue time and stored whole (`credit_notes.document`), same as
 * `invoices.document` — see `contracts/invoices.ts` for why.
 *
 * Table (owned by `credit_notes`, see db/schema.ts `creditNotes` /
 * `creditNoteCounters`):
 *
 * ```
 * credit_notes:
 *   credit_note_number  text pk          -- "TT/CN/26-27/000001"
 *   invoice_number       text fk -> invoices(invoice_number) on delete restrict
 *   order_id              text fk -> payments(order_id) on delete restrict
 *   user_id               uuid fk -> users(id) on delete restrict
 *   fy                    text             -- own series, may differ from the invoice's fy
 *   seq                   integer          -- gapless within fy
 *   issued_at             timestamptz
 *   total_paise           integer
 *   document              jsonb            -- CreditNoteDocumentSchema, frozen
 *
 * credit_note_counters:
 *   fy        text pk
 *   next_seq  integer
 * ```
 */

import { z } from 'zod'

/** Same shape as `InvoiceSellerBlockSchema` (contracts/invoices.ts) — duplicated, not imported: contracts import only `zod`. */
export const CreditNoteSellerBlockSchema = z.object({
  legalName: z.string(),
  brand: z.string(),
  address: z.string(),
  gstin: z.string(),
})

/** Bill-to / ship-to, frozen from the original invoice's own buyer block — never re-read from `addresses`. */
export const CreditNoteBuyerSchema = z.object({
  name: z.string(),
  phone: z.string(),
  houseNumber: z.string(),
  roadArea: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
})

/**
 * One reversed line, mirroring the original invoice line exactly (a
 * self-service cancel/refund is always the FULL order — there is no partial
 * credit note yet). Money here is the amount being taken back: positive
 * magnitudes, the same sign convention as the invoice they reverse.
 */
export const CreditNoteLineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  size: z.string(),
  qty: z.int().positive(),
  unitPriceInr: z.int().nonnegative(),
  lineTotalInr: z.int().nonnegative(),
  hsn: z.string(),
  gstRatePct: z.int().nonnegative(),
  taxableValuePaise: z.int().nonnegative(),
  cgstPaise: z.int().nonnegative(),
  sgstPaise: z.int().nonnegative(),
  igstPaise: z.int().nonnegative(),
})

/** One rate band's aggregate across the whole document — mirrors `InvoiceRateWiseSchema`. */
export const CreditNoteRateWiseSchema = z.object({
  gstRatePct: z.int().nonnegative(),
  taxableValuePaise: z.int().nonnegative(),
  cgstPaise: z.int().nonnegative(),
  sgstPaise: z.int().nonnegative(),
  igstPaise: z.int().nonnegative(),
  totalTaxPaise: z.int().nonnegative(),
})

/** Money reversed, whole rupees, positive magnitudes. Same line-item identity as `InvoiceTotalsSchema` holds here too. */
export const CreditNoteTotalsSchema = z.object({
  goodsInr: z.int().nonnegative(),
  couponDiscountInr: z.int().nonnegative(),
  shippingFeeInr: z.int().nonnegative(),
  totalInr: z.int().nonnegative(),
  amountInWords: z.string(),
  taxableValuePaise: z.int().nonnegative(),
  cgstPaise: z.int().nonnegative(),
  sgstPaise: z.int().nonnegative(),
  igstPaise: z.int().nonnegative(),
  totalTaxPaise: z.int().nonnegative(),
  rateWise: z.array(CreditNoteRateWiseSchema),
})

/** Where the goods were delivered — carried over from the original invoice's `placeOfSupply`. */
export const CreditNotePlaceOfSupplySchema = z.object({
  state: z.string(),
  code: z.string(),
})

/** The whole frozen document. Stored verbatim in `credit_notes.document`. */
export const CreditNoteDocumentSchema = z.object({
  /** Always 2 — see the class doc on why a credit note only ever describes a real tax reversal. */
  docVersion: z.literal(2),
  title: z.literal('CREDIT NOTE'),
  creditNoteNumber: z.string(),
  issuedAt: z.iso.datetime(),
  orderId: z.string(),
  /** The tax invoice this note reverses. */
  originalInvoiceNumber: z.string(),
  originalInvoiceIssuedAt: z.iso.datetime(),
  /** Shopper-facing reason, e.g. the self-service cancel reason, or "Order cancelled — refund issued". */
  reason: z.string(),
  currency: z.literal('INR'),
  seller: CreditNoteSellerBlockSchema,
  buyer: CreditNoteBuyerSchema,
  lines: z.array(CreditNoteLineSchema),
  totals: CreditNoteTotalsSchema,
  notes: z.object({
    footer: z.string(),
    jurisdiction: z.string(),
  }),
  placeOfSupply: CreditNotePlaceOfSupplySchema,
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type CreditNoteSellerBlock = z.infer<typeof CreditNoteSellerBlockSchema>
export type CreditNoteBuyer = z.infer<typeof CreditNoteBuyerSchema>
export type CreditNoteLine = z.infer<typeof CreditNoteLineSchema>
export type CreditNoteRateWise = z.infer<typeof CreditNoteRateWiseSchema>
export type CreditNoteTotals = z.infer<typeof CreditNoteTotalsSchema>
export type CreditNotePlaceOfSupply = z.infer<typeof CreditNotePlaceOfSupplySchema>
export type CreditNoteDocument = z.infer<typeof CreditNoteDocumentSchema>
