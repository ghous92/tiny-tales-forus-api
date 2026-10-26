/**
 * GSTR-1 returns feed (`services/gstr1.ts`).
 *
 * The documents here are hand-built and inserted directly rather than driven
 * through a payment. That is deliberate and it is what the module under test
 * actually promises: it NEVER recomputes tax, it only sums frozen documents.
 * Building the documents is `invoiceDocument.ts`/`creditNoteDocument.ts`'s job
 * and is tested there; putting a real order through Razorpay here would test
 * that code a second time and this code not at all — while making it impossible
 * to write the cases that matter, which are a refund landing in a LATER month
 * than its sale and a `docVersion: 1` invoice sitting inside a registered
 * period.
 *
 * The seller is Jharkhand (`20`) throughout, so a Gujarat (`24`) delivery is
 * IGST and a Jharkhand one is CGST+SGST — the two branches every report has to
 * keep apart.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { CreditNoteDocument } from '../../src/contracts/creditNotes.js'
import type { InvoiceDocument } from '../../src/contracts/invoices.js'
import type { Db } from '../../src/db/client.js'
import { creditNotes, invoices, payments, users } from '../../src/db/schema.js'
import { exportGstr1Csv, resolvePeriod } from '../../src/services/gstr1.js'
import { createTestDb } from '../helpers/app.js'

const SELLER = {
  legalName: 'ADIX AI',
  brand: 'Laanya',
  address: 'Dhanbad, Jharkhand 826001',
  gstRegistered: true,
  gstin: '20AAAAA0000A1Z5',
  supportEmail: 'support@laanya.test',
} as const

const BUYER = {
  name: 'Test Shopper',
  phone: '+919876543210',
  houseNumber: '1',
  roadArea: 'Somewhere',
  city: 'Ahmedabad',
  state: 'Gujarat',
  pincode: '380001',
} as const

/**
 * An 18% single-line IGST invoice: ₹1180 gross decomposes to ₹1000 taxable +
 * ₹180 tax, which is the arithmetic every assertion below leans on.
 */
function igstInvoice(overrides: {
  invoiceNumber: string
  orderId: string
  hsn?: string
  taxablePaise?: number
  igstPaise?: number
  qty?: number
}): InvoiceDocument {
  const taxableValuePaise = overrides.taxablePaise ?? 100_000
  const igstPaise = overrides.igstPaise ?? 18_000
  const qty = overrides.qty ?? 1
  const hsn = overrides.hsn ?? '3305.90'
  const totalInr = (taxableValuePaise + igstPaise) / 100

  return {
    docVersion: 2,
    title: 'TAX INVOICE',
    invoiceNumber: overrides.invoiceNumber,
    issuedAt: '2026-08-05T06:00:00.000Z',
    orderId: overrides.orderId,
    orderedAt: '2026-08-05T05:00:00.000Z',
    paidAt: '2026-08-05T05:30:00.000Z',
    status: 'paid',
    currency: 'INR',
    seller: SELLER,
    manufacturers: [],
    buyer: BUYER,
    lines: [
      {
        sku: 'AH-82U3-T29Q',
        name: 'Hair Oil',
        size: '100 ml',
        qty,
        unitPriceInr: totalInr / qty,
        lineTotalInr: totalInr,
        hsn,
        gstRatePct: 18,
        taxableValuePaise,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise,
      },
    ],
    totals: {
      goodsInr: totalInr,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr,
      amountInWords: 'Rupees Test Only',
      taxableValuePaise,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise,
      totalTaxPaise: igstPaise,
      rateWise: [
        {
          gstRatePct: 18,
          taxableValuePaise,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise,
          totalTaxPaise: igstPaise,
        },
      ],
    },
    payment: { mode: 'Prepaid — online payment', reference: 'pay_test' },
    notes: { gst: '', footer: '', jurisdiction: '' },
    placeOfSupply: { state: 'Gujarat', code: '24' },
  }
}

/** The same sale delivered inside the seller's own state — CGST+SGST rather than IGST. */
function intraStateInvoice(invoiceNumber: string, orderId: string): InvoiceDocument {
  const base = igstInvoice({ invoiceNumber, orderId })
  const line = base.lines[0]!
  return {
    ...base,
    buyer: { ...BUYER, city: 'Dhanbad', state: 'Jharkhand', pincode: '826001' },
    lines: [{ ...line, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0 }],
    totals: {
      ...base.totals,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      igstPaise: 0,
      rateWise: [
        {
          gstRatePct: 18,
          taxableValuePaise: 100_000,
          cgstPaise: 9_000,
          sgstPaise: 9_000,
          igstPaise: 0,
          totalTaxPaise: 18_000,
        },
      ],
    },
    placeOfSupply: { state: 'Jharkhand', code: '20' },
  }
}

/** A pre-tax-engine (or unregistered-seller) invoice: no tax fields anywhere, no place of supply. */
function v1Invoice(invoiceNumber: string, orderId: string): InvoiceDocument {
  return {
    docVersion: 1,
    title: 'INVOICE',
    invoiceNumber,
    issuedAt: '2026-08-06T06:00:00.000Z',
    orderId,
    orderedAt: '2026-08-06T05:00:00.000Z',
    paidAt: '2026-08-06T05:30:00.000Z',
    status: 'paid',
    currency: 'INR',
    seller: SELLER,
    manufacturers: [],
    buyer: BUYER,
    lines: [
      {
        sku: 'AH-82U3-T29Q',
        name: 'Hair Oil',
        size: '100 ml',
        qty: 1,
        unitPriceInr: 500,
        lineTotalInr: 500,
      },
    ],
    totals: {
      goodsInr: 500,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: 500,
      amountInWords: 'Rupees Five Hundred Only',
    },
    payment: { mode: 'Prepaid — online payment', reference: 'pay_test_v1' },
    notes: { gst: '', footer: '', jurisdiction: '' },
  }
}

function creditNoteFor(
  creditNoteNumber: string,
  invoice: InvoiceDocument,
  issuedAt: string
): CreditNoteDocument {
  const line = invoice.lines[0]!
  return {
    docVersion: 2,
    title: 'CREDIT NOTE',
    creditNoteNumber,
    issuedAt,
    orderId: invoice.orderId,
    originalInvoiceNumber: invoice.invoiceNumber,
    originalInvoiceIssuedAt: invoice.issuedAt,
    reason: 'Order cancelled — refund issued',
    currency: 'INR',
    seller: {
      legalName: SELLER.legalName,
      brand: SELLER.brand,
      address: SELLER.address,
      gstin: SELLER.gstin,
    },
    buyer: invoice.buyer,
    lines: [
      {
        sku: line.sku,
        name: line.name,
        size: line.size,
        qty: line.qty,
        unitPriceInr: line.unitPriceInr,
        lineTotalInr: line.lineTotalInr,
        hsn: line.hsn!,
        gstRatePct: line.gstRatePct!,
        taxableValuePaise: line.taxableValuePaise!,
        cgstPaise: line.cgstPaise!,
        sgstPaise: line.sgstPaise!,
        igstPaise: line.igstPaise!,
      },
    ],
    totals: {
      goodsInr: invoice.totals.goodsInr,
      couponDiscountInr: 0,
      shippingFeeInr: 0,
      totalInr: invoice.totals.totalInr,
      amountInWords: 'Rupees Test Only',
      taxableValuePaise: invoice.totals.taxableValuePaise!,
      cgstPaise: invoice.totals.cgstPaise!,
      sgstPaise: invoice.totals.sgstPaise!,
      igstPaise: invoice.totals.igstPaise!,
      totalTaxPaise: invoice.totals.totalTaxPaise!,
      rateWise: invoice.totals.rateWise!,
    },
    notes: { footer: '', jurisdiction: '' },
    placeOfSupply: invoice.placeOfSupply!,
  }
}

/** Parsed CSV: header row plus body rows, quotes stripped. Good enough — the cells here hold no commas. */
function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rest] = csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')))
  return { header: header!, rows: rest }
}

describe('GSTR-1 export', () => {
  let db: Db
  let userId: string

  beforeEach(async () => {
    const ctx = await createTestDb()
    db = ctx.db
    const [user] = await db
      .insert(users)
      .values({ firebaseUid: 'firebase-uid-gstr1', phone: '+919876543210' })
      .returning()
    userId = user!.id
  })

  /** Insert the payment an invoice hangs off, then the invoice itself. */
  async function seedInvoice(doc: InvoiceDocument, issuedAt: string, seq: number): Promise<void> {
    await db.insert(payments).values({
      orderId: doc.orderId,
      userId,
      amountPaise: doc.totals.totalInr * 100,
      status: doc.status,
      cartSnapshot: {},
      addressSnapshot: {},
    })
    await db.insert(invoices).values({
      invoiceNumber: doc.invoiceNumber,
      orderId: doc.orderId,
      userId,
      fy: '26-27',
      seq,
      issuedAt: new Date(issuedAt),
      totalPaise: doc.totals.totalInr * 100,
      document: doc,
    })
  }

  async function seedCreditNote(doc: CreditNoteDocument, issuedAt: string, seq: number) {
    await db.insert(creditNotes).values({
      creditNoteNumber: doc.creditNoteNumber,
      invoiceNumber: doc.originalInvoiceNumber,
      orderId: doc.orderId,
      userId,
      fy: '26-27',
      seq,
      issuedAt: new Date(issuedAt),
      totalPaise: doc.totals.totalInr * 100,
      document: doc,
    })
  }

  describe('resolvePeriod', () => {
    it('expands a month to a half-open IST window', () => {
      const { start, end } = resolvePeriod({ month: '2026-08' })
      expect(start?.toISOString()).toBe('2026-07-31T18:30:00.000Z')
      expect(end?.toISOString()).toBe('2026-08-31T18:30:00.000Z')
    })

    it('rolls December over into the next year', () => {
      const { end } = resolvePeriod({ month: '2026-12' })
      expect(end?.toISOString()).toBe('2026-12-31T18:30:00.000Z')
    })

    it('treats `to` as inclusive of the whole IST day', () => {
      const { end } = resolvePeriod({ from: '2026-08-01', to: '2026-08-31' })
      expect(end?.toISOString()).toBe('2026-08-31T18:30:00.000Z')
    })

    it('is unbounded on both sides when no period is given', () => {
      expect(resolvePeriod({})).toEqual({ start: undefined, end: undefined })
    })
  })

  describe('b2cs (Table 7)', () => {
    it('aggregates by place of supply and rate, reports the own-site ECO, and applies no TCS', async () => {
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' }),
        '2026-08-05T06:00:00.000Z',
        1
      )
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000002', orderId: 'order_2' }),
        '2026-08-06T06:00:00.000Z',
        2
      )

      const { csv } = await exportGstr1Csv(db, { month: '2026-08' })
      const { header, rows } = parseCsv(csv)

      expect(header[0]).toBe('Type')
      expect(rows).toHaveLength(1)
      const [type, pos, rate, taxable, igst, cgst, sgst, , ecommerceGstin] = rows[0]!
      expect(type).toBe('E')
      expect(pos).toBe('24-Gujarat')
      expect(rate).toBe('18')
      // Two ₹1000-taxable sales in the same band collapse to one row.
      expect(taxable).toBe('2000.00')
      expect(igst).toBe('360.00')
      expect(cgst).toBe('0.00')
      expect(sgst).toBe('0.00')
      expect(ecommerceGstin).toBe(SELLER.gstin)
    })

    it('keeps intra-state and inter-state supplies in separate rows', async () => {
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' }),
        '2026-08-05T06:00:00.000Z',
        1
      )
      await seedInvoice(
        intraStateInvoice('LAA/26-27/000002', 'order_2'),
        '2026-08-06T06:00:00.000Z',
        2
      )

      const { rows } = parseCsv((await exportGstr1Csv(db, { month: '2026-08' })).csv)
      expect(rows.map((r) => r[1])).toEqual(['20-Jharkhand', '24-Gujarat'])
      // Jharkhand row: CGST+SGST, no IGST. Gujarat row: the reverse.
      expect([rows[0]![4], rows[0]![5], rows[0]![6]]).toEqual(['0.00', '90.00', '90.00'])
      expect([rows[1]![4], rows[1]![5], rows[1]![6]]).toEqual(['180.00', '0.00', '0.00'])
    })

    it('nets a credit note against the same band', async () => {
      const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' })
      await seedInvoice(invoice, '2026-08-05T06:00:00.000Z', 1)
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000002', orderId: 'order_2' }),
        '2026-08-06T06:00:00.000Z',
        2
      )
      await seedCreditNote(
        creditNoteFor('LAA/CN/26-27/000001', invoice, '2026-08-20T06:00:00.000Z'),
        '2026-08-20T06:00:00.000Z',
        1
      )

      const { rows } = parseCsv((await exportGstr1Csv(db, { month: '2026-08' })).csv)
      // Two sales less one refund — one net sale remains.
      expect(rows[0]![3]).toBe('1000.00')
      expect(rows[0]![4]).toBe('180.00')
    })

    it('reports a negative band when a month carries only a refund for an earlier sale', async () => {
      const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' })
      await seedInvoice(invoice, '2026-08-05T06:00:00.000Z', 1)
      await seedCreditNote(
        creditNoteFor('LAA/CN/26-27/000001', invoice, '2026-09-02T06:00:00.000Z'),
        '2026-09-02T06:00:00.000Z',
        1
      )

      // August is unaffected by a September credit note: a filed month is never
      // retroactively edited.
      const august = parseCsv((await exportGstr1Csv(db, { month: '2026-08' })).csv)
      expect(august.rows[0]![3]).toBe('1000.00')

      // September carries the reversal alone, and is negative. The CSV guard
      // prefixes a leading `-` so Excel cannot evaluate it as a formula.
      const september = parseCsv((await exportGstr1Csv(db, { month: '2026-09' })).csv)
      expect(september.rows[0]![3]).toBe("'-1000.00")
      expect(september.rows[0]![4]).toBe("'-180.00")
    })

    it('omits a docVersion 1 invoice entirely — it has no band to report', async () => {
      await seedInvoice(v1Invoice('LAA/26-27/000001', 'order_1'), '2026-08-06T06:00:00.000Z', 1)

      const { csv, untaxed, events } = await exportGstr1Csv(db, { month: '2026-08' })
      expect(parseCsv(csv).rows).toHaveLength(0)
      // But the caller is told, so the route can log it rather than the supply
      // vanishing silently.
      expect(events).toBe(1)
      expect(untaxed).toBe(1)
    })
  })

  describe('hsn (Table 12)', () => {
    it('groups by HSN and rate, nets quantity, and totals value as taxable + tax', async () => {
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1', qty: 2 }),
        '2026-08-05T06:00:00.000Z',
        1
      )
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000002', orderId: 'order_2', hsn: '3304.99' }),
        '2026-08-06T06:00:00.000Z',
        2
      )

      const { header, rows } = parseCsv(
        (await exportGstr1Csv(db, { month: '2026-08', report: 'hsn' })).csv
      )
      expect(header.slice(0, 6)).toEqual([
        'HSN',
        'Description',
        'UQC',
        'Total Quantity',
        'Total Value',
        'Rate',
      ])
      expect(rows.map((r) => r[0])).toEqual(['3304.99', '3305.90'])
      const [, , uqc, qty, totalValue, rate, taxable] = rows[1]!
      expect(uqc).toBe('NOS')
      expect(qty).toBe('2')
      expect(rate).toBe('18')
      expect(taxable).toBe('1000.00')
      expect(totalValue).toBe('1180.00')
    })

    it('nets a refunded quantity back out', async () => {
      const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1', qty: 3 })
      await seedInvoice(invoice, '2026-08-05T06:00:00.000Z', 1)
      await seedCreditNote(
        creditNoteFor('LAA/CN/26-27/000001', invoice, '2026-08-20T06:00:00.000Z'),
        '2026-08-20T06:00:00.000Z',
        1
      )

      const { rows } = parseCsv((await exportGstr1Csv(db, { month: '2026-08', report: 'hsn' })).csv)
      expect(rows[0]![3]).toBe('0')
      expect(rows[0]![6]).toBe('0.00')
    })
  })

  describe('docs (Table 13)', () => {
    it('reports one series per nature, with the range and no cancellations', async () => {
      const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' })
      await seedInvoice(invoice, '2026-08-05T06:00:00.000Z', 1)
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000002', orderId: 'order_2' }),
        '2026-08-06T06:00:00.000Z',
        2
      )
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000003', orderId: 'order_3' }),
        '2026-08-07T06:00:00.000Z',
        3
      )
      await seedCreditNote(
        creditNoteFor('LAA/CN/26-27/000001', invoice, '2026-08-20T06:00:00.000Z'),
        '2026-08-20T06:00:00.000Z',
        1
      )

      const { rows } = parseCsv(
        (await exportGstr1Csv(db, { month: '2026-08', report: 'docs' })).csv
      )
      expect(rows).toEqual([
        ['Credit Note', 'LAA/CN/26-27/000001', 'LAA/CN/26-27/000001', '1', '0'],
        ['Invoices for outward supply', 'LAA/26-27/000001', 'LAA/26-27/000003', '3', '0'],
      ])
    })

    it('counts a docVersion 1 invoice — Table 13 is about numbers issued, not tax', async () => {
      await seedInvoice(v1Invoice('LAA/26-27/000001', 'order_1'), '2026-08-06T06:00:00.000Z', 1)

      const { rows } = parseCsv(
        (await exportGstr1Csv(db, { month: '2026-08', report: 'docs' })).csv
      )
      expect(rows[0]![3]).toBe('1')
    })
  })

  describe('invoices (backing detail)', () => {
    it('lists a docVersion 1 invoice with an empty rate band rather than dropping it', async () => {
      await seedInvoice(
        igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' }),
        '2026-08-05T06:00:00.000Z',
        1
      )
      await seedInvoice(v1Invoice('LAA/26-27/000002', 'order_2'), '2026-08-06T06:00:00.000Z', 2)

      const { header, rows } = parseCsv(
        (await exportGstr1Csv(db, { month: '2026-08', report: 'invoices' })).csv
      )
      expect(header[0]).toBe('Doc Type')
      expect(rows).toHaveLength(2)

      const v1 = rows.find((r) => r[1] === 'LAA/26-27/000002')!
      expect(v1[3]).toBe('1')
      // Blank where the tax would be — visibly absent, not zero.
      expect(v1[5]).toBe('')
      expect(v1[6]).toBe('')
      expect(v1[4]).toBe('')
    })

    it('carries a credit note as negative amounts, so the detail sums to the summary', async () => {
      const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' })
      await seedInvoice(invoice, '2026-08-05T06:00:00.000Z', 1)
      await seedCreditNote(
        creditNoteFor('LAA/CN/26-27/000001', invoice, '2026-08-20T06:00:00.000Z'),
        '2026-08-20T06:00:00.000Z',
        1
      )

      const { rows } = parseCsv(
        (await exportGstr1Csv(db, { month: '2026-08', report: 'invoices' })).csv
      )
      const note = rows.find((r) => r[0] === 'Credit Note')!
      expect(note[6]).toBe("'-1000.00")
      expect(note[7]).toBe("'-180.00")
    })
  })

  it("excludes documents outside the period on each table's own issued_at", async () => {
    const invoice = igstInvoice({ invoiceNumber: 'LAA/26-27/000001', orderId: 'order_1' })
    // Issued at 23:45 IST on 31 July — the last instant of the PREVIOUS month.
    await seedInvoice(invoice, '2026-07-31T18:15:00.000Z', 1)

    const july = await exportGstr1Csv(db, { month: '2026-07' })
    const august = await exportGstr1Csv(db, { month: '2026-08' })
    expect(july.events).toBe(1)
    expect(august.events).toBe(0)
  })
})
