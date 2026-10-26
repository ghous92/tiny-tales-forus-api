/**
 * `seedConfigDefaults` (core logic behind `scripts/seed-config.ts`) against
 * PGlite: inserts every default when absent, overwrites nothing on re-run
 * (SPEC-V2.md §7 bullet 6).
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { appConfig } from '../../src/db/schema.js'
import { CONFIG_DEFAULTS, seedConfigDefaults } from '../../scripts/seed-config.js'
import { createTestDb } from '../helpers/app.js'

let db: Db

beforeEach(async () => {
  const ctx = await createTestDb()
  db = ctx.db
})

describe('seedConfigDefaults', () => {
  it('inserts all §2 defaults when the table is empty', async () => {
    const inserted = await seedConfigDefaults(db)
    expect(inserted).toHaveLength(CONFIG_DEFAULTS.length)

    const rows = await db.select().from(appConfig)
    expect(rows).toHaveLength(CONFIG_DEFAULTS.length)

    for (const def of CONFIG_DEFAULTS) {
      const [row] = await db.select().from(appConfig).where(eq(appConfig.key, def.key))
      // Strict equality on every key — including 'checkout.whatsappNumber',
      // whose all-digit string value regresses to a JS number if the jsonb
      // column's driver mapping ever double-decodes again (see `jsonbSafe`
      // in src/db/schema.ts).
      expect(row?.value).toEqual(def.value)
      expect(row?.description).toBe(def.description)
    }
  })

  it('overwrites nothing when re-run (existing values untouched)', async () => {
    await seedConfigDefaults(db)
    // Simulate an admin having changed one value since the first seed.
    await db.update(appConfig).set({ value: 'in-app' }).where(eq(appConfig.key, 'checkout.mode'))

    const secondRun = await seedConfigDefaults(db)
    expect(secondRun).toEqual([])

    const [row] = await db.select().from(appConfig).where(eq(appConfig.key, 'checkout.mode'))
    expect(row?.value).toBe('in-app')
  })

  it('inserts only the keys that are absent (mixed state)', async () => {
    await db.insert(appConfig).values({
      key: 'checkout.mode',
      value: 'custom',
      description: 'pre-existing',
    })

    const inserted = await seedConfigDefaults(db)
    expect(inserted).not.toContain('checkout.mode')
    expect(inserted).toHaveLength(CONFIG_DEFAULTS.length - 1)

    const [row] = await db.select().from(appConfig).where(eq(appConfig.key, 'checkout.mode'))
    expect(row?.value).toBe('custom')
  })
})
