/**
 * Fastify/pino logger OPTIONS (not an instance — `fastify()` builds the real
 * pino instance from whatever this returns), factored out of `app.ts` so the
 * "what does a log line look like" decision lives in one place.
 *
 * GCP CLOUD LOGGING SEVERITY MAPPING — the reason this file exists: Cloud
 * Logging does not understand pino's numeric levels. Without a `severity`
 * field set to one of Cloud Logging's own strings (DEBUG/INFO/WARNING/ERROR/
 * CRITICAL/...), every line lands in the Logs Explorer as "Default" severity
 * regardless of how it was logged, which makes the severity facet useless and
 * silently defeats any log-based alerting policy filtered on severity>=ERROR
 * (exactly the kind of policy `lib/alerts.ts` exists to substitute for on the
 * app side). `messageKey: 'message'` is the other half of the same
 * convention: Cloud Logging's structured-log parser reads `message`, not
 * pino's default `msg`.
 *
 * ONE CODE PATH for every environment, including development — the severity
 * formatter is inert noise on a local terminal (pino-pretty or a raw JSON
 * line, either way harmless) but a dev-only branch here is one more place
 * dev and prod could silently diverge, for no real benefit.
 */

import type { FastifyServerOptions } from 'fastify'

type AppEnv = 'development' | 'staging' | 'production'

/** The object shape `fastify({ logger })` accepts, minus the `boolean` escape hatch we never use here. */
type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>

/** pino level label -> GCP Cloud Logging `severity` string. */
const GCP_SEVERITY_BY_LEVEL: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
}

/**
 * Build the logger options `buildApp` hands to `fastify()`. `appEnv` only
 * affects the `serviceContext.environment` binding below — the shape of every
 * log line is identical across environments (see file header).
 */
export function buildLoggerOptions(appEnv: AppEnv): LoggerOptions {
  return {
    // GCP convention (see file header) — Cloud Logging's parser looks for
    // `message`, not pino's default `msg`.
    messageKey: 'message',
    formatters: {
      level(label, number) {
        return { severity: GCP_SEVERITY_BY_LEVEL[label] ?? 'INFO', level: number }
      },
    },
    // Replaces pino's default `{ pid, hostname }` base bindings entirely.
    // Cloud Run containers are ephemeral and already identified by GCP's own
    // instance/revision metadata, so pid/hostname tell an operator nothing
    // actionable; `serviceContext` is what Cloud Logging's Error Reporting
    // integration groups errors by instead (and what `lib/alerts.ts` mirrors
    // in its own alert emails).
    base: { serviceContext: { service: 'tinytales-api', environment: appEnv } },
    // Tokens and other credentials must never reach the logs. Lives here
    // (rather than only inline in app.ts) so any other place that builds a
    // pino instance — none today, but e.g. a future worker/script — gets the
    // same redaction for free instead of having to remember it.
    redact: ['req.headers.authorization', 'req.headers.x-tinytales-proxy-auth'],
  }
}
