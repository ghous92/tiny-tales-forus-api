/**
 * Inbound WhatsApp webhook primitives — signature verification, ref-code
 * extraction, and payload normalisation. Pure: no DB, no config, no network,
 * same rule as `lib/shipping.ts` and `lib/coupons.ts`.
 *
 * Everything here runs BEFORE the payload is trusted. `verifySignature` is the
 * security boundary of the whole feature: the phone number in `from` resolves
 * straight to a Tiny Tales account (accounts are Firebase phone-auth), so a route
 * that parsed an unverified body would let anyone read another shopper's cart
 * and orders by POSTing their number. Verify first, parse second — in that
 * order, on every request, with no "trusted source" bypass.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The `wa.me` deep link prefills a message ending in an opaque ref code —
 * `...Daniya Cream 500ml [TT-4F2A9C]` — and that code is what ties a chat back
 * to a session, a PDP and later an order. Without it this is the
 * unattributable channel the whole design was trying not to build.
 *
 * Deliberately loose on length (4–16) and case-insensitive (the `i` flag covers
 * the `TT-` prefix too, not just the body): the code is minted by the web
 * client, and a webhook that silently dropped attribution because the client
 * lower-cased its links would be invisible — no error, just a channel that
 * looks unattributable again, which is the exact failure this feature exists
 * to avoid.
 */
const REF_CODE_RE = /\[(TT-[A-Za-z0-9]{4,16})\]/i

/** Meta's `X-Hub-Signature-256` header value looks like `sha256=<hex>`. */
const SIGNATURE_PREFIX = 'sha256='

/**
 * Is this request really from Meta?
 *
 * HMAC-SHA256 over the RAW request body with the app secret. Raw matters: any
 * re-serialisation (JSON.parse → JSON.stringify) changes key order and
 * whitespace, and the digest stops matching for reasons that look like a
 * misconfigured secret. The route keeps the body as a Buffer for this reason.
 *
 * Returns false rather than throwing on every malformed input — a missing
 * header, a wrong prefix, a non-hex digest and a genuine mismatch are all the
 * same answer to the only question being asked, and a thrown error here would
 * turn an attacker's probe into a 500 with a stack trace.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string
): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false
  const provided = header.slice(SIGNATURE_PREFIX.length)
  // A hex digest of SHA-256 is always 64 chars. Checking first keeps
  // `Buffer.from(..., 'hex')` from silently truncating garbage into something
  // that could be compared at all.
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false

  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  const providedBuf = Buffer.from(provided, 'hex')
  if (providedBuf.length !== expected.length) return false
  // Constant-time: a fast-fail byte comparison leaks the digest one byte at a
  // time to anyone who can measure response latency.
  return timingSafeEqual(providedBuf, expected)
}

/**
 * Pull the ref code out of a prefilled first message, or null.
 *
 * Returns the code WITHOUT its brackets, uppercased, so `TT-4f2a9c` and
 * `TT-4F2A9C` are the same attribution row.
 */
export function extractRefCode(text: string): string | null {
  const match = REF_CODE_RE.exec(text)
  return match?.[1] ? match[1].toUpperCase() : null
}

/**
 * Strip the ref code (and the whitespace it leaves behind) from a message
 * before it is stored or shown.
 *
 * The code is plumbing the shopper did not write and did not mean; leaving it
 * in the transcript puts an internal token in front of whoever reads the thread
 * — and, in phase 2, in front of the model, which would happily start quoting
 * it back at people.
 */
export function stripRefCode(text: string): string {
  return text.replace(REF_CODE_RE, '').replace(/\s+/g, ' ').trim()
}

/**
 * Normalise a phone number to the form `wa_conversations.wa_phone` stores:
 * E.164 digits, NO leading `+`, matching how Meta sends `from` and how
 * `ops_notifications.target` already stores a recipient.
 */
export function normalizeWaPhone(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

/**
 * The `users.phone` form of the same number: E.164 WITH the leading `+`.
 *
 * This asymmetry is the one thing to keep straight in this module. `users.phone`
 * is written from a Firebase token's `phone_number` claim, which carries the
 * `+`; Meta's webhook omits it. Identity resolution joins across that gap, and
 * getting it backwards produces a silent "no account found" for every shopper
 * who actually has one.
 */
export function toE164(waPhone: string): string {
  const digits = normalizeWaPhone(waPhone)
  return digits ? `+${digits}` : ''
}

/** One inbound message, already flattened out of Meta's nested envelope. */
export interface InboundMessage {
  /** Meta's `wamid.*`. The idempotency key — see `wa_messages.wa_message_id`. */
  waMessageId: string
  /** Sender, E.164 digits with no `+`. */
  from: string
  /** 'text' | 'image' | 'unsupported'. */
  msgType: 'text' | 'image' | 'unsupported'
  /** Body with the ref code stripped. Empty for media. */
  body: string
  /** The ref code found on this message, if any. */
  refCode: string | null
  /** `contacts[].profile.name`, when Meta supplies it. */
  profileName: string | null
  /** Meta's `timestamp`, seconds since epoch, as a number. */
  timestampSec: number
}

/** Narrow unknown JSON without a schema library — the payload is Meta's, not ours. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Flatten Meta's `entry[].changes[].value.messages[]` envelope into a list of
 * messages we care about.
 *
 * Hand-narrowed rather than zod-parsed on purpose: this payload belongs to
 * Meta, who add fields without notice, and a strict schema on someone else's
 * evolving envelope fails closed on a shape that was merely *new*. Anything
 * unrecognised is skipped, never thrown on — a 500 here just makes Meta retry
 * the same unparseable body until it gives up and degrades the webhook.
 *
 * **Status callbacks (`value.statuses`) are not messages** and are skipped by
 * this function on purpose: they are delivery receipts for messages WE sent,
 * and treating one as an inbound would open a fake 24-hour window and let an
 * outbound reply look like a conversation. They are parsed separately, by
 * {@link parseStatusUpdates}, and only ever update an existing outbound row.
 */
export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const root = asRecord(payload)
  if (!root) return []

  const out: InboundMessage[] = []
  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry)
    if (!entryRec) continue
    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change)
      const value = asRecord(changeRec?.value)
      if (!value) continue

      // `contacts` carries the display name, in a sibling array to `messages`
      // rather than on the message itself.
      const profileName =
        asString(asRecord(asRecord(asArray(value.contacts)[0])?.profile)?.name) ?? null

      for (const message of asArray(value.messages)) {
        const msg = asRecord(message)
        if (!msg) continue
        const waMessageId = asString(msg.id)
        const from = asString(msg.from)
        if (!waMessageId || !from) continue

        const rawType = asString(msg.type) ?? 'unsupported'
        const text = asString(asRecord(msg.text)?.body) ?? ''
        // An image's caption is the only text a media message carries, and it
        // is where a shopper writes "is this the one?" — worth keeping.
        const caption = asString(asRecord(msg.image)?.caption) ?? ''
        const rawBody = rawType === 'text' ? text : caption

        out.push({
          waMessageId,
          from: normalizeWaPhone(from),
          msgType: rawType === 'text' ? 'text' : rawType === 'image' ? 'image' : 'unsupported',
          body: stripRefCode(rawBody),
          refCode: extractRefCode(rawBody),
          profileName,
          timestampSec: Number(asString(msg.timestamp) ?? '0') || 0,
        })
      }
    }
  }
  return out
}

/**
 * A delivery receipt for a message WE sent — the ticks in `/admin`.
 *
 * Meta reports the lifecycle out of band from the message itself: `sent` when
 * it reaches WhatsApp's servers, `delivered` when it reaches the handset, and
 * `read` when the shopper opens the chat (only if they have read receipts on —
 * a `read` that never arrives means the setting is off, not that the message
 * was missed). `failed` carries an error we want in front of the operator.
 */
export interface StatusUpdate {
  /** The `wamid.*` of OUR outbound message, matching `wa_messages.wa_message_id`. */
  waMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  /** Meta's `timestamp`, seconds since epoch. 0 when absent. */
  timestampSec: number
  /** First error title/detail on a `failed`, else null. */
  error: string | null
}

/** Only these four move a tick. Anything else Meta adds later is skipped. */
const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed'])

/**
 * Flatten `entry[].changes[].value.statuses[]` into delivery receipts.
 *
 * Same hand-narrowing posture as {@link parseInboundMessages}: this is Meta's
 * envelope, so anything unrecognised is dropped rather than thrown on. Meta
 * also re-sends receipts and delivers them out of order, so the caller must
 * treat these as idempotent and never regress a status — see
 * `services/whatsappInbox.ts#applyStatusUpdate`.
 */
export function parseStatusUpdates(payload: unknown): StatusUpdate[] {
  const root = asRecord(payload)
  if (!root) return []

  const out: StatusUpdate[] = []
  for (const entry of asArray(root.entry)) {
    for (const change of asArray(asRecord(entry)?.changes)) {
      const value = asRecord(asRecord(change)?.value)
      if (!value) continue

      for (const status of asArray(value.statuses)) {
        const rec = asRecord(status)
        if (!rec) continue
        const waMessageId = asString(rec.id)
        const name = asString(rec.status)
        if (!waMessageId || !name || !KNOWN_STATUSES.has(name)) continue

        // `errors[0]` is where a failure says why. Both fields are optional and
        // Meta has shipped each of them alone, so join whichever exist.
        const firstError = asRecord(asArray(rec.errors)[0])
        const errorText = firstError
          ? [
              asString(firstError.title),
              asString(firstError.message) ?? asString(asRecord(firstError.error_data)?.details),
            ]
              .filter(Boolean)
              .join(' — ') || null
          : null

        out.push({
          waMessageId,
          status: name as StatusUpdate['status'],
          timestampSec: Number(asString(rec.timestamp) ?? '0') || 0,
          error: errorText,
        })
      }
    }
  }
  return out
}

/** The free-form service window Meta opens when a customer messages first. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Can we still reply with free text, or does it have to be an approved template?
 *
 * This is the difference between ₹0 and a per-message fee, and between "reply"
 * and "reply is impossible right now" — inside the window Meta allows arbitrary
 * text; outside it, only a template, and this codebase's templates are for
 * order events, not conversation. `/admin` must show the answer rather than let
 * an operator type into a box that will 400.
 */
export function windowOpen(lastInboundAt: Date | null, now: number = Date.now()): boolean {
  if (!lastInboundAt) return false
  return now - lastInboundAt.getTime() < SERVICE_WINDOW_MS
}
