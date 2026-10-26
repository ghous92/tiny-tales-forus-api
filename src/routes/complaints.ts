/**
 * /v1/complaints — HTTP layer only (Rule 4(6) of the Consumer Protection
 * (E-Commerce) Rules 2020). Zod schemas validate every input (strict:
 * unknown keys rejected); business rules live in `services/complaints.ts`.
 *
 * This route layer owns the cross-module wiring the service is forbidden to
 * do (ARCHITECTURE.md module rules): it checks a client-supplied `orderId`'s
 * ownership via the payments module's own 404-on-foreign-id status read, it
 * checks a client-supplied `sku` exists via the catalog module (and resolves
 * its name for the ops email), it
 * reads the shopper's profile (for an email address to confirm to) and
 * `legal.company` config (for the grievance mailbox to notify), and it sends
 * both emails through the Brevo sender — all
 * BEST-EFFORT: an email failure never fails the request, since the ticket
 * (and its tracking number) is already committed by the time email is
 * attempted.
 *
 * Two plugins, mirroring routes/coupons.ts's public/admin split:
 * - `complaintRoutes` (mounted at `/v1/complaints`) — authed shopper routes:
 *   lodge a complaint, list/read the caller's own.
 * - `adminComplaintRoutes` (mounted at `/v1/admin/complaints`) — authed +
 *   admin: list every complaint, update status/resolution.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ComplaintAdminListResponseSchema,
  ComplaintAdminSchema,
  ComplaintAdminUpdateSchema,
  ComplaintCreateSchema,
  ComplaintListResponseSchema,
  ComplaintSchema,
  ComplaintTicketParamsSchema,
  ErrorEnvelopeSchema,
  type Complaint,
} from '../contracts/complaints.js'
import type { Db } from '../db/client.js'
import { notFound } from '../lib/errors.js'
import { escapeHtml, sendTransactionalEmail, type EmailSenderConfig } from '../lib/email.js'
import { getItemBySku } from '../services/catalog.js'
import { getConfigValue } from '../services/config.js'
import {
  createComplaint,
  getComplaint,
  listAllComplaints,
  listComplaints,
  updateComplaintStatus,
} from '../services/complaints.js'
import { getOrderStatus } from '../services/payments.js'
import { getProfile } from '../services/profile.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

const CATEGORY_LABELS: Record<Complaint['category'], string> = {
  product_quality: 'Product quality',
  delivery_shipping: 'Delivery / shipping',
  billing_payment: 'Billing / payment',
  order_issue: 'Order issue',
  other: 'Other',
}

/**
 * Where a new complaint gets notified: the single published grievance mailbox,
 * `legal.company.supportEmail`. It is a ROLE address, never an individual —
 * the named Grievance Officer / Nodal Contact fields were deliberately removed
 * from the published entity record, so nothing here may reintroduce a person's
 * name, personal email, or phone number.
 *
 * The two legacy keys are still read as a fallback so an environment whose
 * `legal.company` row has not been re-seeded yet keeps delivering complaint
 * notifications instead of silently dropping them. Once every environment is
 * re-seeded, the fallback is dead code and can go.
 *
 * Returns `[]` if the key isn't seeded at all or carries no usable address.
 */
async function resolveComplaintRecipients(db: Db): Promise<Array<{ name: string; email: string }>> {
  const company = await getConfigValue<Record<string, unknown>>(db, 'legal.company')
  if (!company) return []
  const candidates = [
    { name: 'Tiny Tales Support', email: company.supportEmail },
    // Legacy, pre-scrub keys — see the note above.
    { name: 'Grievance Officer', email: company.grievanceEmail },
    { name: 'Nodal Contact', email: company.nodalContactEmail },
  ]
  const seen = new Set<string>()
  const recipients: Array<{ name: string; email: string }> = []
  for (const c of candidates) {
    if (typeof c.email !== 'string' || !c.email || seen.has(c.email)) continue
    seen.add(c.email)
    recipients.push({ name: c.name, email: c.email })
  }
  return recipients
}

/**
 * `productLabel` is the catalog name/size resolved from `ticket.sku` at send
 * time, or null when the complaint names no product (or the sku has since
 * been delisted) — the raw sku is always shown regardless, since that is what
 * the ticket actually froze.
 */
function ticketDetailsHtml(ticket: Complaint, productLabel: string | null): string {
  const dueDate = new Date(ticket.dueAt).toDateString()
  return (
    `<ul style="margin:0 0 8px;padding-left:18px;">` +
    `<li>Ticket: <code>${escapeHtml(ticket.ticketNumber)}</code></li>` +
    `<li>Category: ${escapeHtml(CATEGORY_LABELS[ticket.category])}</li>` +
    `<li>Subject: ${escapeHtml(ticket.subject)}</li>` +
    `${ticket.sku ? `<li>Product: ${productLabel ? `${escapeHtml(productLabel)} ` : ''}(<code>${escapeHtml(ticket.sku)}</code>)</li>` : ''}` +
    `${ticket.orderId ? `<li>Order: <code>${escapeHtml(ticket.orderId)}</code></li>` : ''}` +
    `<li>Resolve by: ${escapeHtml(dueDate)} (one-month SLA)</li>` +
    `</ul>` +
    `<p style="white-space:pre-wrap;">${escapeHtml(ticket.message)}</p>`
  )
}

/**
 * Best-effort: notify the Grievance Officer/Nodal Contact, and confirm to
 * the shopper if they have an email on file. Every failure is caught and
 * logged — this must never affect the response already sent for the
 * complaint that was already committed to the DB.
 */
async function sendComplaintEmails(
  db: Db,
  ticket: Complaint,
  userId: string,
  email: EmailSenderConfig | undefined,
  emailFetchImpl: typeof fetch | undefined,
  log: FastifyBaseLogger
): Promise<void> {
  if (!email) return
  try {
    const [recipients, profile, item] = await Promise.all([
      resolveComplaintRecipients(db),
      getProfile(db, userId),
      ticket.sku ? getItemBySku(db, ticket.sku) : Promise.resolve(undefined),
    ])
    const productLabel = item ? `${item.name} (${item.size})` : null

    if (recipients.length > 0) {
      await sendTransactionalEmail(
        email,
        {
          to: recipients,
          subject: `New complaint ${ticket.ticketNumber} — ${CATEGORY_LABELS[ticket.category]}`,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;">${ticketDetailsHtml(ticket, productLabel)}</div>`,
        },
        emailFetchImpl
      )
    }

    if (profile.email) {
      const dueDate = new Date(ticket.dueAt).toDateString()
      await sendTransactionalEmail(
        email,
        {
          to: [{ email: profile.email, ...(profile.name ? { name: profile.name } : {}) }],
          subject: `We received your complaint — ${ticket.ticketNumber}`,
          html:
            `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;">` +
            `<p>We've logged your complaint. You can track it any time using this ticket number:</p>` +
            `<p style="font-size:18px;font-weight:bold;">${escapeHtml(ticket.ticketNumber)}</p>` +
            `<p>We aim to resolve it by ${escapeHtml(dueDate)}.</p>` +
            `</div>`,
        },
        emailFetchImpl
      )
    }
  } catch (caught) {
    log.error(
      { err: caught, ticketNumber: ticket.ticketNumber },
      'complaint: failed to send notification email'
    )
  }
}

export interface ComplaintRoutesOptions {
  db: Db
  /**
   * Brevo sender identity — reuses the same `BREVO_API_KEY`/`ALERT_EMAIL_FROM`
   * env values `lib/alerts.ts` uses (a distinct `fromName`, not a distinct
   * credential). Absent → tickets are still created and returned with a
   * tracking number; only the email step is skipped.
   */
  email?: EmailSenderConfig
  /** Test seam: injected fetch for the Brevo call. */
  emailFetchImpl?: typeof fetch
}

/** Authed shopper routes: lodge a complaint, list/read the caller's own. */
export const complaintRoutes: FastifyPluginAsyncZod<ComplaintRoutesOptions> = async (app, opts) => {
  const { db, email, emailFetchImpl } = opts
  app.addHook('onRequest', app.authenticate)

  app.post(
    '/',
    {
      schema: {
        body: ComplaintCreateSchema,
        response: { 201: ComplaintSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      // Ownership check only, when an order is named — getOrderStatus 404s
      // for a foreign/unknown id; its own return value is unused here.
      if (request.body.orderId) {
        await getOrderStatus(db, request.user.id, request.body.orderId)
      }
      // Existence check only, when a product is named. Deliberately NOT an
      // `active` check: shoppers complain about bottles that have since been
      // delisted, and refusing those would block exactly the complaints most
      // worth hearing.
      if (request.body.sku && !(await getItemBySku(db, request.body.sku))) {
        throw notFound('Product not found')
      }
      const ticket = await createComplaint(db, request.user.id, request.body)
      void sendComplaintEmails(db, ticket, request.user.id, email, emailFetchImpl, request.log)
      return reply.code(201).send(ticket)
    }
  )

  app.get(
    '/',
    { schema: { response: { 200: ComplaintListResponseSchema, ...errorResponses } } },
    async (request) => ({ complaints: await listComplaints(db, request.user.id) })
  )

  app.get(
    '/:ticketNumber',
    {
      schema: {
        params: ComplaintTicketParamsSchema,
        response: { 200: ComplaintSchema, ...errorResponses },
      },
    },
    async (request) => getComplaint(db, request.user.id, request.params.ticketNumber)
  )
}

/** Admin complaint triage, mounted at `/v1/admin/complaints`. */
export const adminComplaintRoutes: FastifyPluginAsyncZod<ComplaintRoutesOptions> = async (
  app,
  { db }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/',
    { schema: { response: { 200: ComplaintAdminListResponseSchema, ...errorResponses } } },
    async () => ({ complaints: await listAllComplaints(db) })
  )

  app.patch(
    '/:ticketNumber',
    {
      schema: {
        params: ComplaintTicketParamsSchema,
        body: ComplaintAdminUpdateSchema,
        response: { 200: ComplaintAdminSchema, ...errorResponses },
      },
    },
    async (request) => updateComplaintStatus(db, request.params.ticketNumber, request.body)
  )
}
