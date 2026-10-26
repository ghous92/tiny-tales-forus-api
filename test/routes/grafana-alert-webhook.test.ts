/**
 * `POST /v1/webhooks/grafana-alert` — Grafana can't hold a Google identity, so
 * this is the one internal boundary gated by a shared secret instead of
 * `authenticateScheduler`. Mirrors `fulfilment.ts`'s Delhivery webhook auth
 * tests (test/routes/fulfilment.test.ts), same auth shape.
 *
 * Beyond auth, the properties that matter: a valid call always answers 200
 * (Grafana must never be given a reason to retry-storm us) and, when Cloud
 * Tasks is configured, the alert is handed to the task enqueuer rather than
 * sent inline.
 */

import { describe, expect, it, vi } from 'vitest'

import type { AlertEmailTaskInput } from '../../src/lib/alertEmailTask.js'
import { createTestApp } from '../helpers/app.js'

const SECRET = 'grafana_webhook_test_secret'

function grafanaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        fingerprint: 'fp-abc123',
        labels: { alertname: 'tinytales-api ERROR logs' },
        annotations: { summary: 'ERROR-level logs detected', description: 'see Loki for detail' },
      },
    ],
    ...overrides,
  }
}

describe('POST /v1/webhooks/grafana-alert — auth', () => {
  it('answers 503 when no webhook secret is configured', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      payload: grafanaBody(),
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('grafana_webhook_disabled')
  })

  it('answers 401 for a wrong secret', async () => {
    const ctx = await createTestApp({ grafanaAlertWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': 'wrong' },
      payload: grafanaBody(),
    })
    expect(res.statusCode).toBe(401)
  })

  it('answers 401 for a missing secret', async () => {
    const ctx = await createTestApp({ grafanaAlertWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      payload: grafanaBody(),
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/webhooks/grafana-alert — dispatch', () => {
  it('enqueues a Cloud Task per alert when Cloud Tasks is configured', async () => {
    const enqueued: AlertEmailTaskInput[] = []
    const ctx = await createTestApp({
      grafanaAlertWebhookSecret: SECRET,
      alertEmailTaskEnqueuer: {
        enqueue: async (input) => {
          enqueued.push(input)
        },
      },
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': SECRET },
      payload: grafanaBody(),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.subject).toContain('FIRING')
    expect(enqueued[0]!.subject).toContain('tinytales-api ERROR logs')
    expect(enqueued[0]!.html).toContain('ERROR-level logs detected')
    expect(enqueued[0]!.dedupeKey).toBe('fp-abc123-firing')
  })

  it('escapes annotation text into the email body', async () => {
    const enqueued: AlertEmailTaskInput[] = []
    const ctx = await createTestApp({
      grafanaAlertWebhookSecret: SECRET,
      alertEmailTaskEnqueuer: { enqueue: async (input) => void enqueued.push(input) },
    })

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': SECRET },
      payload: grafanaBody({
        alerts: [
          {
            status: 'firing',
            fingerprint: 'fp-xss',
            labels: { alertname: '<script>alert(1)</script>' },
            annotations: {},
          },
        ],
      }),
    })

    expect(enqueued[0]!.html).not.toContain('<script>')
    expect(enqueued[0]!.html).toContain('&lt;script&gt;')
  })

  it('falls back to a direct Brevo send when Cloud Tasks is not configured', async () => {
    const calls: Array<{ to: Array<{ email: string }>; subject: string }> = []
    const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const ctx = await createTestApp({
      grafanaAlertWebhookSecret: SECRET,
      alerts: { brevoApiKey: 'k', emailFrom: 'hello@adix.test', emailTo: 'ops@tinytales.test' },
      alertEmailFetchImpl: fakeFetch,
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': SECRET },
      payload: grafanaBody(),
    })

    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toEqual([{ email: 'ops@tinytales.test' }])
  })

  it('still answers 200 when neither Cloud Tasks nor Brevo is configured', async () => {
    const ctx = await createTestApp({ grafanaAlertWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': SECRET },
      payload: grafanaBody(),
    })
    expect(res.statusCode).toBe(200)
  })

  it('does not throw on a malformed payload — never gives Grafana a reason to retry-storm', async () => {
    const ctx = await createTestApp({ grafanaAlertWebhookSecret: SECRET })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana-alert',
      headers: { 'x-grafana-alert-secret': SECRET },
      payload: { unexpected: 'shape' },
    })
    expect(res.statusCode).toBe(200)
  })
})
