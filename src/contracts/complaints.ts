/**
 * Zod contracts for the complaints module (Consumer Protection (E-Commerce)
 * Rules 2020, Rule 4(6)): a shopper-lodged complaint gets an auto-generated
 * tracking ticket number and a one-month resolution SLA. Imports only `zod`,
 * same rule as every other contracts file (shareable with mobile).
 *
 * Table (owned by `complaints`, see db/schema.ts `complaintTickets`):
 *
 * ```
 * complaint_tickets:
 *   id               uuid pk
 *   ticket_number    text unique     -- shopper-facing tracking id, e.g. "TT-20260725-7K3QZM"
 *   user_id          uuid fk -> users(id)
 *   order_id         text null fk -> payments(order_id)
 *   sku              text null       -- seller-sku the complaint is about (frozen, not an FK)
 *   category         text check in (...)
 *   subject          text
 *   message          text
 *   status           text default 'open' check in ('open','in_progress','resolved','closed')
 *   resolution_note  text null
 *   created_at, updated_at timestamptz default now()
 *   due_at           timestamptz    -- created_at + 30 days (Rule 4(6) SLA)
 *   resolved_at      timestamptz null
 * ```
 *
 * Endpoints:
 * - `POST /v1/complaints` (auth): lodges a complaint, generates the ticket
 *   number, emails the grievance mailbox (`legal.company.supportEmail`) and,
 *   if the shopper has an email on file, a confirmation copy —
 *   both best-effort (never blocks the 201).
 * - `GET /v1/complaints` (auth): the caller's own complaints, newest first.
 * - `GET /v1/complaints/:ticketNumber` (auth): one of the caller's own
 *   complaints, looked up by the shopper-facing ticket number (the thing
 *   Rule 4(6) says they can track by) — 404 for another user's ticket or an
 *   unknown number.
 * - `GET /v1/admin/complaints` (auth + admin): every complaint, for ops triage.
 * - `PATCH /v1/admin/complaints/:ticketNumber` (auth + admin): update
 *   status/resolution note.
 */

import { z } from 'zod'

export const ComplaintCategorySchema = z.enum([
  'product_quality',
  'delivery_shipping',
  'billing_payment',
  'order_issue',
  'other',
])

export const ComplaintStatusSchema = z.enum(['open', 'in_progress', 'resolved', 'closed'])

/**
 * POST /v1/complaints body. `orderId` is optional — not every complaint
 * concerns a specific order; when present, ownership is checked (a foreign
 * or unknown id 404s, same rule as the payments module). `sku` is likewise
 * optional (a billing or delivery complaint often names no product); when
 * present it must be a sku the catalog actually knows, so ops never receive
 * a ticket pointing at a product that does not exist.
 */
export const ComplaintCreateSchema = z.strictObject({
  category: ComplaintCategorySchema,
  subject: z.string().min(1, 'subject is required').max(200, 'subject must be 200 characters or fewer'),
  message: z.string().min(1, 'message is required').max(2000, 'message must be 2000 characters or fewer'),
  orderId: z.string().min(1).max(100).optional(),
  sku: z.string().min(1).max(100).optional(),
})

/** One complaint ticket, as returned to the shopper who filed it. */
export const ComplaintSchema = z.object({
  ticketNumber: z.string(),
  orderId: z.string().nullable(),
  sku: z.string().nullable(),
  category: ComplaintCategorySchema,
  subject: z.string(),
  message: z.string(),
  status: ComplaintStatusSchema,
  resolutionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
})

/** GET /v1/complaints response — the caller's own complaints, newest first. */
export const ComplaintListResponseSchema = z.object({
  complaints: z.array(ComplaintSchema),
})

/** Route params for `GET /v1/complaints/:ticketNumber` and the admin PATCH. */
export const ComplaintTicketParamsSchema = z.strictObject({
  ticketNumber: z.string().min(1),
})

/** One complaint, as returned to an admin — adds the filer's user id for ops lookups. */
export const ComplaintAdminSchema = ComplaintSchema.extend({
  userId: z.uuid(),
})

/** GET /v1/complaints/admin response. */
export const ComplaintAdminListResponseSchema = z.object({
  complaints: z.array(ComplaintAdminSchema),
})

/**
 * PATCH /v1/admin/complaints/:ticketNumber body — moves the ticket's status
 * and/or records a resolution note. `resolutionNote` is required when moving
 * to 'resolved' or 'closed' (enforced in the service, not here, since it's a
 * cross-field rule); optional otherwise.
 */
export const ComplaintAdminUpdateSchema = z.strictObject({
  status: ComplaintStatusSchema,
  resolutionNote: z.string().min(1).max(2000).optional(),
})

/** The error envelope every non-2xx response uses (same shape as the other contracts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type ComplaintCategory = z.infer<typeof ComplaintCategorySchema>
export type ComplaintStatus = z.infer<typeof ComplaintStatusSchema>
export type ComplaintCreate = z.infer<typeof ComplaintCreateSchema>
export type Complaint = z.infer<typeof ComplaintSchema>
export type ComplaintListResponse = z.infer<typeof ComplaintListResponseSchema>
export type ComplaintTicketParams = z.infer<typeof ComplaintTicketParamsSchema>
export type ComplaintAdmin = z.infer<typeof ComplaintAdminSchema>
export type ComplaintAdminListResponse = z.infer<typeof ComplaintAdminListResponseSchema>
export type ComplaintAdminUpdate = z.infer<typeof ComplaintAdminUpdateSchema>
