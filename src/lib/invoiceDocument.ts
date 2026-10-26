/**
 * Assembles an {@link InvoiceDocument} from plain values. Pure: no DB, no
 * config reads, no clock. That is deliberate — the invoices service may not
 * read payments/catalog/config (docs/ARCHITECTURE.md module rules), and the
 * route layer that legitimately CAN read all three has no business also owning
 * a hundred lines of document-shaping logic. So the gathering happens in the
 * route and the shaping happens here, where it is trivially testable.
 *
 * The output is frozen into `invoices.document` and never recomputed. Read
 * `contracts/invoices.ts` first for why the document omits GSTIN/HSN/tax
 * columns; this file implements that decision rather than restating it.
 */

import type {
  InvoiceDocument,
  InvoiceLine,
  InvoiceManufacturerBlock,
  InvoiceSellerBlock,
} from '../contracts/invoices.js'
import { gstStateCodeFor } from './gstStates.js'
import { decomposeCartGst, type GstDecomposeResult } from './gstTax.js'
import { amountInWords, formatInvoiceNumber } from './invoiceFormat.js'

/** One priced order line, joined with just enough catalog to print it. */
export interface InvoiceOrderLine {
  sku: string
  /** The product the sku belongs to — the key into {@link BuildInvoiceDocumentInput.productLegal}. */
  productId: string
  name: string
  size: string
  qty: number
  /** Price actually charged per unit, frozen at order time. */
  priceInr: number
  /** `catalog_items.image_url` for the sku, when the catalog holds one. */
  imageUrl?: string | undefined
  /**
   * `hsn`/`gstRatePct` frozen into `payments.cart_snapshot` at order time
   * (docs plan §2.1). Absent/`0` on every order that predates the tax engine
   * — that absence is exactly what keeps this document a `docVersion: 1`
   * (see `resolveGstBreakdown`), never a guess filled in from today's rate.
   */
  hsn?: string
  gstRatePct?: number
}

/** The order being invoiced, already read out of `payments` by the route. */
export interface InvoiceOrderInput {
  orderId: string
  status: 'paid' | 'refunded'
  createdAt: Date
  paidAt: Date | null
  /** Gateway payment reference, when the row carries one. */
  paymentReference: string | null
  buyer: {
    name: string
    phone: string
    houseNumber: string
    roadArea: string
    city: string
    state: string
    pincode: string
  }
  lines: InvoiceOrderLine[]
  goodsInr: number
  couponDiscountInr: number
  shippingFeeInr: number
  totalInr: number
}

/**
 * Legal Metrology / Cosmetics Rules declarations for one product, read from the
 * `products` table. Every field may be `''` — the catalog only enforces
 * completeness at the moment a product goes ACTIVE, and an order can contain a
 * product that was live before that rule existed.
 */
export interface ProductLegalInfo {
  manufacturerName: string
  manufacturerAddress: string
  /**
   * The product's OWN manufacturing licence (Phase 3). Meaningful only
   * alongside `manufacturerName`: a licence number identifies the maker who
   * holds it, so printing one against a different maker's name would be a false
   * declaration. See {@link manufacturerBlocks}.
   */
  manufacturerLicence: string
  countryOfOrigin: string
  consumerCareContact: string
}

export interface BuildInvoiceDocumentInput {
  /** From `invoice.numberPrefix` config, e.g. "TT". */
  numberPrefix: string
  fy: string
  seq: number
  issuedAt: Date
  order: InvoiceOrderInput
  /** Resolved from `legal.company`; the route refuses to issue without legalName + address. */
  seller: InvoiceSellerBlock
  /** Optional invoice note; blank for current invoices (venue belongs in Terms). */
  jurisdiction: { city: string; state: string }
  /**
   * The seller's OWN GST state, distinct from the optional jurisdiction note.
   * Decides IGST vs CGST+SGST. Empty ⇒ a
   * `docVersion: 2` document can never be built, even for a registered
   * seller — a half-configured registration must not silently guess which
   * branch applies.
   */
  registeredStateName?: string
  /** From `legal.manufacturer` — the attribution used for any product that declares none of its own. */
  defaultManufacturer: { legalName: string; address: string; licence: string }
  /** productId → its own declarations, when the catalog holds them. */
  productLegal: ReadonlyMap<string, ProductLegalInfo>
  /** From `invoice.footerNote` config. */
  footerNote: string
}

/** Country of origin is a required declaration; the catalog's own column defaults to this. */
const DEFAULT_COUNTRY_OF_ORIGIN = 'India'

/**
 * The GST sentence is DERIVED from `gstRegistered`, never configured. A config
 * string could be edited to say "GST included" while the flag still said
 * unregistered, and the document would then contradict itself on the one point
 * that makes it lawful. Wording that can only ever be true is worth more than
 * wording that can be tweaked without a deploy.
 */
function gstNoteFor(seller: InvoiceSellerBlock): string {
  return seller.gstRegistered && seller.gstin
    ? `GST charged as shown. GSTIN: ${seller.gstin}.`
    : `GST not applicable — ${seller.legalName} is not registered under GST, and no GST has been charged on this invoice.`
}

/**
 * "Subject to Ahmedabad, Gujarat jurisdiction." — omitted entirely rather than
 * printed with a hole in it when the config carries no city/state. A blank
 * jurisdiction clause on a legal document is worse than no clause.
 */
function jurisdictionNote(jurisdiction: { city: string; state: string }): string {
  const place = [jurisdiction.city, jurisdiction.state].filter(Boolean).join(', ')
  return place ? `Subject to ${place} jurisdiction.` : ''
}

/**
 * Group the order's lines by the manufacturer declaration they carry. Almost
 * always one block; an order spanning two makers gets two, each naming the skus
 * it covers, because the declaration is per-product and collapsing them would
 * attribute a product to the wrong manufacturer.
 *
 * **The licence follows the maker, never the product's neighbours** (Phase 3).
 * A product that declares its own `manufacturerName` is attributed entirely to
 * itself — name, address AND licence — and a product that declares none
 * inherits the configured `legal.manufacturer` entity entirely, licence
 * included. There is no third case, because mixing them produces a block that
 * names one maker and cites another's licence number.
 *
 * This replaced a name-equality check (`legalName === defaultManufacturer
 * .legalName ? defaultManufacturer.licence : ''`), which was the best available
 * before `products.manufacturer_licence` was read: it printed a blank licence
 * for every second supplier, and would have printed the WRONG licence for any
 * supplier that happened to share the default's legal name.
 */
function manufacturerBlocks(input: BuildInvoiceDocumentInput): InvoiceManufacturerBlock[] {
  const { defaultManufacturer, productLegal, order } = input
  const byKey = new Map<string, InvoiceManufacturerBlock>()

  for (const line of order.lines) {
    const info = productLegal.get(line.productId)
    // One decision, made once: does this product declare its own maker?
    const declaresOwn = Boolean(info?.manufacturerName)
    const legalName = declaresOwn ? info!.manufacturerName : defaultManufacturer.legalName
    const address = declaresOwn ? info!.manufacturerAddress : defaultManufacturer.address
    const licence = declaresOwn ? info!.manufacturerLicence : defaultManufacturer.licence
    const countryOfOrigin = info?.countryOfOrigin || DEFAULT_COUNTRY_OF_ORIGIN
    const consumerCareContact = info?.consumerCareContact ?? ''

    const key = [legalName, address, licence, countryOfOrigin, consumerCareContact].join(' ')
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.skus.includes(line.sku)) existing.skus.push(line.sku)
      continue
    }
    byKey.set(key, {
      legalName,
      address,
      licence,
      countryOfOrigin,
      consumerCareContact,
      skus: [line.sku],
    })
  }

  return [...byKey.values()]
}

function toLines(order: InvoiceOrderInput, gst: GstDecomposeResult | null): InvoiceLine[] {
  return order.lines.map((line, i) => {
    const base: InvoiceLine = {
      sku: line.sku,
      name: line.name,
      size: line.size,
      qty: line.qty,
      unitPriceInr: line.priceInr,
      lineTotalInr: line.qty * line.priceInr,
    }
    // Omitted rather than frozen as '' — an absent key and an empty string
    // render identically, and the document should not carry a field that says
    // nothing.
    if (line.imageUrl) base.imageUrl = line.imageUrl
    const taxed = gst?.lines[i]
    if (!taxed) return base
    return {
      ...base,
      hsn: line.hsn,
      gstRatePct: line.gstRatePct,
      taxableValuePaise: taxed.taxableValuePaise,
      cgstPaise: taxed.cgstPaise,
      sgstPaise: taxed.sgstPaise,
      igstPaise: taxed.igstPaise,
    }
  })
}

/**
 * Attempt the `docVersion: 2` tax decomposition. Returns null — never
 * throws — the moment any precondition isn't met: registration off, the
 * seller's own state not configured, any line missing its frozen
 * `hsn`/`gstRatePct`, or an unrecognised delivery state
 * (`lib/gstStates.ts` throws on those by design). An invoice failing to
 * issue because of a tax-computation edge case would be worse than one
 * that issues correctly as a plain `docVersion: 1` INVOICE — the seller's
 * registration status alone still decides the document's TITLE (see
 * `buildInvoiceDocument`), independent of whether this succeeds.
 */
function resolveGstBreakdown(input: BuildInvoiceDocumentInput): GstDecomposeResult | null {
  const { order, registeredStateName } = input
  if (!registeredStateName) return null
  if (order.lines.some((line) => !line.hsn || !line.gstRatePct)) return null

  try {
    const interState = gstStateCodeFor(order.buyer.state) !== gstStateCodeFor(registeredStateName)
    return decomposeCartGst({
      lines: order.lines.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        priceInr: line.priceInr,
        gstRatePct: line.gstRatePct!,
      })),
      couponDiscountInr: order.couponDiscountInr,
      shippingFeeInr: order.shippingFeeInr,
      totalInr: order.totalInr,
      interState,
    })
  } catch {
    return null
  }
}

/**
 * Build the document. `seq` is its position in `fy`'s series — the caller
 * (services/invoices.ts `issueInvoice`) allocates it inside the issuing
 * transaction and passes it straight through.
 */
export function buildInvoiceDocument(input: BuildInvoiceDocumentInput): InvoiceDocument {
  const { order, seller } = input
  const registered = seller.gstRegistered && Boolean(seller.gstin)
  // Independent of docVersion: the TITLE reflects the seller's CURRENT
  // registration status (s.31 requires it the moment registration is real),
  // while docVersion reflects whether THIS order's frozen data can actually
  // support a tax breakdown. A registered seller's pre-tax-engine order still
  // heads "TAX INVOICE" — it just can't grow tax columns it never captured.
  const gst = registered ? resolveGstBreakdown(input) : null

  return {
    docVersion: gst ? 2 : 1,
    // The single most important string on the page. Only a GST-registered
    // supplier may head a document "TAX INVOICE" (CGST s.31).
    title: registered ? 'TAX INVOICE' : 'INVOICE',
    invoiceNumber: formatInvoiceNumber(input.numberPrefix, input.fy, input.seq),
    issuedAt: input.issuedAt.toISOString(),
    orderId: order.orderId,
    orderedAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    status: order.status,
    currency: 'INR',
    seller,
    manufacturers: manufacturerBlocks(input),
    buyer: order.buyer,
    lines: toLines(order, gst),
    totals: {
      goodsInr: order.goodsInr,
      couponDiscountInr: order.couponDiscountInr,
      shippingFeeInr: order.shippingFeeInr,
      totalInr: order.totalInr,
      amountInWords: amountInWords(order.totalInr),
      ...(gst && {
        taxableValuePaise: gst.totals.taxableValuePaise,
        cgstPaise: gst.totals.cgstPaise,
        sgstPaise: gst.totals.sgstPaise,
        igstPaise: gst.totals.igstPaise,
        totalTaxPaise: gst.totals.totalTaxPaise,
        rateWise: gst.rateWise,
      }),
    },
    payment: {
      mode: order.paymentReference ? 'Prepaid — online payment' : 'Prepaid',
      reference: order.paymentReference,
    },
    notes: {
      gst: gstNoteFor(seller),
      footer: input.footerNote,
      jurisdiction: jurisdictionNote(input.jurisdiction),
    },
    ...(gst && { placeOfSupply: { state: order.buyer.state, code: gstStateCodeFor(order.buyer.state) } }),
  }
}
