/**
 * Cloud Tasks producer for the Grafana-alert-to-email path
 * (`routes/grafanaAlertWebhook.ts` → this → `routes/internalAlertEmail.ts`).
 *
 * Unlike `SweepTaskKind` tasks (`lib/tasks.ts`), which deliberately carry no
 * payload, this task carries the fully-rendered email — there is no shared
 * sweep runner on the receiving end to re-derive it from, only a Grafana
 * webhook payload that already arrived once and shouldn't be re-fetched.
 */

import type { CloudTasksConfig } from './tasks.js'
import { enqueueRawCloudTask } from './tasks.js'

export interface AlertEmailTaskInput {
  subject: string
  html: string
  /**
   * Collapses a flapping alert into one task: derive from the Grafana alert's
   * `fingerprint` + `status` (firing/resolved) so re-notifications for the
   * same incident within Cloud Tasks' ~1h dedupe window are absorbed rather
   * than emailing the same incident repeatedly.
   */
  dedupeKey: string
}

export interface AlertEmailTaskEnqueuer {
  enqueue(input: AlertEmailTaskInput): Promise<void>
}

export function createAlertEmailTaskEnqueuer(
  cfg: CloudTasksConfig,
  fetchImpl: typeof fetch = fetch
): AlertEmailTaskEnqueuer {
  return {
    async enqueue({ subject, html, dedupeKey }) {
      // Cloud Tasks constrains task names to [a-zA-Z0-9_-]{1,500} — Grafana's
      // fingerprint is normally hex, but sanitize defensively rather than let
      // an unexpected character 400 the enqueue and drop the alert.
      const safeKey = dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 400)
      await enqueueRawCloudTask(
        cfg,
        {
          name: `alert-email-${safeKey}`,
          scheduleTime: new Date(),
          url: `${cfg.targetBaseUrl}/v1/internal/alert-email`,
          body: { subject, html },
        },
        fetchImpl
      )
    },
  }
}
