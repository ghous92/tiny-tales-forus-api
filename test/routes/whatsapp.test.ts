/**
 * Route tests: `/v1/whatsapp/webhook` (public, HMAC-gated) and
 * `/v1/admin/whatsapp` (the human inbox).
 *
 * The webhook cases carry the weight here. It is the only public endpoint in
 * this codebase that turns an unauthenticated request into a lookup of a real
 * shopper's account, so "rejects a forged payload" and "is idempotent under
 * Meta's retries" are correctness requirements, not edge cases.
 */

import { createHmac } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { adminPushDevices, appConfig, users, waConversations, waMessages } from '../../src/db/schema.js'
import type { AdminPushMessage, AdminPushSender } from '../../src/lib/notify/adminPush.js'
import { FOLLOW_UP_BODY } from '../../src/lib/whatsapp/followUp.js'
import { auth, createTestApp, promoteToAdmin, USER_A, USER_ADMIN, type TestContext } from '../helpers/app.js'

const APP_SECRET = 'test-app-secret'
const VERIFY_TOKEN = 'test-verify-token'
const SHOPPER = '919876543210'

let ctx: TestContext
/** Bodies the fake Graph API was asked to send. */
let sends: Array<Record<string, unknown>>
/**
 * Set to make the next sends fail the way Meta actually fails them: HTTP 200
 * carrying an `error` body. Left undefined for the happy path.
 */
let graphFailure: { error: { message: string } } | undefined

function graphFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    sends.push(JSON.parse(String(init?.body ?? '{}')))
    if (graphFailure) {
      return new Response(JSON.stringify(graphFailure), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // A DISTINCT id per send, because Meta mints one per message and
    // `wa_messages.wa_message_id` is unique across both directions. A fake that
    // returned a constant would collide on the second outbound and fail a route
    // that is actually fine.
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function makeApp(
  options: { configured?: boolean; canSend?: boolean; pushSender?: AdminPushSender } = {}
) {
  const { configured = true, canSend = true } = options
  sends = []
  graphFailure = undefined
  ctx = await createTestApp({
    ...(configured ? { whatsappInbound: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } } : {}),
    ...(canSend ? { whatsapp: { phoneNumberId: 'pnid', accessToken: 'token' } } : {}),
    whatsappFetch: graphFetch(),
    ...(options.pushSender ? { adminPushSender: options.pushSender } : {}),
  })
}

/** Meta's envelope for one inbound text message. */
function inboundBody(overrides: { id?: string; from?: string; text?: string; name?: string } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: overrides.name ?? 'Priya' } }],
              messages: [
                {
                  id: overrides.id ?? 'wamid.IN1',
                  from: overrides.from ?? SHOPPER,
                  type: 'text',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: overrides.text ?? 'Do you deliver to 380015? [LNY-4F2A9C]' },
                },
              ],
            },
          },
        ],
      },
    ],
  })
}

function post(body: string, signature?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    payload: body,
  })
}

function sign(body: string, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
}

afterEach(async () => {
  await ctx.app.close()
})

describe('GET /v1/whatsapp/webhook (Meta subscription challenge)', () => {
  beforeEach(async () => {
    await makeApp()
  })

  it('echoes the challenge as a BARE string when the token matches', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=42',
    })
    expect(res.statusCode).toBe(200)
    // Not `{"challenge":"42"}` — Meta compares the body verbatim.
    expect(res.body).toBe('42')
  })

  it('403s on a wrong verify token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=42',
    })
    expect(res.statusCode).toBe(403)
  })

  it('403s when the mode is not subscribe', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=42',
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /v1/whatsapp/webhook — the signature gate', () => {
  it('403s and stores NOTHING on a forged payload', async () => {
    await makeApp()
    const body = inboundBody()
    const res = await post(body, sign(body, 'attacker-secret'))
    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })

  it('403s when the signature header is missing entirely', async () => {
    await makeApp()
    const res = await post(inboundBody())
    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })

  // The attack this endpoint exists to refuse: a number belongs to a real
  // account, so an unsigned body naming it must not create a thread that a
  // later reply would deliver to that person.
  it('403s on a valid body signed for DIFFERENT content', async () => {
    await makeApp()
    const signature = sign(inboundBody({ text: 'hello' }))
    const res = await post(inboundBody({ text: 'refund my order' }), signature)
    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })

  // Closed, not degraded — the opposite of the Razorpay/Delhivery posture, and
  // deliberately so.
  it('503s and accepts nothing when no app secret is configured', async () => {
    await makeApp({ configured: false })
    const body = inboundBody()
    const res = await post(body, sign(body))
    expect(res.statusCode).toBe(503)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })
})

describe('POST /v1/whatsapp/webhook — recording', () => {
  beforeEach(async () => {
    await makeApp()
  })

  it('creates a thread, strips the ref code, and keeps the code for attribution', async () => {
    const body = inboundBody()
    const res = await post(body, sign(body))
    expect(res.statusCode).toBe(200)

    const [conversation] = await ctx.db.select().from(waConversations)
    expect(conversation).toMatchObject({
      waPhone: SHOPPER,
      profileName: 'Priya',
      refCode: 'LNY-4F2A9C',
      status: 'open',
      // Zero, not one: the auto-reply below answered it in the same request.
      unreadCount: 0,
    })
    // No account exists for this number in a fresh test DB — a stranger is the
    // normal first contact, not an error.
    expect(conversation?.userId).toBeNull()

    const inbound = await ctx.db
      .select()
      .from(waMessages)
      .where(eq(waMessages.direction, 'inbound'))
    expect(inbound[0]?.body).toBe('Do you deliver to 380015?')
  })

  it('sends the first-contact auto-reply once and records it', async () => {
    const body = inboundBody()
    await post(body, sign(body))

    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ to: SHOPPER, type: 'text' })

    const outbound = await ctx.db
      .select()
      .from(waMessages)
      .where(eq(waMessages.direction, 'outbound'))
    expect(outbound).toHaveLength(1)
    expect(outbound[0]?.status).toBe('sent')
    expect(outbound[0]?.waMessageId).toBe('wamid.OUT1')
  })

  // Meta retries any webhook it did not get a 200 for. Without the unique
  // constraint + ON CONFLICT DO NOTHING, a retry storm becomes a message storm
  // at the shopper's end.
  it('is idempotent: a replayed message adds no row and sends no second reply', async () => {
    const body = inboundBody()
    await post(body, sign(body))
    const res = await post(body, sign(body))

    expect(res.statusCode).toBe(200)
    expect(await ctx.db.select().from(waMessages)).toHaveLength(2) // 1 in, 1 auto-reply
    expect(sends).toHaveLength(1)
  })

  it('a second DIFFERENT message bumps unread but does not auto-reply again', async () => {
    const first = inboundBody()
    await post(first, sign(first))
    const second = inboundBody({ id: 'wamid.IN2', text: 'still there?' })
    await post(second, sign(second))

    const [conversation] = await ctx.db.select().from(waConversations)
    // The auto-reply zeroed it, then the second inbound raised it to 1.
    expect(conversation?.unreadCount).toBe(1)
    expect(sends).toHaveLength(1)
  })

  /**
   * Backdate every delivered outbound on the thread, so the cooldown can be
   * crossed without the test sleeping through it.
   */
  async function ageOutbound(minutes: number) {
    const at = new Date(Date.now() - minutes * 60_000)
    await ctx.db
      .update(waMessages)
      .set({ createdAt: at })
      .where(eq(waMessages.direction, 'outbound'))
    await ctx.db.update(waConversations).set({ lastOutboundAt: at })
  }

  // The prod failure this gate was rewritten for: one automated message at
  // 05:17, the shopper taps the site button again at 06:00, and hears nothing
  // for the rest of the day. The site advertises a chat that then ignores them.
  it('answers a site-button message again once the bot cooldown has passed', async () => {
    const first = inboundBody()
    await post(first, sign(first))
    expect(sends).toHaveLength(1)

    await ageOutbound(45)

    const second = inboundBody({
      id: 'wamid.IN2',
      text: 'Hi Laanya! Could you tell me what products you have available? [LNY-6F341R]',
    })
    await post(second, sign(second))
    expect(sends).toHaveLength(2)
  })

  // Same message, seconds later: a shopper double-tapping the button is not two
  // requests for the price list.
  it('does not answer a second site-button message inside the flood guard', async () => {
    const first = inboundBody()
    await post(first, sign(first))
    const second = inboundBody({ id: 'wamid.IN2', text: 'products? [LNY-6F341R]' })
    await post(second, sign(second))

    expect(sends).toHaveLength(1)
  })

  // An automated price list landing mid-conversation reads as the person the
  // shopper was talking to having been a bot all along.
  it('stays silent once a human has replied, however the shopper writes back', async () => {
    // An authed request upserts the operator's `users` row — `sent_by` is a FK.
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    const [operator] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, USER_ADMIN.phoneNumber))

    const first = inboundBody()
    await post(first, sign(first))
    // Attribute the thread's reply to that operator, then age it well past the
    // bot cooldown but well inside the human handover window.
    await ctx.db
      .update(waMessages)
      .set({ sentBy: operator!.id })
      .where(eq(waMessages.direction, 'outbound'))
    await ageOutbound(120)

    const second = inboundBody({ id: 'wamid.IN2', text: 'products? [LNY-6F341R]' })
    await post(second, sign(second))

    expect(sends).toHaveLength(1)
  })

  // The 2026-09-03 prod failure: an operator typed in the thread the previous
  // afternoon, the shopper came back to the site the next morning and tapped the
  // chat button four times, and the 24h human-owns window swallowed every one.
  it('answers a site-button message once the human has been quiet for hours', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    const [operator] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, USER_ADMIN.phoneNumber))

    const first = inboundBody()
    await post(first, sign(first))
    await ctx.db
      .update(waMessages)
      .set({ sentBy: operator!.id })
      .where(eq(waMessages.direction, 'outbound'))
    await ageOutbound(4 * 60)

    const second = inboundBody({
      id: 'wamid.IN2',
      text: 'Hi Laanya! Could you tell me what products you have available? [LNY-6F341R]',
    })
    await post(second, sign(second))

    expect(sends).toHaveLength(2)
  })

  // The shortened window is for the site button ONLY. A shopper typing into an
  // existing human conversation is still talking to the person, all day.
  it('keeps the full-day human window for a message with no ref code', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    const [operator] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, USER_ADMIN.phoneNumber))

    const first = inboundBody()
    await post(first, sign(first))
    await ctx.db
      .update(waMessages)
      .set({ sentBy: operator!.id })
      .where(eq(waMessages.direction, 'outbound'))
    await ageOutbound(4 * 60)

    const second = inboundBody({ id: 'wamid.IN2', text: 'any update on my order?' })
    await post(second, sign(second))

    expect(sends).toHaveLength(1)
  })

  // A send that failed reached nobody, so it can neither claim the thread nor
  // start a cooldown — the shopper is still owed an answer.
  it('keeps trying the auto-reply while every send is failing', async () => {
    await ctx.app.close()
    await makeApp({ canSend: false })

    const first = inboundBody()
    await post(first, sign(first))
    const second = inboundBody({ id: 'wamid.IN2', text: 'anyone there? [LNY-6F341R]' })
    await post(second, sign(second))

    const outbound = await ctx.db
      .select()
      .from(waMessages)
      .where(eq(waMessages.direction, 'outbound'))
    expect(outbound).toHaveLength(2)
    expect(outbound.every((row) => row.status === 'failed')).toBe(true)
  })

  it('keeps the FIRST ref code when a later message carries another', async () => {
    const first = inboundBody()
    await post(first, sign(first))
    const second = inboundBody({ id: 'wamid.IN2', text: 'and this one? [LNY-ZZZZZZ]' })
    await post(second, sign(second))

    const [conversation] = await ctx.db.select().from(waConversations)
    expect(conversation?.refCode).toBe('LNY-4F2A9C')
  })

  // The identity unlock: the phone number IS the login.
  it('resolves the thread to a Laanya account when the number matches a user', async () => {
    // Any authed request upserts USER_A, whose phone is +91…
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const digits = USER_A.phoneNumber.replace(/[^0-9]/g, '')

    const body = inboundBody({ from: digits, id: 'wamid.KNOWN' })
    await post(body, sign(body))

    const [conversation] = await ctx.db
      .select()
      .from(waConversations)
      .where(eq(waConversations.waPhone, digits))
    expect(conversation?.userId).not.toBeNull()
  })

  it('200s on a signed body that is not JSON, so Meta stops retrying it', async () => {
    const res = await post('not json', sign('not json'))
    expect(res.statusCode).toBe(200)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })

  it('records a FAILED outbound when send credentials are missing', async () => {
    await ctx.app.close()
    await makeApp({ canSend: false })
    const body = inboundBody()
    await post(body, sign(body))

    const outbound = await ctx.db
      .select()
      .from(waMessages)
      .where(eq(waMessages.direction, 'outbound'))
    expect(outbound[0]?.status).toBe('failed')
    // A failed reply must not clear the badge — nobody was answered.
    const [conversation] = await ctx.db.select().from(waConversations)
    expect(conversation?.unreadCount).toBe(1)
  })
})

describe('/v1/admin/whatsapp', () => {
  beforeEach(async () => {
    await makeApp()
    await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations',
      headers: auth(USER_ADMIN.token),
    })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  })

  const A = () => auth(USER_ADMIN.token)

  async function seedConversation() {
    const body = inboundBody()
    await post(body, sign(body))
    const [conversation] = await ctx.db.select().from(waConversations)
    return conversation!
  }

  it('401s without a token and 403s for a non-admin', async () => {
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/admin/whatsapp/conversations' })).statusCode
    ).toBe(401)
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/admin/whatsapp/conversations',
          headers: auth(USER_A.token),
        })
      ).statusCode
    ).toBe(403)
  })

  it('lists conversations with the waiting and anonymous counts', async () => {
    await seedConversation()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations',
      headers: A(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0]).toMatchObject({ waPhone: SHOPPER, windowOpen: true })
    // The auto-reply answered it, so nothing is waiting on a human.
    expect(body.waiting).toBe(0)
    expect(body.anonymous).toBe(1)
  })

  it('returns a thread in reading order', async () => {
    const conversation = await seedConversation()
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/admin/whatsapp/conversations/${conversation.id}`,
      headers: A(),
    })
    expect(res.statusCode).toBe(200)
    const messages = res.json().messages
    expect(messages[0].direction).toBe('inbound')
    expect(messages[1].direction).toBe('outbound')
  })

  it('404s for an unknown conversation', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations/00000000-0000-0000-0000-000000000000',
      headers: A(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('sends a human reply and attributes it to the admin', async () => {
    const conversation = await seedConversation()
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/whatsapp/conversations/${conversation.id}/reply`,
      headers: A(),
      payload: { body: 'Yes, we deliver to 380015 in 2 days.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ text: { body: 'Yes, we deliver to 380015 in 2 days.', preview_url: false } })

    const outbound = await ctx.db
      .select()
      .from(waMessages)
      .where(eq(waMessages.direction, 'outbound'))
    expect(outbound[1]?.sentBy).not.toBeNull()
  })

  // The operator is told BEFORE they send, not after Meta's 131047 leaves a
  // `failed` row that reads like a bug.
  it('refuses a reply once the 24-hour window has closed', async () => {
    const conversation = await seedConversation()
    await ctx.db
      .update(waConversations)
      .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(waConversations.id, conversation.id))

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/whatsapp/conversations/${conversation.id}/reply`,
      headers: A(),
      payload: { body: 'too late' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toMatch(/24-hour/i)
    expect(sends).toHaveLength(1)
  })

  it('rejects an empty or over-long reply', async () => {
    const conversation = await seedConversation()
    const url = `/v1/admin/whatsapp/conversations/${conversation.id}/reply`
    // 422, not 400 — this app maps schema violations to validation_failed.
    expect(
      (await ctx.app.inject({ method: 'POST', url, headers: A(), payload: { body: '' } })).statusCode
    ).toBe(422)
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url,
          headers: A(),
          payload: { body: 'x'.repeat(4097) },
        })
      ).statusCode
    ).toBe(422)
  })

  /**
   * The follow-up template — the ONLY thing that can enter a closed thread.
   *
   * These cases guard a message that costs money on every send and is read by
   * Meta as MARKETING, so the refusals matter more than the happy path: each
   * one is a send that should not have been paid for.
   */
  describe('follow-up template', () => {
    const TEMPLATE = 'laanya_support_followup'

    async function configureTemplate(name: unknown = TEMPLATE, locale: unknown = 'en') {
      for (const [key, value] of [
        ['notify.supportFollowupTemplate', name],
        ['notify.supportFollowupLocale', locale],
      ] as const) {
        await ctx.db
          .insert(appConfig)
          .values({ key, value })
          .onConflictDoUpdate({ target: appConfig.key, set: { value } })
      }
    }

    /** Push the thread past the 24-hour window without waiting a day. */
    async function closeWindow(id: string) {
      await ctx.db
        .update(waConversations)
        .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(waConversations.id, id))
    }

    const followUp = (id: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/whatsapp/conversations/${id}/follow-up`,
        headers: A(),
      })

    it('sends the template into a closed thread and stores the rendered body', async () => {
      const conversation = await seedConversation()
      await closeWindow(conversation.id)
      await configureTemplate()

      const res = await followUp(conversation.id)
      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(true)

      // A TEMPLATE send, not a session text: the payload Meta gets must carry
      // the approved name and exactly one body param, or it is a 132000.
      expect(sends[1]).toMatchObject({
        type: 'template',
        template: {
          name: TEMPLATE,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: 'Priya' }] }],
        },
      })

      // The transcript shows what the shopper actually received, rendered from
      // our copy of the approved wording — not a placeholder.
      const outbound = await ctx.db
        .select()
        .from(waMessages)
        .where(eq(waMessages.direction, 'outbound'))
      const template = outbound.find((row) => row.msgType === 'template')
      expect(template?.body).toBe(FOLLOW_UP_BODY.replace('{{1}}', 'Priya'))
      expect(template?.status).toBe('sent')
      expect(template?.sentBy).not.toBeNull()
    })

    // The mirror of the reply route's own guard. A template inside a live
    // window is a paid message that says less than the free reply available.
    it('refuses while the window is still open', async () => {
      const conversation = await seedConversation()
      await configureTemplate()

      const res = await followUp(conversation.id)
      expect(res.statusCode).toBe(422)
      expect(res.json().error.message).toMatch(/still open/i)
      expect(sends).toHaveLength(1)
    })

    // Enqueue-before-approval is the pattern elsewhere; here there is nothing
    // to enqueue, so an unconfigured template must refuse rather than send
    // against whatever name the adapter was booted with.
    it('refuses when no template is configured', async () => {
      const conversation = await seedConversation()
      await closeWindow(conversation.id)

      const res = await followUp(conversation.id)
      expect(res.statusCode).toBe(422)
      expect(res.json().error.message).toMatch(/supportFollowupTemplate/)
      expect(sends).toHaveLength(1)
    })

    // One follow-up per shopper message. A second unsolicited template because
    // the first went unanswered is what gets a number rate-limited by Meta.
    it('refuses a second follow-up until the shopper writes again', async () => {
      const conversation = await seedConversation()
      await closeWindow(conversation.id)
      await configureTemplate()

      expect((await followUp(conversation.id)).statusCode).toBe(200)
      const second = await followUp(conversation.id)
      expect(second.statusCode).toBe(409)
      expect(second.json().error.message).toMatch(/already been sent/i)
      expect(sends).toHaveLength(2)
    })

    // The guard keys on msg_type, so a HUMAN reply sent earlier in the window
    // must not be mistaken for a follow-up already spent.
    it('still allows a follow-up after an ordinary reply in the same window', async () => {
      const conversation = await seedConversation()
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/whatsapp/conversations/${conversation.id}/reply`,
        headers: A(),
        payload: { body: 'On its way.' },
      })
      await closeWindow(conversation.id)
      await configureTemplate()

      expect((await followUp(conversation.id)).statusCode).toBe(200)
    })

    // Meta rejects a parameter carrying newlines, tabs or runs of spaces with
    // 132000, and the profile name is a string the shopper controls entirely.
    it('flattens a shopper-supplied profile name into a legal parameter', async () => {
      const body = inboundBody({ name: '  Priya\n\tSharma    Rao  ' })
      await post(body, sign(body))
      const [conversation] = await ctx.db.select().from(waConversations)
      await closeWindow(conversation!.id)
      await configureTemplate()

      expect((await followUp(conversation!.id)).statusCode).toBe(200)
      const sent = sends[sends.length - 1] as {
        template: { components: Array<{ parameters: Array<{ text: string }> }> }
      }
      const param = sent.template.components[0]!.parameters[0]!.text
      expect(param).toBe('Priya Sharma Rao')
      expect(param).not.toMatch(/[\n\t]|\s{4}/)
    })

    // A send that failed still happened. An operator who cannot see the attempt
    // makes it again — and the dedupe guard must not count it as spent.
    it('records a failed template send and lets the operator retry', async () => {
      const conversation = await seedConversation()
      await closeWindow(conversation.id)
      await configureTemplate()
      graphFailure = { error: { message: 'Template name does not exist' } }

      const res = await followUp(conversation.id)
      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(false)

      const [failed] = await ctx.db
        .select()
        .from(waMessages)
        .where(eq(waMessages.msgType, 'template'))
      expect(failed?.status).toBe('failed')
      expect(failed?.error).toMatch(/Template name does not exist/)

      graphFailure = undefined
      expect((await followUp(conversation.id)).statusCode).toBe(200)
    })
  })

  it('closes a thread, and a new inbound re-opens it', async () => {
    const conversation = await seedConversation()
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/whatsapp/conversations/${conversation.id}/status`,
      headers: A(),
      payload: { status: 'closed' },
    })
    expect(closed.json().status).toBe('closed')

    // The shopper writing again is the authority on whether it is settled.
    const second = inboundBody({ id: 'wamid.IN2', text: 'one more thing' })
    await post(second, sign(second))
    const [reopened] = await ctx.db.select().from(waConversations)
    expect(reopened?.status).toBe('open')
  })
})

/**
 * Push alerts to the operator's phone.
 *
 * The inbox only works if someone knows a message arrived, so "an inbound
 * message pushes to every registered admin device" is the feature, and "a push
 * failure never breaks the webhook" is the safety rule around it — Meta retries
 * a non-200, and a dead Firebase token must not cause a message to be recorded
 * twice.
 */
describe('admin inbox push alerts', () => {
  /** Every (tokens, message) pair the fake sender was handed. */
  let pushes: Array<{ tokens: string[]; message: AdminPushMessage }>
  /** Tokens the fake reports as dead, so the prune path can be exercised. */
  let dead: string[]
  /** When set, the fake throws instead of sending. */
  let pushError: Error | null

  function fakeSender(): AdminPushSender {
    return async (tokens, message) => {
      if (pushError) throw pushError
      pushes.push({ tokens, message })
      return { sent: tokens.length - dead.length, staleTokens: dead }
    }
  }

  async function registerDevice(token: string, label = 'iPhone home screen') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/whatsapp/devices',
      headers: auth(USER_ADMIN.token),
      payload: { token, label },
    })
    // Asserted here rather than in each caller: a rejected registration makes
    // every push assertion below fail with "expected 1, got 0", which reads as
    // a broken webhook rather than a bad fixture.
    expect(res.statusCode).toBe(200)
    return res
  }

  beforeEach(async () => {
    pushes = []
    dead = []
    pushError = null
    await makeApp({ pushSender: fakeSender() })
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_ADMIN.token) })
    await promoteToAdmin(ctx.db, USER_ADMIN.uid)
  })

  it('refuses to register a device for a non-admin', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/whatsapp/devices',
      headers: auth(USER_A.token),
      payload: { token: 'x'.repeat(40), label: 'Sneaky phone' },
    })
    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(adminPushDevices)).toHaveLength(0)
  })

  it('pushes the sender and a preview when a shopper messages', async () => {
    await registerDevice('fcm-token-phone-000000000000')
    const body = inboundBody({ text: 'Is the 1L oil in stock?' })
    const res = await post(body, sign(body))

    expect(res.statusCode).toBe(200)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.tokens).toEqual(['fcm-token-phone-000000000000'])
    expect(pushes[0]?.message.title).toBe('Priya')
    expect(pushes[0]?.message.body).toBe('Is the 1L oil in stock?')
    // The link must land on the thread, not the inbox root: the whole point is
    // tapping the banner and being where the reply gets typed.
    const [conversation] = await ctx.db.select().from(waConversations)
    expect(pushes[0]?.message.link).toContain(`/admin/whatsapp/?thread=${conversation!.id}`)
  })

  it('moves a re-registered token instead of stacking duplicates', async () => {
    await registerDevice('fcm-token-old-0000000000000')
    // Same surface, new token — FCM rotates these on its own schedule.
    await registerDevice('fcm-token-new-0000000000000')

    const rows = await ctx.db.select().from(adminPushDevices)
    expect(rows.map((row) => row.token)).toEqual(['fcm-token-new-0000000000000'])
  })

  it('drops a token Firebase reports as dead', async () => {
    await registerDevice('fcm-token-dead-000000000000')
    dead = ['fcm-token-dead-000000000000']

    const first = inboundBody()
    await post(first, sign(first))
    expect(await ctx.db.select().from(adminPushDevices)).toHaveLength(0)

    // Nothing left to notify, so the sender is not called again at all.
    const second = inboundBody({ id: 'wamid.IN2', text: 'still there?' })
    await post(second, sign(second))
    expect(pushes).toHaveLength(1)
  })

  it('records the message even when the push blows up', async () => {
    await registerDevice('fcm-token-phone-000000000000')
    pushError = new Error('firebase is down')

    const body = inboundBody({ text: 'hello?' })
    const res = await post(body, sign(body))

    // A 500 here would have Meta retry the same message forever.
    expect(res.statusCode).toBe(200)
    const inbound = (await ctx.db.select().from(waMessages)).filter(
      (message) => message.direction === 'inbound'
    )
    expect(inbound).toHaveLength(1)
  })

  it('stops pushing once the device is unregistered', async () => {
    await registerDevice('fcm-token-phone-000000000000')
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/whatsapp/devices',
      headers: auth(USER_ADMIN.token),
      payload: { token: 'fcm-token-phone-000000000000' },
    })
    expect(res.statusCode).toBe(200)

    const body = inboundBody()
    await post(body, sign(body))
    expect(pushes).toHaveLength(0)
  })
})
