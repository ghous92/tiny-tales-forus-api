/**
 * MSG91 SMS adapter: `POST /api/v5/flow/` with an authkey header.
 *
 * India's DLT rules sit behind this channel. Every SMS is scrubbed against the
 * text registered on the DLT portal, and anything that differs outside a
 * variable is blocked. The wording therefore lives in the MSG91 template (which
 * is linked to the DLT template id), never here: this adapter only supplies the
 * template id and the variable values.
 *
 * - `message.template.name` is the MSG91 template id, NOT the DLT template id.
 * - `params` are POSITIONAL and map to `var1..varN`, so the MSG91 template must
 *   name its variables `var1`, `var2`, ... in reading order.
 * - `short_url` stays off: a rewritten link is text DLT never approved.
 *
 * No DB imports, no config imports, same as `whatsappCloud.ts`.
 */

import type { NotificationChannel, NotificationMessage, SendResult } from './types.js'

const FLOW_URL = 'https://control.msg91.com/api/v5/flow/'
const SEND_TIMEOUT_MS = 15_000

export interface Msg91SmsConfig {
  authKey: string
}

interface FlowResponse {
  type?: string
  message?: string
}

function recipientVars(message: NotificationMessage): Record<string, string> {
  return Object.fromEntries(message.params.map((value, index) => [`var${index + 1}`, value]))
}

export function createMsg91SmsChannel(
  config: Msg91SmsConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): NotificationChannel {
  return {
    async send(target: string, message: NotificationMessage): Promise<SendResult> {
      const templateId = message.template?.name
      // Every SMS kind is template-required, so reaching this is a wiring bug.
      if (templateId === undefined) {
        return { ok: false, error: 'SMS send failed: no MSG91 template id resolved' }
      }
      try {
        const res = await fetchImpl(FLOW_URL, {
          method: 'POST',
          headers: { authkey: config.authKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            template_id: templateId,
            short_url: '0',
            recipients: [{ mobiles: target, ...recipientVars(message) }],
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
        const body = (await res.json().catch(() => undefined)) as FlowResponse | undefined
        // MSG91 can answer 200 with `type: "error"`, so read both.
        if (!res.ok || body?.type !== 'success') {
          const detail = body?.message ?? `HTTP ${res.status}`
          return {
            ok: false,
            error: `SMS send failed (template ${templateId}, sent ${message.params.length} vars): ${detail}`,
          }
        }
        return { ok: true, providerMessageId: body.message }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'SMS send failed (network error)',
        }
      }
    },
  }
}
