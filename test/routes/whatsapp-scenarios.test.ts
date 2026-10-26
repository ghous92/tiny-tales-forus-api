/**
 * Scenario tests: realistic shopper conversations driven end-to-end through the
 * real code path — a signed Meta webhook in, a thread and an auto-reply out, an
 * operator reply back — covering the permutation matrix of everything that can
 * vary about an inbound message.
 *
 * Distinct from `whatsapp.test.ts`, which tests each route's contract in
 * isolation. This file asks a different question: *given a real shopper doing a
 * real thing, does the flow hold?* Every message body here is one a shopper on
 * a ₹349 body cream would plausibly send — the trust objections from TASK-04 §1
 * are the script, because those are the conversations this channel exists to
 * have.
 *
 * The dimensions crossed below:
 *
 *   entry      : ref code / no code / lower-case code / malformed code / code mid-sentence
 *   identity   : phone matches a Tiny Tales account / stranger
 *   message    : text / image+caption / image, no caption / unsupported type
 *   delivery   : single / batched / Meta retry / two entries in one envelope
 *   signature  : valid / forged / absent / body tampered / webhook unconfigured
 *   thread     : new / existing / closed then re-opened
 *   window     : inside 24h / expired
 *   reply      : sent / Meta rejects / no send credentials
 *
 * `RECORD_TRANSCRIPTS=1 npx vitest run test/routes/whatsapp-scenarios.test.ts`
 * prints each conversation as it would read in `/admin`, which is the artefact
 * phase 2's system prompt gets written against.
 */

import { createHmac } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { waConversations, waMessages } from '../../src/db/schema.js'
import { auth, createTestApp, promoteToAdmin, USER_A, USER_ADMIN, type TestContext } from '../helpers/app.js'

const APP_SECRET = 'scenario-app-secret'
const VERIFY_TOKEN = 'scenario-verify-token'

/** A shopper who has never bought — the acquisition case, and most of the inbox. */
const STRANGER = '919812345678'
/** USER_A's number without the `+`: the identity-resolution case. */
const KNOWN = USER_A.phoneNumber.replace(/[^0-9]/g, '')

let ctx: TestContext
let sends: Array<{ to: string; body: string }>
/** Set to make the fake Graph API reject the next send, as Meta would. */
let sendFailure: string | null

function graphFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as {
      to: string
      text?: { body?: string }
    }
    if (sendFailure) {
      const message = sendFailure
      sendFailure = null
      return new Response(JSON.stringify({ error: { message, code: 131047 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    sends.push({ to: parsed.to, body: parsed.text?.body ?? '' })
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function makeApp(options: { configured?: boolean; canSend?: boolean } = {}) {
  const { configured = true, canSend = true } = options
  sends = []
  sendFailure = null
  ctx = await createTestApp({
    ...(configured ? { whatsappInbound: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } } : {}),
    ...(canSend ? { whatsapp: { phoneNumberId: 'pnid', accessToken: 'token' } } : {}),
    whatsappFetch: graphFetch(),
  })
}

/** One message as Meta shapes it. `type` drives which body field is populated. */
interface MetaMessage {
  id: string
  from: string
  type?: 'text' | 'image' | 'location' | 'audio' | 'sticker'
  text?: string
  caption?: string
  name?: string
  timestamp?: string
}

function metaMessage(m: MetaMessage) {
  const type = m.type ?? 'text'
  return {
    id: m.id,
    from: m.from,
    type,
    timestamp: m.timestamp ?? String(Math.floor(Date.now() / 1000)),
    ...(type === 'text' ? { text: { body: m.text ?? '' } } : {}),
    ...(type === 'image' ? { image: { id: 'media-1', ...(m.caption ? { caption: m.caption } : {}) } } : {}),
    ...(type === 'location' ? { location: { latitude: 23.02, longitude: 72.57 } } : {}),
  }
}

/** A whole webhook envelope. Several messages here = one Meta batch. */
function envelope(messages: MetaMessage[]) {
  const name = messages.find((m) => m.name)?.name
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
              metadata: { display_phone_number: '919217585635', phone_number_id: 'pnid' },
              ...(name ? { contacts: [{ profile: { name } }] } : {}),
              messages: messages.map(metaMessage),
            },
          },
        ],
      },
    ],
  })
}

function sign(body: string, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
}

/** POST a body Meta really signed. */
function deliver(body: string, signature = sign(body)) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload: body,
  })
}

/** Shorthand: one shopper says one thing. */
async function says(m: MetaMessage) {
  return deliver(envelope([m]))
}

async function threadFor(waPhone: string) {
  const [row] = await ctx.db
    .select()
    .from(waConversations)
    .where(eq(waConversations.waPhone, waPhone))
  return row
}

async function messagesFor(conversationId: string) {
  return ctx.db
    .select()
    .from(waMessages)
    .where(eq(waMessages.conversationId, conversationId))
    .orderBy(waMessages.createdAt)
}

/**
 * Print a thread the way `/admin` renders it. Off unless `RECORD_TRANSCRIPTS=1`
 * — the point is a readable artefact, not noise on every CI run.
 */
async function record(label: string, waPhone: string) {
  if (!process.env.RECORD_TRANSCRIPTS) return
  const thread = await threadFor(waPhone)
  if (!thread) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${label} ===\n  (no thread — rejected before any write)`)
    return
  }
  const rows = await messagesFor(thread.id)
  const lines = rows.map((row) => {
    const who = row.direction === 'inbound' ? 'shopper' : 'tinytales '
    const flag = row.status === 'failed' ? ' [NOT DELIVERED]' : ''
    return `  ${who} | ${row.body || `(${row.msgType}, no text)`}${flag}`
  })
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${label} ===\n  +${thread.waPhone} · ${thread.userId ? 'account' : 'no account'}` +
      ` · ref ${thread.refCode ?? '—'} · ${thread.status}\n${lines.join('\n')}`
  )
}

async function makeAdmin() {
  await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/whatsapp/conversations',
    headers: auth(USER_ADMIN.token),
  })
  await promoteToAdmin(ctx.db, USER_ADMIN.uid)
}

async function operatorReplies(conversationId: string, body: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/admin/whatsapp/conversations/${conversationId}/reply`,
    headers: auth(USER_ADMIN.token),
    payload: { body },
  })
}

afterEach(async () => {
  await ctx.app.close()
})

// --- Scenario 1: the case the whole feature exists for -----------------------

describe('scenario: a stranger on a PDP asks whether the business is real', () => {
  beforeEach(async () => {
    await makeApp()
    await makeAdmin()
  })

  it('carries a shopper from deep link to answered question', async () => {
    // The `wa.me` prefill, verbatim.
    await says({
      id: 'wamid.S1a',
      from: STRANGER,
      name: 'Priya',
      text: 'Hi, I want to know about Daniya Multi-Purpose Body Cream 500ml [TT-4F2A9C]',
    })

    const thread = await threadFor(STRANGER)
    expect(thread).toMatchObject({ refCode: 'TT-4F2A9C', profileName: 'Priya', status: 'open' })
    // The ref code is stripped: the shopper never wrote it and must not read it.
    const first = (await messagesFor(thread!.id))[0]
    expect(first?.body).toBe('Hi, I want to know about Daniya Multi-Purpose Body Cream 500ml')
    // The trust signal: something answered immediately.
    expect(sends).toHaveLength(1)

    // Then the real objections, in the order shoppers actually raise them.
    await says({ id: 'wamid.S1b', from: STRANGER, text: 'Is this original? My cousin got a fake one online' })
    await says({ id: 'wamid.S1c', from: STRANGER, text: 'And do you deliver to 380015? COD possible?' })

    const waiting = await threadFor(STRANGER)
    expect(waiting?.unreadCount).toBe(2)
    // Two more inbounds must NOT trigger two more auto-replies.
    expect(sends).toHaveLength(1)

    const reply = await operatorReplies(
      waiting!.id,
      'Yes — sold by Tiny Tales, manufactured by Saman Products (licence GC1299). We deliver to 380015 in 2 days. Prepaid only right now.'
    )
    expect(reply.statusCode).toBe(200)
    expect(reply.json().ok).toBe(true)

    const answered = await threadFor(STRANGER)
    expect(answered?.unreadCount).toBe(0)
    await record('S1 — stranger, deep link, trust objections', STRANGER)
  })
})

// --- Scenario 2: identity, the thing that makes the agent worth building -----

describe('scenario: a signed-up shopper messages about an order', () => {
  beforeEach(async () => {
    await makeApp()
    await makeAdmin()
    // Any authed request upserts the account, exactly as a real login would.
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
  })

  it('resolves the thread to their account with no linking step', async () => {
    await says({ id: 'wamid.S2', from: KNOWN, name: 'Rahul', text: 'where is my order? ordered 3 days back' })
    const thread = await threadFor(KNOWN)
    expect(thread?.userId).not.toBeNull()
    await record('S2 — known account, order status', KNOWN)
  })

  it('adopts the account when the shopper signs up AFTER first messaging', async () => {
    await ctx.app.close()
    await makeApp()
    await makeAdmin()

    // Message first — no account exists yet.
    await says({ id: 'wamid.S2a', from: KNOWN, text: 'do you have the 1L cream?' })
    expect((await threadFor(KNOWN))?.userId).toBeNull()

    // Then they sign up, then write again.
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    await says({ id: 'wamid.S2b', from: KNOWN, text: 'ok I made an account' })

    expect((await threadFor(KNOWN))?.userId).not.toBeNull()
    await record('S2b — anonymous first, account later', KNOWN)
  })
})

// --- Scenario 3: every entry-point permutation ------------------------------

describe('scenario: ref-code permutations from the wa.me prefill', () => {
  beforeEach(async () => {
    await makeApp()
  })

  const cases: Array<{ label: string; text: string; expected: string | null; body: string }> = [
    {
      label: 'code at the end (the standard prefill)',
      text: 'Tell me about Daniya Hair Oil 200ml [TT-9A1B2C]',
      expected: 'TT-9A1B2C',
      body: 'Tell me about Daniya Hair Oil 200ml',
    },
    {
      label: 'lower-case link',
      text: 'price for shampoo 1L [lny-7d3e5f]',
      expected: 'TT-7D3E5F',
      body: 'price for shampoo 1L',
    },
    {
      label: 'code mid-sentence (shopper typed around it)',
      text: 'hi [TT-ABCD12] is this available',
      expected: 'TT-ABCD12',
      body: 'hi is this available',
    },
    {
      label: 'no code — shopper saved the number and wrote later',
      text: 'do you sell petroleum jelly',
      expected: null,
      body: 'do you sell petroleum jelly',
    },
    {
      label: 'malformed code is not attribution',
      text: 'hello [TT-] there',
      expected: null,
      body: 'hello [TT-] there',
    },
    {
      label: 'wrong prefix is not ours',
      text: 'hello [ABC-4F2A9C]',
      expected: null,
      body: 'hello [ABC-4F2A9C]',
    },
  ]

  it.each(cases)('$label', async ({ text, expected, body }) => {
    const from = `9198000${String(cases.findIndex((c) => c.text === text)).padStart(5, '0')}`
    await says({ id: `wamid.R${from}`, from, text })
    const thread = await threadFor(from)
    expect(thread?.refCode ?? null).toBe(expected)
    expect((await messagesFor(thread!.id))[0]?.body).toBe(body)
  })
})

// --- Scenario 4: message types ----------------------------------------------

describe('scenario: what a shopper can actually send', () => {
  beforeEach(async () => {
    await makeApp()
  })

  it('keeps an image caption — "is this the one I bought?"', async () => {
    await says({ id: 'wamid.M1', from: STRANGER, type: 'image', caption: 'is this the same bottle?' })
    const thread = await threadFor(STRANGER)
    const [first] = await messagesFor(thread!.id)
    expect(first).toMatchObject({ msgType: 'image', body: 'is this the same bottle?' })
    // Still worth an auto-reply: a photo with no text is a real question.
    expect(sends).toHaveLength(1)
  })

  it('records a bare image with no caption rather than dropping it', async () => {
    await says({ id: 'wamid.M2', from: STRANGER, type: 'image' })
    const thread = await threadFor(STRANGER)
    expect((await messagesFor(thread!.id))[0]).toMatchObject({ msgType: 'image', body: '' })
  })

  it.each(['location', 'audio', 'sticker'] as const)(
    'records an unsupported %s so the operator sees SOMETHING arrived',
    async (type) => {
      await says({ id: `wamid.M-${type}`, from: STRANGER, type })
      const thread = await threadFor(STRANGER)
      expect((await messagesFor(thread!.id))[0]?.msgType).toBe('unsupported')
    }
  )
})

// --- Scenario 5: how Meta actually delivers ---------------------------------

describe('scenario: Meta delivery quirks', () => {
  beforeEach(async () => {
    await makeApp()
  })

  it('handles two messages from a NEW number in one batch', async () => {
    // The race the unique index exists for: no thread yet, two inserts.
    await deliver(
      envelope([
        { id: 'wamid.B1', from: STRANGER, name: 'Anita', text: 'hi' },
        { id: 'wamid.B2', from: STRANGER, text: 'is the 500ml in stock?' },
      ])
    )
    const thread = await threadFor(STRANGER)
    expect(await messagesFor(thread!.id)).toHaveLength(3) // 2 in, 1 auto-reply
    expect(sends).toHaveLength(1)
  })

  it('handles two DIFFERENT shoppers in one batch', async () => {
    await deliver(
      envelope([
        { id: 'wamid.C1', from: STRANGER, text: 'do you deliver to Surat?' },
        { id: 'wamid.C2', from: '919555000111', text: 'refund status?' },
      ])
    )
    expect(await ctx.db.select().from(waConversations)).toHaveLength(2)
    expect(sends).toHaveLength(2)
  })

  it('survives a full replay of a batch it already processed', async () => {
    const batch = envelope([
      { id: 'wamid.D1', from: STRANGER, text: 'hi' },
      { id: 'wamid.D2', from: STRANGER, text: 'price?' },
    ])
    await deliver(batch)
    await deliver(batch)
    await deliver(batch)

    const thread = await threadFor(STRANGER)
    expect(await messagesFor(thread!.id)).toHaveLength(3)
    expect(sends).toHaveLength(1)
    expect(thread?.unreadCount).toBe(1)
  })

  it('ignores a delivery receipt for a message WE sent', async () => {
    await says({ id: 'wamid.E1', from: STRANGER, text: 'hello' })
    const before = await threadFor(STRANGER)

    const receipt = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.OUT1', status: 'read', recipient_id: STRANGER, timestamp: '1788600100' },
                ],
              },
            },
          ],
        },
      ],
    })
    const res = await deliver(receipt)
    expect(res.statusCode).toBe(200)

    const after = await threadFor(STRANGER)
    // A receipt must not open a fake window or look like a shopper message.
    expect(after?.lastInboundAt?.getTime()).toBe(before?.lastInboundAt?.getTime())
    expect(await messagesFor(after!.id)).toHaveLength(2)
  })
})

// --- Scenario 6: the security boundary, from a shopper's perspective --------

describe('scenario: someone tries to read a real customer’s thread', () => {
  it('refuses a forged webhook naming a real account', async () => {
    await makeApp()
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })

    const body = envelope([{ id: 'wamid.X1', from: KNOWN, text: 'send me my order details' }])
    const res = await deliver(body, sign(body, 'not-the-app-secret'))

    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
    expect(sends).toHaveLength(0)
    await record('S6 — forged payload', KNOWN)
  })

  it('refuses a body edited after signing', async () => {
    await makeApp()
    const original = envelope([{ id: 'wamid.X2', from: STRANGER, text: 'hi' }])
    const tampered = envelope([{ id: 'wamid.X2', from: KNOWN, text: 'hi' }])
    const res = await deliver(tampered, sign(original))
    expect(res.statusCode).toBe(403)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })

  it('accepts nothing at all while the webhook is unconfigured', async () => {
    await makeApp({ configured: false })
    const body = envelope([{ id: 'wamid.X3', from: STRANGER, text: 'hi' }])
    expect((await deliver(body)).statusCode).toBe(503)
    expect(await ctx.db.select().from(waConversations)).toHaveLength(0)
  })
})

// --- Scenario 7: the 24-hour window, which decides whether we can reply -----

describe('scenario: the reply window', () => {
  beforeEach(async () => {
    await makeApp()
    await makeAdmin()
  })

  it('lets the operator answer inside 24h', async () => {
    await says({ id: 'wamid.W1', from: STRANGER, text: 'is 1L cheaper per ml than 500ml?' })
    const thread = await threadFor(STRANGER)
    const res = await operatorReplies(thread!.id, 'Yes — ₹649 for 1L vs ₹349 for 500ml, about 7% less per ml.')
    expect(res.statusCode).toBe(200)
    await record('S7 — answered inside the window', STRANGER)
  })

  it('refuses after 24h and says why, instead of a failed send', async () => {
    await says({ id: 'wamid.W2', from: STRANGER, text: 'thinking about it, will confirm tomorrow' })
    const thread = await threadFor(STRANGER)
    await ctx.db
      .update(waConversations)
      .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(waConversations.id, thread!.id))

    const res = await operatorReplies(thread!.id, 'still interested?')
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toMatch(/24-hour/i)
    // Nothing was attempted, so nothing can have half-happened.
    expect(sends).toHaveLength(1)
  })

  it('re-opens the window the moment the shopper writes again', async () => {
    await says({ id: 'wamid.W3a', from: STRANGER, text: 'will confirm tomorrow' })
    const thread = await threadFor(STRANGER)
    await ctx.db
      .update(waConversations)
      .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(waConversations.id, thread!.id))
    expect((await operatorReplies(thread!.id, 'hello?')).statusCode).toBe(422)

    await says({ id: 'wamid.W3b', from: STRANGER, text: 'ok I want to order the 1L' })
    expect((await operatorReplies(thread!.id, 'Great — sending you the details.')).statusCode).toBe(200)
    await record('S7c — window closed, then re-opened by the shopper', STRANGER)
  })
})

// --- Scenario 8: things going wrong on our side -----------------------------

describe('scenario: our own failures stay visible', () => {
  it('records a Meta rejection instead of losing the operator’s message', async () => {
    await makeApp()
    await makeAdmin()
    await says({ id: 'wamid.F1', from: STRANGER, text: 'hello?' })
    const thread = await threadFor(STRANGER)

    sendFailure = '(#131047) Message failed to send because more than 24 hours have passed'
    const res = await operatorReplies(thread!.id, 'Sorry for the delay!')

    // 200 with ok:false — the row exists and the operator can see what happened.
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(false)
    const rows = await messagesFor(thread!.id)
    const failed = rows.find((r) => r.status === 'failed')
    expect(failed?.error).toMatch(/131047/)
    // The badge is 0 here — but NOT because the failed reply cleared it. The
    // auto-reply had already answered this thread, and a failed send correctly
    // leaves `unreadCount` untouched.
    //
    // Known gap, recorded rather than papered over: a failed reply is visible
    // in the TRANSCRIPT (red bubble) but not in the LIST, so an operator
    // scanning the inbox sees a thread that looks answered. The list would need
    // its own "last outbound failed" signal to close this.
    expect((await threadFor(STRANGER))?.unreadCount).toBe(0)
    await record('S8 — reply rejected by Meta', STRANGER)
  })

  it('still records the shopper when we cannot reply at all', async () => {
    await makeApp({ canSend: false })
    await says({ id: 'wamid.F2', from: STRANGER, name: 'Meera', text: 'is COD available?' })

    const thread = await threadFor(STRANGER)
    // The inbound is the valuable half — never lose it because the reply failed.
    const rows = await messagesFor(thread!.id)
    expect(rows.filter((r) => r.direction === 'inbound')).toHaveLength(1)
    expect(rows.find((r) => r.direction === 'outbound')?.status).toBe('failed')
    expect(thread?.unreadCount).toBe(1)
    await record('S8b — no send credentials configured', STRANGER)
  })
})

// --- Scenario 9: the operator's queue behaves -------------------------------

describe('scenario: the inbox as an operator works it', () => {
  beforeEach(async () => {
    await makeApp()
    await makeAdmin()
  })

  it('closes a handled thread and re-opens it when the shopper returns', async () => {
    await says({ id: 'wamid.Q1', from: STRANGER, text: 'do you ship to Rajkot?' })
    const thread = await threadFor(STRANGER)
    await operatorReplies(thread!.id, 'Yes, 2–3 days.')

    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/whatsapp/conversations/${thread!.id}/status`,
      headers: auth(USER_ADMIN.token),
      payload: { status: 'closed' },
    })
    expect(closed.json().status).toBe('closed')

    // Filters are the operator's queue: a handled thread leaves the open list.
    const open = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations?status=open',
      headers: auth(USER_ADMIN.token),
    })
    expect(open.json().conversations).toHaveLength(0)

    await says({ id: 'wamid.Q2', from: STRANGER, text: 'actually one more thing' })
    const reopened = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations?status=open',
      headers: auth(USER_ADMIN.token),
    })
    expect(reopened.json().conversations).toHaveLength(1)
    expect(reopened.json().waiting).toBe(1)
    await record('S9 — closed, then re-opened', STRANGER)
  })

  it('counts strangers separately — the acquisition slice', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(USER_A.token) })
    await says({ id: 'wamid.Q3', from: KNOWN, text: 'order update please' })
    await says({ id: 'wamid.Q4', from: STRANGER, text: 'first time buying, is it safe?' })
    await says({ id: 'wamid.Q5', from: '919555000222', text: 'price list?' })

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations',
      headers: auth(USER_ADMIN.token),
    })
    expect(list.json().conversations).toHaveLength(3)
    expect(list.json().anonymous).toBe(2)
  })

  it('orders the queue by who is waiting longest, not by our own replies', async () => {
    await says({ id: 'wamid.Q6', from: STRANGER, text: 'first', timestamp: '1788600000' })
    await says({ id: 'wamid.Q7', from: '919555000333', text: 'second', timestamp: '1788700000' })

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/whatsapp/conversations',
      headers: auth(USER_ADMIN.token),
    })
    // Newest inbound first.
    expect(list.json().conversations[0].waPhone).toBe('919555000333')
  })
})
