/**
 * The caricature-preview ledger (`caricature_previews`) and its limits. Each
 * preview is a paid image-model call, so a shopper gets a few per photo and a
 * few per India day, and everyone together gets a daily cap set in env.
 *
 * `reservePreview` checks the limits and writes a `pending` row in one
 * transaction, holding a lock on the shopper's users row, so two previews sent
 * at once cannot both pass on the same count. `settlePreview` records how the
 * call went; `failed` rows (our fault, not the shopper's) stop counting.
 * A gallery outfit the model refuses is our prompt's fault too, so it does not
 * use up the photo, but it still counts for the day (each refusal may be billed).
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { caricaturePreviews } from '../db/schema.js'

export const PREVIEWS_PER_PHOTO = 2
export const PREVIEWS_PER_DAY = 5

const IST_OFFSET_MS = 330 * 60_000

/** Midnight in India, as a UTC instant, for the day `now` falls in. */
export function startOfIndiaDay(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS
  return new Date(shifted - (shifted % 86_400_000) - IST_OFFSET_MS)
}

export type PreviewLimit = 'photo' | 'day' | 'busy'

export class PreviewLimitError extends Error {
  constructor(readonly limit: PreviewLimit) {
    super(`caricature preview limit: ${limit}`)
    this.name = 'PreviewLimitError'
  }
}

export interface PreviewQuota {
  perPhoto: number
  perDay: number
  usedToday: number
  /** Only when asked about one photo: previews used on it. */
  photoUsed?: number
  /** Only when asked about one photo: characters with a saved preview, free to see again. */
  saved?: string[]
}

const COUNTED = ne(caricaturePreviews.status, 'failed')
const PHOTO_COUNTED = and(
  COUNTED,
  sql`not (${caricaturePreviews.status} = 'refused' and ${caricaturePreviews.character} like 'tpl:%')`
)

export async function previewQuota(
  db: Db,
  userId: string,
  now = new Date(),
  photoHash?: string
): Promise<PreviewQuota> {
  const [row] = await db
    .select({ n: count() })
    .from(caricaturePreviews)
    .where(
      and(
        eq(caricaturePreviews.userId, userId),
        gte(caricaturePreviews.createdAt, startOfIndiaDay(now)),
        COUNTED
      )
    )
  const quota: PreviewQuota = {
    perPhoto: PREVIEWS_PER_PHOTO,
    perDay: PREVIEWS_PER_DAY,
    usedToday: row?.n ?? 0,
  }
  if (!photoHash) return quota

  const rows = await db
    .select({ character: caricaturePreviews.character, status: caricaturePreviews.status })
    .from(caricaturePreviews)
    .where(
      and(
        eq(caricaturePreviews.userId, userId),
        eq(caricaturePreviews.photoHash, photoHash),
        PHOTO_COUNTED
      )
    )
  quota.photoUsed = rows.length
  quota.saved = [...new Set(rows.filter((r) => r.status === 'ok').map((r) => r.character))]
  return quota
}

/**
 * Check every limit and record a pending preview. Throws PreviewLimitError
 * naming the limit that was hit. Returns the row id and what is left after
 * this preview.
 */
export async function reservePreview(
  db: Db,
  input: { userId: string; photoHash: string; character: string; model: string; dailyCap: number },
  now = new Date()
): Promise<{ id: string; photoLeft: number; todayLeft: number }> {
  const dayStart = startOfIndiaDay(now)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${input.userId} for update`)

    const [photo] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(
        and(
          eq(caricaturePreviews.userId, input.userId),
          eq(caricaturePreviews.photoHash, input.photoHash),
          PHOTO_COUNTED
        )
      )
    const photoUsed = photo?.n ?? 0
    if (photoUsed >= PREVIEWS_PER_PHOTO) throw new PreviewLimitError('photo')

    const [day] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(
        and(
          eq(caricaturePreviews.userId, input.userId),
          gte(caricaturePreviews.createdAt, dayStart),
          COUNTED
        )
      )
    const dayUsed = day?.n ?? 0
    if (dayUsed >= PREVIEWS_PER_DAY) throw new PreviewLimitError('day')

    const [everyone] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(and(gte(caricaturePreviews.createdAt, dayStart), COUNTED))
    if ((everyone?.n ?? 0) >= input.dailyCap) throw new PreviewLimitError('busy')

    const [row] = await tx
      .insert(caricaturePreviews)
      .values({
        userId: input.userId,
        photoHash: input.photoHash,
        character: input.character,
        model: input.model,
        createdAt: now,
      })
      .returning({ id: caricaturePreviews.id })
    return {
      id: row!.id,
      photoLeft: PREVIEWS_PER_PHOTO - photoUsed - 1,
      todayLeft: PREVIEWS_PER_DAY - dayUsed - 1,
    }
  })
}

export async function settlePreview(
  db: Db,
  id: string,
  result: {
    status: 'ok' | 'refused' | 'failed'
    inputTokens?: number
    outputTokens?: number
    previewKey?: string | null
    image?: Buffer | null
    photo?: Buffer | null
    characterImage?: Buffer | null
  }
): Promise<void> {
  await db
    .update(caricaturePreviews)
    .set({
      status: result.status,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      previewKey: result.previewKey ?? null,
      image: result.image ?? null,
      photo: result.status === 'ok' ? (result.photo ?? null) : null,
      characterImage: result.status === 'ok' ? (result.characterImage ?? null) : null,
    })
    .where(and(eq(caricaturePreviews.id, id), inArray(caricaturePreviews.status, ['pending'])))
}

/**
 * Previews made before the photo was kept have none. Seeing the same photo
 * again fills it in, so that preview can be ordered from the list too.
 */
export async function keepPreviewSources(
  db: Db,
  id: string,
  sources: { photo: Buffer; characterImage?: Buffer | null }
): Promise<void> {
  await db
    .update(caricaturePreviews)
    .set({
      photo: sources.photo,
      ...(sources.characterImage ? { characterImage: sources.characterImage } : {}),
    })
    .where(and(eq(caricaturePreviews.id, id), isNull(caricaturePreviews.photo)))
}

/** A preview this shopper already paid for with this photo and character. */
export async function findSavedPreview(
  db: Db,
  userId: string,
  photoHash: string,
  character: string
): Promise<{ id: string; image: Buffer; previewKey: string | null; hasPhoto: boolean } | null> {
  const [row] = await db
    .select({
      id: caricaturePreviews.id,
      image: caricaturePreviews.image,
      previewKey: caricaturePreviews.previewKey,
      hasPhoto: sql<boolean>`${caricaturePreviews.photo} is not null`,
    })
    .from(caricaturePreviews)
    .where(
      and(
        eq(caricaturePreviews.userId, userId),
        eq(caricaturePreviews.photoHash, photoHash),
        eq(caricaturePreviews.character, character),
        eq(caricaturePreviews.status, 'ok')
      )
    )
    .orderBy(desc(caricaturePreviews.createdAt))
    .limit(1)
  return row?.image
    ? { id: row.id, image: row.image, previewKey: row.previewKey, hasPhoto: row.hasPhoto }
    : null
}

/** The shopper's saved previews, newest first (no image bytes). */
export async function listSavedPreviews(db: Db, userId: string, limit = 24) {
  return db
    .select({
      id: caricaturePreviews.id,
      character: caricaturePreviews.character,
      previewKey: caricaturePreviews.previewKey,
      photoHash: caricaturePreviews.photoHash,
      hasPhoto: sql<boolean>`${caricaturePreviews.photo} is not null`,
      createdAt: caricaturePreviews.createdAt,
    })
    .from(caricaturePreviews)
    .where(
      and(
        eq(caricaturePreviews.userId, userId),
        eq(caricaturePreviews.status, 'ok'),
        isNotNull(caricaturePreviews.image)
      )
    )
    .orderBy(desc(caricaturePreviews.createdAt))
    .limit(limit)
}

/** One stored picture of a saved preview: the render, the photo, or their character picture. */
export async function getSavedPreviewImage(
  db: Db,
  userId: string,
  id: string,
  part: 'image' | 'photo' | 'characterImage' = 'image'
): Promise<Buffer | null> {
  const [row] = await db
    .select({ bytes: caricaturePreviews[part] })
    .from(caricaturePreviews)
    .where(and(eq(caricaturePreviews.id, id), eq(caricaturePreviews.userId, userId)))
  return row?.bytes ?? null
}

export async function photosLeft(db: Db, userId: string, photoHash: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(caricaturePreviews)
    .where(
      and(
        eq(caricaturePreviews.userId, userId),
        eq(caricaturePreviews.photoHash, photoHash),
        PHOTO_COUNTED
      )
    )
  return Math.max(0, PREVIEWS_PER_PHOTO - (row?.n ?? 0))
}
