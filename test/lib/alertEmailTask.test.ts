/**
 * `lib/alertEmailTask.ts` — the alert-email Cloud Task producer. Unlike
 * `createCloudTasksEnqueuer` (`test/lib/tasks.test.ts`), this task carries a
 * real payload (subject/html), so the properties that matter here are: the
 * body actually lands on the wire, the URL points at `/v1/internal/alert-email`
 * (not a sweep route), and a flapping alert (same fingerprint+status) still
 * collapses to one task the way the sweep debounce does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAlertEmailTaskEnqueuer } from '../../src/lib/alertEmailTask.js'
import type { CloudTasksConfig } from '../../src/lib/tasks.js'

const CFG: CloudTasksConfig = {
  project: 'laanya-prod',
  location: 'asia-southeast1',
  queue: 'laanya-sweeps',
  targetBaseUrl: 'https://api.laanya.test',
  serviceAccountEmail: 'laanya-scheduler@laanya-prod.iam.gserviceaccount.com',
  audience: 'laanya-sweeps-prod',
}
const PARENT = 'projects/laanya-prod/locations/asia-southeast1/queues/laanya-sweeps'

beforeEach(() => {
  vi.resetModules()
})

function stubAuth(): void {
  vi.doMock('google-auth-library', () => ({
    GoogleAuth: class {
      getAccessToken(): Promise<string> {
        return Promise.resolve('fake-access-token')
      }
    },
  }))
}

describe('createAlertEmailTaskEnqueuer', () => {
  it('POSTs the rendered email to /v1/internal/alert-email, base64-encoded', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch

    await createAlertEmailTaskEnqueuer(CFG, fetchImpl).enqueue({
      subject: '[FIRING] laanya-api error rate',
      html: '<p>boom</p>',
      dedupeKey: 'abc123-firing',
    })

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${PARENT}/tasks`)
    const body = JSON.parse(String(init.body)) as {
      task: {
        name: string
        httpRequest: { url: string; body: string; oidcToken: { audience: string } }
      }
    }
    expect(body.task.name).toBe(`${PARENT}/tasks/alert-email-abc123-firing`)
    expect(body.task.httpRequest.url).toBe('https://api.laanya.test/v1/internal/alert-email')
    expect(
      JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString('utf8'))
    ).toEqual({ subject: '[FIRING] laanya-api error rate', html: '<p>boom</p>' })
    expect(body.task.httpRequest.oidcToken.audience).toBe(CFG.audience)
  })

  it('collapses a flapping alert (same fingerprint+status) into one task name', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch
    const enqueuer = createAlertEmailTaskEnqueuer(CFG, fetchImpl)

    await enqueuer.enqueue({ subject: 'a', html: 'a', dedupeKey: 'fp1-firing' })
    await enqueuer.enqueue({ subject: 'b', html: 'b', dedupeKey: 'fp1-firing' })

    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    const names = calls.map(
      ([, init]) => (JSON.parse(String(init.body)) as { task: { name: string } }).task.name
    )
    expect(names[0]).toBe(names[1])
  })

  it('sanitizes a dedupeKey outside Cloud Tasks name constraints', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    ) as unknown as typeof fetch

    await createAlertEmailTaskEnqueuer(CFG, fetchImpl).enqueue({
      subject: 'a',
      html: 'a',
      dedupeKey: 'weird:key/with spaces!',
    })

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    const body = JSON.parse(String(init.body)) as { task: { name: string } }
    expect(body.task.name).toMatch(/^projects\/.*\/tasks\/alert-email-[a-zA-Z0-9_-]+$/)
  })

  it('treats 409 ALREADY_EXISTS as success', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response('already exists', { status: 409 })
    ) as unknown as typeof fetch
    await expect(
      createAlertEmailTaskEnqueuer(CFG, fetchImpl).enqueue({
        subject: 'a',
        html: 'a',
        dedupeKey: 'x',
      })
    ).resolves.toBeUndefined()
  })

  it('throws on any other failure', async () => {
    stubAuth()
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 403 })
    ) as unknown as typeof fetch
    await expect(
      createAlertEmailTaskEnqueuer(CFG, fetchImpl).enqueue({
        subject: 'a',
        html: 'a',
        dedupeKey: 'x',
      })
    ).rejects.toThrow(/403/)
  })
})
