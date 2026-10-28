/**
 * Zod contracts for the invoices module. Imports only `zod`, same rule as every
 * other contracts file (shareable with mobile and the admin SPA).
 *
 * ## What this document is, legally
 *
 * ## STATUS 2026-09-26 — Adix reseller model restored
 *
 * Two things have changed since this was written, neither of them yet
 * reflected in the code underneath:
 *
 * 1. Adix IS now registered — GSTIN on file (TT_LEGAL_GSTIN), and
 *    `legal.company.gstRegistered` has been `true` in prod since
 *    2026-08-13. The `docVersion: 2` forward-compatibility path described
 *    below is therefore the live path, not a future one.
 * 2. The owner restored the reseller model: Saman makes a B2B supply to Adix;
 *    Adix sells to the shopper under its own GSTIN. The September 5 proposal
 *    for Saman to invoice shoppers is archived in `docs/SPEC-DROPSHIP-MODEL.md`.
 *    The invoice contract encodes the principal model selected now.
 *
 * The original rationale, kept because it states why the choice mattered:
 *
 * Adix AI (brand: Tiny Tales) sells as PRINCIPAL — the seller of record — goods
 * manufactured by a separately licensed entity. It was NOT registered under GST
 * (`legal.company.gstRegistered: false`) when this was written. That single fact
 * decided the whole shape of the document:
 *
 * - The title is **INVOICE**, never "Tax Invoice": only a registered supplier
 *   may issue one (CGST s.31).
 * - There is **no GSTIN field with a value**, because printing a registration
 *   number one does not hold is a false statement on a commercial document.
 * - There are **no CGST/SGST/IGST columns**: an unregistered person must not
 *   collect tax (CGST s.32). `notes.gst` says so in words on the face of the
 *   document rather than leaving the absence to be guessed at.
 * - There is **no HSN column**: HSN is a tax-invoice field, and the catalog
 *   holds no HSN data to print even if it were one.
 *
 * Adix's website is within the broad ECO definition, but CBIC's own-site FAQ
 * says an ECO selling its own products is not required to collect TCS on those
 * own-account supplies. Here Adix purchases from Saman and resells under its
 * own billing; Saman's GSTIN belongs on the separate B2B invoice to Adix.
 * Manufacturer attribution (required by Legal Metrology and Cosmetics rules)
 * remains on the consumer invoice as product information, not as supplier.
 *
 * ## Forward compatibility (now built — see `docVersion`)
 *
 * Every legal string is resolved from the `legal.company` / `legal.manufacturer`
 * config rows, never hardcoded. The day a GSTIN exists, flipping
 * `gstRegistered: true` and filling `gstin` makes the builder emit
 * `title: 'TAX INVOICE'`, print the number, and (once an order's lines all
 * carry a frozen `hsn`/`gstRatePct`) emit a `docVersion: 2` document with
 * per-line HSN/rate/taxable/tax columns, a rate-wise summary and
 * `placeOfSupply` — see `InvoiceLineSchema`, `InvoiceTotalsSchema`,
 * `InvoiceDocumentSchema`. No code change, no deploy. A `docVersion: 1`
 * document issued before that day renders exactly as issued forever —
 * `docVersion` is decided once, at issue time, never recomputed by a reader.
 *
 * ## Immutability
 *
 * An `InvoiceDocument` is FROZEN at issue time and stored whole
 * (`invoices.document`). It is fully denormalised on purpose: renaming a
 * product, moving the registered office or re-pricing a sku must never change a
 * document that has already been emailed to a customer and printed for a
 * courier.
 *
 * Table (owned by `invoices`, see db/schema.ts `invoices` / `invoiceCounters`):
 *
 * ```
 * invoices:
 *   invoice_number  text pk          -- "TT/26-27/000142"
 *   order_id        text unique fk -> payments(order_id) on delete restrict
 *   user_id         uuid fk -> users(id) on delete restrict
 *   fy              text             -- "26-27" (Indian FY, 1 Apr–31 Mar)
 *   seq             integer          -- gapless within fy
 *   issued_at       timestamptz
 *   total_paise     integer
 *   document        jsonb            -- InvoiceDocumentSchema, frozen
 *   email_status    text             -- pending|sending|sent|failed|skipped_no_email|skipped_backfill
 *   email_to, emailed_at, email_attempts, last_email_error
 *
 * invoice_counters:
 *   fy        text pk
 *   next_seq  integer
 * ```
 *
 * Endpoints:
 * - `GET /v1/invoices/orders/:orderId` (auth): the caller's own stored invoice.
 * - `GET /v1/invoices/orders/:orderId/html` (auth): the same document rendered
 *   as a standalone printable HTML page (`text/html`) — what the app's invoice
 *   screen shows in a WebView.
 * - `GET /v1/admin/invoices` (auth + admin): the sales register, newest first.
 * - `GET /v1/admin/invoices/:invoiceNumber` (auth + admin).
 * - `GET /v1/admin/invoices/:invoiceNumber/html?copy=customer|delivery`
 *   (auth + admin): the print view; `delivery` adds the packing-slip band that
 *   travels with the parcel.
 * - `POST /v1/admin/invoices/:invoiceNumber/email` (auth + admin): (re)send the
 *   customer's copy, optionally to an override address.
 * - `GET /v1/admin/invoices/export.csv` (auth + admin): flat sales register.
 */

import { z } from 'zod'

/** How the customer's emailed copy is doing. Mirrors `invoices_email_status_valid`. */
export const InvoiceEmailStatusSchema = z.enum([
  'pending',
  /**
   * Claimed by a sender that has not answered yet — see `claimInvoiceEmail`.
   * Transient by construction: it becomes `sent`/`failed` when the send returns,
   * or is reclaimed to `failed` by the sweep's reaper if the sender died.
   */
  'sending',
  'sent',
  'failed',
  /** We hold no email address for this shopper — nothing was attempted, and that is not a failure. */
  'skipped_no_email',
  /** Issued retroactively by `scripts/backfill-invoices.ts`; deliberately never mailed. */
  'skipped_backfill',
])

/**
 * Seller of record. As of 2026-08-13 prod runs `gstRegistered: true`, and since
 * 2026-09-04 `gstin` is the real GSTIN (it was a placeholder in
 * between). The renderer keys off `gstRegistered` alone, so both flip together
 * or not at all.
 * `supportEmail` is a ROLE mailbox — no individual's name, personal email or
 * phone number appears on this document or anywhere else we publish.
 */
export const InvoiceSellerBlockSchema = z.object({
  legalName: z.string(),
  brand: z.string(),
  address: z.string(),
  gstRegistered: z.boolean(),
  gstin: z.string(),
  supportEmail: z.string(),
})

/**
 * Manufacturer attribution (Cosmetics Rules 2020 + Legal Metrology (Packaged
 * Commodities) Rules r.6). An array, not a single block: an order may span
 * products from different makers, and the declaration is per-product, not
 * per-invoice. `skus` says which lines each block covers — the renderer omits
 * that list when there is exactly one block, which is the ordinary case.
 */
export const InvoiceManufacturerBlockSchema = z.object({
  legalName: z.string(),
  address: z.string(),
  /** Manufacturing licence number, e.g. "GC1299". '' when not applicable/known. */
  licence: z.string(),
  countryOfOrigin: z.string(),
  /** Consumer-care channel for the product itself; '' falls back to the seller's `supportEmail`. */
  consumerCareContact: z.string(),
  skus: z.array(z.string()),
})

/** Bill-to / ship-to. Frozen from the order's own `address_snapshot`, never re-read from `addresses`. */
export const InvoiceBuyerSchema = z.object({
  name: z.string(),
  phone: z.string(),
  houseNumber: z.string(),
  roadArea: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
})

/**
 * One priced line, exactly as charged. `unitPriceInr` is the post-discount
 * price the shopper actually paid per unit (the only per-unit number
 * `payments.cart_snapshot` freezes) — there is no MRP/strike-through here,
 * because inventing a "you saved ₹X" figure the row cannot support would be a
 * false claim on an invoice.
 *
 * The tax fields below are the extension point this comment used to promise
 * and now is: present (docVersion 2) once the seller is GST-registered AND
 * every line of the order carried an `hsn`/`gstRatePct` at order time;
 * entirely absent (docVersion 1) otherwise. All money here is PAISE, integer
 * — no float reaches a legal document. Exactly one of `cgstPaise`+`sgstPaise`
 * or `igstPaise` is non-zero per line, decided once for the whole document by
 * `placeOfSupply` vs the seller's registered state (`lib/gstStates.ts`).
 */
export const InvoiceLineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  size: z.string(),
  /**
   * The sku's catalog thumbnail, frozen with the rest of the line so the
   * emailed copy shows the shopper what they actually bought. Presentation
   * only — absent on every document issued before this field existed, and on
   * any sku the catalog holds no image for, which the renderers handle with a
   * monogram tile rather than a broken image.
   */
  imageUrl: z.string().max(2048).optional(),
  qty: z.int().positive(),
  unitPriceInr: z.int().nonnegative(),
  lineTotalInr: z.int().nonnegative(),
  hsn: z.string().optional(),
  gstRatePct: z.int().nonnegative().optional(),
  taxableValuePaise: z.int().nonnegative().optional(),
  cgstPaise: z.int().nonnegative().optional(),
  sgstPaise: z.int().nonnegative().optional(),
  igstPaise: z.int().nonnegative().optional(),
})

/** One rate band's aggregate across the whole document — the invoice footer row and the GSTR-1 rate-wise input. */
export const InvoiceRateWiseSchema = z.object({
  gstRatePct: z.int().nonnegative(),
  taxableValuePaise: z.int().nonnegative(),
  cgstPaise: z.int().nonnegative(),
  sgstPaise: z.int().nonnegative(),
  igstPaise: z.int().nonnegative(),
  totalTaxPaise: z.int().nonnegative(),
})

/**
 * Money, whole rupees, in the order the document prints them. The identity
 * `goodsInr − couponDiscountInr + shippingFeeInr === totalInr` holds for every
 * document and is asserted in the renderer's tests.
 *
 * The tax aggregates are the same present-iff-docVersion-2 extension as
 * `InvoiceLineSchema`'s — see there for why. `taxableValuePaise` +
 * `totalTaxPaise` sum to `totalInr × 100` when present (`lib/gstTax.ts`'s
 * invariant, carried through unchanged into the frozen document).
 */
export const InvoiceTotalsSchema = z.object({
  goodsInr: z.int().nonnegative(),
  couponDiscountInr: z.int().nonnegative(),
  shippingFeeInr: z.int().nonnegative(),
  totalInr: z.int().nonnegative(),
  /** "Rupees One Thousand Four Hundred Only" — the customary Indian invoice line. */
  amountInWords: z.string(),
  taxableValuePaise: z.int().nonnegative().optional(),
  cgstPaise: z.int().nonnegative().optional(),
  sgstPaise: z.int().nonnegative().optional(),
  igstPaise: z.int().nonnegative().optional(),
  totalTaxPaise: z.int().nonnegative().optional(),
  rateWise: z.array(InvoiceRateWiseSchema).optional(),
})

/**
 * How it was paid. There is no `couponCode` field: `payments.cart_snapshot`
 * freezes the discount AMOUNT but not the code that produced it, and printing a
 * code we did not store would be a guess. The discount row stands on its own.
 */
export const InvoicePaymentSchema = z.object({
  /** Display copy, e.g. "Prepaid — online payment". */
  mode: z.string(),
  /** Gateway payment reference, or null for an order that never carried one. */
  reference: z.string().nullable(),
})

/** The three standing footnotes. All three come from config so wording is editable without a deploy. */
export const InvoiceNotesSchema = z.object({
  /** e.g. "GST not applicable — the supplier is not registered under GST." */
  gst: z.string(),
  /** e.g. "This is a computer-generated invoice and does not require a signature." */
  footer: z.string(),
  /** e.g. "Subject to Ahmedabad, Gujarat jurisdiction." */
  jurisdiction: z.string(),
})

/** Where the goods were delivered, for the face of a `docVersion: 2` document (IGST s.10(1)(a)). */
export const InvoicePlaceOfSupplySchema = z.object({
  state: z.string(),
  code: z.string(),
})

/** The whole frozen document. Stored verbatim in `invoices.document`. */
export const InvoiceDocumentSchema = z.object({
  /**
   * 1 while unregistered (or for any order predating the tax engine) — no
   * GSTIN, no tax columns, no HSN, per `contracts/invoices.ts`'s class doc.
   * 2 once the seller is GST-registered and every line of THIS order carried
   * an `hsn`/`gstRatePct` at order time (`buildInvoiceDocument` decides which,
   * never the reader) — adds the tax fields on `InvoiceLineSchema`/
   * `InvoiceTotalsSchema` and `placeOfSupply`. Readers branch on this rather
   * than guessing, so a frozen v1 document renders exactly as issued forever,
   * even after the seller later registers.
   */
  docVersion: z.union([z.literal(1), z.literal(2)]),
  /** 'INVOICE' while unregistered; 'TAX INVOICE' the day a GSTIN exists. */
  title: z.string(),
  invoiceNumber: z.string(),
  issuedAt: z.iso.datetime(),
  orderId: z.string(),
  orderedAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  status: z.enum(['paid', 'refunded']),
  currency: z.literal('INR'),
  seller: InvoiceSellerBlockSchema,
  manufacturers: z.array(InvoiceManufacturerBlockSchema),
  buyer: InvoiceBuyerSchema,
  lines: z.array(InvoiceLineSchema),
  totals: InvoiceTotalsSchema,
  payment: InvoicePaymentSchema,
  notes: InvoiceNotesSchema,
  /** Present only on `docVersion: 2`. */
  placeOfSupply: InvoicePlaceOfSupplySchema.optional(),
})

/** `GET /v1/invoices/orders/:orderId` — the customer's own invoice. */
export const InvoiceResponseSchema = z.object({
  invoiceNumber: z.string(),
  issuedAt: z.iso.datetime(),
  document: InvoiceDocumentSchema,
})

/** Route params keyed by the order the invoice belongs to. */
export const InvoiceOrderParamsSchema = z.strictObject({
  orderId: z.string().min(1),
})

/** Route params keyed by the document number itself (admin). */
export const InvoiceNumberParamsSchema = z.strictObject({
  invoiceNumber: z.string().min(1),
})

/** Which copy to render. 'delivery' adds the DELIVERY COPY band + packing block for the parcel. */
export const InvoiceCopySchema = z.enum(['customer', 'delivery'])

/** `?copy=` on the two HTML endpoints. Absent ⇒ the customer copy. */
export const InvoiceHtmlQuerySchema = z.strictObject({
  copy: InvoiceCopySchema.optional(),
})

/**
 * One row of the admin sales register. Deliberately flat (no nested document):
 * the list view is a table, and shipping the full jsonb for every row would
 * make the register many times larger than the screen that renders it.
 */
export const InvoiceSummarySchema = z.object({
  invoiceNumber: z.string(),
  orderId: z.string(),
  issuedAt: z.iso.datetime(),
  status: z.enum(['paid', 'refunded']),
  buyerName: z.string(),
  buyerPhone: z.string(),
  buyerCity: z.string(),
  buyerState: z.string(),
  goodsInr: z.int(),
  couponDiscountInr: z.int(),
  shippingFeeInr: z.int(),
  totalInr: z.int(),
  emailStatus: InvoiceEmailStatusSchema,
  emailTo: z.string().nullable(),
  emailedAt: z.iso.datetime().nullable(),
})

/**
 * `GET /v1/admin/invoices` query. `q` matches invoice number, order id, buyer
 * name or buyer phone (case-insensitive substring). `from`/`to` are inclusive
 * calendar bounds on `issuedAt`, as `YYYY-MM-DD`.
 */
export const InvoiceListQuerySchema = z.strictObject({
  q: z.string().min(1).max(100).optional(),
  emailStatus: InvoiceEmailStatusSchema.optional(),
  status: z.enum(['paid', 'refunded']).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/** `GET /v1/admin/invoices` response. `total` is the count BEFORE limit/offset, for the pager. */
export const InvoiceListResponseSchema = z.object({
  invoices: z.array(InvoiceSummarySchema),
  total: z.int(),
})

/** `GET /v1/admin/invoices/:invoiceNumber` — the summary plus the frozen document. */
export const InvoiceAdminDetailSchema = InvoiceSummarySchema.extend({
  document: InvoiceDocumentSchema,
  emailAttempts: z.int(),
  lastEmailError: z.string().nullable(),
})

/**
 * `POST /v1/admin/invoices/:invoiceNumber/email` body. `to` overrides the
 * stored address for this send only — it does NOT rewrite the invoice, which is
 * immutable; it is recorded as the address the copy went to.
 */
export const InvoiceEmailRequestSchema = z.strictObject({
  to: z.email().optional(),
})

/** The outcome of a (re)send attempt, as the admin panel shows it. */
export const InvoiceEmailResultSchema = z.object({
  invoiceNumber: z.string(),
  emailStatus: InvoiceEmailStatusSchema,
  emailTo: z.string().nullable(),
  emailedAt: z.iso.datetime().nullable(),
  emailAttempts: z.int(),
  lastEmailError: z.string().nullable(),
})

/** `POST /v1/admin/invoices/retry-emails` — one sweep's counts. */
export const InvoiceEmailSweepResponseSchema = z.object({
  scanned: z.int(),
  sent: z.int(),
  failed: z.int(),
  /** No address on file, or no sender configured — nothing to retry. */
  skipped: z.int(),
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type InvoiceEmailStatus = z.infer<typeof InvoiceEmailStatusSchema>
export type InvoiceSellerBlock = z.infer<typeof InvoiceSellerBlockSchema>
export type InvoiceManufacturerBlock = z.infer<typeof InvoiceManufacturerBlockSchema>
export type InvoiceBuyer = z.infer<typeof InvoiceBuyerSchema>
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>
export type InvoiceRateWise = z.infer<typeof InvoiceRateWiseSchema>
export type InvoiceTotals = z.infer<typeof InvoiceTotalsSchema>
export type InvoicePlaceOfSupply = z.infer<typeof InvoicePlaceOfSupplySchema>
export type InvoicePayment = z.infer<typeof InvoicePaymentSchema>
export type InvoiceNotes = z.infer<typeof InvoiceNotesSchema>
export type InvoiceDocument = z.infer<typeof InvoiceDocumentSchema>
export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>
export type InvoiceCopy = z.infer<typeof InvoiceCopySchema>
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>
export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>
export type InvoiceListResponse = z.infer<typeof InvoiceListResponseSchema>
export type InvoiceAdminDetail = z.infer<typeof InvoiceAdminDetailSchema>
export type InvoiceEmailRequest = z.infer<typeof InvoiceEmailRequestSchema>
export type InvoiceEmailResult = z.infer<typeof InvoiceEmailResultSchema>
export type InvoiceEmailSweepResponse = z.infer<typeof InvoiceEmailSweepResponseSchema>
