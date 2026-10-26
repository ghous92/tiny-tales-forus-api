/**
 * Invoices business rules. This module owns `invoices` and `invoice_counters`
 * and NOTHING else: per docs/ARCHITECTURE.md it never reads another module's
 * table and never touches `app_config` or `env`. The document handed to
 * {@link issueInvoice} arrives fully built — assembling it from payments +
 * config + catalog is the ROUTE layer's job (`routes/payments.ts`), and the
 * assembly itself is a pure function in `lib/invoiceDocument.ts`.
 *
 * ## The one hard invariant: a gapless series
 *
 * India expects invoice numbers to run consecutively within a financial year,
 * with no holes. That rules out a Postgres SEQUENCE: `nextval` is deliberately
 * non-transactional — a rolled-back transaction keeps the number it consumed,
 * leaving a permanent gap nobody can explain to an auditor. So the counter is
 * an ordinary row updated inside the SAME transaction as the insert:
 *
 * ```sql
 * INSERT INTO invoice_counters (fy, next_seq) VALUES ($1, 2)
 * ON CONFLICT (fy) DO UPDATE SET next_seq = invoice_counters.next_seq + 1
 * RETURNING next_seq - 1
 * ```
 *
 * The `ON CONFLICT DO UPDATE` takes a row lock, so concurrent issuers serialize
 * on it rather than racing; and if the surrounding transaction rolls back, the
 * increment rolls back with it and the number is handed to the next caller
 * instead of being lost. The `invoices_fy_seq_idx` unique index is the
 * belt-and-braces: even a bug in this file cannot put two documents on one
 * number.
 *
 * ## Immutability
 *
 * An issued invoice is never updated except for its EMAIL DELIVERY state
 * (`recordEmailAttempt`). There is no update path for `document`, `total_paise`
 * or the number itself, deliberately: the customer already has a copy.
 */

import { and, count, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm'

import type {
  InvoiceAdminDetail,
  InvoiceDocument,
  InvoiceEmailStatus,
  InvoiceListQuery,
  InvoiceSummary,
} from '../contracts/invoices.js'
import type { Db } from '../db/client.js'
// `invoice_counters` is written only through the raw `INSERT … ON CONFLICT`
// in `allocateSeq` below — the drizzle builder has no way to express
// `RETURNING next_seq - 1`, and splitting it into read-then-write would lose
// the atomicity the gapless series depends on.
import { invoices, type InvoiceRow } from '../db/schema.js'
import { istDayAfter, istDayStart } from '../lib/invoiceFormat.js'

/** A drizzle transaction handle — same query surface as {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Rows past this many failed sends stop being retried by the recovery sweep. */
export const MAX_EMAIL_ATTEMPTS = 5

/**
 * How long an invoice may sit claimed (`sending`) before
 * {@link reapStuckInvoiceEmails} takes it back.
 *
 * Same value and same reasoning as `OPS_NOTIFICATION_CLAIM_STALE_MS`: it has to
 * be far longer than any real Brevo round trip, because reaping a send that is
 * merely slow re-creates the duplicate the claim exists to prevent.
 */
export const EMAIL_CLAIM_STALE_MS = 15 * 60 * 1000

/**
 * Allocate the next number in `fy`'s series. MUST be called inside the same
 * transaction as the insert that consumes it — see the module note on why a
 * SEQUENCE would be wrong here.
 */
async function allocateSeq(tx: Tx, fy: string): Promise<number> {
  // `next_seq` names the number the NEXT invoice will take, so the value this
  // statement returns is the post-update one minus one — 1 on the insert path
  // (row created at 2), and the previous value on the conflict path. Gapless
  // and starting at 1 either way.
  const result = await tx.execute<{ seq: number }>(sql`
    insert into invoice_counters (fy, next_seq) values (${fy}, 2)
    on conflict (fy) do update set next_seq = invoice_counters.next_seq + 1
    returning next_seq - 1 as seq
  `)
  // node-postgres and PGlite both wrap rows in `{ rows }`, but the drizzle
  // typings differ between drivers — normalise instead of branching on driver.
  const rows =
    (result as unknown as { rows?: Array<{ seq: number }> }).rows ??
    (result as unknown as Array<{ seq: number }>)
  const seq = rows[0]?.seq
  if (seq === undefined) throw new Error('invoice counter allocation returned no row')
  return Number(seq)
}

export interface IssueInvoiceInput {
  orderId: string
  userId: string
  /** Indian FY the number belongs to, e.g. "26-27" (see lib/invoiceFormat.ts). */
  fy: string
  issuedAt: Date
  totalPaise: number
  /**
   * Builds the frozen document once its position in the series is known. The
   * number is printed ON the document, so the document cannot exist before
   * allocation — and the builder, not this module, owns the number's FORMAT
   * (lib/invoiceFormat.ts `formatInvoiceNumber`, whose prefix is configurable).
   * This module owns only its uniqueness.
   */
  buildDocument: (fy: string, seq: number) => InvoiceDocument
  /** Where the customer's copy will be sent; null when we hold no address for them. */
  emailTo: string | null
  /**
   * Initial delivery state. `pending` for a live issue (the route mails it
   * post-commit), `skipped_no_email` when there is no address, and
   * `skipped_backfill` for documents minted retroactively, which are
   * deliberately never mailed.
   */
  emailStatus: InvoiceEmailStatus
}

/**
 * Issue the invoice for an order, or return the one already issued.
 *
 * Idempotent by design, because the three payment paths (client verify,
 * webhook, recover sweep) can all reach the transition and the backfill script
 * is a fourth issuer. The existence check runs BEFORE allocation so a repeat
 * call never consumes a number it will not use — that would be exactly the gap
 * the whole design exists to prevent.
 *
 * Throws on a genuine conflict (two issuers racing the same order outside the
 * `markPaid` guard). Callers that must not fail their own transaction — i.e.
 * the paid-order hook, where the money is already captured — wrap this in a
 * SAVEPOINT so the rollback takes the counter increment with it.
 */
export async function issueInvoice(tx: Tx, input: IssueInvoiceInput): Promise<InvoiceRow> {
  const [existing] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.orderId, input.orderId))
    .limit(1)
  if (existing) return existing

  const seq = await allocateSeq(tx, input.fy)
  const document = input.buildDocument(input.fy, seq)
  const invoiceNumber = document.invoiceNumber
  if (!invoiceNumber) throw new Error('invoice document was built without an invoice number')

  const [row] = await tx
    .insert(invoices)
    .values({
      invoiceNumber,
      orderId: input.orderId,
      userId: input.userId,
      fy: input.fy,
      seq,
      issuedAt: input.issuedAt,
      totalPaise: input.totalPaise,
      document,
      emailStatus: input.emailStatus,
      emailTo: input.emailTo,
    })
    .returning()
  if (!row) throw new Error('invoice insert returned no row')
  return row
}

/** The caller's own invoice for an order, or undefined (unknown order, or someone else's). */
export async function getInvoiceByOrderId(
  db: Db,
  orderId: string,
  userId?: string
): Promise<InvoiceRow | undefined> {
  const where = userId
    ? and(eq(invoices.orderId, orderId), eq(invoices.userId, userId))
    : eq(invoices.orderId, orderId)
  const [row] = await db.select().from(invoices).where(where).limit(1)
  return row
}

/** One invoice by its document number (admin lookups). */
export async function getInvoiceByNumber(
  db: Db,
  invoiceNumber: string
): Promise<InvoiceRow | undefined> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.invoiceNumber, invoiceNumber))
    .limit(1)
  return row
}

/** Row → the flat register shape. Reads the frozen document; never re-derives anything from live tables. */
export function toInvoiceSummary(row: InvoiceRow): InvoiceSummary {
  const doc = row.document as InvoiceDocument
  return {
    invoiceNumber: row.invoiceNumber,
    orderId: row.orderId,
    issuedAt: row.issuedAt.toISOString(),
    status: doc.status,
    buyerName: doc.buyer.name,
    buyerPhone: doc.buyer.phone,
    buyerCity: doc.buyer.city,
    buyerState: doc.buyer.state,
    goodsInr: doc.totals.goodsInr,
    couponDiscountInr: doc.totals.couponDiscountInr,
    shippingFeeInr: doc.totals.shippingFeeInr,
    totalInr: doc.totals.totalInr,
    emailStatus: row.emailStatus as InvoiceEmailStatus,
    emailTo: row.emailTo,
    emailedAt: row.emailedAt ? row.emailedAt.toISOString() : null,
  }
}

/** Row → the admin detail view: the register row plus the frozen document and delivery diagnostics. */
export function toInvoiceAdminDetail(row: InvoiceRow): InvoiceAdminDetail {
  return {
    ...toInvoiceSummary(row),
    document: row.document as InvoiceDocument,
    emailAttempts: row.emailAttempts,
    lastEmailError: row.lastEmailError,
  }
}

/** Compose the WHERE for the admin register. Empty filters ⇒ undefined (no predicate). */
function listFilters(query: InvoiceListQuery): SQL | undefined {
  const clauses: SQL[] = []

  if (query.q) {
    const like = `%${query.q}%`
    const match = or(
      ilike(invoices.invoiceNumber, like),
      ilike(invoices.orderId, like),
      // The buyer lives inside the frozen document, so search reaches into it
      // rather than duplicating name/phone into columns that could then
      // disagree with the document they claim to describe.
      sql`${invoices.document}->'buyer'->>'name' ilike ${like}`,
      sql`${invoices.document}->'buyer'->>'phone' ilike ${like}`
    )
    if (match) clauses.push(match)
  }

  if (query.emailStatus) clauses.push(eq(invoices.emailStatus, query.emailStatus))
  if (query.status) clauses.push(sql`${invoices.document}->>'status' = ${query.status}`)
  if (query.from) clauses.push(gte(invoices.issuedAt, istDayStart(query.from)))
  // Inclusive of the whole `to` day: everything strictly before the next IST midnight.
  if (query.to) clauses.push(lt(invoices.issuedAt, istDayAfter(query.to)))

  if (clauses.length === 0) return undefined
  return clauses.length === 1 ? clauses[0] : and(...clauses)
}

/**
 * The admin sales register, newest first. `total` is the count BEFORE
 * limit/offset so the pager can show "showing 50 of 812" — computed with a
 * second COUNT rather than a window function so the two queries stay readable
 * and independently indexable.
 */
export async function listInvoices(
  db: Db,
  query: InvoiceListQuery
): Promise<{ invoices: InvoiceSummary[]; total: number }> {
  const where = listFilters(query)
  const limit = query.limit ?? 50
  const offset = query.offset ?? 0

  const [rows, counted] = await Promise.all([
    where
      ? db
          .select()
          .from(invoices)
          .where(where)
          .orderBy(desc(invoices.issuedAt))
          .limit(limit)
          .offset(offset)
      : db.select().from(invoices).orderBy(desc(invoices.issuedAt)).limit(limit).offset(offset),
    where
      ? db.select({ value: count() }).from(invoices).where(where)
      : db.select({ value: count() }).from(invoices),
  ])

  return { invoices: rows.map(toInvoiceSummary), total: counted[0]?.value ?? 0 }
}

/**
 * Every invoice matching the register filters, ordered oldest-first — the shape
 * a CSV sales register wants (an accountant reads a book forwards). Unpaginated
 * on purpose: the export IS the whole result set.
 */
export async function listInvoicesForExport(
  db: Db,
  query: InvoiceListQuery
): Promise<InvoiceSummary[]> {
  const where = listFilters(query)
  const rows = where
    ? await db.select().from(invoices).where(where).orderBy(invoices.issuedAt)
    : await db.select().from(invoices).orderBy(invoices.issuedAt)
  return rows.map(toInvoiceSummary)
}

/** The outcome of one send attempt, as {@link recordEmailAttempt} records it. */
export type EmailAttemptOutcome =
  | { status: 'sent'; to: string }
  | { status: 'failed'; to: string; error: string }
  /** No address on file — nothing was tried, so this does NOT count as an attempt. */
  | { status: 'skipped_no_email' }

/**
 * Take an invoice for emailing, or return undefined if somebody else has it.
 *
 * The customer's copy has two senders that can hold the same row at the same
 * moment: `sendCapturedInvoiceEmails`, fired the instant a payment commits, and
 * the retry sweep draining `pending`/`failed`. Two sweep runs can also overlap —
 * Cloud Scheduler retries a run past its 300s attempt deadline while Cloud Run
 * leaves the original handler running. Before this claim, every one of those
 * read the row, called Brevo, and only THEN wrote a status: a window in which
 * the shopper is mailed the same invoice twice.
 *
 * The guarded UPDATE closes it in one statement — a compare-and-swap, not a
 * lock. Nothing holds a transaction open across the Brevo call, which matters
 * beyond correctness: a `SELECT ... FOR UPDATE` spanning a third-party HTTP
 * round trip would pin a Neon compute awake for the whole sweep loop
 * (docs/WIP-NEON-COST.md).
 *
 * `emailAttempts` is incremented HERE, not at the terminal write, so a send
 * that never returns still burns its budget — a try counted only on completion
 * is not counted at all when the provider never answers, and that is how one
 * poisonous row gets retried forever.
 *
 * `force` is for the admin resend button (`POST /:invoiceNumber/email`), where a
 * human is deliberately re-mailing a copy that already went, possibly to an
 * override address, possibly past the retry cap. It widens the predicate to
 * everything except `sending`: a claim held by a live sender is still not
 * something to cut in front of.
 */
export async function claimInvoiceEmail(
  db: Db,
  invoiceNumber: string,
  force = false
): Promise<InvoiceRow | undefined> {
  const eligible = force
    ? ne(invoices.emailStatus, 'sending')
    : and(
        inArray(invoices.emailStatus, ['pending', 'failed']),
        lt(invoices.emailAttempts, MAX_EMAIL_ATTEMPTS)
      )

  const [row] = await db
    .update(invoices)
    .set({
      emailStatus: 'sending',
      emailAttempts: sql`${invoices.emailAttempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(invoices.invoiceNumber, invoiceNumber), eligible))
    .returning()
  return row
}

/**
 * Return invoices abandoned mid-send to the retry pool, and report how many.
 *
 * A claimed row whose sender died — instance evicted, deploy mid-sweep, a
 * handler killed after its scheduler attempt deadline passed — would otherwise
 * sit in `sending` forever, and `sending` appears in no sweep predicate. Without
 * this the safeguard would quietly become a way to lose the customer's copy.
 *
 * Reaped to `failed` rather than `pending`, the same choice
 * `reapStuckOpsNotifications` makes: the claim was taken, so the mail may well
 * have gone out. Both states retry equally, but only `failed` reads honestly on
 * the admin register, and the attempt already counted at claim time still bounds
 * a row that keeps dying mid-send.
 */
export async function reapStuckInvoiceEmails(
  db: Db,
  now: Date = new Date(),
  staleMs: number = EMAIL_CLAIM_STALE_MS
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs)
  const rows = await db
    .update(invoices)
    .set({
      emailStatus: 'failed',
      lastEmailError: 'send abandoned mid-flight; reclaimed by the retry sweep',
      updatedAt: sql`now()`,
    })
    .where(and(eq(invoices.emailStatus, 'sending'), lt(invoices.updatedAt, cutoff)))
    .returning({ invoiceNumber: invoices.invoiceNumber })
  return rows.length
}

/**
 * Record how the customer's copy went, closing out a {@link claimInvoiceEmail}.
 * The ONLY mutation an issued invoice ever receives — the document itself is
 * immutable (see the module note).
 *
 * `emailAttempts` is NOT touched here; the claim already counted the try. The
 * one outcome that reaches this function without a claim is `skipped_no_email`,
 * resolved before claiming precisely so that a shopper who never gave us an
 * address cannot exhaust the retry budget that exists for transient Brevo
 * failures.
 */
export async function recordEmailAttempt(
  db: Db,
  invoiceNumber: string,
  outcome: EmailAttemptOutcome
): Promise<InvoiceRow | undefined> {
  const patch =
    outcome.status === 'sent'
      ? {
          emailStatus: 'sent' as const,
          emailTo: outcome.to,
          emailedAt: sql`now()`,
          lastEmailError: null,
        }
      : outcome.status === 'failed'
        ? {
            emailStatus: 'failed' as const,
            emailTo: outcome.to,
            lastEmailError: outcome.error.slice(0, 500),
          }
        : { emailStatus: 'skipped_no_email' as const }

  const [row] = await db
    .update(invoices)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(invoices.invoiceNumber, invoiceNumber))
    .returning()
  return row
}

/**
 * Invoices whose customer copy still owes a send — what the recover sweep
 * retries. `skipped_no_email` and `skipped_backfill` are terminal by design and
 * never appear here.
 */
export async function listInvoicesNeedingEmail(db: Db, limit = 100): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(invoices)
    .where(
      and(
        inArray(invoices.emailStatus, ['pending', 'failed']),
        lt(invoices.emailAttempts, MAX_EMAIL_ATTEMPTS)
      )
    )
    .orderBy(invoices.issuedAt)
    .limit(limit)
}

/**
 * How many rows {@link listInvoicesNeedingEmail} would return, uncapped by the
 * sweep limit. Readiness only — same predicate, no `limit`.
 *
 * Note what this deliberately does NOT count: `skipped_no_email`, the terminal
 * state every invoice for a phone-only account lands in. Those are not a
 * backlog and no sweep will ever move them; counting them would report work
 * that does not exist.
 */
export async function countInvoicesNeedingEmail(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(
        inArray(invoices.emailStatus, ['pending', 'failed']),
        lt(invoices.emailAttempts, MAX_EMAIL_ATTEMPTS)
      )
    )
  return row?.n ?? 0
}
