/**
 * `lib/notify/whatsappCloud.ts` — the Meta Graph API template send.
 *
 * The properties worth pinning here are all about the COMPONENTS array, because
 * that is the single thing Meta will reject a send over while the credentials
 * are perfectly fine (132000/132001). Specifically:
 *
 *   - a header is emitted only when the frozen message carries one, since a
 *     header sent to a template approved without one fails exactly as hard as
 *     a missing required one;
 *   - each URL button is its OWN component with `sub_type: 'url'` and a
 *     STRINGIFIED index, not one component holding a list;
 *   - the failure text names the template and the shape actually sent, because
 *     the row's stored `last_error` is all an operator gets to work from.
 *
 * The two live customer templates are the regression cases: `laanya_refill_reminder`
 * (2 body params + required image header + STATIC button) and
 * `laanya_order_delivered` (2 body params, NO header, STATIC button). Neither
 * takes a button parameter, so neither may emit a button component.
 */

import { describe, expect, it, vi } from 'vitest'

import type { NotificationMessage } from '../../src/lib/notify/types.js'
import {
  createWhatsAppCloudChannel,
  type WhatsAppCloudConfig,
} from '../../src/lib/notify/whatsappCloud.js'

const CFG: WhatsAppCloudConfig = {
  phoneNumberId: '927479007124972',
  accessToken: 'test-token',
  templateName: 'order_paid_ops',
  templateLocale: 'en',
}

interface SentTemplate {
  messaging_product: string
  to: string
  type: string
  template: {
    name: string
    language: { code: string }
    components: Array<{
      type: string
      sub_type?: string
      index?: string
      parameters: Array<Record<string, unknown>>
    }>
  }
}

/** A fetch stub plus a reader for the single request body it captured. */
function stubFetch(
  response: Response
): { impl: typeof fetch; sent: () => SentTemplate; init: () => RequestInit } {
  const fn = vi.fn(async () => response.clone())
  const calls = () =>
    (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
  return {
    impl: fn as unknown as typeof fetch,
    sent: () => JSON.parse(String(calls()[1].body)) as SentTemplate,
    init: () => calls()[1],
  }
}

const OK = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 })

describe('createWhatsAppCloudChannel — component assembly', () => {
  it('sends a body-only template with no header and no button components', async () => {
    const f = stubFetch(OK())
    // The approved `laanya_order_delivered` shape: 2 params, nothing else.
    const message: NotificationMessage = { params: ['Asha', 'Daniya Body Cream'] }

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', message)

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.TEST' })
    const components = f.sent().template.components
    expect(components).toHaveLength(1)
    expect(components[0]!.type).toBe('body')
    expect(components[0]!.parameters).toEqual([
      { type: 'text', text: 'Asha' },
      { type: 'text', text: 'Daniya Body Cream' },
    ])
  })

  it('emits an image header as a `link` parameter, before the body', async () => {
    const f = stubFetch(OK())
    // The approved `laanya_refill_reminder` shape: header is REQUIRED.
    const message: NotificationMessage = {
      params: ['Asha', 'Daniya Body Cream'],
      header: { link: 'https://image-intake.adix-ai.workers.dev/hero.jpg' },
    }

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', message)

    const components = f.sent().template.components
    expect(components.map((c) => c.type)).toEqual(['header', 'body'])
    expect(components[0]!.parameters).toEqual([
      { type: 'image', image: { link: 'https://image-intake.adix-ai.workers.dev/hero.jpg' } },
    ])
  })

  it('gives every URL button its own component, with sub_type url and a STRINGIFIED index', async () => {
    const f = stubFetch(OK())
    const message: NotificationMessage = {
      params: ['Asha'],
      buttons: [
        { index: 0, suffix: 'account/orders/order_A1' },
        { index: 1, suffix: 'catalog/SKU-1' },
      ],
    }

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', message)

    const components = f.sent().template.components
    expect(components.map((c) => c.type)).toEqual(['body', 'button', 'button'])
    expect(components[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'account/orders/order_A1' }],
    })
    // Stringified, not numeric — Meta addresses buttons positionally by string.
    expect(components[2]!.index).toBe('1')
    expect(typeof components[2]!.index).toBe('string')
  })

  it('emits no button component for an empty button list', async () => {
    const f = stubFetch(OK())

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['Asha'],
      buttons: [],
    })

    expect(f.sent().template.components.map((c) => c.type)).toEqual(['body'])
  })

  it('emits an empty body component for a template with no variables', async () => {
    const f = stubFetch(OK())

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', { params: [] })

    const components = f.sent().template.components
    expect(components).toHaveLength(1)
    expect(components[0]).toEqual({ type: 'body', parameters: [] })
  })
})

describe('createWhatsAppCloudChannel — template resolution', () => {
  it('uses the boot-time template when the message carries no override', async () => {
    const f = stubFetch(OK())

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', { params: ['x'] })

    expect(f.sent().template).toMatchObject({ name: 'order_paid_ops', language: { code: 'en' } })
  })

  it('lets the per-message override win, so a config fix drains the failed backlog', async () => {
    const f = stubFetch(OK())

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['Asha', 'Daniya Body Cream'],
      template: { name: 'laanya_refill_reminder', locale: 'en' },
    })

    expect(f.sent().template).toMatchObject({
      name: 'laanya_refill_reminder',
      language: { code: 'en' },
    })
  })

  it('posts to the configured phone number id with a bearer token', async () => {
    const f = stubFetch(OK())

    await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', { params: ['x'] })

    const [url] = (f.impl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe('https://graph.facebook.com/v21.0/927479007124972/messages')
    expect((f.init().headers as Record<string, string>).authorization).toBe('Bearer test-token')
    expect(f.sent().messaging_product).toBe('whatsapp')
    expect(f.sent().to).toBe('919900000001')
  })
})

describe('createWhatsAppCloudChannel — failure reporting', () => {
  /**
   * The param-count hint is the whole point of the stored error: a 132000 says
   * only that Meta refused the payload, so the message must name the template
   * AND the component shape that went out, for every combination of components.
   */
  it('names the template and a body-only shape on a 132000', async () => {
    const f = stubFetch(
      new Response(JSON.stringify({ error: { code: 132000, message: 'number of parameters does not match' } }), {
        status: 200,
      })
    )

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['Asha', 'Daniya Body Cream'],
      template: { name: 'laanya_order_delivered', locale: 'en' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('laanya_order_delivered/en')
    // Assert on the "sent ..." segment, not the whole string: the static hint
    // that follows it names header/body/button generically, so a bare
    // `not.toContain('button')` would match the hint rather than the shape.
    expect(result.error).toContain('sent 2 body params —')
    expect(result.error).not.toContain('image header')
    expect(result.error).not.toContain('url button')
    expect(result.error).toContain('number of parameters does not match')
  })

  it('names the header and the button count when both were sent', async () => {
    const f = stubFetch(
      new Response(JSON.stringify({ error: { code: 132000, message: 'nope' } }), { status: 200 })
    )

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['Asha', 'Daniya Body Cream'],
      header: { link: 'https://img.test/hero.jpg' },
      buttons: [{ index: 0, suffix: 'catalog/SKU-1' }],
    })

    expect(result.error).toContain('2 body params')
    expect(result.error).toContain('image header')
    expect(result.error).toContain('1 url button')
    // Singular for one, so the text reads as a count rather than a label.
    expect(result.error).not.toContain('1 url buttons')
  })

  it('pluralises multiple buttons', async () => {
    const f = stubFetch(
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 200 })
    )

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: [],
      buttons: [
        { index: 0, suffix: 'a' },
        { index: 1, suffix: 'b' },
      ],
    })

    expect(result.error).toContain('2 url buttons')
  })

  /**
   * Meta answers 200 with an error body on some rejections. Reading success out
   * of the status line alone would record a send that never happened, and the
   * row would go terminal `sent` with nothing delivered.
   */
  it('treats a 200 carrying an error body as a failure', async () => {
    const f = stubFetch(
      new Response(JSON.stringify({ error: { code: 132001, message: 'template does not exist' } }), {
        status: 200,
      })
    )

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['x'],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('template does not exist')
  })

  it('falls back to the status line when the error body is unreadable', async () => {
    const f = stubFetch(new Response('not json at all', { status: 401 }))

    const result = await createWhatsAppCloudChannel(CFG, f.impl).send('919900000001', {
      params: ['x'],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 401')
  })

  it('returns a failed result rather than throwing on a transport error', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    const result = await createWhatsAppCloudChannel(CFG, impl).send('919900000001', {
      params: ['x'],
    })

    expect(result).toEqual({ ok: false, error: 'ECONNRESET' })
  })
})
