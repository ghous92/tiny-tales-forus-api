/**
 * Minimal Brevo transactional-email sender, for features that need to send a
 * specific recipient a specific message (unlike `lib/alerts.ts`'s
 * `ErrorAlerter`, which always mails one fixed operator inbox and owns its
 * own dedupe/cooldown/storm-brake pipeline — those two concerns don't share
 * a shape, so this stays a separate, self-contained sender rather than a
 * refactor of that already-hardened module).
 *
 * Same safety rule as `lib/alerts.ts`: HTML is inline-styled only (no
 * `<style>` blocks — most clients strip them), and every interpolated value
 * must be passed through {@link escapeHtml} before it lands in a template
 * literal.
 */

export interface EmailSenderConfig {
  apiKey: string
  fromEmail: string
  fromName: string
}

export interface EmailRecipient {
  email: string
  name?: string
}

export interface SendEmailInput {
  to: EmailRecipient[]
  subject: string
  html: string
}

/** `&` first, or it would double-escape the entities produced by the other replacements. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * POST one transactional email via the Brevo HTTP API. Throws on a non-2xx
 * response or a transport failure — callers that must never let an email
 * failure break their own request (e.g. a ticket already written to the DB)
 * are responsible for catching and logging, not this function.
 */
export async function sendTransactionalEmail(
  config: EmailSenderConfig,
  input: SendEmailInput,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<void> {
  const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: config.fromEmail, name: config.fromName },
      to: input.to.map((r) => (r.name ? { email: r.email, name: r.name } : { email: r.email })),
      subject: input.subject,
      htmlContent: input.html,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Brevo email send failed: ${res.status} ${text}`)
  }
}
