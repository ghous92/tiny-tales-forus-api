/**
 * Credit-notes business rules. This module owns `credit_notes` and
 * `credit_note_counters` and NOTHING else — same ARCHITECTURE.md module rule
 * `services/invoices.ts` follows, and for the same reason: it never reads
 * another module's table. The document handed to {@link issueCreditNote}
 * arrives fully built — reversing the frozen invoice is `lib/creditNoteDocument.ts`'s
 * job, and the composition (reading the invoice, resolving config) is the
 * ROUTE layer's (`routes/creditNotes.ts`).
 *
 * Gapless series, allocation SQL, and the idempotent-by-orderId issuance shape
 * all mirror `services/invoices.ts` exactly — read that module's class doc
 * first; this one does not repeat the reasoning.
 */

import { eq, sql } from 'drizzle-orm'

import type { CreditNoteDocument } from '../contracts/creditNotes.js'
import type { Db } from '../db/client.js'
import { creditNotes, type CreditNoteRow } from '../db/schema.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Allocate the next number in `fy`'s series. MUST be called inside the same
 * transaction as the insert that consumes it — see `services/invoices.ts`
 * `allocateSeq` for why a SEQUENCE would be wrong here. Own series, own
 * counters row: a credit note's `fy` may differ from the invoice it reverses
 * (issued months later, possibly across a financial-year boundary).
 */
async function allocateSeq(tx: Tx, fy: string): Promise<number> {
  const result = await tx.execute<{ seq: number }>(sql`
    insert into credit_note_counters (fy, next_seq) values (${fy}, 2)
    on conflict (fy) do update set next_seq = credit_note_counters.next_seq + 1
    returning next_seq - 1 as seq
  `)
  const rows =
    (result as unknown as { rows?: Array<{ seq: number }> }).rows ??
    (result as unknown as Array<{ seq: number }>)
  const seq = rows[0]?.seq
  if (seq === undefined) throw new Error('credit note counter allocation returned no row')
  return Number(seq)
}

export interface IssueCreditNoteInput {
  orderId: string
  invoiceNumber: string
  userId: string
  /** Indian FY the number belongs to, e.g. "26-27" (see lib/invoiceFormat.ts). */
  fy: string
  issuedAt: Date
  totalPaise: number
  /** Builds the frozen document once its position in the series is known — see `services/invoices.ts` `buildDocument`. */
  buildDocument: (fy: string, seq: number) => CreditNoteDocument
}

/**
 * Issue the credit note for an order, or return the one already issued.
 *
 * Idempotent by `orderId` — the existence check runs BEFORE allocation, same
 * ordering `issueInvoice` uses, so a repeat call (the webhook and a self-service
 * cancel racing the same refund) never consumes a number it will not use.
 */
export async function issueCreditNote(tx: Tx, input: IssueCreditNoteInput): Promise<CreditNoteRow> {
  const [existing] = await tx
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.orderId, input.orderId))
    .limit(1)
  if (existing) return existing

  const seq = await allocateSeq(tx, input.fy)
  const document = input.buildDocument(input.fy, seq)
  const creditNoteNumber = document.creditNoteNumber
  if (!creditNoteNumber) throw new Error('credit note document was built without a credit note number')

  const [row] = await tx
    .insert(creditNotes)
    .values({
      creditNoteNumber,
      invoiceNumber: input.invoiceNumber,
      orderId: input.orderId,
      userId: input.userId,
      fy: input.fy,
      seq,
      issuedAt: input.issuedAt,
      totalPaise: input.totalPaise,
      document,
    })
    .returning()
  if (!row) throw new Error('credit note insert returned no row')
  return row
}

/** The caller's own credit note for an order, or undefined (unknown order, or none issued). */
export async function getCreditNoteByOrderId(db: Db, orderId: string): Promise<CreditNoteRow | undefined> {
  const [row] = await db.select().from(creditNotes).where(eq(creditNotes.orderId, orderId)).limit(1)
  return row
}

/** One credit note by its document number (admin lookups). */
export async function getCreditNoteByNumber(
  db: Db,
  creditNoteNumber: string
): Promise<CreditNoteRow | undefined> {
  const [row] = await db
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.creditNoteNumber, creditNoteNumber))
    .limit(1)
  return row
}
