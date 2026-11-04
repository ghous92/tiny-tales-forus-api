/**
 * Shipped-order email to the SHOPPER, sent through Brevo and the
 * `ops_notifications` outbox like every other customer message.
 *
 * Email rather than SMS because DLT blocks any SMS whose link is not
 * whitelisted as a CTA on the portal ("URL not found on DLT under cta"), and a
 * courier's tracking page never can be. An email carries the courier's own
 * link with no such rule.
 *
 * `params` are POSITIONAL: first name, order id, courier, AWB, tracking link
 * (`''` when the courier has none).
 *
 * No DB imports, no config imports, same as `msg91Sms.ts`.
 */

import { escapeHtml, sendTransactionalEmail, type EmailSenderConfig } from '../email.js'
import type { NotificationChannel, NotificationMessage, SendResult } from './types.js'

function render(message: NotificationMessage): { subject: string; html: string } {
  const [firstName = '', orderId = '', courier = '', awb = '', trackingUrl = ''] = message.params
  const greeting = firstName === '' ? 'Hi,' : `Hi ${escapeHtml(firstName)},`
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b6b6b">${label}</td><td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`
  const track =
    trackingUrl === ''
      ? ''
      : `<p style="margin:20px 0"><a href="${escapeHtml(trackingUrl)}" style="background:#1f1f1f;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none">Track your parcel</a></p>`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;max-width:520px">
<p>${greeting}</p>
<p>Your Tiny Tales order has shipped.</p>
<table style="border-collapse:collapse">${row('Order', orderId)}${row('Courier', courier)}${row('AWB', awb)}</table>
${track}
<p style="color:#6b6b6b;font-size:13px">You can also see this order under My Orders at <a href="https://www.tinytalesforus.com/account/orders/">tinytalesforus.com</a>.</p>
<p>Tiny Tales, a brand of Adix AI</p>
</div>`
  return { subject: `Your Tiny Tales order ${orderId} has shipped`, html }
}

export function createShippedEmailChannel(
  config: EmailSenderConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): NotificationChannel {
  return {
    async send(target: string, message: NotificationMessage): Promise<SendResult> {
      const { subject, html } = render(message)
      try {
        await sendTransactionalEmail(config, { to: [{ email: target }], subject, html }, fetchImpl)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'shipped email failed' }
      }
    },
  }
}
