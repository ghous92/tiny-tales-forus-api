/**
 * Zod contracts for the WhatsApp inbox — request validation AND response types.
 * Imports only `zod`, same rule as the other contract modules.
 *
 * Endpoints (see routes/whatsapp.ts):
 *   GET  /v1/whatsapp/webhook                    public — Meta's subscription challenge
 *   POST /v1/whatsapp/webhook                    public — HMAC-verified inbound
 *   GET  /v1/admin/whatsapp/conversations        admin  — inbox list
 *   GET  /v1/admin/whatsapp/conversations/:id    admin  — one thread
 *   POST /v1/admin/whatsapp/conversations/:id/reply   admin — free-form reply
 *   POST /v1/admin/whatsapp/conversations/:id/status  admin — open/close
 *
 * There is deliberately NO contract for the inbound payload itself. That
 * envelope belongs to Meta, who add fields without notice, so it is
 * hand-narrowed in `lib/whatsapp/inbound.ts` — a strict schema on someone
 * else's evolving shape fails closed on a payload that was merely new.
 */

import { z } from 'zod'

/**
 * Meta's subscription handshake. The querystring is `hub.mode` /
 * `hub.verify_token` / `hub.challenge` — dotted names, so they are quoted keys
 * rather than identifiers.
 */
export const WebhookVerifyQuerySchema = z.object({
  'hub.mode': z.string().optional(),
  'hub.verify_token': z.string().optional(),
  'hub.challenge': z.string().optional(),
})

/**
 * The challenge echo is a BARE STRING, not JSON. Meta compares the response
 * body verbatim during subscription, so wrapping it in an envelope fails the
 * handshake with no useful error on either side.
 */
export const WebhookChallengeSchema = z.string()

const conversationBase = {
  id: z.string(),
  waPhone: z.string(),
  profileName: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  refCode: z.string().nullable(),
  status: z.string(),
  lastInboundAt: z.string().nullable(),
  lastOutboundAt: z.string().nullable(),
  unreadCount: z.int(),
  /** False once 24h have passed since the last inbound — only a template can go then. */
  windowOpen: z.boolean(),
  createdAt: z.string(),
}

export const WaConversationSummarySchema = z.object({
  ...conversationBase,
  lastMessage: z.string(),
})

export const WaConversationListSchema = z.object({
  conversations: z.array(WaConversationSummarySchema),
  /** Open threads with an unanswered inbound — the nav badge. */
  waiting: z.int(),
  /** Threads from numbers with no Tiny Tales account. */
  anonymous: z.int(),
})

export const WaMessageSchema = z.object({
  id: z.string(),
  direction: z.string(),
  msgType: z.string(),
  body: z.string(),
  status: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
})

export const WaConversationThreadSchema = z.object({
  ...conversationBase,
  messages: z.array(WaMessageSchema),
})

export const WaConversationParamsSchema = z.strictObject({ id: z.uuid() })

export const WaConversationListQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/**
 * A human reply. Capped at 4096 characters because that is WhatsApp's own text
 * limit — rejecting here gives the operator a message instead of a 400 from
 * Meta after the row was already written.
 */
export const WaReplyBodySchema = z.strictObject({
  body: z.string().min(1, 'Message is required').max(4096, 'WhatsApp messages cap at 4096 characters'),
})

export const WaStatusBodySchema = z.strictObject({ status: z.enum(['open', 'closed']) })

export const WaReplyResponseSchema = z.object({
  ok: z.boolean(),
  message: WaMessageSchema,
})

/**
 * Registering a browser for push.
 *
 * The token is opaque and long (FCM tokens run past 150 characters and the
 * format is not contractual), so this bounds it rather than pattern-matching
 * it. `label` is what the admin sees in their device list.
 */
export const WaDeviceBodySchema = z.strictObject({
  token: z.string().min(20, 'Not a push token').max(4096),
  label: z.string().max(64).optional(),
})

export const WaDeviceResponseSchema = z.object({
  ok: z.boolean(),
  /** Echoed so the browser can confirm the row it now owns. */
  label: z.string(),
})

export type WaDeviceBody = z.infer<typeof WaDeviceBodySchema>

export type WebhookVerifyQuery = z.infer<typeof WebhookVerifyQuerySchema>
export type WaConversationSummary = z.infer<typeof WaConversationSummarySchema>
export type WaConversationList = z.infer<typeof WaConversationListSchema>
export type WaConversationThread = z.infer<typeof WaConversationThreadSchema>
export type WaConversationParams = z.infer<typeof WaConversationParamsSchema>
export type WaConversationListQuery = z.infer<typeof WaConversationListQuerySchema>
export type WaReplyBody = z.infer<typeof WaReplyBodySchema>
export type WaStatusBody = z.infer<typeof WaStatusBodySchema>

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
