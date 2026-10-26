/**
 * Unit tests for `ErrorAlerter` (src/lib/alerts.ts). No real network: a fake
 * `fetch` stands in for both Brevo and the GitHub API, and an injected `now`
 * drives the cooldown/storm-brake math deterministically. What's proved here:
 * fingerprint stability/collision rules, per-fingerprint cooldown dedupe, the
 * global storm brake, the Brevo request shape (incl. HTML escaping), the
 * suppressed-in-development / unconfigured path, and the GitHub
 * search-then-create-or-reuse flow.
 */

import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { ErrorAlerter, fingerprintError, type ClientErrorEvent } from '../../src/lib/alerts.js'

// --- test doubles -----------------------------------------------------------

interface LogCall {
  level: string
  fields?: unknown
  msg?: string | undefined
}

/** Minimal FastifyBaseLogger stand-in that just records calls. */
function createFakeLogger() {
  const calls: LogCall[] = []
  const record = (level: string) => (fieldsOrMsg: unknown, msg?: string) => {
    if (typeof fieldsOrMsg === 'string') calls.push({ level, msg: fieldsOrMsg })
    else calls.push({ level, fields: fieldsOrMsg, msg })
  }
  const logger = {
    level: 'info',
    info: record('info'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    warn: record('warn'),
    trace: record('trace'),
    silent: () => {},
    child() {
      return logger
    },
  }
  return { logger: logger as unknown as FastifyBaseLogger, calls }
}

interface RecordedCall {
  url: string
  init?: RequestInit | undefined
}

/** Fake fetch routing Brevo / GitHub-search / GitHub-create calls to configurable, mutable responses. */
function createFetchMock() {
  const calls: RecordedCall[] = []
  const state = {
    brevo: { ok: true, status: 200, text: '' },
    githubSearch: { ok: true, status: 200, body: { items: [] as Array<{ html_url: string }> } },
    githubCreate: { ok: true, status: 201, body: { html_url: 'https://github.com/acme/laanya-api/issues/1' } },
  }

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, init })

    if (urlStr.startsWith('https://api.brevo.com')) {
      const r = state.brevo
      return { ok: r.ok, status: r.status, text: async () => r.text, json: async () => ({}) } as Response
    }
    if (urlStr.includes('/search/issues')) {
      const r = state.githubSearch
      return {
        ok: r.ok,
        status: r.status,
        text: async () => JSON.stringify(r.body),
        json: async () => r.body,
      } as Response
    }
    if (urlStr.includes('/issues')) {
      const r = state.githubCreate
      return {
        ok: r.ok,
        status: r.status,
        text: async () => JSON.stringify(r.body),
        json: async () => r.body,
      } as Response
    }
    throw new Error(`unexpected fetch: ${urlStr}`)
  }) as unknown as typeof fetch

  return { impl, calls, state }
}

/** Fire-and-forget notify* calls schedule promise chains; one macrotask turn is enough for microtasks to fully drain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const BREVO = { apiKey: 'brevo-test-key', emailFrom: 'alerts@laanya.shop', emailTo: 'oncall@laanya.shop' }
const GITHUB = { token: 'gh-test-token', repo: 'acme/laanya-api' }

// --- fingerprintError ---------------------------------------------------------

describe('fingerprintError', () => {
  it('is a stable 12-char hex string for the same input', () => {
    const input = { kind: 'server', name: 'Error', message: 'boom', route: 'GET /v1/x' } as const
    const fp1 = fingerprintError(input)
    const fp2 = fingerprintError(input)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[0-9a-f]{12}$/)
  })

  it('collides messages that differ only by a digit id', () => {
    const fp1 = fingerprintError({
      kind: 'server',
      name: 'NotFoundError',
      message: 'user 123 not found',
      route: 'GET /v1/addresses/:id',
    })
    const fp2 = fingerprintError({
      kind: 'server',
      name: 'NotFoundError',
      message: 'user 456 not found',
      route: 'GET /v1/addresses/:id',
    })
    expect(fp1).toBe(fp2)
  })

  it('collides messages that differ only by a UUID', () => {
    const fp1 = fingerprintError({
      kind: 'server',
      name: 'NotFoundError',
      message: 'address 4f9c2f6a-1c8e-4b8e-9f3a-2b1d5c7e8a90 not found',
      route: 'GET /v1/addresses/:id',
    })
    const fp2 = fingerprintError({
      kind: 'server',
      name: 'NotFoundError',
      message: 'address 00000000-0000-4000-8000-000000000000 not found',
      route: 'GET /v1/addresses/:id',
    })
    expect(fp1).toBe(fp2)
  })

  it('does NOT collide different routes for the same message', () => {
    const fp1 = fingerprintError({ kind: 'server', name: 'Error', message: 'boom', route: 'GET /v1/x' })
    const fp2 = fingerprintError({ kind: 'server', name: 'Error', message: 'boom', route: 'POST /v1/y' })
    expect(fp1).not.toBe(fp2)
  })

  it('does NOT collide different error names for the same message/route', () => {
    const fp1 = fingerprintError({ kind: 'server', name: 'TypeError', message: 'boom', route: 'GET /v1/x' })
    const fp2 = fingerprintError({ kind: 'server', name: 'RangeError', message: 'boom', route: 'GET /v1/x' })
    expect(fp1).not.toBe(fp2)
  })

  it('ignores line:col churn in stack frames (paths only)', () => {
    const stackA = 'Error: boom\n    at handler (/app/src/routes/foo.js:10:5)'
    const stackB = 'Error: boom\n    at handler (/app/src/routes/foo.js:99:1)'
    const fp1 = fingerprintError({ kind: 'server', name: 'Error', message: 'boom', route: 'GET /v1/x', stack: stackA })
    const fp2 = fingerprintError({ kind: 'server', name: 'Error', message: 'boom', route: 'GET /v1/x', stack: stackB })
    expect(fp1).toBe(fp2)
  })

  it('ignores framework/async churn in the stack tail (in-app frames only)', () => {
    // Same throw site in our own code, but different RUNTIME tails: one thrown
    // synchronously, one from a deeper async continuation (extra node_modules
    // runner frame + a node: internal). The tail must not change the identity —
    // otherwise the same bug pages twice across an await boundary. Mirrors the
    // real vitest stack shapes that motivated the in-app filter in alerts.ts.
    const appFrame = '    at handler (/app/src/routes/foo.js:10:5)'
    const stackShallow = `Error: boom\n${appFrame}\n    at run (/app/node_modules/@vitest/runner/dist/x.js:155:11)`
    const stackDeep =
      `Error: boom\n${appFrame}\n    at run (/app/node_modules/@vitest/runner/dist/x.js:752:20)\n` +
      '    at processTicksAndRejections (node:internal/process/task_queues:103:5)'
    const base = { kind: 'server', name: 'Error', message: 'boom', route: 'GET /v1/x' } as const
    expect(fingerprintError({ ...base, stack: stackShallow })).toBe(fingerprintError({ ...base, stack: stackDeep }))
  })

  it('client fingerprint: type + normalized message + url pathname (ids still collapse)', () => {
    const fp1 = fingerprintError({
      kind: 'client',
      type: 'error',
      message: 'crash 123',
      urlPathname: '/checkout',
    })
    const fp2 = fingerprintError({
      kind: 'client',
      type: 'error',
      message: 'crash 456',
      urlPathname: '/checkout',
    })
    expect(fp1).toBe(fp2)
  })

  it('client fingerprint differs across event types for the same message/url', () => {
    const fp1 = fingerprintError({ kind: 'client', type: 'error', message: 'boom', urlPathname: '/x' })
    const fp2 = fingerprintError({ kind: 'client', type: 'console.error', message: 'boom', urlPathname: '/x' })
    expect(fp1).not.toBe(fp2)
  })
})

// --- suppressed in development / unconfigured -------------------------------

describe('suppressed sends', () => {
  it('suppresses (debug log, no fetch) in development even with Brevo configured', async () => {
    const { impl, calls } = createFetchMock()
    const { logger, calls: logCalls } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'development',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => 1_000,
    })

    alerter.notifyServerError(new Error('boom'), {
      method: 'GET',
      path: '/v1/x',
      requestId: 'req-1',
      statusCode: 500,
    })
    await flush()

    expect(calls).toHaveLength(0)
    expect(logCalls.some((c) => c.level === 'debug' && String(c.msg).includes('alert suppressed'))).toBe(true)
  })

  it('suppresses in staging/production when Brevo is not configured', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({ appEnv: 'production', log: logger, fetchImpl: impl, now: () => 1_000 })

    alerter.notifyServerError(new Error('boom'), {
      method: 'GET',
      path: '/v1/x',
      requestId: 'req-1',
      statusCode: 500,
    })
    await flush()

    expect(calls).toHaveLength(0)
  })
})

// --- cooldown dedupe ---------------------------------------------------------

describe('cooldown dedupe', () => {
  it('does not re-send within the 30-minute server cooldown, but does after it elapses', async () => {
    let now = 1_000_000
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => now,
    })
    const ctx = { method: 'GET', path: '/v1/x', requestId: 'req', statusCode: 500 } as const

    alerter.notifyServerError(new Error('boom'), { ...ctx, requestId: 'req-1' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(1)

    now += 10 * 60 * 1000 // +10 min — still within the 30-min cooldown
    alerter.notifyServerError(new Error('boom'), { ...ctx, requestId: 'req-2' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(1)

    now += 25 * 60 * 1000 // now 35 min after the first send — cooldown has elapsed
    alerter.notifyServerError(new Error('boom'), { ...ctx, requestId: 'req-3' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(2)
  })
})

// --- storm brake --------------------------------------------------------------

describe('storm brake', () => {
  it('caps at 20 emails within a rolling hour and logs a warning once the cap is hit', async () => {
    let now = 1_000_000
    const { impl, calls } = createFetchMock()
    const { logger, calls: logCalls } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => now,
    })

    // 21 DISTINCT fingerprints (different path each time), all within the hour.
    for (let i = 0; i < 21; i++) {
      alerter.notifyServerError(new Error(`boom-${i}`), {
        method: 'GET',
        path: `/v1/x${i}`,
        requestId: `req-${i}`,
        statusCode: 500,
      })
      await flush()
      now += 1_000
    }

    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(20)
    expect(
      logCalls.some((c) => c.level === 'warn' && String(c.msg).includes('storm brake'))
    ).toBe(true)
  })
})

// --- email payload shape + HTML escaping -------------------------------------

describe('Brevo email payload', () => {
  it('POSTs the expected endpoint/headers/subject/body shape', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'staging',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => 1_700_000_000_000,
    })

    alerter.notifyServerError(new Error('boom'), {
      method: 'POST',
      path: '/v1/addresses',
      requestId: 'req-1',
      userId: 'user-1',
      statusCode: 500,
    })
    await flush()

    const call = calls.find((c) => c.url === 'https://api.brevo.com/v3/smtp/email')
    expect(call).toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(call!.init?.headers).toMatchObject({
      'api-key': BREVO.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    })

    const body = JSON.parse(call!.init!.body as string) as {
      sender: { email: string; name: string }
      to: Array<{ email: string }>
      subject: string
      htmlContent: string
    }
    expect(body.sender).toEqual({ email: BREVO.emailFrom, name: 'Laanya Alerts' })
    expect(body.to).toEqual([{ email: BREVO.emailTo }])
    expect(body.subject).toContain('🚨')
    expect(body.subject).toContain('[staging]')
    expect(body.subject).toContain('POST /v1/addresses')
    expect(body.htmlContent).toContain('req-1')
    expect(body.htmlContent).toContain('user-1')
  })

  it('HTML-escapes a dangerous message before it reaches the email body', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => 1_000,
    })

    const err = new Error('<script>alert(1)</script> & "quoted"')
    alerter.notifyServerError(err, {
      method: 'GET',
      path: '/v1/x',
      requestId: 'req-1',
      statusCode: 500,
    })
    await flush()

    const call = calls.find((c) => c.url === 'https://api.brevo.com/v3/smtp/email')
    const body = JSON.parse(call!.init!.body as string) as { htmlContent: string }
    expect(body.htmlContent).not.toContain('<script>')
    expect(body.htmlContent).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body.htmlContent).toContain('&amp;')
    expect(body.htmlContent).toContain('&quot;quoted&quot;')
  })

  it('logs at error level (full detail) when Brevo responds non-2xx', async () => {
    const { impl, state } = createFetchMock()
    state.brevo = { ok: false, status: 500, text: 'internal server error' }
    const { logger, calls: logCalls } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      fetchImpl: impl,
      now: () => 1_000,
    })

    alerter.notifyServerError(new Error('boom'), {
      method: 'GET',
      path: '/v1/x',
      requestId: 'req-1',
      statusCode: 500,
    })
    await flush()

    const errorLog = logCalls.find((c) => c.level === 'error' && String(c.msg).includes('Brevo email send failed'))
    expect(errorLog).toBeDefined()
    expect(errorLog?.fields).toMatchObject({ status: 500, body: 'internal server error' })
  })
})

// --- GitHub issue integration --------------------------------------------

describe('GitHub issue integration', () => {
  it('creates an issue on first alert, then reuses it via search once the fingerprint is seen again after cooldown', async () => {
    let now = 1_000_000
    const { impl, calls, state } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      github: GITHUB,
      fetchImpl: impl,
      now: () => now,
    })
    const ctx = { method: 'GET', path: '/v1/x', requestId: 'req-1', statusCode: 500 } as const

    alerter.notifyServerError(new Error('boom'), ctx)
    await flush()

    const createCalls = calls.filter(
      (c) => c.url === 'https://api.github.com/repos/acme/laanya-api/issues' && c.init?.method === 'POST'
    )
    expect(createCalls).toHaveLength(1)
    const createBody = JSON.parse(createCalls[0]!.init!.body as string) as {
      title: string
      labels: string[]
      body: string
    }
    expect(createBody.labels).toEqual(['auto-fix-candidate', 'production'])
    expect(createBody.title).toMatch(/\[fp:[0-9a-f]{12}\]$/)
    expect(createBody.body).toContain('## Instructions for the automated fixer')

    const firstEmail = calls.find((c) => c.url === 'https://api.brevo.com/v3/smtp/email')
    const firstEmailBody = JSON.parse(firstEmail!.init!.body as string) as { htmlContent: string }
    expect(firstEmailBody.htmlContent).toContain('https://github.com/acme/laanya-api/issues/1')

    // Search now reports the issue just created as open, for the same fingerprint.
    state.githubSearch = { ok: true, status: 200, body: { items: [{ html_url: state.githubCreate.body.html_url }] } }

    now += 31 * 60 * 1000 // past the 30-minute server cooldown — a second alert fires
    alerter.notifyServerError(new Error('boom'), { ...ctx, requestId: 'req-2' })
    await flush()

    const createCallsAfter = calls.filter(
      (c) => c.url === 'https://api.github.com/repos/acme/laanya-api/issues' && c.init?.method === 'POST'
    )
    // Still just the one creation — the second alert found and reused the existing issue.
    expect(createCallsAfter).toHaveLength(1)

    const searchCalls = calls.filter((c) => c.url.includes('/search/issues'))
    expect(searchCalls.length).toBeGreaterThanOrEqual(2)
    expect(searchCalls[0]!.url).toContain(encodeURIComponent('fp:'))
    expect(searchCalls[0]!.init).toMatchObject({
      headers: {
        authorization: `Bearer ${GITHUB.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'laanya-api-alerter',
      },
    })
  })

  it('omitting github config skips issue creation entirely (email still sends)', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({ appEnv: 'production', log: logger, brevo: BREVO, fetchImpl: impl, now: () => 1_000 })

    alerter.notifyServerError(new Error('boom'), {
      method: 'GET',
      path: '/v1/x',
      requestId: 'req-1',
      statusCode: 500,
    })
    await flush()

    expect(calls.some((c) => c.url.includes('github.com'))).toBe(false)
    expect(calls.some((c) => c.url.startsWith('https://api.brevo.com'))).toBe(true)
  })
})

// --- notifyClientEvents -------------------------------------------------

describe('notifyClientEvents', () => {
  it('applies the 60-minute cooldown to noisy classes (console.error/memory/rerender) vs 30 for error/unhandledrejection', async () => {
    let now = 1_000_000
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({ appEnv: 'production', log: logger, brevo: BREVO, fetchImpl: impl, now: () => now })

    const noisyEvent: ClientErrorEvent = { type: 'console.error', message: 'noisy warning', url: '/home' }

    alerter.notifyClientEvents([noisyEvent], { ip: '1.2.3.4', source: 'mobile' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(1)

    now += 45 * 60 * 1000 // +45 min — within the 60-min noisy cooldown
    alerter.notifyClientEvents([noisyEvent], { ip: '1.2.3.4', source: 'mobile' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(1)

    now += 20 * 60 * 1000 // now 65 min after the first send — past the 60-min cooldown
    alerter.notifyClientEvents([noisyEvent], { ip: '1.2.3.4', source: 'mobile' })
    await flush()
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(2)
  })

  it('dedupes two events on the same pathname whose urls differ only by query string', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({ appEnv: 'production', log: logger, brevo: BREVO, fetchImpl: impl, now: () => 1_000 })

    alerter.notifyClientEvents(
      [{ type: 'error', message: 'crash', url: 'https://laanya.shop/checkout?ref=a' }],
      { ip: '1.2.3.4', source: 'web' }
    )
    await flush()
    alerter.notifyClientEvents(
      [{ type: 'error', message: 'crash', url: 'https://laanya.shop/checkout?ref=b' }],
      { ip: '1.2.3.4', source: 'web' }
    )
    await flush()

    // Same pathname (query string ignored) + same type/message => same
    // fingerprint => the second is within cooldown and sends no second email.
    expect(calls.filter((c) => c.url.startsWith('https://api.brevo.com'))).toHaveLength(1)
  })

  it('uses a warning glyph for noisy classes and a siren for error/unhandledrejection', async () => {
    const { impl, calls } = createFetchMock()
    const { logger } = createFakeLogger()
    const alerter = new ErrorAlerter({ appEnv: 'production', log: logger, brevo: BREVO, fetchImpl: impl, now: () => 1_000 })

    alerter.notifyClientEvents(
      [{ type: 'memory', message: 'high memory usage', url: '/home' }],
      { ip: '1.2.3.4', source: 'mobile' }
    )
    await flush()
    const noisyBody = JSON.parse(calls[0]!.init!.body as string) as { subject: string }
    expect(noisyBody.subject).toContain('⚠️')

    alerter.notifyClientEvents(
      [{ type: 'unhandledrejection', message: 'promise rejected', url: '/checkout' }],
      { ip: '1.2.3.4', source: 'web' }
    )
    await flush()
    const crashBody = JSON.parse(calls[1]!.init!.body as string) as { subject: string }
    expect(crashBody.subject).toContain('🚨')
  })

  it('never throws even if fetch itself rejects (network failure)', async () => {
    const { logger, calls: logCalls } = createFakeLogger()
    const failingFetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const alerter = new ErrorAlerter({
      appEnv: 'production',
      log: logger,
      brevo: BREVO,
      fetchImpl: failingFetch,
      now: () => 1_000,
    })

    expect(() =>
      alerter.notifyServerError(new Error('boom'), {
        method: 'GET',
        path: '/v1/x',
        requestId: 'req-1',
        statusCode: 500,
      })
    ).not.toThrow()
    await flush()

    expect(logCalls.some((c) => c.level === 'error' && String(c.msg).includes('Brevo email send threw'))).toBe(true)
  })
})
