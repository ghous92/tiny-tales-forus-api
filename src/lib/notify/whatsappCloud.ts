/**
 * WhatsApp Business Cloud API adapter — Meta Graph API direct, no BSP
 * (docs/SPEC-MANUAL-FULFILMENT.md §8 decision 1). `POST
 * /{phone-number-id}/messages` with a permanent System User access token.
 *
 * Business-initiated messages require a PRE-APPROVED template (§3):
 * - Template `name` and `language` code must match the Meta Business Manager
 *   approval exactly, or the send fails with error 132001.
 * - Template variables may not contain newlines, tabs, or 4+ consecutive
 *   spaces (error 132000) — the caller's `params` must already be single-line,
 *   trimmed text; this adapter does not sanitise them.
 * - The COMPONENTS sent must match the ones approved. An image header and URL
 *   buttons are supported (customer retention templates use both), but each is
 *   sent only when the frozen message carries it, because a header sent to a
 *   template approved without one fails exactly as hard as a missing one.
 *
 * Bold (`*asterisks*`) and italics (`_underscores_`) live in the APPROVED
 * TEMPLATE TEXT, never in a parameter: a parameter cannot carry newlines and is
 * rejected for leading or trailing whitespace, so all structure is static and
 * only values vary.
 *
 * No DB imports, no config imports — credentials arrive as plain values from
 * the caller, exactly as `lib/razorpay.ts` and `lib/delhivery.ts` take theirs.
 */

import type { NotificationChannel, NotificationMessage, SendResult } from './types.js'

/**
 * Meta rejects a template send whose components do not match the approved
 * template's, and the error text is not always specific about which one.
 * Recorded here because it is the single likeliest cause of a send that fails
 * on every attempt while the credentials themselves are fine.
 *
 * Covers all three components, not just the body: since customer templates
 * carry image headers and URL buttons, "the counts disagree" now has three
 * places to be true, and an operator reading a stored error needs to know
 * which shape went out before they can tell which end is wrong.
 */
const PARAM_COUNT_HINT = 'check the approved template’s header/body/button components match'

/**
 * Describe the component shape actually sent, for the stored error.
 *
 * The row's own `last_error` is all an operator gets to work from later, and a
 * 132000 says only that Meta refused the payload. Naming what we sent — 5 body
 * params, an image header, 1 button — is what makes the mismatch visible
 * without a redeploy to add logging.
 */
function describeComponents(message: NotificationMessage): string {
  const parts = [`${message.params.length} body params`]
  if (message.header !== undefined) parts.push('image header')
  if (message.buttons !== undefined && message.buttons.length > 0) {
    parts.push(`${message.buttons.length} url button${message.buttons.length === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

/** One entry in the Graph API's `template.components` array. */
interface GraphComponent {
  type: string
  sub_type?: string
  index?: string
  parameters: unknown[]
}

/**
 * Assemble `template.components` from the frozen message.
 *
 * Order matters to readers, not to Meta: header, body, then buttons, matching
 * how the template reads top to bottom.
 *
 * Buttons are the awkward shape — each button is its OWN component, carrying
 * `sub_type: 'url'` and a stringified `index`, rather than one component
 * holding a list. Getting this wrong is a 132000 that names no button.
 */
function buildComponents(message: NotificationMessage): GraphComponent[] {
  const components: GraphComponent[] = []

  if (message.header !== undefined) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: message.header.link } }],
    })
  }

  // Emitted even when empty: a template approved with zero body variables
  // accepts an empty body component, and this preserves the exact payload
  // every existing ops kind already sends.
  components.push({
    type: 'body',
    parameters: message.params.map((text) => ({ type: 'text', text })),
  })

  for (const button of message.buttons ?? []) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(button.index),
      parameters: [{ type: 'text', text: button.suffix }],
    })
  }

  return components
}

export interface WhatsAppCloudConfig {
  /** The WABA phone number id (not the phone number itself). */
  phoneNumberId: string
  /** Permanent System User token — NOT the 24-hour dev token (SPEC §8). */
  accessToken: string
  /**
   * Fallback approved template name, e.g. `order_paid_ops`. Used when the
   * message carries no `template` override — see {@link NotificationMessage}.
   */
  templateName: string
  /** Fallback approved language code, e.g. `en` — must match the approval exactly. */
  templateLocale: string
}

/** Meta Graph API version this adapter targets. */
const GRAPH_API_VERSION = 'v21.0'

interface GraphSendResponse {
  messages?: Array<{ id?: string }>
  error?: { message?: string; code?: number }
}

/**
 * Build the channel adapter. Every call is independent (no shared state), so
 * this is safe to construct once at boot and reuse across requests, the same
 * way `createDelhiveryAdapter` is.
 */
export function createWhatsAppCloudChannel(
  config: WhatsAppCloudConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): NotificationChannel {
  return {
    async send(target: string, message: NotificationMessage): Promise<SendResult> {
      // Per-message override wins over the boot-time value, so an operator can
      // correct a wrong template name in config and have the retry sweep drain
      // the rows it already failed on — no redeploy, no dead backlog.
      const templateName = message.template?.name ?? config.templateName
      const templateLocale = message.template?.locale ?? config.templateLocale
      try {
        const res = await fetchImpl(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: target,
              type: 'template',
              template: {
                name: templateName,
                language: { code: templateLocale },
                components: buildComponents(message),
              },
            }),
          }
        )

        // Meta answers 200 with an error body on some rejections and non-2xx on
        // others (SPEC §3 — 132000/132001 are documented runtime failures, not
        // transport failures) — read success out of the status line AND the
        // body, never just one.
        const body = (await res.json().catch(() => undefined)) as GraphSendResponse | undefined
        if (!res.ok || body?.error) {
          const detail = body?.error?.message ?? `HTTP ${res.status}`
          // Name the template and the param count in the stored error. Both
          // 132000 and 132001 are "the template and this payload disagree",
          // and the row's own error text is all an operator gets to work from
          // later — without these two facts it says only that Meta said no.
          return {
            ok: false,
            error: `WhatsApp send failed (template ${templateName}/${templateLocale}, sent ${describeComponents(message)} — ${PARAM_COUNT_HINT}): ${detail}`,
          }
        }

        return { ok: true, providerMessageId: body?.messages?.[0]?.id }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'WhatsApp send failed (network error)',
        }
      }
    },
  }
}

/**
 * Send a FREE-FORM text message — no template.
 *
 * Legal only inside the 24-hour service window a customer opens by messaging
 * first, which is the whole economic basis of the concierge (TASK-04 §1): inside
 * that window Meta charges nothing and accepts arbitrary text, so no template
 * approval gates a reply. Outside it, Meta rejects this with error 131047 and
 * only an approved template will go — callers must check `windowOpen()` first
 * rather than discover it from a failed send.
 *
 * Separate from the {@link NotificationChannel} adapter above on purpose. That
 * one is the outbox's business-initiated path: templates, frozen params, retry
 * sweep. This is a reply inside a live conversation — different trigger,
 * different rules, no outbox row. Sharing the credentials is the only overlap.
 */
export async function sendSessionText(
  config: Pick<WhatsAppCloudConfig, 'phoneNumberId' | 'accessToken'>,
  to: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<SendResult> {
  try {
    const res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          // `preview_url: false` — a link in a reply must not render a preview
          // card built by fetching that URL from Meta's servers.
          text: { body: text, preview_url: false },
        }),
      }
    )
    const body = (await res.json().catch(() => undefined)) as GraphSendResponse | undefined
    if (!res.ok || body?.error) {
      const detail = body?.error?.message ?? `HTTP ${res.status}`
      // 131047 is specifically "the 24-hour window has closed". Name it, because
      // it is the one failure here that is not a bug and not a credential
      // problem — it is simply too late to reply this way.
      return { ok: false, error: `WhatsApp session send failed: ${detail}` }
    }
    return { ok: true, providerMessageId: body?.messages?.[0]?.id }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'WhatsApp session send failed (network error)',
    }
  }
}
