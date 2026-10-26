/**
 * Unit tests for the inbound WhatsApp primitives — signature verification, ref
 * codes, phone normalisation, envelope flattening and the service window. Pure
 * (no DB, no network), the fast guard on the one function in this feature that
 * is a security boundary rather than a convenience.
 */

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  extractRefCode,
  normalizeWaPhone,
  parseInboundMessages,
  parseStatusUpdates,
  SERVICE_WINDOW_MS,
  stripRefCode,
  toE164,
  verifySignature,
  windowOpen,
} from '../../src/lib/whatsapp/inbound.js'

const SECRET = 'test-app-secret'

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
}

describe('verifySignature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

  it('accepts a correct signature', () => {
    expect(verifySignature(Buffer.from(body), sign(body), SECRET)).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(Buffer.from(body), sign(body, 'wrong'), SECRET)).toBe(false)
  })

  it('rejects when the body changed by a single byte', () => {
    const signature = sign(body)
    expect(verifySignature(Buffer.from(`${body} `), signature, SECRET)).toBe(false)
  })

  // The raw-body requirement, demonstrated: re-serialising the SAME data
  // changes the bytes, and this is why the route keeps a Buffer instead of
  // letting Fastify parse and the handler re-stringify.
  it('rejects a re-serialised body with the same data', () => {
    const signature = sign('{"a":1,"b":2}')
    expect(verifySignature(Buffer.from('{"b":2,"a":1}'), signature, SECRET)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifySignature(Buffer.from(body), undefined, SECRET)).toBe(false)
  })

  it('rejects a header without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')
    expect(verifySignature(Buffer.from(body), bare, SECRET)).toBe(false)
  })

  it('rejects non-hex and wrong-length digests without throwing', () => {
    expect(verifySignature(Buffer.from(body), 'sha256=zzzz', SECRET)).toBe(false)
    expect(verifySignature(Buffer.from(body), 'sha256=abcd', SECRET)).toBe(false)
    expect(verifySignature(Buffer.from(body), 'sha256=', SECRET)).toBe(false)
  })
})

describe('ref codes', () => {
  const text = 'Hi, I want to know about Daniya Cream 500ml [LNY-4F2A9C]'

  it('extracts the code without its brackets', () => {
    expect(extractRefCode(text)).toBe('LNY-4F2A9C')
  })

  it('uppercases so one entry point is one attribution row', () => {
    expect(extractRefCode('hello [lny-4f2a9c]')).toBe('LNY-4F2A9C')
  })

  it('returns null when there is no code', () => {
    expect(extractRefCode('is this genuine?')).toBeNull()
  })

  // The code is plumbing the shopper never wrote — it must not end up in the
  // transcript a human (or, in phase 2, the model) reads.
  it('strips the code and tidies the whitespace it leaves', () => {
    expect(stripRefCode(text)).toBe('Hi, I want to know about Daniya Cream 500ml')
  })

  it('leaves a message with no code untouched', () => {
    expect(stripRefCode('is this genuine?')).toBe('is this genuine?')
  })
})

describe('phone normalisation', () => {
  it('strips everything that is not a digit', () => {
    expect(normalizeWaPhone('+91 98765-43210')).toBe('919876543210')
  })

  // The asymmetry that identity resolution depends on: Meta omits the `+`,
  // `users.phone` carries it. Getting this backwards makes every account look
  // like a stranger.
  it('adds the + back for the users.phone form', () => {
    expect(toE164('919876543210')).toBe('+919876543210')
  })

  it('does not produce a bare + for an empty number', () => {
    expect(toE164('')).toBe('')
  })
})

describe('parseInboundMessages', () => {
  function envelope(message: Record<string, unknown>, contacts?: unknown) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                ...(contacts ? { contacts } : {}),
                messages: [message],
              },
            },
          ],
        },
      ],
    }
  }

  it('flattens a text message and pulls out its ref code', () => {
    const parsed = parseInboundMessages(
      envelope(
        {
          id: 'wamid.ABC',
          from: '919876543210',
          type: 'text',
          timestamp: '1788600000',
          text: { body: 'Do you deliver to 380015? [LNY-4F2A9C]' },
        },
        [{ profile: { name: 'Priya' } }]
      )
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      waMessageId: 'wamid.ABC',
      from: '919876543210',
      msgType: 'text',
      body: 'Do you deliver to 380015?',
      refCode: 'LNY-4F2A9C',
      profileName: 'Priya',
      timestampSec: 1788600000,
    })
  })

  it('keeps an image caption as the body', () => {
    const parsed = parseInboundMessages(
      envelope({
        id: 'wamid.IMG',
        from: '919876543210',
        type: 'image',
        timestamp: '1788600000',
        image: { caption: 'is this the same one?' },
      })
    )
    expect(parsed[0]?.msgType).toBe('image')
    expect(parsed[0]?.body).toBe('is this the same one?')
  })

  // Delivery receipts for messages WE sent. Treating one as inbound would open
  // a fake 24-hour window and make our own reply look like a conversation.
  it('ignores status callbacks entirely', () => {
    const parsed = parseInboundMessages({
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: 'wamid.OUT', status: 'delivered' }] } },
          ],
        },
      ],
    })
    expect(parsed).toEqual([])
  })

  // Meta adds fields without notice. Anything unrecognised is skipped, never
  // thrown on — a 500 here just makes Meta retry the same body until the
  // subscription degrades.
  it('returns an empty list for junk instead of throwing', () => {
    expect(parseInboundMessages(null)).toEqual([])
    expect(parseInboundMessages('nope')).toEqual([])
    expect(parseInboundMessages({ entry: 'not-an-array' })).toEqual([])
    expect(parseInboundMessages({ entry: [{ changes: [{ value: {} }] }] })).toEqual([])
  })

  it('skips a message with no id or no sender', () => {
    expect(parseInboundMessages(envelope({ from: '919876543210', type: 'text' }))).toEqual([])
    expect(parseInboundMessages(envelope({ id: 'wamid.X', type: 'text' }))).toEqual([])
  })

  it('marks an unknown message type unsupported rather than dropping it', () => {
    const parsed = parseInboundMessages(
      envelope({ id: 'wamid.LOC', from: '919876543210', type: 'location', timestamp: '1' })
    )
    expect(parsed[0]?.msgType).toBe('unsupported')
    expect(parsed[0]?.body).toBe('')
  })
})

describe('windowOpen', () => {
  const now = 1_788_600_000_000

  it('is open just inside 24 hours', () => {
    expect(windowOpen(new Date(now - SERVICE_WINDOW_MS + 1000), now)).toBe(true)
  })

  it('is closed exactly at 24 hours', () => {
    expect(windowOpen(new Date(now - SERVICE_WINDOW_MS), now)).toBe(false)
  })

  it('is closed when the shopper has never written', () => {
    expect(windowOpen(null, now)).toBe(false)
  })
})

describe('parseStatusUpdates', () => {
  const receipt = (statuses: unknown[]) => ({
    entry: [{ changes: [{ value: { messaging_product: 'whatsapp', statuses } }] }],
  })

  it('flattens a delivery receipt', () => {
    const parsed = parseStatusUpdates(
      receipt([{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1788600000' }])
    )
    expect(parsed).toEqual([
      { waMessageId: 'wamid.OUT1', status: 'delivered', timestampSec: 1788600000, error: null },
    ])
  })

  it('keeps the error text off a failed send', () => {
    const parsed = parseStatusUpdates(
      receipt([
        {
          id: 'wamid.OUT2',
          status: 'failed',
          timestamp: '1788600000',
          errors: [{ code: 131047, title: 'Re-engagement message', message: 'window closed' }],
        },
      ])
    )
    expect(parsed[0]?.status).toBe('failed')
    expect(parsed[0]?.error).toBe('Re-engagement message — window closed')
  })

  it('skips a status Meta invents later, and one with no id', () => {
    expect(parseStatusUpdates(receipt([{ id: 'wamid.X', status: 'warped' }]))).toEqual([])
    expect(parseStatusUpdates(receipt([{ status: 'read' }]))).toEqual([])
  })

  it('is empty for an inbound-message envelope, and vice versa', () => {
    const inboundEnvelope = {
      entry: [
        {
          changes: [
            { value: { messages: [{ id: 'wamid.IN', from: '919876543210', type: 'text', timestamp: '1' }] } },
          ],
        },
      ],
    }
    expect(parseStatusUpdates(inboundEnvelope)).toEqual([])
    expect(parseInboundMessages(receipt([{ id: 'wamid.OUT', status: 'read' }]))).toEqual([])
  })
})
