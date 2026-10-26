/**
 * `buildCreditNoteDocument` — the pure reversal of a frozen `docVersion: 2`
 * invoice. Mirrors `test/lib/invoiceHtml.test.ts`'s fixtures (`input()`/
 * `v2Input()`) rather than reinventing GST test data.
 */

import { describe, expect, it } from 'vitest'

import type { InvoiceSellerBlock } from '../../src/contracts/invoices.js'
import { buildCreditNoteDocument } from '../../src/lib/creditNoteDocument.js'
import {
  buildInvoiceDocument,
  type BuildInvoiceDocumentInput,
  type ProductLegalInfo,
} from '../../src/lib/invoiceDocument.js'

const REGISTERED_SELLER: InvoiceSellerBlock = {
  legalName: 'Adix AI',
  brand: 'Laanya',
  address: '3, Qamar Makhdumi Road, near Noori Masjid, Bhuli Road, Wasseypur, Dhanbad, Jharkhand 826001',
  gstRegistered: true,
  gstin: '20AAAAA0000A1Z5',
  supportEmail: 'hello@adix.ai',
}

const UNREGISTERED_SELLER: InvoiceSellerBlock = {
  legalName: 'Adix AI',
  brand: 'Laanya',
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

/** Registered + registeredStateName + every line carrying hsn/rate — the docVersion: 2 fixture (see invoiceHtml.test.ts). */
function v2Input(overrides: Partial<BuildInvoiceDocumentInput> = {}): BuildInvoiceDocumentInput {
  const base = input({ seller: REGISTERED_SELLER, registeredStateName: 'Jharkhand' })
  return {
    ...base,
    order: {
      ...base.order,
      lines: base.order.lines.map((line) => ({ ...line, hsn: '3305.90', gstRatePct: 18 })),
    },
    ...overrides,
  }
}

describe('buildCreditNoteDocument', () => {
  it('returns null for a docVersion 1 invoice — nothing to reverse under s.34', () => {
    const invoice = buildInvoiceDocument(input())
    expect(invoice.docVersion).toBe(1)
    const note = buildCreditNoteDocument({
      numberPrefix: 'LAA',
      fy: '26-27',
      seq: 1,
      issuedAt: new Date('2026-08-10T00:00:00Z'),
      orderId: invoice.orderId,
      invoice,
      reason: 'Order cancelled',
      footerNote: 'footer',
    })
    expect(note).toBeNull()
  })

  it('reverses a docVersion 2 invoice line-for-line', () => {
    const invoice = buildInvoiceDocument(v2Input())
    expect(invoice.docVersion).toBe(2)

    const note = buildCreditNoteDocument({
      numberPrefix: 'LAA',
      fy: '26-27',
      seq: 1,
      issuedAt: new Date('2026-08-10T00:00:00Z'),
      orderId: invoice.orderId,
      invoice,
      reason: 'Order cancelled — refund issued',
      footerNote: 'This is a computer-generated invoice and does not require a signature.',
    })

    expect(note).not.toBeNull()
    if (!note) return

    expect(note.docVersion).toBe(2)
    expect(note.title).toBe('CREDIT NOTE')
    expect(note.creditNoteNumber).toBe('LAA/CN/26-27/000001')
    expect(note.orderId).toBe(invoice.orderId)
    expect(note.originalInvoiceNumber).toBe(invoice.invoiceNumber)
    expect(note.originalInvoiceIssuedAt).toBe(invoice.issuedAt)
    expect(note.reason).toBe('Order cancelled — refund issued')
    expect(note.buyer).toEqual(invoice.buyer)
    expect(note.placeOfSupply).toEqual(invoice.placeOfSupply)

    expect(note.lines).toHaveLength(invoice.lines.length)
    note.lines.forEach((line, i) => {
      const src = invoice.lines[i]!
      expect(line.sku).toBe(src.sku)
      expect(line.qty).toBe(src.qty)
      expect(line.unitPriceInr).toBe(src.unitPriceInr)
      expect(line.lineTotalInr).toBe(src.lineTotalInr)
      expect(line.hsn).toBe(src.hsn)
      expect(line.gstRatePct).toBe(src.gstRatePct)
      expect(line.taxableValuePaise).toBe(src.taxableValuePaise)
      expect(line.cgstPaise).toBe(src.cgstPaise)
      expect(line.sgstPaise).toBe(src.sgstPaise)
      expect(line.igstPaise).toBe(src.igstPaise)
    })

    expect(note.totals.totalInr).toBe(invoice.totals.totalInr)
    expect(note.totals.taxableValuePaise).toBe(invoice.totals.taxableValuePaise)
    expect(note.totals.cgstPaise).toBe(invoice.totals.cgstPaise)
    expect(note.totals.sgstPaise).toBe(invoice.totals.sgstPaise)
    expect(note.totals.igstPaise).toBe(invoice.totals.igstPaise)
    expect(note.totals.totalTaxPaise).toBe(invoice.totals.totalTaxPaise)
    expect(note.totals.rateWise).toEqual(invoice.totals.rateWise)

    // Same invariant `invoiceHtml.test.ts` asserts on the invoice itself: taxable + tax == total.
    expect(note.totals.taxableValuePaise + note.totals.totalTaxPaise).toBe(note.totals.totalInr * 100)
  })

  it('numbers independently of the invoice series — fy/seq come from the credit note counters, not the invoice', () => {
    const invoice = buildInvoiceDocument(v2Input({ fy: '26-27', seq: 999 }))
    const note = buildCreditNoteDocument({
      numberPrefix: 'LAA',
      fy: '27-28',
      seq: 3,
      issuedAt: new Date('2027-04-10T00:00:00Z'),
      orderId: invoice.orderId,
      invoice,
      reason: 'Refund issued',
      footerNote: 'footer',
    })
    expect(note?.creditNoteNumber).toBe('LAA/CN/27-28/000003')
    expect(invoice.invoiceNumber).toBe('LAA/26-27/000999')
  })
})
