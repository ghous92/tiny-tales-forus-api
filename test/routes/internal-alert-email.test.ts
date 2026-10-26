/**
 * `POST /v1/internal/alert-email` — the receiving end of the Cloud Task
 * `lib/alertEmailTask.ts` enqueues. Same OIDC gate as `/v1/internal/sweeps/*`
 * (test/routes/internal-sweeps.test.ts covers that gate exhaustively; this
 * file only re-confirms it's wired, then focuses on what's specific here:
 * unconfigured Brevo answers 503 rather than pretending to send, and a
 * successful send calls Brevo with the fixed operator inbox.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  auth,
  createTestApp,
  SCHEDULER_AUDIENCE,
  SCHEDULER_SA,
  SCHEDULER_STRANGER,
  USER_A,
} from '../helpers/app.js'

const SCHEDULER = { audience: SCHEDULER_AUDIENCE, allowedServiceAccounts: [SCHEDULER_SA.email] }
const BREVO_API_KEY = 'brevo_test_fake'
const EMAIL_FROM = 'hello@adix.test'
const EMAIL_TO = 'ops@laanya.test'

function oidc(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

describe('POST /v1/internal/alert-email — auth', () => {
  it('answers 503 scheduler_disabled when no audience/allowlist is configured', async () => {
    const ctx = await createTestApp()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: oidc(SCHEDULER_SA.token),
      payload: { subject: 'x', html: 'x' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('scheduler_disabled')
  })

  it('403s a valid token from a service account that is not allowlisted', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: oidc(SCHEDULER_STRANGER.token),
      payload: { subject: 'x', html: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects a Firebase customer token — the human gate is not the machine gate', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: auth(USER_A.token),
      payload: { subject: 'x', html: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/internal/alert-email — send', () => {
  it('answers 503 alerting_disabled when Brevo is not configured', async () => {
    const ctx = await createTestApp({ scheduler: SCHEDULER })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: oidc(SCHEDULER_SA.token),
      payload: { subject: 'x', html: 'x' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('alerting_disabled')
  })

  it('sends via Brevo to the fixed operator inbox on a valid task callback', async () => {
    const calls: Array<{ to: Array<{ email: string }>; subject: string; htmlContent: string }> = []
    const fakeFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ messageId: 'fake' }), { status: 201 })
    }) as unknown as typeof fetch

    const ctx = await createTestApp({
      scheduler: SCHEDULER,
      alerts: { brevoApiKey: BREVO_API_KEY, emailFrom: EMAIL_FROM, emailTo: EMAIL_TO },
      alertEmailFetchImpl: fakeFetch,
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: oidc(SCHEDULER_SA.token),
      payload: { subject: '[FIRING] laanya-api error rate', html: '<p>boom</p>' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sent: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toEqual([{ email: EMAIL_TO }])
    expect(calls[0]!.subject).toBe('[FIRING] laanya-api error rate')
    expect(calls[0]!.htmlContent).toBe('<p>boom</p>')
  })

  it('surfaces a Brevo failure as a 500 so Cloud Tasks retries', async () => {
    const fakeFetch = vi.fn(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch

    const ctx = await createTestApp({
      scheduler: SCHEDULER,
      alerts: { brevoApiKey: BREVO_API_KEY, emailFrom: EMAIL_FROM, emailTo: EMAIL_TO },
      alertEmailFetchImpl: fakeFetch,
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/internal/alert-email',
      headers: oidc(SCHEDULER_SA.token),
      payload: { subject: 'x', html: 'x' },
    })
    expect(res.statusCode).toBe(500)
  })
})
