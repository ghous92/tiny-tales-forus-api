/**
 * `POST /v1/webhooks/grafana-alert` — Grafana Cloud's unified-alerting webhook
 * contact point lands here when the ERROR-severity log alert rule fires (or
 * resolves) for `laanya-api`.
 *
 * Unauthenticated at the Fastify level, unlike everything else that touches
 * an internal boundary in this codebase: Grafana cannot produce a Google OIDC
 * token (`plugins/scheduler.ts`'s `authenticateScheduler`), so this route
 * gates itself with a constant-time shared-secret compare instead — the same
 * pattern `routes/fulfilment.ts` uses for the Delhivery carrier webhook,
 * which has the identical problem (a third party that can't hold a GCP
 * identity). Secret absent ⇒ 503, same closed-by-default posture.
 *
 * Always answers 200 once the secret checks out, even if the downstream
 * enqueue/send fails (logged, not thrown) — Grafana retries a non-2xx
 * webhook, and a retry storm here would just be duplicate alert emails, not
 * recovered delivery, since a Brevo failure is Cloud Tasks' job to retry (see
 * `routes/internalAlertEmail.ts`), not Grafana's.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/fulfilment.js'
import { escapeHtml, sendTransactionalEmail, type EmailSenderConfig } from '../lib/email.js'
import type { AlertEmailTaskEnqueuer } from '../lib/alertEmailTask.js'

/** Constant-time compare that tolerates length mismatch (the naive version leaks length). */
function secretMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Grafana's unified-alerting webhook body — parsed defensively (untyped walk,
// not a strict zod shape) because an unrecognized field or a Grafana version
// bump must never turn into a 400 that Grafana retries forever.
const GrafanaWebhookBodySchema = z.object({}).passthrough()

const AckSchema = z.object({ received: z.boolean() })

export interface GrafanaAlertWebhookOptions {
  /** `GRAFANA_ALERT_WEBHOOK_SECRET`. Absent ⇒ the webhook answers 503. */
  webhookSecret?: string | undefined
  /** Preferred path: enqueue via Cloud Tasks for retry-on-Brevo-failure. */
  taskEnqueuer?: AlertEmailTaskEnqueuer | undefined
  /**
   * Fallback used only when Cloud Tasks isn't configured — this is the
   * "crucial error" alert path and has no cron backstop, so a missing queue
   * must still deliver the email rather than silently drop the alert.
   */
  email?: EmailSenderConfig | undefined
  alertEmailTo: string
  emailFetchImpl?: typeof fetch
}

interface ParsedAlert {
  status: string
  name: string
  fingerprint: string
  summary: string
  description: string
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function parseAlerts(body: unknown): ParsedAlert[] {
  if (body === null || typeof body !== 'object') return []
  const b = body as Record<string, unknown>
  const alerts = Array.isArray(b.alerts) ? b.alerts : []
  return alerts.map((raw): ParsedAlert => {
    const a = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const labels =
      a.labels !== null && typeof a.labels === 'object'
        ? (a.labels as Record<string, unknown>)
        : {}
    const annotations =
      a.annotations !== null && typeof a.annotations === 'object'
        ? (a.annotations as Record<string, unknown>)
        : {}
    return {
      status: stringField(a, 'status') || 'firing',
      name: stringField(labels, 'alertname') || 'laanya-api alert',
      fingerprint: stringField(a, 'fingerprint') || randomUUID(),
      summary: stringField(annotations, 'summary'),
      description: stringField(annotations, 'description'),
    }
  })
}

function renderEmail(alert: ParsedAlert): { subject: string; html: string } {
  const verb = alert.status === 'resolved' ? 'RESOLVED' : 'FIRING'
  const subject = `[${verb}] ${alert.name} — laanya-api`
  const html = `
    <div style="font-family:sans-serif;font-size:14px;color:#111">
      <p style="font-weight:bold;font-size:16px">${escapeHtml(verb)}: ${escapeHtml(alert.name)}</p>
      ${alert.summary ? `<p>${escapeHtml(alert.summary)}</p>` : ''}
      ${alert.description ? `<p style="color:#555">${escapeHtml(alert.description)}</p>` : ''}
      <p style="color:#888;font-size:12px">fingerprint: ${escapeHtml(alert.fingerprint)}</p>
    </div>
  `.trim()
  return { subject, html }
}

export const grafanaAlertWebhookRoutes: FastifyPluginAsyncZod<GrafanaAlertWebhookOptions> = async (
  app,
  opts
) => {
  const { webhookSecret, taskEnqueuer, email, alertEmailTo, emailFetchImpl } = opts

  app.post(
    '/grafana-alert',
    {
      schema: {
        body: GrafanaWebhookBodySchema,
        response: {
          200: AckSchema,
          '4xx': ErrorEnvelopeSchema,
          '5xx': ErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      if (webhookSecret === undefined || webhookSecret === '') {
        return reply.code(503).send({
          error: { code: 'grafana_webhook_disabled', message: 'Grafana webhook is not configured' },
        })
      }

      const provided = request.headers['x-grafana-alert-secret'] ?? ''
      const token = Array.isArray(provided) ? (provided[0] ?? '') : provided
      if (!secretMatches(webhookSecret, token)) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'Invalid webhook secret' },
        })
      }

      const alerts = parseAlerts(request.body)
      for (const alert of alerts) {
        const { subject, html } = renderEmail(alert)
        const dedupeKey = `${alert.fingerprint}-${alert.status}`
        try {
          if (taskEnqueuer !== undefined) {
            await taskEnqueuer.enqueue({ subject, html, dedupeKey })
          } else if (email !== undefined) {
            await sendTransactionalEmail(email, { to: [{ email: alertEmailTo }], subject, html }, emailFetchImpl)
          } else {
            request.log.warn(
              { alert: alert.name },
              'Grafana alert received but neither Cloud Tasks nor Brevo is configured'
            )
          }
        } catch (err) {
          request.log.error({ err, alert: alert.name }, 'failed to dispatch Grafana alert email')
        }
      }

      return { received: true }
    }
  )
}
