/**
 * Complaints business rules (Consumer Protection (E-Commerce) Rules 2020,
 * Rule 4(6)): lodging a complaint generates a unique shopper-facing tracking
 * ticket number and a one-month resolution SLA (`dueAt`).
 *
 * Cross-module rule (docs/ARCHITECTURE.md): this module owns the
 * `complaint_tickets` table and never reads another module's table or
 * `app_config`/`env` directly. `orderId` ownership (when a complaint names
 * an order) and every email side-effect are the ROUTE layer's job.
 */

import { randomInt } from 'node:crypto'

import { and, desc, eq, sql } from 'drizzle-orm'

import type {
  Complaint,
  ComplaintAdmin,
  ComplaintAdminUpdate,
  ComplaintCreate,
} from '../contracts/complaints.js'
import type { Db } from '../db/client.js'
import { complaintTickets, type ComplaintTicketRow } from '../db/schema.js'
import { notFound, validationFailed } from '../lib/errors.js'

/** Excludes 0/O/1/I — the characters shoppers most often misread when reading a ticket number aloud or off a screenshot. */
const TICKET_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TICKET_RANDOM_LEN = 6
const SLA_DAYS = 30
const MAX_TICKET_GENERATION_ATTEMPTS = 5

function randomTicketSuffix(): string {
  let suffix = ''
  for (let i = 0; i < TICKET_RANDOM_LEN; i++) {
    suffix += TICKET_CHARSET[randomInt(TICKET_CHARSET.length)]
  }
  return suffix
}

/** "TT-20260725-7K3QZM" — date-prefixed for readability, random suffix for uniqueness. */
function generateTicketNumber(now: Date): string {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `TT-${datePart}-${randomTicketSuffix()}`
}

function toComplaint(row: ComplaintTicketRow): Complaint {
  return {
    ticketNumber: row.ticketNumber,
    orderId: row.orderId,
    sku: row.sku,
    category: row.category as Complaint['category'],
    subject: row.subject,
    message: row.message,
    status: row.status as Complaint['status'],
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }
}

function toAdminComplaint(row: ComplaintTicketRow): ComplaintAdmin {
  return { ...toComplaint(row), userId: row.userId }
}

/**
 * Lodge a complaint: generates a unique ticket number (retried on the
 * astronomically rare collision — 32^6 combinations per day) and sets
 * `dueAt` = now + 30 days.
 */
export async function createComplaint(db: Db, userId: string, input: ComplaintCreate): Promise<Complaint> {
  const now = new Date()
  const dueAt = new Date(now.getTime() + SLA_DAYS * 24 * 60 * 60 * 1000)

  for (let attempt = 0; attempt < MAX_TICKET_GENERATION_ATTEMPTS; attempt++) {
    const ticketNumber = generateTicketNumber(now)
    const [row] = await db
      .insert(complaintTickets)
      .values({
        ticketNumber,
        userId,
        orderId: input.orderId ?? null,
        sku: input.sku ?? null,
        category: input.category,
        subject: input.subject,
        message: input.message,
        dueAt,
      })
      .onConflictDoNothing({ target: complaintTickets.ticketNumber })
      .returning()
    if (row) return toComplaint(row)
  }
  throw new Error('Could not generate a unique complaint ticket number after several attempts')
}

/** GET /v1/complaints — the caller's own complaints, newest first. */
export async function listComplaints(db: Db, userId: string): Promise<Complaint[]> {
  const rows = await db
    .select()
    .from(complaintTickets)
    .where(eq(complaintTickets.userId, userId))
    .orderBy(desc(complaintTickets.createdAt))
  return rows.map(toComplaint)
}

/**
 * GET /v1/complaints/:ticketNumber — the caller's own ticket, looked up by
 * the shopper-facing tracking number. Cross-user access or an unknown number
 * both read as 404.
 */
export async function getComplaint(db: Db, userId: string, ticketNumber: string): Promise<Complaint> {
  const [row] = await db
    .select()
    .from(complaintTickets)
    .where(and(eq(complaintTickets.ticketNumber, ticketNumber), eq(complaintTickets.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Complaint not found')
  return toComplaint(row)
}

/** GET /v1/admin/complaints — every complaint, newest first (ops triage). */
export async function listAllComplaints(db: Db): Promise<ComplaintAdmin[]> {
  const rows = await db.select().from(complaintTickets).orderBy(desc(complaintTickets.createdAt))
  return rows.map(toAdminComplaint)
}

/**
 * PATCH /v1/admin/complaints/:ticketNumber — moves status and/or records a
 * resolution note. Moving to 'resolved'/'closed' requires a note (the
 * shopper needs to see *why* it's closed) and stamps `resolvedAt`; moving
 * back to 'open'/'in_progress' clears `resolvedAt`. Omitting
 * `resolutionNote` on a non-terminal update keeps whatever note is already
 * on the row.
 */
export async function updateComplaintStatus(
  db: Db,
  ticketNumber: string,
  input: ComplaintAdminUpdate
): Promise<ComplaintAdmin> {
  const isTerminal = input.status === 'resolved' || input.status === 'closed'
  if (isTerminal && !input.resolutionNote) {
    throw validationFailed('resolutionNote is required when resolving or closing a complaint')
  }

  const [row] = await db
    .update(complaintTickets)
    .set({
      status: input.status,
      resolutionNote: input.resolutionNote ?? sql`${complaintTickets.resolutionNote}`,
      resolvedAt: isTerminal ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(complaintTickets.ticketNumber, ticketNumber))
    .returning()
  if (!row) throw notFound('Complaint not found')
  return toAdminComplaint(row)
}
