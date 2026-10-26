/**
 * "Notify me" requests (contracts/restock.ts). Owns `restock_requests`.
 * Draining (sending the "it's here" message once a piece is purchasable) is a
 * separate step; this module only records who asked for what.
 */
import { sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { restockRequests } from '../db/schema.js'
import { validationFailed } from '../lib/errors.js'

/**
 * Record a request. Idempotent: a second ask for the same piece by the same
 * account or email is absorbed by the partial unique indexes, so the caller
 * always gets the same answer and learns nothing about other requests.
 */
export async function requestRestock(
  db: Db,
  input: { sku: string; userId?: string | undefined; email?: string | undefined }
): Promise<void> {
  if (!input.userId && !input.email) throw validationFailed('An email address is required')
  await db
    .insert(restockRequests)
    .values({
      sku: input.sku,
      userId: input.userId ?? null,
      email: input.userId ? null : (input.email ?? '').trim().toLowerCase(),
    })
    .onConflictDoNothing()
}

/** Pending requests per sku, for the admin view and the drain step. */
export async function countPendingRestockRequests(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ sku: restockRequests.sku, n: sql<number>`count(*)::int` })
    .from(restockRequests)
    .where(sql`${restockRequests.notifiedAt} is null`)
    .groupBy(restockRequests.sku)
  return new Map(rows.map((row) => [row.sku, row.n]))
}
