/**
 * Custom miniature and caricature requests (contracts/customRequests.ts).
 * Owns `custom_requests`. The photos are already in image-intake by the time
 * a request arrives; this module records them with the shopper's choices.
 */
import { randomInt } from 'node:crypto'

import { and, count, desc, eq, inArray } from 'drizzle-orm'

import type {
  CustomPhoto,
  CustomRequest,
  CustomRequestAdmin,
  CustomRequestAdminUpdate,
  CustomRequestCreate,
} from '../contracts/customRequests.js'
import type { Db } from '../db/client.js'
import { customRequests, users, type CustomRequestRow } from '../db/schema.js'
import { ID_PREFIX } from '../lib/brand.js'
import { limitExceeded, notFound } from '../lib/errors.js'

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_NUMBER_ATTEMPTS = 5
/** Requests still waiting on the team; a brake on a runaway or abusive client. */
export const MAX_OPEN_REQUESTS = 5
const OPEN_STATUSES = ['submitted', 'in_review'] as const

function requestNumber(now: Date): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += CHARSET[randomInt(CHARSET.length)]
  return `${ID_PREFIX}-CR-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${suffix}`
}

function toRequest(row: CustomRequestRow): CustomRequest {
  const photos = row.photos as CustomPhoto[]
  return {
    requestNumber: row.requestNumber,
    kind: row.kind as CustomRequest['kind'],
    photoKeys: photos.map((photo) => photo.key),
    colours: row.colours as CustomRequest['colours'],
    notes: row.notes,
    pincode: row.pincode,
    neededBy: row.neededBy,
    status: row.status as CustomRequest['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Postgres unique violation, as surfaced by both node-postgres and PGlite. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

export async function createCustomRequest(
  db: Db,
  userId: string,
  input: CustomRequestCreate,
  now: Date = new Date()
): Promise<CustomRequest> {
  const [open] = await db
    .select({ n: count() })
    .from(customRequests)
    .where(
      and(eq(customRequests.userId, userId), inArray(customRequests.status, [...OPEN_STATUSES]))
    )
  if ((open?.n ?? 0) >= MAX_OPEN_REQUESTS) {
    throw limitExceeded(
      `You have ${MAX_OPEN_REQUESTS} requests waiting for a reply. We will get back to you on those first.`
    )
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(customRequests)
        .values({
          requestNumber: requestNumber(now),
          userId,
          kind: input.kind,
          photos: input.photos,
          colours: input.colours,
          notes: input.notes || null,
          pincode: input.pincode ?? null,
          neededBy: input.neededBy ?? null,
        })
        .returning()
      return toRequest(row!)
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
  }
  throw new Error('could not allocate a unique custom request number')
}

export async function listCustomRequests(db: Db, userId: string): Promise<CustomRequest[]> {
  const rows = await db
    .select()
    .from(customRequests)
    .where(eq(customRequests.userId, userId))
    .orderBy(desc(customRequests.createdAt))
  return rows.map(toRequest)
}

function toAdmin(row: CustomRequestRow, phone: string | null): CustomRequestAdmin {
  return {
    ...toRequest(row),
    userId: row.userId,
    phone,
    photos: row.photos as CustomPhoto[],
    adminNote: row.adminNote,
  }
}

export async function listAllCustomRequests(db: Db): Promise<CustomRequestAdmin[]> {
  const rows = await db
    .select({ request: customRequests, phone: users.phone })
    .from(customRequests)
    .leftJoin(users, eq(users.id, customRequests.userId))
    .orderBy(desc(customRequests.createdAt))
  return rows.map(({ request, phone }) => toAdmin(request, phone))
}

export async function updateCustomRequestStatus(
  db: Db,
  requestNumberParam: string,
  input: CustomRequestAdminUpdate
): Promise<CustomRequestAdmin> {
  const [row] = await db
    .update(customRequests)
    .set({
      status: input.status,
      ...(input.adminNote !== undefined && { adminNote: input.adminNote }),
      updatedAt: new Date(),
    })
    .where(eq(customRequests.requestNumber, requestNumberParam))
    .returning()
  if (!row) throw notFound('Custom request not found')
  const [user] = await db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)
  return toAdmin(row, user?.phone ?? null)
}
