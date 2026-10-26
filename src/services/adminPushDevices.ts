/**
 * `admin_push_devices` — which browsers an admin gets notified on.
 *
 * Owns that one table and nothing else, per ARCHITECTURE.md rule 2. It does not
 * know what a WhatsApp conversation is; the webhook asks it for tokens and hands
 * back whatever FCM rejected.
 */

import { and, desc, eq, inArray, ne } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { adminPushDevices, users, type AdminPushDeviceRow } from '../db/schema.js'

/**
 * Register (or refresh) one browser for one admin.
 *
 * The token is the identity of a BROWSER, so a conflict on it moves the
 * registration to whoever is signed in now rather than adding a second row.
 * Otherwise a shared laptop would push every alert twice, and the first owner
 * would keep receiving notifications for an inbox they no longer hold.
 */
export async function registerDevice(
  db: Db,
  input: { userId: string; token: string; label?: string | undefined }
): Promise<AdminPushDeviceRow> {
  const [row] = await db
    .insert(adminPushDevices)
    .values({ userId: input.userId, token: input.token, label: input.label ?? '' })
    .onConflictDoUpdate({
      target: adminPushDevices.token,
      set: {
        userId: input.userId,
        label: input.label ?? '',
        lastSeenAt: new Date(),
      },
    })
    .returning()

  return row!
}

/** Drop one browser's registration — the "turn notifications off" path. */
export async function unregisterDevice(db: Db, token: string): Promise<void> {
  await db.delete(adminPushDevices).where(eq(adminPushDevices.token, token))
}

/**
 * Every token belonging to a current admin.
 *
 * Joined against `users.role` on every send rather than trusted from
 * registration time: an admin who is demoted must stop receiving customer
 * messages immediately, and nothing else would notice that their rows are
 * still sitting here.
 */
export async function adminTokens(db: Db): Promise<string[]> {
  const rows = await db
    .select({ token: adminPushDevices.token })
    .from(adminPushDevices)
    .innerJoin(users, eq(users.id, adminPushDevices.userId))
    .where(eq(users.role, 'admin'))
    .orderBy(desc(adminPushDevices.lastSeenAt))

  return rows.map((row) => row.token)
}

/** Delete the tokens FCM reported dead. No-op on an empty list. */
export async function pruneTokens(db: Db, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return
  await db.delete(adminPushDevices).where(inArray(adminPushDevices.token, tokens))
}

/** One admin's own browsers, for a "your devices" list in `/admin`. */
export async function listDevices(db: Db, userId: string): Promise<AdminPushDeviceRow[]> {
  return db
    .select()
    .from(adminPushDevices)
    .where(eq(adminPushDevices.userId, userId))
    .orderBy(desc(adminPushDevices.lastSeenAt))
}

/**
 * Drop this admin's OTHER registrations for the same label.
 *
 * A home-screen web app that gets reinstalled mints a fresh token while the old
 * row lingers, and the old one stays "valid" at FCM for weeks — long enough to
 * double every alert. Same person, same label, different token means the older
 * one is a ghost.
 */
export async function pruneSupersededDevices(
  db: Db,
  input: { userId: string; token: string; label: string }
): Promise<void> {
  if (input.label === '') return
  await db
    .delete(adminPushDevices)
    .where(
      and(
        eq(adminPushDevices.userId, input.userId),
        eq(adminPushDevices.label, input.label),
        ne(adminPushDevices.token, input.token)
      )
    )
}
