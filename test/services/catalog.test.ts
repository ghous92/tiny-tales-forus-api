/**
 * Service-rule tests against PGlite for the catalog read model — the lookup
 * surface cart/payments will consume (SPEC-V2.md §3).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { catalogItems } from '../../src/db/schema.js'
import { getActiveItems, getItemBySku, getItemsBySkus } from '../../src/services/catalog.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
  await db.insert(catalogItems).values([
    {
      sku: 'AH-82U3-T29Q',
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '200ml',
      priceInr: 249,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: 'https://example.com/img.jpg',
      active: true,
    },
    {
      sku: '04-JPDR-6Z6N',
      productId: 'dan-hair-oil',
      name: 'Daniya Hair Oil',
      size: '500ml',
      priceInr: 399,
      lengthCm: 5,
      widthCm: 5,
      heightCm: 5,
      imageUrl: 'https://example.com/img2.jpg',
      active: false,
    },
  ])
})

describe('getItemsBySkus', () => {
  it('returns matching rows including inactive ones', async () => {
    const items = await getItemsBySkus(db, ['AH-82U3-T29Q', '04-JPDR-6Z6N', 'nonexistent'])
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.sku).sort()).toEqual(['04-JPDR-6Z6N', 'AH-82U3-T29Q'])
  })

  it('returns [] for an empty sku list without querying', async () => {
    expect(await getItemsBySkus(db, [])).toEqual([])
  })
})

describe('getActiveItems', () => {
  it('filters out inactive skus', async () => {
    const items = await getActiveItems(db, ['AH-82U3-T29Q', '04-JPDR-6Z6N'])
    expect(items).toHaveLength(1)
    expect(items[0]?.sku).toBe('AH-82U3-T29Q')
  })
})

describe('getItemBySku', () => {
  it('returns the item for an existing sku', async () => {
    const item = await getItemBySku(db, 'AH-82U3-T29Q')
    expect(item).toMatchObject({ sku: 'AH-82U3-T29Q', priceInr: 249, active: true })
  })

  it('returns undefined for a missing sku', async () => {
    expect(await getItemBySku(db, 'nope')).toBeUndefined()
  })
})
