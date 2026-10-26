/**
 * The first-contact WhatsApp auto-reply body. Pure function, no app needed.
 *
 * The invariants worth protecting: never list something we cannot sell, never
 * answer with nothing, and never render a fake "offer" when the price equals
 * the MRP.
 */

import { describe, expect, it } from 'vitest'

import type { CatalogSnapshot, CatalogProduct, CatalogVariant } from '../../src/contracts/catalog.js'
import { buildCatalogAutoReply, FALLBACK_AUTO_REPLY } from '../../src/lib/whatsapp/autoReply.js'

function variant(over: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    sku: 'SKU-1',
    asin: '',
    size: '100ml',
    size_ml: 100,
    color: '',
    price_inr: 299,
    mrp_inr: 399,
    effective_price_inr: 299,
    in_stock: true,
    stock_qty: 10,
    best_before_mode: 'printed_on_pack',
    best_before_date: null,
    item_part_number: '',
    weight_g: 120,
    length_cm: 5,
    width_cm: 5,
    height_cm: 15,
    ...over,
  } as CatalogVariant
}

function product(name: string, variants: CatalogVariant[]): CatalogProduct {
  return { name, variants } as CatalogProduct
}

function snapshot(products: CatalogProduct[]): CatalogSnapshot {
  return { version: 'v1', products, categories: [] } as unknown as CatalogSnapshot
}

describe('buildCatalogAutoReply', () => {
  it('lists each in-stock size with its effective price', () => {
    const body = buildCatalogAutoReply(
      snapshot([
        product('Daniya Hair Oil for Silky, Long and Strong Hair', [
          variant({ size: '100ml', effective_price_inr: 299, mrp_inr: 399 }),
          variant({ size: '200ml', effective_price_inr: 1499, mrp_inr: 1499 }),
        ]),
      ])
    )

    // The Amazon-length SEO title is cut at its first qualifier.
    expect(body).toContain('*Daniya Hair Oil*')
    expect(body).toContain('• 100ml — ₹299 (MRP ~₹399~)')
    // Indian grouping, and NO strike-through when price === MRP.
    expect(body).toContain('• 200ml — ₹1,499')
    expect(body).not.toContain('~₹1,499~')
    expect(body).toContain('https://www.laanya.shop')
  })

  // Listing a size we cannot ship invites exactly the reply this feature is
  // meant to avoid — a shopper asking for something we then have to refuse.
  it('omits out-of-stock variants, and products left with none', () => {
    const body = buildCatalogAutoReply(
      snapshot([
        product('Daniya Hair Oil', [
          variant({ size: '100ml', in_stock: false }),
          variant({ size: '200ml', in_stock: true }),
        ]),
        product('Daniya Shampoo', [variant({ size: '200ml', in_stock: false })]),
      ])
    )

    expect(body).toContain('200ml')
    expect(body).not.toContain('100ml')
    expect(body).not.toContain('Daniya Shampoo')
  })

  // The body cream ships three colours in every size; a per-SKU list prints the
  // same size and price three times and reads like a bug.
  it('collapses colour variants to one line per size and names the shades once', () => {
    const body = buildCatalogAutoReply(
      snapshot([
        product('Daniya Body Cream', [
          variant({ size: '100ml', color: 'rose-pink', effective_price_inr: 119, mrp_inr: 140 }),
          variant({ size: '100ml', color: 'lily-green', effective_price_inr: 119, mrp_inr: 140 }),
          variant({ size: '200ml', color: 'rose-pink', effective_price_inr: 199, mrp_inr: 250 }),
        ]),
      ])
    )

    expect(body.match(/• 100ml/g)).toHaveLength(1)
    expect(body).toContain('• 200ml — ₹199 (MRP ~₹250~)')
    expect(body).toContain('Shades: rose pink, lily green')
  })

  // Whatever is shown must be a price the shopper can actually pay for that
  // size, so the cheapest live SKU wins the line rather than the first one.
  it('shows the cheapest in-stock SKU for a size', () => {
    const body = buildCatalogAutoReply(
      snapshot([
        product('Daniya Body Cream', [
          variant({ size: '100ml', color: 'a', effective_price_inr: 149, mrp_inr: 160 }),
          variant({ size: '100ml', color: 'b', effective_price_inr: 119, mrp_inr: 140 }),
        ]),
      ])
    )

    expect(body).toContain('• 100ml — ₹119 (MRP ~₹140~)')
    expect(body).not.toContain('₹149')
  })

  it('falls back to the human promise when nothing is sellable, or the snapshot is missing', () => {
    expect(buildCatalogAutoReply(snapshot([]))).toBe(FALLBACK_AUTO_REPLY)
    expect(buildCatalogAutoReply(snapshot([product('Dark', [variant({ in_stock: false })])]))).toBe(
      FALLBACK_AUTO_REPLY
    )
    expect(buildCatalogAutoReply(null)).toBe(FALLBACK_AUTO_REPLY)
  })

  // A reply that has to be scrolled twice before a price appears reads as a
  // catalogue dump, so the overflow is counted rather than printed.
  it('caps the list and says how many more there are', () => {
    const many = Array.from({ length: 11 }, (_, i) => product(`Item ${i}`, [variant()]))
    const body = buildCatalogAutoReply(snapshot(many))

    expect(body).toContain('*Item 7*')
    expect(body).not.toContain('*Item 8*')
    expect(body).toContain('…and 3 more on the site.')
  })
})
