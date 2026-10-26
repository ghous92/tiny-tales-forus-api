/**
 * Two Tiny Tales catalog rules:
 *
 * 1. No hard-coded prices. A variant without a price is still published (the
 *    storefront renders "Coming soon / Notify me"), but it must never be
 *    purchasable: the cart refuses it server-side, so a ₹0 line cannot exist.
 * 2. The takedown flag. A hidden product disappears from the public catalog
 *    and stops being purchasable, without losing its `active` state.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { catalogItems } from '../../src/db/schema.js'
import {
  auth,
  createTestApp,
  promoteToAdmin,
  USER_A,
  USER_ADMIN,
  type TestContext,
} from '../helpers/app.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestApp()
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/catalog/products',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  await admin('POST', '/v1/admin/catalog/categories', { slug: 'characters', label: 'Characters' })
  await admin('POST', '/v1/admin/catalog/products', {
    id: 'tt-old-wizard',
    slug: 'old-wizard',
    name: 'The Old Wizard',
    category: 'characters',
    images: { main: { thumb: 't', grid: 'g', pdp: 'p', zoom: 'z' }, gallery: [] },
    manufacturerName: 'Tiny Tales',
    manufacturerAddress: 'India',
    manufacturerLicence: 'n/a',
    countryOfOrigin: 'India',
    consumerCareContact: 'care@example.com',
  })
})

afterEach(async () => {
  await ctx.app.close()
})

function admin(method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) {
  return ctx.app.inject({ method, url, headers: auth(USER_ADMIN.token), payload })
}

async function publicProduct(slug: string) {
  const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog' })
  expect(res.statusCode).toBe(200)
  const body = res.json() as {
    products: Array<{
      slug: string
      variants: Array<{ sku: string; price_inr: number | null; effective_price_inr: number | null }>
    }>
  }
  return body.products.find((p) => p.slug === slug)
}

describe('unpriced variants ("Coming soon")', () => {
  beforeEach(async () => {
    const res = await admin('POST', '/v1/admin/catalog/products/tt-old-wizard/variants', {
      sku: 'TT-WIZ-STD',
      size: 'Standard',
    })
    expect(res.statusCode).toBe(201)
  })

  it('is published with a null price, never a zero', async () => {
    const product = await publicProduct('old-wizard')
    expect(product?.variants[0]).toMatchObject({
      sku: 'TT-WIZ-STD',
      price_inr: null,
      effective_price_inr: null,
    })
  })

  it('is projected inactive, so the cart refuses it', async () => {
    const [item] = await ctx.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.sku, 'TT-WIZ-STD'))
    expect(item?.active).toBe(false)

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/cart/items/TT-WIZ-STD',
      headers: auth(USER_A.token),
      payload: { qty: 1 },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('becomes purchasable the moment a price lands', async () => {
    const res = await admin('PUT', '/v1/admin/catalog/variants/TT-WIZ-STD', { priceInr: 1299 })
    expect(res.statusCode).toBe(200)
    const [item] = await ctx.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.sku, 'TT-WIZ-STD'))
    expect(item).toMatchObject({ active: true, priceInr: 1299 })
    expect((await publicProduct('old-wizard'))?.variants[0]?.price_inr).toBe(1299)
  })
})

describe('takedown flag (hidden)', () => {
  beforeEach(async () => {
    await admin('POST', '/v1/admin/catalog/products/tt-old-wizard/variants', {
      sku: 'TT-WIZ-STD',
      size: 'Standard',
      priceInr: 1299,
    })
  })

  it('removes the product from the public catalog and makes it unpurchasable', async () => {
    expect(await publicProduct('old-wizard')).toBeDefined()

    const res = await admin('PUT', '/v1/admin/catalog/products/tt-old-wizard', {
      hidden: true,
      hiddenReason: 'rights-holder complaint',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      active: true,
      hidden: true,
      hiddenReason: 'rights-holder complaint',
    })

    expect(await publicProduct('old-wizard')).toBeUndefined()
    const [item] = await ctx.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.sku, 'TT-WIZ-STD'))
    expect(item?.active).toBe(false)
  })

  it('restores everything when unhidden, because active was never touched', async () => {
    await admin('PUT', '/v1/admin/catalog/products/tt-old-wizard', { hidden: true })
    await admin('PUT', '/v1/admin/catalog/products/tt-old-wizard', { hidden: false })
    expect(await publicProduct('old-wizard')).toBeDefined()
    const [item] = await ctx.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.sku, 'TT-WIZ-STD'))
    expect(item?.active).toBe(true)
  })
})
