/**
 * WhatsApp inbox — conversation threads and their messages.
 *
 * Owns `wa_conversations` + `wa_messages` and nothing else. Per ARCHITECTURE.md
 * rule 2 this service does not import another service: identity resolution is a
 * direct read of `users.phone` (the same table `plugins/auth.ts` upserts), not a
 * call into the profile service.
 *
 * **No AI here and none above it.** TASK-04 phase 1 is deliberately plumbing
 * plus a human inbox: the transcripts this produces are what the agent's system
 * prompt gets written against in phase 2.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import {
  users,
  waConversations,
  waMessages,
  type WaConversationRow,
  type WaMessageRow,
} from '../db/schema.js'
import {
  toE164,
  windowOpen,
  type InboundMessage,
  type StatusUpdate,
} from '../lib/whatsapp/inbound.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Resolve a WhatsApp number to a Tiny Tales account, or null.
 *
 * The phone number IS the login (Firebase phone auth), so this is the entire
 * "linking flow" — there isn't one. Null is the normal case for a first-time
 * visitor and must stay a first-class outcome: most people who open the chat
 * from a PDP have never ordered.
 */
export async function resolveUserByWaPhone(db: Db | Tx, waPhone: string): Promise<string | null> {
  const e164 = toE164(waPhone)
  if (!e164) return null
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.phone, e164)).limit(1)
  return row?.id ?? null
}

/**
 * Record one inbound message, creating or updating its thread.
 *
 * Returns `{ conversation, isNew, duplicate }`. `duplicate: true` means Meta
 * retried a webhook we already stored — the caller must treat that as a no-op
 * and NOT auto-reply again, or a retry storm turns into a message storm at the
 * shopper's end.
 *
 * The whole thing runs in one transaction because the message insert and the
 * thread's `last_inbound_at` / `unread_count` are one fact, and a half-applied
 * version of it puts a thread in the inbox with a window timestamp that no
 * message explains.
 */
export async function recordInboundMessage(
  db: Db,
  message: InboundMessage
): Promise<{ conversation: WaConversationRow; isNew: boolean; duplicate: boolean }> {
  const receivedAt = message.timestampSec > 0 ? new Date(message.timestampSec * 1000) : new Date()

  return db.transaction(async (tx: Tx) => {
    const userId = await resolveUserByWaPhone(tx, message.from)

    // Create the thread if this number has never written before. `onConflict`
    // rather than select-then-insert: two messages from the same new number can
    // arrive in the same batch, and the unique index is the only real guard.
    const [inserted] = await tx
      .insert(waConversations)
      .values({
        waPhone: message.from,
        userId,
        profileName: message.profileName,
        refCode: message.refCode,
        lastInboundAt: receivedAt,
        unreadCount: 1,
      })
      .onConflictDoNothing({ target: waConversations.waPhone })
      .returning()

    const isNew = inserted !== undefined

    // Dedupe on Meta's message id. This is what makes the webhook idempotent
    // under Meta's retries; everything below it is skipped on a repeat.
    const [storedMessage] = await tx
      .insert(waMessages)
      .values({
        conversationId:
          inserted?.id ??
          (
            await tx
              .select({ id: waConversations.id })
              .from(waConversations)
              .where(eq(waConversations.waPhone, message.from))
              .limit(1)
          )[0]!.id,
        direction: 'inbound',
        waMessageId: message.waMessageId,
        msgType: message.msgType,
        body: message.body,
      })
      .onConflictDoNothing({ target: waMessages.waMessageId })
      .returning({ id: waMessages.id, conversationId: waMessages.conversationId })

    if (!storedMessage) {
      const [existing] = await tx
        .select()
        .from(waConversations)
        .where(eq(waConversations.waPhone, message.from))
        .limit(1)
      return { conversation: existing!, isNew: false, duplicate: true }
    }

    if (isNew) return { conversation: inserted, isNew: true, duplicate: false }

    // Existing thread: bump the window and the unread badge.
    //
    // `refCode` uses COALESCE so the FIRST code seen wins — the entry point that
    // earned the conversation, not whichever page the shopper last revisited.
    // `userId` is refreshed every time because a shopper can sign up AFTER
    // first messaging, and the thread should adopt the account the moment it
    // exists rather than staying anonymous forever.
    const [updated] = await tx
      .update(waConversations)
      .set({
        userId,
        profileName: message.profileName ?? sql`${waConversations.profileName}`,
        refCode: sql`coalesce(${waConversations.refCode}, ${message.refCode})`,
        lastInboundAt: receivedAt,
        unreadCount: sql`${waConversations.unreadCount} + 1`,
        // A shopper writing again re-opens a thread a human had closed. Their
        // message is the authority on whether the matter is settled.
        status: 'open',
        updatedAt: new Date(),
      })
      .where(eq(waConversations.waPhone, message.from))
      .returning()

    return { conversation: updated!, isNew: false, duplicate: false }
  })
}

/**
 * Record an outbound message (human reply or automated first-touch).
 *
 * Written whether the send succeeded or failed, and `status`/`error` carry
 * which. A failed reply that left no row would be invisible in `/admin` — the
 * operator would see their message vanish and send it again.
 */
export async function recordOutboundMessage(
  db: Db,
  input: {
    conversationId: string
    body: string
    status: 'sent' | 'failed'
    waMessageId?: string | undefined
    error?: string | undefined
    sentBy?: string | undefined
    /**
     * What kind of message went out. Defaults to 'text' — the free-form reply,
     * which is all this function sent before follow-up templates existed.
     *
     * 'template' is load-bearing rather than decorative: it is how the
     * follow-up route knows a template has ALREADY been sent since the
     * shopper's last message, and refuses to send a second one. Matching on the
     * rendered body text would work until the approved wording changed, at
     * which point the guard would silently stop guarding.
     */
    msgType?: 'text' | 'template' | undefined
  }
): Promise<WaMessageRow> {
  return db.transaction(async (tx: Tx) => {
    const [row] = await tx
      .insert(waMessages)
      .values({
        conversationId: input.conversationId,
        direction: 'outbound',
        waMessageId: input.waMessageId ?? null,
        msgType: input.msgType ?? 'text',
        body: input.body,
        status: input.status,
        error: input.error ?? null,
        sentBy: input.sentBy ?? null,
      })
      .returning()

    // Only a SENT message clears the unread badge and moves the thread's
    // outbound clock. A failed send answered nobody.
    if (input.status === 'sent') {
      await tx
        .update(waConversations)
        .set({ lastOutboundAt: new Date(), unreadCount: 0, updatedAt: new Date() })
        .where(eq(waConversations.id, input.conversationId))
    }

    return row!
  })
}

/** The stored status's rank, as SQL — the guard that keeps ticks monotonic. */
const STATUS_RANK_SQL = sql`case ${waMessages.status}
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    when 'failed' then 4
    else 0 end`

/**
 * Rank of each outbound status along its real lifecycle.
 *
 * Meta re-sends receipts and delivers them out of order — a `delivered` for a
 * message the shopper has already read is routine — so a status is only ever
 * written when it OUTRANKS what is stored. Without this the ticks flicker
 * backwards, which reads to an operator as a message that un-sent itself.
 *
 * `failed` sits at the top because it is terminal and the one state that needs
 * a human: nothing Meta says afterwards makes a failed send delivered.
 */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
}

/**
 * Apply one delivery receipt to the outbound message it belongs to.
 *
 * Keyed on Meta's `wamid.*`, which is unique across the table, so an unknown id
 * is simply a no-op — receipts arrive for template sends made by other parts of
 * this codebase, and for messages predating the row. Returns the conversation
 * whose transcript changed, or null when nothing did, so a caller can decide
 * whether anything is worth pushing.
 */
export async function applyStatusUpdate(db: Db, update: StatusUpdate): Promise<string | null> {
  const [row] = await db
    .update(waMessages)
    .set({
      status: update.status,
      ...(update.error !== null ? { error: update.error } : {}),
    })
    .where(
      and(
        eq(waMessages.waMessageId, update.waMessageId),
        eq(waMessages.direction, 'outbound'),
        // Monotonic: a stale receipt loses to the state already recorded.
        sql`coalesce(${waMessages.status}, '') is distinct from ${update.status}`,
        sql`coalesce(${STATUS_RANK_SQL}, 0) < ${STATUS_RANK[update.status] ?? 0}`
      )
    )
    .returning({ conversationId: waMessages.conversationId })

  return row?.conversationId ?? null
}

/**
 * Who sent the last message that actually reached this shopper, and when.
 *
 * `sent_by` is the operator's user id on a human reply and NULL on an automated
 * one, which is the only way to tell the two apart after the fact — and the
 * auto-reply gate needs exactly that distinction: an operator mid-conversation
 * must never be talked over, while the bot's own last word is not a reason to
 * stay silent for a day.
 *
 * Every status EXCEPT 'failed' counts. A failed send reached nobody, so it can
 * neither claim the thread for a human nor start a cooldown — while 'sent',
 * 'delivered' and 'read' are the same message at three points of its life, and
 * a receipt advancing it must not make a reply that went out look like one that
 * never did. (This is why the test is "not failed" rather than "is sent": the
 * webhook rewrites this column after the fact.)
 */
export async function lastDeliveredOutbound(
  db: Db,
  conversationId: string
): Promise<{ at: Date; byHuman: boolean } | null> {
  const [row] = await db
    .select({ at: waMessages.createdAt, sentBy: waMessages.sentBy })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.conversationId, conversationId),
        eq(waMessages.direction, 'outbound'),
        sql`${waMessages.status} is distinct from 'failed'`
      )
    )
    .orderBy(desc(waMessages.createdAt))
    .limit(1)

  return row ? { at: row.at, byHuman: row.sentBy !== null } : null
}

/** One row in the `/admin` inbox list. */
export interface ConversationSummary {
  id: string
  waPhone: string
  profileName: string | null
  userId: string | null
  /** The shopper's account name, when they have one. */
  userName: string | null
  refCode: string | null
  status: string
  lastInboundAt: string | null
  lastOutboundAt: string | null
  unreadCount: number
  /** Whether a free-form reply is still legal — see `windowOpen`. */
  windowOpen: boolean
  /** Preview of the most recent message, either direction. */
  lastMessage: string
  createdAt: string
}

/**
 * The inbox list, newest activity first.
 *
 * Ordered by `last_inbound_at` rather than `updated_at`: the queue an operator
 * works is "who is waiting on me", and a thread we replied to should not jump
 * back to the top because of our own reply.
 */
export async function listConversations(
  db: Db,
  opts: { status?: 'open' | 'closed' | undefined; limit?: number | undefined } = {}
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await db
    .select({
      conversation: waConversations,
      userName: users.name,
    })
    .from(waConversations)
    .leftJoin(users, eq(users.id, waConversations.userId))
    .where(opts.status ? eq(waConversations.status, opts.status) : undefined)
    .orderBy(desc(waConversations.lastInboundAt))
    .limit(limit)

  const now = Date.now()
  const summaries: ConversationSummary[] = []
  for (const row of rows) {
    const [latest] = await db
      .select({ body: waMessages.body, direction: waMessages.direction })
      .from(waMessages)
      .where(eq(waMessages.conversationId, row.conversation.id))
      .orderBy(desc(waMessages.createdAt))
      .limit(1)

    summaries.push({
      ...toSummary(row.conversation, row.userName, now),
      lastMessage: latest ? `${latest.direction === 'outbound' ? 'You: ' : ''}${latest.body}` : '',
    })
  }
  return summaries
}

function toSummary(
  row: WaConversationRow,
  userName: string | null,
  now: number
): Omit<ConversationSummary, 'lastMessage'> {
  return {
    id: row.id,
    waPhone: row.waPhone,
    profileName: row.profileName,
    userId: row.userId,
    userName,
    refCode: row.refCode,
    status: row.status,
    lastInboundAt: row.lastInboundAt ? row.lastInboundAt.toISOString() : null,
    lastOutboundAt: row.lastOutboundAt ? row.lastOutboundAt.toISOString() : null,
    unreadCount: row.unreadCount,
    windowOpen: windowOpen(row.lastInboundAt, now),
    createdAt: row.createdAt.toISOString(),
  }
}

/** One conversation plus its full transcript, oldest first (reading order). */
export interface ConversationThread extends Omit<ConversationSummary, 'lastMessage'> {
  messages: Array<{
    id: string
    direction: string
    msgType: string
    body: string
    status: string | null
    error: string | null
    createdAt: string
  }>
}

export async function getConversation(db: Db, id: string): Promise<ConversationThread | null> {
  const [row] = await db
    .select({ conversation: waConversations, userName: users.name })
    .from(waConversations)
    .leftJoin(users, eq(users.id, waConversations.userId))
    .where(eq(waConversations.id, id))
    .limit(1)
  if (!row) return null

  const messages = await db
    .select()
    .from(waMessages)
    .where(eq(waMessages.conversationId, id))
    .orderBy(waMessages.createdAt)

  return {
    ...toSummary(row.conversation, row.userName, Date.now()),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      msgType: m.msgType,
      body: m.body,
      status: m.status,
      error: m.error,
      createdAt: m.createdAt.toISOString(),
    })),
  }
}

/** Mark a thread handled. A new inbound re-opens it — see `recordInboundMessage`. */
export async function setConversationStatus(
  db: Db,
  id: string,
  status: 'open' | 'closed'
): Promise<WaConversationRow | null> {
  const [row] = await db
    .update(waConversations)
    .set({ status, updatedAt: new Date(), ...(status === 'closed' ? { unreadCount: 0 } : {}) })
    .where(eq(waConversations.id, id))
    .returning()
  return row ?? null
}

/** Threads with an unanswered inbound — the number the `/admin` nav badge shows. */
export async function countWaiting(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waConversations)
    .where(and(eq(waConversations.status, 'open'), sql`${waConversations.unreadCount} > 0`))
  return row?.n ?? 0
}

/** Threads from shoppers with no Tiny Tales account — the acquisition slice of the inbox. */
export async function countAnonymous(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waConversations)
    .where(isNull(waConversations.userId))
  return row?.n ?? 0
}
