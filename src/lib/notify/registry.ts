/**
 * Channel name → adapter. Absent/undefined means "not configured", which is a
 * SUPPORTED state (docs/SPEC-MANUAL-FULFILMENT.md §4A) — same posture as
 * `payments`/`geocode`/analytics: a deploy with no WhatsApp credentials must
 * not throw, it must resolve every send as `skipped_unconfigured`.
 *
 * Deliberately a plain object type rather than a class: the registry is built
 * once in `app.ts` from whatever `lib/notify/*` adapters the environment
 * configured, and `services/opsNotifications.ts`'s callers just index into it.
 */

import type { NotificationChannel } from './types.js'

export type NotificationChannelRegistry = Partial<Record<string, NotificationChannel>>

/** Look up a channel by name. Undefined means unconfigured, not an error. */
export function resolveChannel(
  registry: NotificationChannelRegistry,
  channel: string
): NotificationChannel | undefined {
  return registry[channel]
}
