/**
 * The caricature-preview ledger (`caricature_previews`) and its limits. Each
 * preview is a paid image-model call, so a shopper gets a few per photo and a
 * few per India day, and everyone together gets a daily cap set in env.
 *
 * A preview belongs to an owner: the signed-in shopper (`user_id`), or, before
 * signing in, the browser's own id (`guest_id`). Guests get fewer previews; the
 * point of letting them preview at all is that nobody signed in to see one
 * when a sign-in stood in the way. When a guest signs in, `claimGuestPreviews`
 * moves their rows onto the account, so the previews come back and the saved
 * list fills in.
 *
 * `reservePreview` checks the limits and writes a `pending` row in one
 * transaction, holding a lock on the owner, so two previews sent at once cannot
 * both pass on the same count. `settlePreview` records how the call went;
 * `failed` rows (our fault, not the shopper's) stop counting. A gallery outfit
 * the model refuses is our prompt's fault too, so it does not use up the photo,
 * but it still counts for the day (each refusal may be billed).
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { caricaturePreviews } from '../db/schema.js'

export const PREVIEWS_PER_PHOTO = 2
export const PREVIEWS_PER_DAY = 5
export const GUEST_PREVIEWS_PER_PHOTO = 1
export const GUEST_PREVIEWS_PER_DAY = 2

/** Whose previews: a signed-in shopper, or a browser that has not signed in. */
export type PreviewOwner = { kind: 'user'; id: string } | { kind: 'guest'; id: string }

/** The browser's own id (web `getDeviceId`, a UUID), as sent in X-Preview-Guest. */
const GUEST_ID = /^[A-Za-z0-9_-]{16,64}$/

export function guestIdFromHeader(header: string | string[] | undefined): string | null {
  return typeof header === 'string' && GUEST_ID.test(header) ? header : null
}

export function previewLimits(owner: PreviewOwner): { perPhoto: number; perDay: number } {
  return owner.kind === 'user'
    ? { perPhoto: PREVIEWS_PER_PHOTO, perDay: PREVIEWS_PER_DAY }
    : { perPhoto: GUEST_PREVIEWS_PER_PHOTO, perDay: GUEST_PREVIEWS_PER_DAY }
}

const ownedBy = (owner: PreviewOwner) =>
  owner.kind === 'user'
    ? eq(caricaturePreviews.userId, owner.id)
    : eq(caricaturePreviews.guestId, owner.id)

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
  owner: PreviewOwner,
  now = new Date(),
  photoHash?: string
): Promise<PreviewQuota> {
  const [row] = await db
    .select({ n: count() })
    .from(caricaturePreviews)
    .where(and(ownedBy(owner), gte(caricaturePreviews.createdAt, startOfIndiaDay(now)), COUNTED))
  const quota: PreviewQuota = {
    ...previewLimits(owner),
    usedToday: row?.n ?? 0,
  }
  if (!photoHash) return quota

  const rows = await db
    .select({ character: caricaturePreviews.character, status: caricaturePreviews.status })
    .from(caricaturePreviews)
    .where(and(ownedBy(owner), eq(caricaturePreviews.photoHash, photoHash), PHOTO_COUNTED))
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
  input: {
    owner: PreviewOwner
    photoHash: string
    character: string
    characters: number
    model: string
    dailyCap: number
  },
  now = new Date()
): Promise<{ id: string; photoLeft: number; todayLeft: number }> {
  const dayStart = startOfIndiaDay(now)
  const { owner } = input
  const limits = previewLimits(owner)
  return db.transaction(async (tx) => {
    // One reservation at a time per owner: the users row for a shopper, an
    // advisory lock on the id for a guest (who has no row).
    if (owner.kind === 'user') {
      await tx.execute(sql`select 1 from users where id = ${owner.id} for update`)
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${owner.id}))`)
    }

    const [photo] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(and(ownedBy(owner), eq(caricaturePreviews.photoHash, input.photoHash), PHOTO_COUNTED))
    const photoUsed = photo?.n ?? 0
    if (photoUsed >= limits.perPhoto) throw new PreviewLimitError('photo')

    const [day] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(and(ownedBy(owner), gte(caricaturePreviews.createdAt, dayStart), COUNTED))
    const dayUsed = day?.n ?? 0
    if (dayUsed >= limits.perDay) throw new PreviewLimitError('day')

    const [everyone] = await tx
      .select({ n: count() })
      .from(caricaturePreviews)
      .where(and(gte(caricaturePreviews.createdAt, dayStart), COUNTED))
    if ((everyone?.n ?? 0) >= input.dailyCap) throw new PreviewLimitError('busy')

    const [row] = await tx
      .insert(caricaturePreviews)
      .values({
        characters: input.characters,
        userId: owner.kind === 'user' ? owner.id : null,
        guestId: owner.kind === 'guest' ? owner.id : null,
        photoHash: input.photoHash,
        character: input.character,
        model: input.model,
        createdAt: now,
      })
      .returning({ id: caricaturePreviews.id })
    return {
      id: row!.id,
      photoLeft: limits.perPhoto - photoUsed - 1,
      todayLeft: limits.perDay - dayUsed - 1,
    }
  })
}

/**
 * A guest who signs in keeps their previews: rows made under this browser's id
 * with no account yet become the account's. Returns how many moved.
 */
export async function claimGuestPreviews(db: Db, userId: string, guestId: string): Promise<number> {
  const rows = await db
    .update(caricaturePreviews)
    .set({ userId })
    .where(and(eq(caricaturePreviews.guestId, guestId), isNull(caricaturePreviews.userId)))
    .returning({ id: caricaturePreviews.id })
  return rows.length
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

/** A preview this owner already paid for with this photo and character. */
export async function findSavedPreview(
  db: Db,
  owner: PreviewOwner,
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
        ownedBy(owner),
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

/** The shopper's saved previews, newest first (no image bytes). Signed in only. */
export async function listSavedPreviews(db: Db, userId: string, limit = 24) {
  return db
    .select({
      id: caricaturePreviews.id,
      character: caricaturePreviews.character,
      previewKey: caricaturePreviews.previewKey,
      photoHash: caricaturePreviews.photoHash,
      hasPhoto: sql<boolean>`${caricaturePreviews.photo} is not null`,
      characters: caricaturePreviews.characters,
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

export async function photosLeft(db: Db, owner: PreviewOwner, photoHash: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(caricaturePreviews)
    .where(and(ownedBy(owner), eq(caricaturePreviews.photoHash, photoHash), PHOTO_COUNTED))
  return Math.max(0, previewLimits(owner).perPhoto - (row?.n ?? 0))
}
