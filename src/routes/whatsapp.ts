/**
 * /v1/whatsapp — inbound WhatsApp webhook (TASK-04 phase 1).
 *
 * Two public routes and nothing else public:
 *   GET  /webhook  Meta's one-time subscription challenge
 *   POST /webhook  every inbound message and delivery receipt, HMAC-verified
 *                  before it is parsed
 *
 * **The security posture, stated once.** A WhatsApp number resolves directly to
 * a Tiny Tales account, because accounts are Firebase phone-auth. An unverified
 * POST naming someone else's number would therefore be a way to read their
 * cart, orders and address book. So: verify `X-Hub-Signature-256` over the RAW
 * body, on every request, before parsing — and when it fails, answer 403 and
 * write nothing. There is no trusted-source bypass and no dev shortcut.
 *
 * **Unconfigured is CLOSED, not degraded.** With no app secret the POST route
 * answers 503 rather than accepting unverified traffic. That is the opposite of
 * the Razorpay/Delhivery posture elsewhere in this codebase, and deliberately:
 * a missing outbound credential means a message does not go out, while a missing
 * inbound secret would mean anyone can impersonate any shopper.
 *
 * **No AI in this file.** Phase 1 is plumbing plus a human inbox on purpose —
 * the transcripts it collects are what the phase-2 system prompt is written
 * against. The only automated outbound is a deterministic render of the
 * in-stock catalog (`lib/whatsapp/autoReply.ts`), not an answer to what the
 * shopper actually asked — rate-limited by {@link autoReplyDue}, which yields
 * the thread to a human operator for a day but answers a returning shopper in
 * minutes, and a fresh site-button tap within hours.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ErrorEnvelopeSchema,
  WaConversationListQuerySchema,
  WaConversationListSchema,
  WaConversationParamsSchema,
  WaConversationThreadSchema,
  WaDeviceBodySchema,
  WaDeviceResponseSchema,
  WaReplyBodySchema,
  WaReplyResponseSchema,
  WaStatusBodySchema,
  WebhookChallengeSchema,
  WebhookVerifyQuerySchema,
} from '../contracts/whatsapp.js'
import type { Db } from '../db/client.js'
import { conflict, forbidden, notFound, validationFailed } from '../lib/errors.js'
import type { AdminPushSender } from '../lib/notify/adminPush.js'
import { createWhatsAppCloudChannel, sendSessionText } from '../lib/notify/whatsappCloud.js'
import { buildCatalogAutoReply, FALLBACK_AUTO_REPLY } from '../lib/whatsapp/autoReply.js'
import {
  FOLLOW_UP_LOCALE_KEY,
  FOLLOW_UP_TEMPLATE_KEY,
  followUpParam,
  renderFollowUp,
} from '../lib/whatsapp/followUp.js'
import {
  parseInboundMessages,
  parseStatusUpdates,
  verifySignature,
  windowOpen,
} from '../lib/whatsapp/inbound.js'
import {
  adminTokens,
  pruneSupersededDevices,
  pruneTokens,
  registerDevice,
  unregisterDevice,
} from '../services/adminPushDevices.js'
import { getCatalogSnapshot } from '../services/catalogRead.js'
import { getConfigValues } from '../services/config.js'
import {
  applyStatusUpdate,
  countAnonymous,
  countWaiting,
  getConversation,
  lastDeliveredOutbound,
  listConversations,
  recordInboundMessage,
  recordOutboundMessage,
  setConversationStatus,
} from '../services/whatsappInbox.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Credentials the webhook needs. All optional — absent closes the route. */
export interface WhatsAppInboundConfig {
  /** Meta app secret, for `X-Hub-Signature-256`. Absent ⇒ POST /webhook is 503. */
  appSecret?: string | undefined
  /** The token echoed back during Meta's GET subscription challenge. */
  verifyToken?: string | undefined
  /** WABA phone number id — needed to REPLY, not to receive. */
  phoneNumberId?: string | undefined
  /** System User access token — needed to REPLY, not to receive. */
  accessToken?: string | undefined
}

export interface WhatsAppRoutesOptions {
  db: Db
  config: WhatsAppInboundConfig
  /** Injected in tests. */
  fetchImpl?: typeof fetch | undefined
  /**
   * Override the first-contact auto-reply with a fixed string. Unset (the
   * normal case) means the body is rendered from the live catalog by
   * `lib/whatsapp/autoReply.ts`. Set to '' to disable the auto-reply entirely
   * and leave every reply to a human.
   */
  autoReplyText?: string | undefined
  /**
   * Sends "a customer messaged you" to the admins' browsers. Absent means no
   * push is attempted at all — the inbox still works, nobody is told.
   */
  pushSender?: AdminPushSender | undefined
  /** Origin the notification's tap-through link is built against. */
  adminBaseUrl?: string | undefined
}

/**
 * The auto-reply is cached for a few minutes rather than rebuilt per message.
 *
 * It is three catalog queries, it fires once per NEW thread, and a burst of
 * first-contacts is exactly the moment the DB should not take three extra
 * round-trips per shopper. Minutes of staleness is the right trade: a price
 * change reaches WhatsApp a little after it reaches the site, and the site is
 * where the order is actually placed.
 */
const AUTO_REPLY_TTL_MS = 5 * 60_000

/**
 * How long a HUMAN reply owns the thread.
 *
 * Once an operator has answered, the shopper is talking to a person, and an
 * automated price list landing in the middle of that is worse than no reply at
 * all — it reads as the person having been a bot the whole time. A day of quiet
 * matches the free-form service window: past it we could not send this text
 * without a template anyway, so the thread is effectively new.
 */
const HUMAN_HANDOVER_MS = 24 * 60 * 60_000

/**
 * How long a human reply owns the thread against a SITE-BUTTON message.
 *
 * A ref-coded message is not the shopper continuing yesterday's conversation —
 * they were on the storefront, tapped the chat button, and sent the "what
 * products do you have available?" prefill. Holding that for a full day because
 * an operator typed once the previous afternoon is the prod failure of
 * 2026-09-03: four site-button taps, no reply, the human-owns window swallowing
 * all of them. Three hours is long enough that an operator mid-conversation is
 * never talked over, and short enough that a fresh tap is answered while the
 * shopper is still on the site.
 */
const SITE_BUTTON_HANDOVER_MS = 3 * 60 * 60_000

/**
 * How long the bot's OWN last word suppresses the next one.
 *
 * Short on purpose. This gate exists to stop a shopper who sends "hi", their
 * PIN code and a photo in one breath from getting three identical price lists —
 * not to stop them from getting an answer. The first cut of this used the same
 * 24 hours as the human window, and the result was a shopper tapping the site
 * button at 06:00, after a single automated message at 05:17, hearing nothing:
 * the site advertises a chat that then ignores them, which is exactly the
 * failure the feature was built to remove.
 */
const AUTO_REPLY_COOLDOWN_MS = 15 * 60_000

/**
 * How long a site-button tap suppresses the next one.
 *
 * A message carrying a ref code came from the storefront button with "what
 * products do you have available?" already typed into it. That is not chatter,
 * it is the shopper asking the one question this reply answers, so it clears
 * the cooldown down to a flood guard.
 */
const SITE_BUTTON_COOLDOWN_MS = 60_000

/**
 * Is an automated reply owed on this thread?
 *
 * Reads the last DELIVERED outbound, not `last_outbound_at` alone: a failed
 * send moves nothing, so a shopper we could not reach stays owed an answer
 * instead of being marked handled.
 */
function autoReplyDue(
  lastOutbound: { at: Date; byHuman: boolean } | null,
  fromSiteButton: boolean
): boolean {
  if (!lastOutbound) return true
  const elapsed = Date.now() - lastOutbound.at.getTime()
  if (lastOutbound.byHuman) {
    return elapsed >= (fromSiteButton ? SITE_BUTTON_HANDOVER_MS : HUMAN_HANDOVER_MS)
  }
  return elapsed >= (fromSiteButton ? SITE_BUTTON_COOLDOWN_MS : AUTO_REPLY_COOLDOWN_MS)
}

/**
 * Build the "send a free-form message and record it either way" function.
 *
 * Module-level and shared by both plugins below so that a message and its
 * transcript row are written by ONE code path. The failure being avoided is an
 * operator's reply going out with no row, or appearing in the transcript having
 * never gone out.
 */
function makeReplyDeliverer(
  db: Db,
  config: WhatsAppInboundConfig,
  fetchImpl: typeof fetch | undefined
) {
  return async function deliverReply(
    conversationId: string,
    waPhone: string,
    body: string,
    sentBy: string | undefined,
    log: { error: (obj: object, msg: string) => void }
  ) {
    if (!config.phoneNumberId || !config.accessToken) {
      const error = 'WhatsApp send credentials are not configured'
      log.error({ conversationId }, error)
      return recordOutboundMessage(db, { conversationId, body, status: 'failed', error, sentBy })
    }

    const result = await sendSessionText(
      { phoneNumberId: config.phoneNumberId, accessToken: config.accessToken },
      waPhone,
      body,
      fetchImpl
    )
    if (!result.ok) {
      log.error({ conversationId, error: result.error }, 'WhatsApp reply failed')
    }
    return recordOutboundMessage(db, {
      conversationId,
      body,
      status: result.ok ? 'sent' : 'failed',
      waMessageId: result.ok ? result.providerMessageId : undefined,
      error: result.ok ? undefined : result.error,
      sentBy,
    })
  }
}

export const whatsappRoutes: FastifyPluginAsyncZod<WhatsAppRoutesOptions> = async (
  app,
  { db, config, fetchImpl, autoReplyText, pushSender, adminBaseUrl }
) => {
  const deliverReply = makeReplyDeliverer(db, config, fetchImpl)

  /**
   * Tell the admins' browsers that a customer wrote in.
   *
   * Swallows everything. A push is a courtesy on top of a message that is
   * already stored and already auto-answered — letting FCM being down turn into
   * a 500 would make Meta retry the whole envelope and, worse, look like the
   * webhook is broken when the only thing that failed was the doorbell.
   */
  async function notifyAdmins(
    conversation: { id: string; waPhone: string; profileName: string | null },
    message: { body: string; msgType: string },
    log: { error: (obj: object, msg: string) => void }
  ): Promise<void> {
    if (!pushSender) return
    try {
      const tokens = await adminTokens(db)
      if (tokens.length === 0) return

      // A media message has no body worth showing, so name the kind instead of
      // sending an empty notification the operator cannot act on.
      const preview =
        message.body.trim() !== ''
          ? message.body.trim().slice(0, 140)
          : `Sent ${message.msgType === 'image' ? 'a photo' : 'a message'}`

      const { staleTokens } = await pushSender(tokens, {
        title: conversation.profileName?.trim() || `+${conversation.waPhone}`,
        body: preview,
        // Trailing slash is load-bearing: the shop is a Next static export
        // built with `trailingSlash: true`, so /admin/whatsapp bounces through
        // a redirect the notification tap does not need.
        link: `${adminBaseUrl ?? ''}/admin/whatsapp/?thread=${conversation.id}`,
      })
      await pruneTokens(db, staleTokens)
    } catch (err) {
      log.error({ err, conversationId: conversation.id }, 'could not push the inbox alert')
    }
  }

  /** Per-plugin cache of the rendered price list. */
  let cached: { body: string; builtAtMs: number } | null = null

  /**
   * The body of the first-contact auto-reply: the in-stock price list.
   *
   * Falls back to the fixed "a human will reply" text on any catalog failure —
   * the shopper hearing nothing at all is the one outcome worth protecting
   * against, so a broken catalog degrades the message rather than the channel.
   */
  async function autoReplyBody(log: { error: (obj: object, msg: string) => void }): Promise<string> {
    if (autoReplyText !== undefined) return autoReplyText
    const now = Date.now()
    if (cached && now - cached.builtAtMs < AUTO_REPLY_TTL_MS) return cached.body
    try {
      const body = buildCatalogAutoReply(await getCatalogSnapshot(db))
      // Only a successful build is cached: a transient DB blip must not pin the
      // holding message in front of every shopper for the next five minutes.
      cached = { body, builtAtMs: now }
      return body
    } catch (err) {
      log.error({ err }, 'could not build catalog auto-reply; falling back to the holding message')
      return FALLBACK_AUTO_REPLY
    }
  }

  /**
   * Meta's subscription handshake: it GETs this URL once with a token we chose,
   * and expects `hub.challenge` echoed back as a bare string.
   *
   * The reply is `text/plain` and unwrapped — Meta compares the body verbatim,
   * so a JSON envelope fails the subscription with no useful error.
   */
  app.get(
    '/webhook',
    {
      schema: {
        querystring: WebhookVerifyQuerySchema,
        response: { 200: WebhookChallengeSchema, '4xx': ErrorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const mode = request.query['hub.mode']
      const token = request.query['hub.verify_token']
      const challenge = request.query['hub.challenge']

      if (!config.verifyToken) throw forbidden('WhatsApp webhook is not configured')
      if (mode !== 'subscribe' || token !== config.verifyToken) {
        throw forbidden('WhatsApp webhook verification failed')
      }
      return reply.type('text/plain').send(challenge ?? '')
    }
  )

  // Raw-body scope, matching the Razorpay webhook: the HMAC is over the exact
  // bytes Meta sent, and any re-serialisation changes key order and whitespace
  // enough to break a digest that was otherwise fine.
  app.register(async (hook) => {
    hook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body)
    )

    hook.post('/webhook', async (request, reply) => {
      if (!config.appSecret) {
        // Closed, not degraded — see the module docstring.
        return reply.code(503).send({
          error: { code: 'whatsapp_disabled', message: 'WhatsApp webhook is not configured' },
        })
      }

      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from((request.body as string | undefined) ?? '')
      const signature = request.headers['x-hub-signature-256']

      if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, config.appSecret)) {
        // Deliberately terse and unlogged-at-error: a bad signature is an
        // internet fact, not an incident, and logging every probe at error
        // level would bury the ones that matter.
        request.log.warn({ path: '/v1/whatsapp/webhook' }, 'rejected webhook with bad signature')
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'Signature verification failed' },
        })
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody.toString('utf8'))
      } catch {
        // Signed but unparseable. 200 anyway: Meta retries a non-200, and no
        // number of retries will make this body parse.
        request.log.warn('signed webhook body was not JSON')
        return reply.code(200).send({ ok: true })
      }

      for (const message of parseInboundMessages(payload)) {
        try {
          const { conversation, duplicate } = await recordInboundMessage(db, message)
          // A Meta retry of a message we already stored. Storing was idempotent;
          // replying would not be.
          if (duplicate) continue

          // `message.refCode` rather than `conversation.refCode`: the stored one
          // COALESCEs to the FIRST code ever seen, so it says nothing about
          // whether THIS message came from the site button.
          const dueNow =
            autoReplyText !== '' &&
            autoReplyDue(await lastDeliveredOutbound(db, conversation.id), message.refCode !== null)

          if (dueNow) {
            const replyText = await autoReplyBody(request.log)
            if (replyText) {
              await deliverReply(conversation.id, conversation.waPhone, replyText, undefined, request.log)
            }
          }

          // Alert the operator LAST and never let it break the batch: the
          // shopper's message is already stored and answered by this point, and
          // a notification failing is a worse day than a lost one — the inbox
          // still holds the message either way.
          await notifyAdmins(conversation, message, request.log)
        } catch (err) {
          // One bad message must not fail the batch — the rest are other
          // people's conversations. Meta would retry the whole envelope, and
          // the messages that DID land would be deduped on the second pass.
          request.log.error({ err, waMessageId: message.waMessageId }, 'could not record inbound WhatsApp message')
        }
      }

      // Delivery receipts for messages WE sent — what `/admin` draws its ticks
      // from. Handled after the inbound loop and never allowed to fail the
      // request: a lost receipt costs a tick, a 500 costs the whole envelope.
      for (const update of parseStatusUpdates(payload)) {
        try {
          await applyStatusUpdate(db, update)
        } catch (err) {
          request.log.error({ err, waMessageId: update.waMessageId }, 'could not apply WhatsApp status receipt')
        }
      }

      // Always 200 on a verified request. A non-200 makes Meta retry, and
      // repeated failures degrade the webhook subscription itself.
      return reply.code(200).send({ ok: true })
    })
  })

}

export interface WhatsAppAdminRoutesOptions {
  db: Db
  config: WhatsAppInboundConfig
  fetchImpl?: typeof fetch | undefined
}

/**
 * /v1/admin/whatsapp — the human inbox.
 *
 * Registered separately from the webhook because the two have opposite gates:
 * the webhook is public and authenticates the CALLER by HMAC, while everything
 * here is `authenticate` + `requireAdmin`. Keeping them in one plugin would put
 * an unauthenticated route inside an admin-hooked scope, which is exactly the
 * mistake that is invisible until it is exploited.
 */
export const whatsappAdminRoutes: FastifyPluginAsyncZod<WhatsAppAdminRoutesOptions> = async (
  app,
  { db, config, fetchImpl }
) => {
  const deliverReply = makeReplyDeliverer(db, config, fetchImpl)
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  /**
   * Register this browser for "a customer messaged you" notifications.
   *
   * Idempotent by design — the browser calls it on every load of the inbox,
   * because FCM rotates a registration token whenever it feels like it and the
   * only reliable moment to learn the current one is when the page is open.
   */
  app.post(
    '/devices',
    {
      schema: {
        body: WaDeviceBodySchema,
        response: { 200: WaDeviceResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const label = request.body.label ?? ''
      await registerDevice(db, {
        userId: request.user.id,
        token: request.body.token,
        label,
      })
      // Reinstalling a home-screen web app mints a new token and abandons the
      // old one, which stays valid at FCM for weeks — long enough to double
      // every alert. Same person, same label, older token: it is a ghost.
      await pruneSupersededDevices(db, { userId: request.user.id, token: request.body.token, label })
      return { ok: true, label }
    }
  )

  /** Turn notifications off for this browser. */
  app.delete(
    '/devices',
    {
      schema: {
        body: WaDeviceBodySchema,
        response: { 200: WaDeviceResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      await unregisterDevice(db, request.body.token)
      return { ok: true, label: request.body.label ?? '' }
    }
  )

  app.get(
    '/conversations',
    {
      schema: {
        querystring: WaConversationListQuerySchema,
        response: { 200: WaConversationListSchema, ...errorResponses },
      },
    },
    async (request) => ({
      conversations: await listConversations(db, {
        status: request.query.status,
        limit: request.query.limit,
      }),
      waiting: await countWaiting(db),
      anonymous: await countAnonymous(db),
    })
  )

  app.get(
    '/conversations/:id',
    {
      schema: {
        params: WaConversationParamsSchema,
        response: { 200: WaConversationThreadSchema, ...errorResponses },
      },
    },
    async (request) => {
      const thread = await getConversation(db, request.params.id)
      if (!thread) throw notFound('Conversation not found')
      return thread
    }
  )

  /**
   * Reply inside the 24-hour service window.
   *
   * The window is checked HERE, before the send, rather than left to Meta's
   * 131047. An operator typing a careful answer into a closed thread should
   * be told before they send it, not after — and a rejected send would still
   * have written a `failed` row that reads like a bug.
   */
  app.post(
    '/conversations/:id/reply',
    {
      schema: {
        params: WaConversationParamsSchema,
        body: WaReplyBodySchema,
        response: { 200: WaReplyResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const thread = await getConversation(db, request.params.id)
      if (!thread) throw notFound('Conversation not found')
      if (!windowOpen(thread.lastInboundAt ? new Date(thread.lastInboundAt) : null)) {
        throw validationFailed(
          'The 24-hour reply window has closed. Only an approved template can be sent now.'
        )
      }

      const message = await deliverReply(
        thread.id,
        thread.waPhone,
        request.body.body,
        request.user.id,
        request.log
      )
      return {
        ok: message.status === 'sent',
        message: {
          id: message.id,
          direction: message.direction,
          msgType: message.msgType,
          body: message.body,
          status: message.status,
          error: message.error,
          createdAt: message.createdAt.toISOString(),
        },
      }
    }
  )

  /**
   * Send the approved follow-up template into a thread whose window has shut.
   *
   * The mirror image of the reply route above: that one refuses once the
   * 24-hour window closes, this one refuses while it is still OPEN. Both
   * directions matter. A template sent into a live window is a paid MARKETING
   * message that says less than the free-form reply the operator could have
   * typed instead, and Meta counts it against the number's quality rating all
   * the same.
   *
   * Deliberately takes no request body. The wording is fixed by the Meta
   * approval — `FOLLOW_UP_BODY` is the copy of it we render the transcript
   * from — and an operator-supplied string would be silently discarded by the
   * Graph API, producing a transcript row that quotes a message nobody
   * received.
   */
  app.post(
    '/conversations/:id/follow-up',
    {
      schema: {
        params: WaConversationParamsSchema,
        response: { 200: WaReplyResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const thread = await getConversation(db, request.params.id)
      if (!thread) throw notFound('Conversation not found')

      if (thread.windowOpen) {
        throw validationFailed(
          'The 24-hour window is still open — reply normally instead. A template costs money and says less.'
        )
      }

      // Nothing to reopen. A thread that has never received an inbound message
      // is one WE started, and templating at it is a cold contact rather than a
      // follow-up.
      if (!thread.lastInboundAt) {
        throw validationFailed('This shopper has never messaged in, so there is nothing to follow up on.')
      }

      // One follow-up per shopper message, enforced on `msgType` rather than on
      // the body text — see `recordOutboundMessage`. The shopper is under no
      // obligation to answer, and a second unsolicited template because the
      // first went unanswered is the exact behaviour that gets a number
      // rate-limited by Meta.
      const inboundAt = Date.parse(thread.lastInboundAt)
      const alreadySent = thread.messages.some(
        (message) =>
          message.direction === 'outbound' &&
          message.msgType === 'template' &&
          message.status !== 'failed' &&
          Date.parse(message.createdAt) > inboundAt
      )
      if (alreadySent) {
        throw conflict(
          'A follow-up has already been sent since this shopper last wrote. Wait for them to reply.'
        )
      }

      // Template name and locale are resolved at send time from config, not
      // frozen at boot, for the same reason `NotificationTemplate` is resolved
      // per-send: a wrong name fails every attempt, and an operator must be
      // able to correct it without a redeploy.
      const values = await getConfigValues(db, [FOLLOW_UP_TEMPLATE_KEY, FOLLOW_UP_LOCALE_KEY])
      const templateName = values.get(FOLLOW_UP_TEMPLATE_KEY)
      const templateLocale = values.get(FOLLOW_UP_LOCALE_KEY)
      if (typeof templateName !== 'string' || templateName.length === 0) {
        throw validationFailed(
          `No follow-up template is configured. Set ${FOLLOW_UP_TEMPLATE_KEY} once Meta approves it.`
        )
      }
      if (!config.phoneNumberId || !config.accessToken) {
        throw validationFailed('WhatsApp send credentials are not configured')
      }

      const body = renderFollowUp(thread.profileName)
      const channel = createWhatsAppCloudChannel(
        {
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          templateName,
          templateLocale: typeof templateLocale === 'string' ? templateLocale : 'en',
        },
        fetchImpl
      )
      const result = await channel.send(thread.waPhone, {
        params: [followUpParam(thread.profileName)],
      })
      if (!result.ok) {
        request.log.error(
          { conversationId: thread.id, error: result.error },
          'WhatsApp follow-up template failed'
        )
      }

      // Recorded either way, exactly as `deliverReply` does: a send that failed
      // still happened, and an operator who cannot see the attempt will make it
      // again.
      const message = await recordOutboundMessage(db, {
        conversationId: thread.id,
        body,
        msgType: 'template',
        status: result.ok ? 'sent' : 'failed',
        waMessageId: result.ok ? result.providerMessageId : undefined,
        error: result.ok ? undefined : result.error,
        sentBy: request.user.id,
      })

      return {
        ok: message.status === 'sent',
        message: {
          id: message.id,
          direction: message.direction,
          msgType: message.msgType,
          body: message.body,
          status: message.status,
          error: message.error,
          createdAt: message.createdAt.toISOString(),
        },
      }
    }
  )

  app.post(
    '/conversations/:id/status',
    {
      schema: {
        params: WaConversationParamsSchema,
        body: WaStatusBodySchema,
        response: { 200: WaConversationThreadSchema, ...errorResponses },
      },
    },
    async (request) => {
      const updated = await setConversationStatus(db, request.params.id, request.body.status)
      if (!updated) throw notFound('Conversation not found')
      const thread = await getConversation(db, request.params.id)
      if (!thread) throw notFound('Conversation not found')
      return thread
    }
  )
}
