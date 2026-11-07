/**
 * "No photo to hand?" (contracts/customLeads.ts).
 *
 *   POST /v1/custom-leads   public, email required, rate-limited
 *
 * Ad visitors read the whole /custom/ page and left at the photo button: the
 * photo was on someone else's phone, or the gift was a surprise. This sends
 * them the prices, what makes a good photo, and a link back, and tells the team
 * inbox so someone can help with the photo. Nothing is stored.
 *
 * It sends mail to an address typed by anyone, so it is braked three ways: per
 * IP, per address (one email a day; a repeat answers ok and sends nothing, so
 * the answer never says whether an address was used), and a daily total.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema } from '../contracts/cart.js'
import {
  CustomLeadCreateSchema,
  CustomLeadResponseSchema,
  type CustomLeadCreate,
} from '../contracts/customLeads.js'
import {
  CUSTOM_FIGURE_BASE_PRICE_INR,
  MAX_FIGURE_CHARACTERS,
  customFigurePriceInr,
} from '../lib/customFigures.js'
import { escapeHtml, sendTransactionalEmail, type EmailSenderConfig } from '../lib/email.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const STOREFRONT = 'https://www.tinytalesforus.com'
/** The published support mailbox; mirrors the storefront's SUPPORT_EMAIL. */
const SUPPORT_EMAIL = 'hello@adix.ai'

const IP_LIMIT = 5
const IP_WINDOW_MS = 60 * 60_000
const ADDRESS_WINDOW_MS = 24 * 60 * 60_000
const DAILY_CAP = 300
const MAX_KEYS = 5_000

const ipBuckets = new Map<string, { count: number; windowStart: number }>()
const addressSent = new Map<string, number>()
let day = { key: '', count: 0 }

/** Fixed-window per-IP brake, same shape as routes/restock.ts. */
function ipLimited(ip: string, now: number): boolean {
  const entry = ipBuckets.get(ip)
  if (!entry || now - entry.windowStart >= IP_WINDOW_MS) {
    if (ipBuckets.size >= MAX_KEYS) {
      const oldest = ipBuckets.keys().next()
      if (!oldest.done) ipBuckets.delete(oldest.value)
    }
    ipBuckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > IP_LIMIT
}

/** True if this address was mailed in the last day; otherwise records it. */
function sentRecently(address: string, now: number): boolean {
  const at = addressSent.get(address)
  if (at !== undefined && now - at < ADDRESS_WINDOW_MS) return true
  if (addressSent.size >= MAX_KEYS) {
    const oldest = addressSent.keys().next()
    if (!oldest.done) addressSent.delete(oldest.value)
  }
  addressSent.delete(address)
  addressSent.set(address, now)
  return false
}

/** Counts against the day's total (India day); false once it is spent. */
function withinDailyCap(now: number): boolean {
  const key = new Date(now + 5.5 * 60 * 60_000).toISOString().slice(0, 10)
  if (day.key !== key) day = { key, count: 0 }
  day.count += 1
  return day.count <= DAILY_CAP
}

/** Test seam — resets the brakes between cases. */
export function clearCustomLeadLimits(): void {
  ipBuckets.clear()
  addressSent.clear()
  day = { key: '', count: 0 }
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`

function shopperHtml(lead: CustomLeadCreate): string {
  const kind = lead.kind ?? 'miniature'
  const link =
    `${STOREFRONT}/custom/?kind=${kind}` +
    '&utm_source=email&utm_medium=lead&utm_campaign=custom-photo-later'
  const prices = Array.from({ length: MAX_FIGURE_CHARACTERS }, (_, i) => i + 1)
    .map(
      (n) =>
        `<tr><td style="padding:4px 16px 4px 0;">${n} ${n === 1 ? 'person or pet' : 'people or pets'}</td>` +
        `<td style="padding:4px 0;font-weight:bold;">${inr(customFigurePriceInr(CUSTOM_FIGURE_BASE_PRICE_INR, n))}</td></tr>`
    )
    .join('')
  // Timeline words mirror the storefront's policy.ts (CUSTOM_PROOF_DAYS, CUSTOM_LEAD_DAYS).
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5;">` +
    `<p>Here is what you asked for on tinytalesforus.com, for when you have the photo.</p>` +
    `<p style="font-weight:bold;margin-bottom:4px;">What it costs</p>` +
    `<p style="margin-top:0;">One photo makes one piece. The price is set by how many are in it:</p>` +
    `<table style="border-collapse:collapse;">${prices}</table>` +
    `<p style="font-weight:bold;margin-bottom:4px;">How long it takes</p>` +
    `<p style="margin-top:0;">We send you a 3D proof 1–2 working days after you order. Nothing is printed until you approve it. ` +
    `After you approve, we make and paint it in 7–12 working days, then the courier brings it. ` +
    `For a birthday, wedding or anniversary, order about four weeks before.</p>` +
    `<p style="font-weight:bold;margin-bottom:4px;">The photo to ask for</p>` +
    `<ul style="margin-top:0;padding-left:20px;">` +
    `<li>Recent, so the piece looks like them today.</li>` +
    `<li>Facing the camera, shoulders square. We model the sides from the front.</li>` +
    `<li>Daylight on the face, not behind them, and in focus.</li>` +
    `<li>The original from the phone, not a screenshot or a forwarded copy.</li>` +
    (kind === 'miniature'
      ? `<li>Close enough to see each one clearly. A full-length photo helps with clothes and shoes.</li>`
      : `<li>Close enough that the face fills much of the photo.</li>`) +
    `</ul>` +
    `<p style="margin:24px 0;"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold;">Start your piece</a></p>` +
    `<p style="color:#555;font-size:13px;">Questions, or not sure a photo will work? Write to ${SUPPORT_EMAIL}. ` +
    `You are not on a mailing list; this is the one email you asked for.</p>` +
    `</div>`
  )
}

function teamHtml(lead: CustomLeadCreate): string {
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;">` +
    `<p>Someone on /custom/ had no photo to hand and asked for the prices by email. ` +
    `They were sent the prices, photo tips and a link back. A short personal note offering help with the photo may win the order.</p>` +
    `<p>Email: <b>${escapeHtml(lead.email)}</b><br>` +
    `Kind: ${escapeHtml(lead.kind ?? 'not chosen')}<br>` +
    `Needed by: ${escapeHtml(lead.neededBy ?? 'not given')}</p>` +
    `<p style="color:#555;font-size:13px;">They were told someone from the team may write once to help with the photo. Write once at most.</p>` +
    `</div>`
  )
}

export interface CustomLeadRoutesOptions {
  /** Absent -> 503 `email_disabled`: there is nothing to send with. */
  email?: EmailSenderConfig | undefined
  /** `ALERT_EMAIL_TO`: the team inbox told about each one. Absent -> only the shopper is mailed. */
  alertEmailTo?: string | undefined
  /** Test seam: injected fetch for the Brevo calls. */
  emailFetchImpl?: typeof fetch
}

/** Mounted at '/v1/custom-leads' by app.ts. Public. */
export const customLeadRoutes: FastifyPluginAsyncZod<CustomLeadRoutesOptions> = async (
  app,
  { email, alertEmailTo, emailFetchImpl }
) => {
  app.post(
    '/',
    {
      schema: {
        body: CustomLeadCreateSchema,
        response: { 200: CustomLeadResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const now = Date.now()
      if (ipLimited(request.ip, now)) {
        return reply.code(429).send({
          error: { code: 'limit_exceeded', message: 'Too many requests. Try again later.' },
        })
      }
      if (!email) {
        return reply.code(503).send({
          error: { code: 'email_disabled', message: 'Email is not available right now.' },
        })
      }
      const lead = { ...request.body, email: request.body.email.trim().toLowerCase() }
      if (sentRecently(lead.email, now)) return { ok: true as const }
      if (!withinDailyCap(now)) {
        request.log.warn('custom lead: daily cap reached')
        return reply.code(503).send({
          error: { code: 'email_busy', message: 'We cannot send more today. Try again tomorrow.' },
        })
      }
      try {
        await sendTransactionalEmail(
          email,
          {
            to: [{ email: lead.email }],
            subject: 'Your Tiny Tales prices, and a link back',
            html: shopperHtml(lead),
          },
          emailFetchImpl
        )
      } catch (err) {
        // Let them try again rather than wait a day for an email that never came.
        addressSent.delete(lead.email)
        request.log.error({ err }, 'custom lead: failed to send the prices email')
        return reply.code(502).send({
          error: { code: 'email_failed', message: 'That did not go through. Try again in a minute.' },
        })
      }
      request.log.info({ kind: lead.kind ?? null }, 'custom lead: prices emailed')
      if (alertEmailTo) {
        // Best-effort: the shopper has their email already.
        await sendTransactionalEmail(
          email,
          {
            to: [{ email: alertEmailTo }],
            subject: `Photo later: ${lead.email} (${lead.kind ?? 'kind not chosen'}${lead.neededBy ? `, needed by ${lead.neededBy}` : ''})`,
            html: teamHtml(lead),
          },
          emailFetchImpl
        ).catch((err: unknown) => {
          request.log.error({ err }, 'custom lead: failed to tell the team')
        })
      }
      return { ok: true as const }
    }
  )
}
