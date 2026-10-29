#!/usr/bin/env tsx
/**
 * `npm run db:test-previews -- --phone +919000000000 --photo ./face.jpg [--dir ./test-previews]
 *  [--characters doctor,pilot,bride] [--render]` — give a test number saved caricature previews,
 * so staging and prod can be tested end to end ("Your previews", "Order this figure")
 * without spending on OpenAI each time.
 *
 * The rendered JPEGs live in `--dir` as `<characterId>.jpg`. With `--render`, any missing one is
 * rendered once from `--photo` (OPENAI_API_KEY, about ₹2 each) and written there; running the
 * script again against the other environment reuses the files, so staging and prod show the
 * same pictures for one spend. Without `--render` a missing file is an error.
 *
 * Rows are written exactly as the preview route writes them (status 'ok', photo + image kept,
 * photo_hash = sha256 of the photo), so uploading the same photo and choosing the same character
 * returns the saved one free. Re-running replaces only this user's seeded rows
 * (model = 'seeded-test'), never a real preview.
 *
 * The phone must already exist in `users`: log in once with it on that environment first.
 */

/* eslint-disable no-console -- operator script, output is the interface */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { caricaturePreviews, users } from '../src/db/schema.js'
import { CARICATURE_CHARACTERS, type CaricatureCharacterId } from '../src/lib/caricatureCharacters.js'
import { galleryPrompt, renderCaricature } from '../src/lib/openai.js'

const SEED_MODEL = 'seeded-test'
const DEFAULT_CHARACTERS = ['doctor', 'pilot', 'bride', 'cricketer', 'chef']

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message: string): never {
  console.error(`db:test-previews: ${message}`)
  process.exit(1)
}

function photoType(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.subarray(1, 4).toString() === 'PNG') return 'image/png'
  if (bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return fail('--photo must be a JPEG, PNG or WebP')
}

async function main(): Promise<void> {
  const phone = arg('phone')
  const photoPath = arg('photo')
  if (!phone || !/^\+\d{8,15}$/.test(phone)) fail('--phone must be E.164, e.g. +919000000000')
  if (!photoPath) fail('--photo <file> is required (the photo the previews are made from)')
  const dir = resolve(arg('dir') ?? 'test-previews')
  const ids = (arg('characters')?.split(',') ?? DEFAULT_CHARACTERS).map((s) => s.trim())
  for (const id of ids) {
    if (!Object.hasOwn(CARICATURE_CHARACTERS, id)) fail(`unknown character "${id}"`)
  }
  const render = process.argv.includes('--render')

  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) fail('set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')

  const photo = await readFile(photoPath)
  const mimetype = photoType(photo)
  const photoHash = createHash('sha256').update(photo).digest('hex')

  await mkdir(dir, { recursive: true })
  const images = new Map<string, Buffer>()
  for (const id of ids) {
    const file = join(dir, `${id}.jpg`)
    if (!existsSync(file)) {
      if (!render) fail(`${file} is missing; add it or pass --render`)
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) fail('--render needs OPENAI_API_KEY')
      console.log(`rendering ${id} …`)
      const { jpeg } = await renderCaricature({
        fetchImpl: fetch,
        apiKey,
        model: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2.5-flare',
        prompt: galleryPrompt(CARICATURE_CHARACTERS[id as CaricatureCharacterId].costume),
        images: [{ bytes: photo, mimetype }],
      })
      await writeFile(file, jpeg)
    }
    images.set(id, await readFile(file))
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone))
    if (!user) fail(`no user with phone ${phone}; log in once with it on this environment first`)

    await db.transaction(async (tx) => {
      await tx
        .delete(caricaturePreviews)
        .where(and(eq(caricaturePreviews.userId, user.id), eq(caricaturePreviews.model, SEED_MODEL)))
      for (const id of ids) {
        await tx.insert(caricaturePreviews).values({
          userId: user.id,
          photoHash,
          character: `tpl:${id}`,
          status: 'ok',
          model: SEED_MODEL,
          image: images.get(id)!,
          photo,
        })
      }
    })
    console.log(`seeded ${ids.length} previews for ${phone}: ${ids.join(', ')}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
