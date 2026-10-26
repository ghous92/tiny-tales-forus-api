#!/usr/bin/env tsx
/**
 * `npm run ads:export-audience -- <out.csv>` — write the ChatGPT Ads custom
 * audience file: past buyers who opted in to ad-audience sharing, as SHA-256
 * hashes of their email and phone.
 *
 * The intended use is an EXCLUDED audience on acquisition campaigns, so spend
 * goes to people who have not bought yet.
 *
 * CONSENT IS THE ONLY GATE. A row is exported only when
 * `users.ad_audience_opt_in = true` — never null (never asked), never false
 * (declined or withdrawn). See the column's note in `db/schema.ts`. Each export
 * is a full snapshot: REPLACE the audience at OpenAI with it, never append, or
 * a shopper who withdrew stays uploaded.
 *
 * Hashing reuses the exact normalisation the Conversions API sender uses
 * (`lib/openaiAdsConversions.ts`), so an audience member and a conversion for
 * the same shopper hash identically. Hashing is not anonymisation — this file is
 * still personal data. Do not commit it, share it, or leave it lying around;
 * delete it after upload.
 *
 * READ-ONLY against the database.
 */

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import { payments, users } from '../src/db/schema.js'
import { normalizeEmail, normalizePhone } from '../src/lib/openaiAdsConversions.js'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function main(): Promise<void> {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: npm run ads:export-audience -- <out.csv>')
    process.exit(1)
  }
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('ads:export-audience: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool)
    const rows = await db
      .selectDistinct({ email: users.email, phone: users.phone })
      .from(users)
      .innerJoin(payments, eq(payments.userId, users.id))
      .where(
        and(
          eq(users.adAudienceOptIn, true),
          isNotNull(users.adAudienceOptInAt),
          eq(payments.status, 'paid'),
          // Belt and braces: deleteAccount already sets the flag false, but a
          // tombstoned row must never leave the building whatever the flag says.
          sql`${users.phone} not like 'deleted-%'`
        )
      )

    const lines = ['email,phone']
    for (const row of rows) {
      const email = row.email ? sha256(normalizeEmail(row.email)) : ''
      const digits = normalizePhone(row.phone)
      const phone = digits ? sha256(digits) : ''
      if (email || phone) lines.push(`${email},${phone}`)
    }
    writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 })
    console.log(`ads:export-audience: wrote ${lines.length - 1} members to ${out}`)
  } finally {
    await pool.end()
  }
}

await main()
