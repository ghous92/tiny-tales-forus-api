/**
 * Unit tests for the invoice formatters. Two of these guard real money bugs:
 * the financial-year boundary (an invoice on the wrong side of 1 April lands in
 * the wrong numbering series) and the amount-in-words line (the thing a reader
 * checks the figures against).
 */

import { describe, expect, it } from 'vitest'

import {
  amountInWords,
  financialYearOf,
  formatInvoiceDate,
  formatInvoiceDateTime,
  formatInvoiceNumber,
  formatMoneyFromPaise,
  formatMoneyINR,
  istCalendarDate,
} from '../../src/lib/invoiceFormat.js'

describe('financialYearOf', () => {
  it('starts a new year on 1 April IST', () => {
    expect(financialYearOf(new Date('2026-03-31T12:00:00+05:30'))).toBe('25-26')
    expect(financialYearOf(new Date('2026-04-01T00:00:00+05:30'))).toBe('26-27')
  })

  it('uses IST, not UTC, at the boundary', () => {
    // 20:00 UTC on 31 March is already 01:30 on 1 April in Ahmedabad. An
    // invoice issued at that instant belongs to the NEW financial year — this
    // is the case a naive `getUTCMonth()` gets wrong.
    expect(financialYearOf(new Date('2026-03-31T20:00:00Z'))).toBe('26-27')
    // And the mirror case: 19:00 UTC is 00:30 IST on 31 March — still the old FY.
    expect(financialYearOf(new Date('2026-03-30T19:00:00Z'))).toBe('25-26')
  })

  it('spans a century boundary without producing "99-00" nonsense out of order', () => {
    expect(financialYearOf(new Date('2099-05-01T00:00:00+05:30'))).toBe('99-00')
    expect(financialYearOf(new Date('2100-05-01T00:00:00+05:30'))).toBe('00-01')
  })
})

describe('formatInvoiceNumber', () => {
  it('zero-pads to a fixed width so the series sorts and aligns', () => {
    expect(formatInvoiceNumber('LAA', '26-27', 1)).toBe('LAA/26-27/000001')
    expect(formatInvoiceNumber('LAA', '26-27', 142)).toBe('LAA/26-27/000142')
  })

  it('does not truncate a number that outgrows the padding', () => {
    expect(formatInvoiceNumber('LAA', '26-27', 1234567)).toBe('LAA/26-27/1234567')
  })
})

describe('dates', () => {
  it('renders in IST', () => {
    expect(formatInvoiceDate('2026-08-05T06:42:00Z')).toBe('05 Aug 2026')
    expect(formatInvoiceDateTime('2026-08-05T06:42:00Z')).toBe('05 Aug 2026, 12:12 IST')
    // 19:00 UTC is the next calendar day in India.
    expect(formatInvoiceDate('2026-08-05T19:00:00Z')).toBe('06 Aug 2026')
  })

  it('gives the IST calendar day for filter bounds', () => {
    expect(istCalendarDate(new Date('2026-08-05T19:00:00Z'))).toBe('2026-08-06')
  })
})

describe('formatMoneyINR', () => {
  it('groups in the Indian style, not in thousands', () => {
    expect(formatMoneyINR(0)).toBe('₹0.00')
    expect(formatMoneyINR(999)).toBe('₹999.00')
    expect(formatMoneyINR(1400)).toBe('₹1,400.00')
    expect(formatMoneyINR(123456)).toBe('₹1,23,456.00')
    expect(formatMoneyINR(12345678)).toBe('₹1,23,45,678.00')
  })

  it('keeps the sign outside the symbol', () => {
    expect(formatMoneyINR(-250)).toBe('-₹250.00')
  })
})

describe('formatMoneyFromPaise', () => {
  it('renders the actual paise, not a rounded-to-rupee .00', () => {
    expect(formatMoneyFromPaise(42_373)).toBe('₹423.73')
    expect(formatMoneyFromPaise(0)).toBe('₹0.00')
    expect(formatMoneyFromPaise(100)).toBe('₹1.00')
    expect(formatMoneyFromPaise(5)).toBe('₹0.05')
  })

  it('groups the rupee part in the Indian style', () => {
    expect(formatMoneyFromPaise(12_345_678_00)).toBe('₹1,23,45,678.00')
  })

  it('keeps the sign outside the symbol', () => {
    expect(formatMoneyFromPaise(-4373)).toBe('-₹43.73')
  })
})

describe('amountInWords', () => {
  it('spells the customary line', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only')
    expect(amountInWords(1)).toBe('Rupees One Only')
    expect(amountInWords(15)).toBe('Rupees Fifteen Only')
    expect(amountInWords(90)).toBe('Rupees Ninety Only')
    expect(amountInWords(101)).toBe('Rupees One Hundred One Only')
    expect(amountInWords(1400)).toBe('Rupees One Thousand Four Hundred Only')
  })

  it('uses the Indian scale (lakh/crore), never million', () => {
    expect(amountInWords(100_000)).toBe('Rupees One Lakh Only')
    expect(amountInWords(1_23_456)).toBe(
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'
    )
    expect(amountInWords(1_00_00_000)).toBe('Rupees One Crore Only')
    expect(amountInWords(12_00_00_000)).toBe('Rupees Twelve Crore Only')
  })

  it('treats a negative or fractional amount as its whole-rupee floor', () => {
    // Money is whole rupees end to end in this system; anything else is a bug
    // upstream, and the words line must not invent paise to describe it.
    expect(amountInWords(249.7)).toBe('Rupees Two Hundred Forty Nine Only')
    expect(amountInWords(-5)).toBe('Rupees Zero Only')
  })
})
