/**
 * Colour variants (lib/filamentColors.ts): listed pieces get one sku per
 * filament colour; custom figures never do, and the chosen colour reaches the
 * cart line that orders and invoices are built from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedColorVariants } from '../../scripts/seed-color-variants.js'
import { seedCustomFigures } from '../../scripts/seed-custom-figures.js'
import { categories, products, productVariants } from '../../src/db/schema.js'
import { FILAMENT_COLORS } from '../../src/lib/filamentColors.js'
import { projectProduct } from '../../src/services/catalogProjection.js'
import { auth, createTestApp, USER_A, type TestContext } from '../helpers/app.js'

let ctx: TestContext

const NO_IMAGES = { main: { thumb: '', grid: '', pdp: '', zoom: '' }, gallery: [] }
const SIZE = '13.5 × 7.5 × 5.5 cm'

async function insertPiece(priceInr: number): Promise<void> {
  await ctx.db
    .insert(categories)
    .values({ slug: 'devotional', label: 'Devotional', active: true, sortOrder: 1 })
    .onConflictDoNothing()
  await ctx.db
    .insert(products)
    .values({
      id: 'tt-elephant-diya',
      slug: 'elephant-diya',
      name: 'The Elephant Diya',
      category: 'devotional',
      description: 'A diya holder.',
      active: true,
      hidden: false,
      seasonalDiscountPct: 20,
      hsnCode: '3926',
      gstRatePct: 18,
      images: NO_IMAGES,
    })
    .onConflictDoNothing()
  await ctx.db
    .insert(productVariants)
    .values({
      sku: 'TT-ELEDIYA-STD',
      productId: 'tt-elephant-diya',
      size: SIZE,
      priceInr,
      mrpInr: priceInr,
      inStock: true,
      weightG: 200,
      lengthCm: 15,
      widthCm: 10,
      heightCm: 10,
    })
    .onConflictDoUpdate({
      target: productVariants.sku,
      set: { priceInr, mrpInr: priceInr },
    })
  await projectProduct(ctx.db as never, 'tt-elephant-diya')
}

beforeEach(async () => {
  ctx = await createTestApp()
  await insertPiece(474)
})

afterEach(async () => {
  await ctx.app.close()
})

describe('db:color-variants', () => {
  it('lists the as-photographed variant first, then one sku per colour', async () => {
    await seedColorVariants(ctx.db)
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    const product = (
      res.json() as {
        products: Array<{
          id: string
          variants: Array<{ sku: string; color: string | null; effective_price_inr: number }>
        }>
      }
    ).products.find((p) => p.id === 'tt-elephant-diya')
    expect(product?.variants.map((v) => v.color)).toEqual([
      null,
      ...FILAMENT_COLORS.map((c) => c.slug),
    ])
    expect(product?.variants[4]?.sku).toBe('TT-ELEDIYA-RED')
    expect(new Set(product?.variants.map((v) => v.effective_price_inr))).toEqual(new Set([379]))
  })

  it('puts the colour on the cart line, and the sku can be bought', async () => {
    await seedColorVariants(ctx.db)
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/cart/items/TT-ELEDIYA-RED',
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBe(200)
    const line = (res.json() as { items: Array<{ sku: string; size: string }> }).items[0]
    expect(line).toMatchObject({ sku: 'TT-ELEDIYA-RED', size: `${SIZE} · Red` })
  })

  it('leaves custom figures alone', async () => {
    await seedCustomFigures(ctx.db, 800)
    const summary = await seedColorVariants(ctx.db)
    expect(summary).toEqual({ products: 1, variants: FILAMENT_COLORS.length })
  })

  it('re-running follows a base price change without adding skus', async () => {
    await seedColorVariants(ctx.db)
    await insertPiece(500)
    const summary = await seedColorVariants(ctx.db)
    expect(summary.variants).toBe(FILAMENT_COLORS.length)
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    const body = res.json() as {
      products: Array<{ variants: Array<{ sku: string; price_inr: number }> }>
    }
    expect(body.products[0]?.variants).toHaveLength(FILAMENT_COLORS.length + 1)
    expect(new Set(body.products[0]?.variants.map((v) => v.price_inr))).toEqual(new Set([500]))
  })
})
