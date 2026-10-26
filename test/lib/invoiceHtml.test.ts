/**
 * The document builder and its two renderings.
 *
 * The centrepiece is the GST guard: while `legal.company.gstRegistered` is
 * false, the words "Tax Invoice", "GSTIN", "CGST", "SGST", "IGST" and "HSN"
 * must appear NOWHERE in either rendering. Every one of them would be a false
 * statement on a commercial document issued by an unregistered supplier, and
 * every one of them is exactly the kind of thing a well-meaning copy edit
 * reintroduces. This test is what stops that. The mirror image — once
 * registered AND every line carries a frozen hsn/rate (docVersion 2) — is
 * that the relevant words MUST appear; a tax invoice silently missing its tax
 * columns is its own kind of false statement.
 */

import { describe, expect, it } from 'vitest'

import type { InvoiceSellerBlock } from '../../src/contracts/invoices.js'
import {
  buildInvoiceDocument,
  type BuildInvoiceDocumentInput,
  type ProductLegalInfo,
} from '../../src/lib/invoiceDocument.js'
import { renderInvoiceEmailHtml, renderInvoicePrintHtml } from '../../src/lib/invoiceHtml.js'

/** REGISTERED, with every precondition `resolveGstBreakdown` needs — the docVersion: 2 fixture. */
const REGISTERED_SELLER: InvoiceSellerBlock = {
  legalName: 'Adix AI',
  brand: 'Tiny Tales',
  address: '3, Qamar Makhdumi Road, near Noori Masjid, Bhuli Road, Wasseypur, Dhanbad, Jharkhand 826001',
  gstRegistered: true,
  gstin: '20AAAAA0000A1Z5',
  supportEmail: 'hello@adix.ai',
}

const UNREGISTERED_SELLER: InvoiceSellerBlock = {
  legalName: 'Adix AI',
  brand: 'Tiny Tales',
  address: '4/B Al-Farooq CHS, Sarkhej, Ahmedabad, Gujarat 380051',
  gstRegistered: false,
  gstin: '',
  supportEmail: 'hello@adix.ai',
}

function input(overrides: Partial<BuildInvoiceDocumentInput> = {}): BuildInvoiceDocumentInput {
  return {
    numberPrefix: 'LAA',
    fy: '26-27',
    seq: 142,
    issuedAt: new Date('2026-08-05T06:42:00Z'),
    seller: UNREGISTERED_SELLER,
    jurisdiction: { city: 'Ahmedabad', state: 'Gujarat' },
    defaultManufacturer: {
      legalName: 'Saman Products Company',
      address: '4/B Al-Farooq Com Housing Society, Sarkhej, Ahmedabad, Gujarat 380051',
      licence: 'GC1299',
    },
    productLegal: new Map<string, ProductLegalInfo>(),
    footerNote: 'This is a computer-generated invoice and does not require a signature.',
    order: {
      orderId: 'order_TEST0001',
      status: 'paid',
      createdAt: new Date('2026-08-04T10:00:00Z'),
      paidAt: new Date('2026-08-04T10:02:00Z'),
      paymentReference: 'pay_TEST0001',
      buyer: {
        name: 'Asha Rao',
        phone: '9876543210',
        houseNumber: '12B',
        roadArea: 'Satellite Road',
        city: 'Ahmedabad',
        state: 'Gujarat',
        pincode: '380015',
      },
      lines: [
        {
          sku: 'AH-82U3-T29Q',
          productId: 'aloe-gel',
          name: 'Aloe Vera Gel',
          size: '100g',
          qty: 2,
          priceInr: 249,
        },
        {
          sku: '04-JPDR-6Z6N',
          productId: 'rose-water',
          name: 'Rose Water',
          size: '200ml',
          qty: 1,
          priceInr: 199,
        },
      ],
      goodsInr: 697,
      couponDiscountInr: 50,
      shippingFeeInr: 40,
      totalInr: 687,
    },
    ...overrides,
  }
}

/**
 * A registered seller, `registeredStateName` configured, and every line
 * carrying `hsn`/`gstRatePct` — the full precondition set for a
 * `docVersion: 2` document. Buyer stays in Gujarat (the `input()` default),
 * seller registered in Jharkhand ⇒ inter-state ⇒ IGST, the live path today.
 */
function v2Input(overrides: Partial<BuildInvoiceDocumentInput> = {}): BuildInvoiceDocumentInput {
  const base = input({
    seller: REGISTERED_SELLER,
    registeredStateName: 'Jharkhand',
  })
  return {
    ...base,
    order: {
      ...base.order,
      lines: base.order.lines.map((line) => ({ ...line, hsn: '3305.90', gstRatePct: 18 })),
    },
    ...overrides,
  }
}

describe('buildInvoiceDocument', () => {
  it('titles the document INVOICE and states GST is not applicable', () => {
    const doc = buildInvoiceDocument(input())
    expect(doc.title).toBe('INVOICE')
    expect(doc.notes.gst).toContain('not registered under GST')
    expect(doc.seller.gstin).toBe('')
  })

  it('numbers the document from its position in the series', () => {
    expect(buildInvoiceDocument(input()).invoiceNumber).toBe('LAA/26-27/000142')
  })

  it('keeps the totals identity: goods − discount + delivery = total', () => {
    const { totals } = buildInvoiceDocument(input())
    expect(totals.goodsInr - totals.couponDiscountInr + totals.shippingFeeInr).toBe(totals.totalInr)
    expect(totals.amountInWords).toBe('Rupees Six Hundred Eighty Seven Only')
  })

  it('extends each line to qty × unit price', () => {
    const doc = buildInvoiceDocument(input())
    expect(doc.lines[0]).toMatchObject({ qty: 2, unitPriceInr: 249, lineTotalInr: 498 })
    expect(doc.lines[1]).toMatchObject({ qty: 1, unitPriceInr: 199, lineTotalInr: 199 })
  })

  it('falls back to the configured manufacturer when a product declares none', () => {
    const doc = buildInvoiceDocument(input())
    expect(doc.manufacturers).toHaveLength(1)
    expect(doc.manufacturers[0]).toMatchObject({
      legalName: 'Saman Products Company',
      licence: 'GC1299',
      countryOfOrigin: 'India',
    })
  })

  it("prefers a product's own declaration and splits blocks when they differ", () => {
    const productLegal = new Map<string, ProductLegalInfo>([
      [
        'rose-water',
        {
          manufacturerName: 'Other Cosmetics Pvt Ltd',
          manufacturerAddress: 'Plot 9, Vatva, Ahmedabad',
          manufacturerLicence: '',
          countryOfOrigin: 'India',
          consumerCareContact: 'care@other.test',
        },
      ],
    ])
    const doc = buildInvoiceDocument(input({ productLegal }))
    expect(doc.manufacturers).toHaveLength(2)
    const other = doc.manufacturers.find((m) => m.legalName === 'Other Cosmetics Pvt Ltd')
    expect(other?.skus).toEqual(['04-JPDR-6Z6N'])
    // The licence belongs to the CONFIGURED entity, so it must not be printed
    // against a different maker's name.
    expect(other?.licence).toBe('')
  })

  it("prints a product's own licence against its own name, never the configured maker's", () => {
    const productLegal = new Map<string, ProductLegalInfo>([
      [
        'rose-water',
        {
          manufacturerName: 'Other Cosmetics Pvt Ltd',
          manufacturerAddress: 'Plot 9, Vatva, Ahmedabad',
          manufacturerLicence: 'GC5555',
          countryOfOrigin: 'India',
          consumerCareContact: 'care@other.test',
        },
      ],
    ])
    const doc = buildInvoiceDocument(input({ productLegal }))
    const other = doc.manufacturers.find((m) => m.legalName === 'Other Cosmetics Pvt Ltd')
    expect(other?.licence).toBe('GC5555')
  })

  it('omits the jurisdiction clause rather than printing a hole in it', () => {
    const doc = buildInvoiceDocument(input({ jurisdiction: { city: '', state: '' } }))
    expect(doc.notes.jurisdiction).toBe('')
  })

  it('becomes a TAX INVOICE the moment a GSTIN exists, with no code change', () => {
    const doc = buildInvoiceDocument(
      input({ seller: { ...UNREGISTERED_SELLER, gstRegistered: true, gstin: '24AAAAA0000A1Z5' } })
    )
    expect(doc.title).toBe('TAX INVOICE')
    expect(doc.notes.gst).toContain('24AAAAA0000A1Z5')
  })
})

describe('buildInvoiceDocument — GST (docVersion 2)', () => {
  it('reaches docVersion 2 once registered, registeredStateName is set, and every line carries hsn/rate', () => {
    const doc = buildInvoiceDocument(v2Input())
    expect(doc.docVersion).toBe(2)
    expect(doc.title).toBe('TAX INVOICE')
  })

  it('carries the invariant through: Σ(taxable + tax) === totalInr × 100', () => {
    const doc = buildInvoiceDocument(v2Input())
    const paise = (doc.totals.taxableValuePaise ?? 0) + (doc.totals.totalTaxPaise ?? 0)
    expect(paise).toBe(doc.totals.totalInr * 100)
  })

  it('is IGST — the live path today: seller in Jharkhand, buyer in Gujarat', () => {
    const doc = buildInvoiceDocument(v2Input())
    expect(doc.totals.igstPaise).toBeGreaterThan(0)
    expect(doc.totals.cgstPaise).toBe(0)
    expect(doc.totals.sgstPaise).toBe(0)
    expect(doc.placeOfSupply).toEqual({ state: 'Gujarat', code: '24' })
  })

  it('is CGST+SGST for an intra-state delivery', () => {
    const base = v2Input()
    const doc = buildInvoiceDocument({
      ...base,
      order: { ...base.order, buyer: { ...base.order.buyer, state: 'Jharkhand' } },
    })
    expect(doc.totals.igstPaise).toBe(0)
    expect(doc.totals.cgstPaise).toBeGreaterThan(0)
    expect(doc.totals.sgstPaise).toBeGreaterThan(0)
  })

  it('uses the live Gujarat seller location: Gujarat delivery is CGST+SGST', () => {
    const base = v2Input()
    const doc = buildInvoiceDocument({
      ...base,
      registeredStateName: 'Gujarat',
      order: { ...base.order, buyer: { ...base.order.buyer, state: 'Gujarat' } },
    })
    expect(doc.totals.igstPaise).toBe(0)
    expect((doc.totals.cgstPaise ?? 0) + (doc.totals.sgstPaise ?? 0)).toBeGreaterThan(0)
    expect(doc.placeOfSupply).toEqual({ state: 'Gujarat', code: '24' })
  })

  it('uses the live Gujarat seller location: another-state delivery is IGST', () => {
    const base = v2Input()
    const doc = buildInvoiceDocument({
      ...base,
      registeredStateName: 'Gujarat',
      order: { ...base.order, buyer: { ...base.order.buyer, state: 'Maharashtra' } },
    })
    expect(doc.totals.igstPaise).toBeGreaterThan(0)
    expect(doc.totals.cgstPaise).toBe(0)
    expect(doc.totals.sgstPaise).toBe(0)
    expect(doc.placeOfSupply).toEqual({ state: 'Maharashtra', code: '27' })
  })

  it('title stays TAX INVOICE (registration is real) even when docVersion falls back to 1', () => {
    // omit registeredStateName entirely — exactOptionalPropertyTypes means an
    // explicit `undefined` isn't assignable, and "absent" is the real-world
    // case anyway (an unconfigured config key).
    const withoutState = v2Input()
    delete withoutState.registeredStateName
    const doc = buildInvoiceDocument(withoutState)
    expect(doc.docVersion).toBe(1)
    expect(doc.title).toBe('TAX INVOICE')
    expect(doc.placeOfSupply).toBeUndefined()
  })

  it('falls back to docVersion 1 when a line is missing its frozen hsn/rate (pre-tax-engine order)', () => {
    const base = v2Input()
    const doc = buildInvoiceDocument({
      ...base,
      order: {
        ...base.order,
        // Same reason: omit the keys rather than setting them `undefined`.
        lines: base.order.lines.map(({ hsn: _hsn, gstRatePct: _rate, ...rest }) => rest),
      },
    })
    expect(doc.docVersion).toBe(1)
  })

  it('falls back to docVersion 1 rather than throwing on an unrecognised delivery state', () => {
    const base = v2Input()
    const doc = buildInvoiceDocument({
      ...base,
      order: { ...base.order, buyer: { ...base.order.buyer, state: 'Narnia' } },
    })
    expect(doc.docVersion).toBe(1)
  })
})

/** The words that must never appear while the seller is unregistered. */
const FORBIDDEN = ['Tax Invoice', 'TAX INVOICE', 'GSTIN', 'CGST', 'SGST', 'IGST', 'HSN']

describe('GST guard', () => {
  const doc = buildInvoiceDocument(input())

  it.each(FORBIDDEN)('the print rendering never contains %s', (word) => {
    expect(renderInvoicePrintHtml(doc)).not.toContain(word)
  })

  it.each(FORBIDDEN)('the email rendering never contains %s', (word) => {
    expect(renderInvoiceEmailHtml(doc)).not.toContain(word)
  })
})

/** The words that MUST appear once registered + docVersion 2 (mirrors FORBIDDEN above). */
const REQUIRED_INTER_STATE = ['TAX INVOICE', 'GSTIN', 'HSN', 'IGST']

describe('GST guard — registered, inter-state (docVersion 2)', () => {
  const doc = buildInvoiceDocument(v2Input())

  it.each(REQUIRED_INTER_STATE)('the print rendering contains %s', (word) => {
    expect(renderInvoicePrintHtml(doc)).toContain(word)
  })

  it.each(REQUIRED_INTER_STATE)('the email rendering contains %s', (word) => {
    expect(renderInvoiceEmailHtml(doc)).toContain(word)
  })

  it('never prints a per-line CGST/SGST label for an inter-state document', () => {
    // The rate-wise summary table always has CGST/SGST/IGST as bare column
    // HEADERS (zeroed where inapplicable — a real GSTR-1 rate-wise row does
    // the same) — this checks the per-LINE label, which carries the "9%"
    // and is the thing that would be a false statement if it appeared here.
    const html = renderInvoicePrintHtml(doc)
    expect(html).not.toContain('CGST 9%')
    expect(html).not.toContain('SGST 9%')
  })

  it('prints the place of supply', () => {
    expect(renderInvoicePrintHtml(doc)).toContain('Gujarat (24)')
    expect(renderInvoiceEmailHtml(doc)).toContain('Gujarat (24)')
  })
})

describe('GST guard — registered, intra-state (docVersion 2)', () => {
  const base = v2Input()
  const doc = buildInvoiceDocument({
    ...base,
    order: { ...base.order, buyer: { ...base.order.buyer, state: 'Jharkhand' } },
  })

  it.each(['CGST', 'SGST'])('the print rendering contains %s', (word) => {
    expect(renderInvoicePrintHtml(doc)).toContain(word)
  })

  it('never prints a per-line IGST label for an intra-state document', () => {
    // Same reasoning as the inter-state test above: the summary table's bare
    // "IGST" column header is always present; the per-line "IGST 18%" label
    // is the thing that must not appear here.
    expect(renderInvoicePrintHtml(doc)).not.toContain('IGST 18%')
  })
})

describe('golden: a frozen docVersion 1 document renders exactly as it always did', () => {
  // NOT built through today's buildInvoiceDocument — this is the literal
  // shape sitting in `invoices.document` for every order issued before the
  // tax engine existed: no hsn, no gstRatePct, no placeOfSupply, no tax
  // totals. A structural (not just "no forbidden words") check, so a future
  // docVersion-2 change that leaks a stray column or row into this path
  // fails loudly instead of only showing up as a wrong-looking PDF.
  const frozenV1 = buildInvoiceDocument(input())

  it('the item table header is exactly the five pre-tax-engine columns, unchanged widths', () => {
    expect(renderInvoicePrintHtml(frozenV1)).toContain(
      '<th style="width:8mm;">#</th><th>Item</th><th class="ctr" style="width:12mm;">Qty</th>' +
        '<th class="num" style="width:24mm;">Rate</th><th class="num" style="width:26mm;">Amount</th>'
    )
  })

  it('carries no rate-wise summary, tax-summary block, or place-of-supply line', () => {
    const printHtml = renderInvoicePrintHtml(frozenV1)
    const emailHtml = renderInvoiceEmailHtml(frozenV1)
    // '.ratewise-wrap'/'table.ratewise' CSS RULES are always embedded (one
    // constant stylesheet on every page) — checking the DOM usage specifically.
    expect(printHtml).not.toContain('class="ratewise-wrap"')
    expect(printHtml).not.toContain('Place of supply')
    expect(emailHtml).not.toContain('Tax summary')
    expect(emailHtml).not.toContain('Place of supply')
  })
})

describe('renderInvoiceEmailHtml', () => {
  const doc = buildInvoiceDocument(input())
  const html = renderInvoiceEmailHtml(doc)

  it('carries no <style> block — mail clients strip them', () => {
    expect(html).not.toContain('<style')
  })

  it('shows the identifying facts a customer needs', () => {
    expect(html).toContain('LAA/26-27/000142')
    expect(html).toContain('order_TEST0001')
    expect(html).toContain('Asha Rao')
    expect(html).toContain('Aloe Vera Gel')
    expect(html).toContain('₹687.00')
    expect(html).toContain('Rupees Six Hundred Eighty Seven Only')
    expect(html).toContain('Saman Products Company')
    expect(html).toContain('hello@adix.ai')
  })

  it('escapes buyer-supplied text instead of letting it inject markup', () => {
    const hostile = buildInvoiceDocument(
      input({
        order: {
          ...input().order,
          buyer: { ...input().order.buyer, name: '<script>alert(1)</script>' },
        },
      })
    )
    const rendered = renderInvoiceEmailHtml(hostile)
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
  })

  it('shows FREE rather than ₹0.00 when delivery was not charged', () => {
    const free = buildInvoiceDocument(
      input({ order: { ...input().order, shippingFeeInr: 0, totalInr: 647 } })
    )
    expect(renderInvoiceEmailHtml(free)).toContain('FREE')
  })

  it('quotes font family names with apostrophes, never inside the style attribute', () => {
    // A `"` inside `style="…"` closes the attribute and the whole declaration
    // is dropped — the message then arrives in the client's default face.
    expect(html).not.toContain('style="font-family:Georgia,"')
    expect(html).toContain("'Segoe UI'")
  })
})

/**
 * The line thumbnail. Presentational, but it is the one part of this document
 * that renders a URL into an `src` — so the guard around what may reach it is
 * as much the subject here as the picture itself.
 */
describe('renderInvoiceEmailHtml — product images', () => {
  function withImage(imageUrl: string | undefined) {
    const base = input()
    return buildInvoiceDocument(
      input({
        order: {
          ...base.order,
          lines: [{ ...base.order.lines[0]!, imageUrl }, base.order.lines[1]!],
        },
      })
    )
  }

  it('renders the catalog image at a fixed size, with the product name as its alt text', () => {
    const html = renderInvoiceEmailHtml(withImage('https://cdn.example.com/aloe.jpg'))
    expect(html).toContain('src="https://cdn.example.com/aloe.jpg"')
    expect(html).toContain('alt="Aloe Vera Gel"')
    expect(html).toContain('width="64" height="64"')
  })

  it('falls back to a monogram tile — never a broken image — when the line has no picture', () => {
    const html = renderInvoiceEmailHtml(withImage(undefined))
    expect(html).not.toContain('<img')
    expect(html).toContain('>A</td>')
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'http://cdn.example.com/a.jpg'])(
    'refuses to emit %s as an image source',
    (url) => {
      const html = renderInvoiceEmailHtml(withImage(url))
      expect(html).not.toContain('<img')
    }
  )
})

describe('renderInvoiceEmailHtml — refunded copy', () => {
  const refunded = { ...buildInvoiceDocument(input()), status: 'refunded' as const }
  const html = renderInvoiceEmailHtml(refunded)

  it('never thanks the shopper for a purchase whose money has gone back', () => {
    expect(html).not.toContain('Thank you')
    expect(html).toContain('Your refund is on its way')
  })

  it('states the sum as the invoice total, not as money we are holding', () => {
    expect(html).toContain('Invoice total')
    expect(html).not.toContain('Total paid')
  })
})

describe('renderInvoicePrintHtml', () => {
  const doc = buildInvoiceDocument(input())

  it('is a standalone A4 document', () => {
    const html = renderInvoicePrintHtml(doc)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@page { size: A4;')
    expect(html).toContain('Page 1 of 1')
  })

  it('defaults to the customer copy', () => {
    expect(renderInvoicePrintHtml(doc)).not.toContain('Delivery copy')
  })

  it('bands the delivery copy and adds a tear-off address block', () => {
    const html = renderInvoicePrintHtml(doc, { copy: 'delivery' })
    expect(html).toContain('Delivery copy')
    expect(html).toContain('Deliver to')
    expect(html).toContain('Satellite Road')
  })

  it('marks a refunded order as refunded', () => {
    const refunded = buildInvoiceDocument(
      input({ order: { ...input().order, status: 'refunded' } })
    )
    expect(renderInvoicePrintHtml(refunded)).toContain('REFUNDED')
  })

  it('escapes buyer-supplied text', () => {
    const hostile = buildInvoiceDocument(
      input({
        order: {
          ...input().order,
          buyer: { ...input().order.buyer, roadArea: '"><img src=x onerror=alert(1)>' },
        },
      })
    )
    const rendered = renderInvoicePrintHtml(hostile)
    expect(rendered).not.toContain('<img src=x')
    expect(rendered).toContain('&lt;img src=x')
  })
})
