/**
 * Custom miniature and caricature requests (contracts/customRequests.ts).
 * Owns `custom_requests`. The photos are already in image-intake by the time
 * a request arrives; this module records them with the shopper's choices.
 */
import { randomInt } from 'node:crypto'

import { and, count, desc, eq, gte, sql } from 'drizzle-orm'

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
/**
 * A brake on a runaway or abusive client. Counted by age, not status: every
 * add to bag creates a request and nothing moves it on once it is paid or
 * dropped from the bag, so an open-request cap would lock shoppers out for good.
 */
export const MAX_REQUESTS_PER_DAY = 10
const REQUEST_WINDOW_MS = 24 * 60 * 60_000
/**
 * Miniature pieces one device or account can add before paying for one. Every
 * piece stores the shopper's photos with us, so this stops the form being used
 * for free. Paying for a miniature starts the count again.
 */
export const MAX_UNPAID_MINIATURES = 10

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

export interface MiniatureAllowance {
  limit: number
  used: number
  left: number
}

/**
 * Pieces counted for this account or device since a miniature was last paid
 * for by this account or anyone else who used the device. Matching on the
 * account too means clearing browser storage does not reset the count.
 */
export async function miniatureAllowance(
  db: Db,
  userId: string,
  deviceId?: string
): Promise<MiniatureAllowance> {
  const scope = deviceId
    ? sql`(cr.user_id = ${userId} or cr.device_id = ${deviceId})`
    : sql`cr.user_id = ${userId}`
  const result = await db.execute(sql`
    select coalesce(sum(jsonb_array_length(cr.photos)), 0)::int as used
    from custom_requests cr
    where cr.kind = 'miniature'
      and ${scope}
      and cr.created_at > coalesce(
        (
          select max(p.paid_at)
          from payments p
          where p.cart_snapshot::text like '%TT-CUSTOM-MINIATURE%'
            and (
              p.user_id = ${userId}
              or p.user_id in (select cr.user_id from custom_requests cr where ${scope})
            )
        ),
        '-infinity'::timestamptz
      )
  `)
  const used = Number((result.rows[0] as { used?: unknown } | undefined)?.used ?? 0)
  return {
    limit: MAX_UNPAID_MINIATURES,
    used,
    left: Math.max(0, MAX_UNPAID_MINIATURES - used),
  }
}

export async function createCustomRequest(
  db: Db,
  userId: string,
  input: CustomRequestCreate,
  now: Date = new Date()
): Promise<CustomRequest> {
  const [recent] = await db
    .select({ n: count() })
    .from(customRequests)
    .where(
      and(
        eq(customRequests.userId, userId),
        gte(customRequests.createdAt, new Date(now.getTime() - REQUEST_WINDOW_MS))
      )
    )
  if ((recent?.n ?? 0) >= MAX_REQUESTS_PER_DAY) {
    throw limitExceeded(
      'You have added a lot of custom pieces today. Try again tomorrow, or email us your photos.'
    )
  }
  if (input.kind === 'miniature') {
    const { limit, left } = await miniatureAllowance(db, userId, input.deviceId)
    if (input.photos.length > left) {
      throw limitExceeded(
        left === 0
          ? `You have reached ${limit} miniature pieces on this device without paying. Check out the pieces in your bag to make more.`
          : `You can add ${left} more miniature ${left === 1 ? 'piece' : 'pieces'} on this device before paying. Remove some photos, or check out your bag first.`
      )
    }
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(customRequests)
        .values({
          requestNumber: requestNumber(now),
          userId,
          deviceId: input.deviceId ?? null,
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
