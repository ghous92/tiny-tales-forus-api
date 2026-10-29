/**
 * Custom figures (lib/customFigures.ts) are ordinary skus for the cart, but
 * never part of the public catalog: they can only be bought from /custom/,
 * with the shopper's photos.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CUSTOM_FIGURE_SKUS } from '../../src/lib/customFigures.js'
import { seedCustomFigures } from '../../scripts/seed-custom-figures.js'
import { auth, createTestApp, USER_A, type TestContext } from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
  await seedCustomFigures(ctx.db, 800)
})

afterEach(async () => {
  await ctx.app.close()
})

describe('custom figures', () => {
  it('stay out of the public catalog and its categories', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      products: Array<{ id: string; variants: Array<{ sku: string }> }>
      categories: Array<{ slug: string }>
    }
    const skus = body.products.flatMap((p) => p.variants.map((v) => v.sku))
    expect(skus).not.toContain(CUSTOM_FIGURE_SKUS.caricature)
    expect(skus).not.toContain(CUSTOM_FIGURE_SKUS.miniature)
    expect(body.categories.map((c) => c.slug)).not.toContain('custom-figures')
  })

  it('are priced per figure by the server cart', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${CUSTOM_FIGURE_SKUS.caricature}`,
      headers: auth(USER_A.token),
      payload: { qty: 3 },
    })
    expect(res.statusCode).toBe(200)
    const line = (
      res.json() as { items: Array<{ sku: string; qty: number; priceInr: number }> }
    ).items.find((item) => item.sku === CUSTOM_FIGURE_SKUS.caricature)
    expect(line).toMatchObject({ qty: 3, priceInr: 800 })
  })

  it('re-seeding moves the price and keeps one row per sku', async () => {
    await seedCustomFigures(ctx.db, 950)
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/cart/items/${CUSTOM_FIGURE_SKUS.miniature}`,
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { totalInr: number }).totalInr).toBe(950)
  })
})
