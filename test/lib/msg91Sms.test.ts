/**
 * `lib/notify/msg91Sms.ts`: the MSG91 flow send. The payload shape is what
 * matters here, because DLT blocks anything that drifts from the approved text.
 */

import { describe, expect, it, vi } from 'vitest'

import { createMsg91SmsChannel } from '../../src/lib/notify/msg91Sms.js'

const TEMPLATE = { name: 'msg91-template-id', locale: '' }

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch
}

describe('createMsg91SmsChannel', () => {
  it('maps positional params to var1..varN with link shortening off', async () => {
    const fetchImpl = respond({ type: 'success', message: 'req-1' })
    const channel = createMsg91SmsChannel({ authKey: 'key' }, fetchImpl)

    const result = await channel.send('919900000001', {
      params: ['order_abc', '299'],
      template: TEMPLATE,
    })

    expect(result).toEqual({ ok: true, providerMessageId: 'req-1' })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('https://control.msg91.com/api/v5/flow/')
    expect((init?.headers as Record<string, string>).authkey).toBe('key')
    expect(JSON.parse(init?.body as string)).toEqual({
      template_id: 'msg91-template-id',
      short_url: '0',
      recipients: [{ mobiles: '919900000001', var1: 'order_abc', var2: '299' }],
    })
  })

  it('treats a 200 with type "error" as a failed send', async () => {
    const channel = createMsg91SmsChannel(
      { authKey: 'key' },
      respond({ type: 'error', message: 'template missing' })
    )
    const result = await channel.send('919900000001', { params: ['a'], template: TEMPLATE })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('template missing')
  })

  it('refuses to send without a resolved template, and never throws', async () => {
    const fetchImpl = respond({ type: 'success', message: 'x' })
    const channel = createMsg91SmsChannel({ authKey: 'key' }, fetchImpl)
    expect((await channel.send('919900000001', { params: [] })).ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()

    const failing = createMsg91SmsChannel({ authKey: 'key' }, (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch)
    expect(await failing.send('919900000001', { params: [], template: TEMPLATE })).toEqual({
      ok: false,
      error: 'boom',
    })
  })
})
