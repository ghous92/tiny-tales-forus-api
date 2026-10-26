/**
 * `POST /v1/internal/alert-email` — the receiving end of the Cloud Task
 * `lib/alertEmailTask.ts` enqueues from `routes/grafanaAlertWebhook.ts`.
 *
 * Same gate as `internalSweepRoutes` (`plugins/scheduler.ts`'s
 * `authenticateScheduler`) since the caller is Cloud Tasks, authenticating
 * with the same OIDC service account Cloud Scheduler uses — this route is
 * NOT reachable from the Grafana webhook directly, only via the queue, which
 * is what buys the retry-on-failure behavior the alert path needs.
 *
 * A send failure throws (→ 500), which Cloud Tasks retries per the
 * `tinytales-sweeps` queue's `MAX_ATTEMPTS`; unlike the sweep debounce, there is
 * no daily backstop cron for this path, so the queue's own retry is the only
 * safety net and must not be swallowed.
 */

import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/fulfilment.js'
import type { EmailSenderConfig } from '../lib/email.js'
import { sendTransactionalEmail } from '../lib/email.js'

const AlertEmailBodySchema = z
  .object({
    subject: z.string().min(1),
    html: z.string().min(1),
  })
  .strict()

const AlertEmailResponseSchema = z.object({ sent: z.boolean() })

export interface InternalAlertEmailRoutesOptions {
  /** Absent ⇒ 503 — mirrors every other Brevo-gated route in this codebase. */
  email?: EmailSenderConfig | undefined
  /** `ALERT_EMAIL_TO` — the fixed operator inbox every alert lands in. */
  alertEmailTo: string
  emailFetchImpl?: typeof fetch
}

export const internalAlertEmailRoutes: FastifyPluginAsyncZod<
  InternalAlertEmailRoutesOptions
> = async (app, opts) => {
  const { email, alertEmailTo, emailFetchImpl } = opts

  app.addHook('onRequest', app.authenticateScheduler)

  app.post(
    '/alert-email',
    {
      schema: {
        body: AlertEmailBodySchema,
        response: {
          200: AlertEmailResponseSchema,
          '4xx': ErrorEnvelopeSchema,
          '5xx': ErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      if (email === undefined) {
        return reply.code(503).send({
          error: { code: 'alerting_disabled', message: 'Brevo is not configured' },
        })
      }
      const { subject, html } = request.body
      await sendTransactionalEmail(
        email,
        { to: [{ email: alertEmailTo }], subject, html },
        emailFetchImpl
      )
      return { sent: true }
    }
  )
}
