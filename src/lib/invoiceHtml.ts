/**
 * The two renderings of an {@link InvoiceDocument}: one for the customer's
 * email, one for print. Both read ONLY the frozen document — never config,
 * never the catalog — so an invoice re-rendered years later is byte-for-byte
 * the document that was issued.
 *
 * Why two renderers and not one:
 *
 * - **Email** must survive Gmail/Outlook, which strip `<style>` blocks and much
 *   of modern CSS. So it is a table layout with 100% inline styles and no
 *   stylesheet at all — the same rule `lib/email.ts` states for every sender.
 * - **Print** is a standalone page opened in a browser (the admin panel's print
 *   iframe, or the app's WebView). It gets a real stylesheet with `@media print`
 *   and A4 page setup, which is the only way to get predictable paper output —
 *   and which email would discard anyway.
 *
 * Every interpolated value goes through {@link escapeHtml}. The document is
 * built from shopper-supplied strings (names, addresses) and must not be able
 * to inject markup into a page an operator opens.
 */

import type {
  InvoiceCopy,
  InvoiceDocument,
  InvoiceLine,
  InvoiceManufacturerBlock,
} from '../contracts/invoices.js'
import { escapeHtml } from './email.js'
import {
  formatInvoiceDate,
  formatInvoiceDateTime,
  formatMoneyFromPaise,
  formatMoneyINR,
} from './invoiceFormat.js'

/** Join the parts of an address that are actually present, so a blank field never leaves ", ,". */
function addressLines(buyer: InvoiceDocument['buyer']): string[] {
  const street = [buyer.houseNumber, buyer.roadArea].filter(Boolean).join(', ')
  const city = [buyer.city, buyer.state, buyer.pincode].filter(Boolean).join(', ')
  return [street, city].filter(Boolean)
}

/** Phones are stored bare 10-digit at the API boundary; print them the way an Indian reader expects. */
function displayPhone(phone: string): string {
  return phone ? `+91 ${phone}` : ''
}

/** "Aloe Vera Gel · 100g" — size omitted when the variant has none. */
function lineTitle(name: string, size: string): string {
  return size ? `${name} · ${size}` : name
}

/**
 * The consumer-care channel to print for a manufacturer block: the product's own
 * if the catalog holds one, else the seller's published mailbox. Never blank —
 * a shopper must always have somewhere to go.
 */
function consumerCare(block: InvoiceManufacturerBlock, fallback: string): string {
  return block.consumerCareContact || fallback
}

/**
 * A `docVersion: 2` line's tax cell: the branch (IGST vs CGST+SGST vs Nil
 * rated) is read off the line itself, never re-derived — `lib/gstTax.ts`
 * always sets exactly one of `igstPaise` or `cgstPaise`+`sgstPaise` (both
 * present, one pair zero) for a taxed line, and a 0% line is unambiguous
 * regardless of place of supply. Returns null for a `docVersion: 1` line
 * (no `gstRatePct` at all), which is what keeps the tax columns off a plain
 * INVOICE entirely.
 */
function lineTax(line: InvoiceLine): { label: string; amountPaise: number } | null {
  if (line.gstRatePct === undefined) return null
  if (line.gstRatePct === 0) return { label: 'Nil rated', amountPaise: 0 }
  if ((line.igstPaise ?? 0) > 0) {
    return { label: `IGST ${line.gstRatePct}%`, amountPaise: line.igstPaise ?? 0 }
  }
  const half = line.gstRatePct / 2
  return {
    label: `CGST ${half}% + SGST ${half}%`,
    amountPaise: (line.cgstPaise ?? 0) + (line.sgstPaise ?? 0),
  }
}

// ── Email rendering ─────────────────────────────────────────────────────────
//
// Inline styles only. Do not add a `<style>` block here, however tempting: most
// clients silently drop it and the invoice arrives as unstyled text.

/**
 * One palette, shared with `PRINT_STYLE` below by value rather than by import
 * (that one is a stylesheet string, this one is inline-style fragments) — a
 * customer who reads the email and then opens the printable copy is looking at
 * the same document, so the two must not drift apart on colour.
 */
const INK = '#2B1917'
const MUTED = '#7C665F'
const RULE = '#E9D9CF'
const RULE_SOFT = '#F2E8E2'
const ACCENT = '#D81B60'
const TINT = '#FCE4EC'
const PAGE = '#F7F2EE'

// Family names are quoted with APOSTROPHES, never `"`: every one of these
// strings is interpolated into a double-quoted `style="…"` attribute, and a
// nested double quote closes it — the whole declaration is then dropped and the
// message renders in the client's default face.
const SANS = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;"
/** The display voice: web-safe on every client, and not the body face. */
const SERIF = "font-family:Georgia,'Times New Roman',Times,serif;"
const EMAIL_TEXT = `${SANS}color:${INK};`
const EMAIL_MUTED = `color:${MUTED};font-size:12px;line-height:1.5;`
const EMAIL_LABEL = `font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:${MUTED};`
const EMAIL_CELL = `padding:10px 8px;border-bottom:1px solid ${RULE_SOFT};font-size:13px;color:${INK};`
/** Six columns of rupee figures have to survive a 320px phone: smaller, tighter. */
const EMAIL_RATE_CELL = `padding:7px 3px;border-bottom:1px solid ${RULE_SOFT};font-size:11px;color:${INK};`
const EMAIL_HEAD_CELL =
  `padding:0 3px 7px;border-bottom:1px solid ${INK};font-size:10px;text-transform:uppercase;` +
  `letter-spacing:0.1em;color:${MUTED};text-align:left;font-weight:normal;`
/** Money never sets ragged against money: same width digits in every column that holds a figure. */
const NUM = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;'

function emailTotalsRow(label: string, value: string, bold = false): string {
  const weight = bold ? 'font-weight:bold;' : ''
  return (
    `<tr>` +
    `<td style="padding:5px 0;font-size:13px;color:${MUTED};${weight}">${escapeHtml(label)}</td>` +
    `<td style="padding:5px 0 5px 24px;font-size:13px;color:${INK};${NUM}${weight}">${escapeHtml(value)}</td>` +
    `</tr>`
  )
}

/**
 * `https:` only, and never interpolated unescaped. The URL reaches here from a
 * frozen document that was written from the catalog, but a renderer that will
 * happily emit whatever string it is handed into an `src` is one bad admin
 * paste away from a `javascript:`/`data:` payload in an operator's mail client.
 */
function safeImageSrc(url: string | undefined): string {
  return url && url.startsWith('https://') ? url : ''
}

/**
 * The line's thumbnail: the catalog image when the document froze one, else a
 * monogram tile in the brand tint. Fixed 64×64 with the dimensions on the
 * element as well as in the style, because Outlook sizes images from the
 * attributes and ignores the CSS.
 */
function emailThumb(line: InvoiceLine): string {
  const src = safeImageSrc(line.imageUrl)
  const frame =
    `width:64px;height:64px;border:1px solid ${RULE};border-radius:6px;` +
    `background-color:${TINT};overflow:hidden;`
  if (src) {
    return (
      `<img src="${escapeHtml(src)}" alt="${escapeHtml(line.name)}" width="64" height="64" ` +
      `style="display:block;${frame}object-fit:cover;" />`
    )
  }
  const initial = (line.name.trim()[0] ?? '·').toUpperCase()
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${frame}">` +
    `<tr><td align="center" valign="middle" ` +
    `style="${SERIF}width:64px;height:64px;font-size:24px;color:${ACCENT};">${escapeHtml(initial)}</td>` +
    `</tr></table>`
  )
}

/**
 * One purchased line as the shopper reads it: picture, what it is, what it
 * cost. The tax figures a `docVersion: 2` document must state ride underneath
 * the name as a sentence rather than as two more columns — at 600px an item
 * table with six columns sets the product name three words to a line, and the
 * name is the whole reason this section exists.
 */
function emailLineRow(line: InvoiceLine, isV2: boolean): string {
  const tax = lineTax(line)
  // Three lines, not six: what it is, what it cost, and — only on a document
  // that must state them — the tax facts, run together on one line where they
  // are available to anyone checking and invisible to everyone else.
  const identity = [line.size, line.sku].filter(Boolean).join(' · ')
  const arithmetic = `${line.qty} × ${formatMoneyINR(line.unitPriceInr)}`
  const taxLine = isV2
    ? [
        line.hsn ? `HSN ${line.hsn}` : '',
        line.taxableValuePaise !== undefined
          ? `Taxable ${formatMoneyFromPaise(line.taxableValuePaise)}`
          : '',
        tax ? `${tax.label} ${formatMoneyFromPaise(tax.amountPaise)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    `<tr>` +
    `<td style="${EMAIL_CELL}width:64px;padding-left:0;" valign="top">${emailThumb(line)}</td>` +
    `<td style="${EMAIL_CELL}" valign="top">` +
    `<div style="font-size:15px;font-weight:bold;line-height:1.35;">${escapeHtml(line.name)}</div>` +
    (identity ? `<div style="${EMAIL_MUTED}margin-top:3px;">${escapeHtml(identity)}</div>` : '') +
    `<div style="${EMAIL_MUTED}margin-top:3px;font-variant-numeric:tabular-nums;">${escapeHtml(arithmetic)}</div>` +
    (taxLine
      ? `<div style="color:${MUTED};font-size:11px;line-height:1.5;margin-top:5px;font-variant-numeric:tabular-nums;">${escapeHtml(taxLine)}</div>`
      : '') +
    `</td>` +
    `<td style="${EMAIL_CELL}${NUM}padding-right:0;font-size:15px;font-weight:bold;" valign="top">` +
    `${escapeHtml(formatMoneyINR(line.lineTotalInr))}</td>` +
    `</tr>`
  )
}

/** One `label / value` pair of the header facts strip. */
function emailFact(label: string, value: string): string {
  return (
    `<td style="padding:0 12px 12px 0;vertical-align:top;" width="50%">` +
    `<div style="${EMAIL_LABEL}">${escapeHtml(label)}</div>` +
    `<div style="font-size:13px;color:${INK};margin-top:3px;font-variant-numeric:tabular-nums;">${escapeHtml(value)}</div>` +
    `</td>`
  )
}

/** Facts are laid two to a row; an odd count gets a blank cell so the grid stays square. */
function emailFactRows(facts: Array<[string, string]>): string {
  const rows: string[] = []
  for (let i = 0; i < facts.length; i += 2) {
    const pair = facts.slice(i, i + 2)
    rows.push(
      `<tr>` +
        pair.map(([label, value]) => emailFact(label, value)).join('') +
        (pair.length === 1 ? `<td width="50%"></td>` : '') +
        `</tr>`
    )
  }
  return rows.join('')
}

/** A block with a hairline above it — the email's only sectioning device. */
function emailBlock(body: string): string {
  return `<div style="border-top:1px solid ${RULE};padding-top:16px;margin-top:24px;">${body}</div>`
}

/** The same block, titled. */
function emailSection(title: string, body: string): string {
  return emailBlock(`<div style="${EMAIL_LABEL}margin-bottom:8px;">${escapeHtml(title)}</div>${body}`)
}

/** One labelled column of the two-up party block. */
function emailParty(label: string, name: string, lines: string[]): string {
  return (
    `<td valign="top" width="50%" style="padding-right:16px;">` +
    `<div style="${EMAIL_LABEL}">${escapeHtml(label)}</div>` +
    `<div style="font-size:13px;font-weight:bold;margin-top:8px;">${escapeHtml(name)}</div>` +
    lines
      .filter(Boolean)
      .map((l) => `<div style="${EMAIL_MUTED}margin-top:2px;">${escapeHtml(l)}</div>`)
      .join('') +
    `</td>`
  )
}

function emailManufacturerBlock(
  block: InvoiceManufacturerBlock,
  fallbackContact: string,
  showSkus: boolean
): string {
  const parts = [
    `<div style="font-weight:bold;">${escapeHtml(block.legalName)}</div>`,
    block.address ? `<div style="${EMAIL_MUTED}">${escapeHtml(block.address)}</div>` : '',
    block.licence
      ? `<div style="${EMAIL_MUTED}">Cosmetics manufacturing licence: ${escapeHtml(block.licence)}</div>`
      : '',
    `<div style="${EMAIL_MUTED}">Country of origin: ${escapeHtml(block.countryOfOrigin)}</div>`,
    `<div style="${EMAIL_MUTED}">Consumer care: ${escapeHtml(consumerCare(block, fallbackContact))}</div>`,
    showSkus
      ? `<div style="${EMAIL_MUTED}">Applies to: ${escapeHtml(block.skus.join(', '))}</div>`
      : '',
  ]
  return `<div style="margin-bottom:10px;">${parts.filter(Boolean).join('')}</div>`
}

/**
 * The opening. A shopper opening this in their inbox is asking one question —
 * "did my order go through?" — so the answer is the first line, in their own
 * name, before any document furniture. A refunded copy must never open with
 * thanks for a purchase whose money has already gone back.
 */
function emailGreeting(doc: InvoiceDocument): { head: string; sub: string } {
  const first = doc.buyer.name.trim().split(/\s+/)[0] ?? ''
  if (doc.status === 'refunded') {
    return {
      head: first ? `Your refund is on its way, ${first}.` : 'Your refund is on its way.',
      sub: 'This copy records the original sale. Nothing further is owed on it — the amount below has been returned to the way you paid.',
    }
  }
  return {
    head: first ? `Thank you, ${first}.` : 'Thank you for your order.',
    sub: "Your order is confirmed and we're getting it packed. Here's exactly what's coming, and what you paid for it. Keep this copy — it's your invoice for returns and support.",
  }
}

/**
 * The customer's emailed copy: the whole invoice inline in the message body, so
 * it needs no attachment, no PDF toolchain and no download before it can be
 * read — the shopper's mail client prints or saves-as-PDF from here.
 *
 * It reads as a receipt first and a legal document second: the greeting, the
 * items with their pictures and the amount paid come before the party blocks,
 * tax summary and statutory declarations, all of which are still present in
 * full further down. Order of reading, not order of importance to a registrar.
 *
 * One column, 640px, no `<style>`, no media queries — the layout has to hold at
 * a 320px phone width without them, which is why nothing here is a multi-column
 * grid except the two-up facts strip and the party blocks, both of which carry
 * short lines that survive being squeezed.
 */
export function renderInvoiceEmailHtml(doc: InvoiceDocument): string {
  const buyerLines = addressLines(doc.buyer)
  const showSkus = doc.manufacturers.length > 1
  const isV2 = doc.docVersion === 2
  const refunded = doc.status === 'refunded'
  const greeting = emailGreeting(doc)
  const brand = doc.seller.brand || doc.seller.legalName
  const totalLabel = refunded ? 'Invoice total' : 'Total paid'

  const itemRows = doc.lines.map((line) => emailLineRow(line, isV2)).join('')

  const rateWiseRows =
    isV2 && doc.totals.rateWise
      ? doc.totals.rateWise
          .map(
            (row) =>
              `<tr>` +
              `<td style="${EMAIL_RATE_CELL}padding-left:0;">${row.gstRatePct}%</td>` +
              `<td style="${EMAIL_RATE_CELL}${NUM}">${escapeHtml(formatMoneyFromPaise(row.taxableValuePaise))}</td>` +
              `<td style="${EMAIL_RATE_CELL}${NUM}">${escapeHtml(formatMoneyFromPaise(row.cgstPaise))}</td>` +
              `<td style="${EMAIL_RATE_CELL}${NUM}">${escapeHtml(formatMoneyFromPaise(row.sgstPaise))}</td>` +
              `<td style="${EMAIL_RATE_CELL}${NUM}">${escapeHtml(formatMoneyFromPaise(row.igstPaise))}</td>` +
              `<td style="${EMAIL_RATE_CELL}${NUM}padding-right:0;">${escapeHtml(formatMoneyFromPaise(row.totalTaxPaise))}</td>` +
              `</tr>`
          )
          .join('')
      : ''

  const rateWiseTable =
    isV2 && rateWiseRows
      ? emailSection(
          'Tax summary',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:12px;">` +
            `<thead><tr>` +
            // Explicit widths: left to itself the browser gives "Rate" a third
            // of the table and crushes the figures it exists to line up.
            `<th width="14%" style="${EMAIL_HEAD_CELL}padding-left:0;">Rate</th>` +
            `<th width="19%" style="${EMAIL_HEAD_CELL}text-align:right;">Taxable</th>` +
            `<th width="16%" style="${EMAIL_HEAD_CELL}text-align:right;">CGST</th>` +
            `<th width="16%" style="${EMAIL_HEAD_CELL}text-align:right;">SGST</th>` +
            `<th width="16%" style="${EMAIL_HEAD_CELL}text-align:right;">IGST</th>` +
            `<th width="19%" style="${EMAIL_HEAD_CELL}text-align:right;padding-right:0;">Total tax</th>` +
            `</tr></thead><tbody>${rateWiseRows}</tbody></table>`
        )
      : ''

  const totalsRows = [
    emailTotalsRow('Items total', formatMoneyINR(doc.totals.goodsInr)),
    doc.totals.couponDiscountInr > 0
      ? emailTotalsRow('Discount', `- ${formatMoneyINR(doc.totals.couponDiscountInr)}`)
      : '',
    emailTotalsRow(
      'Delivery charges',
      doc.totals.shippingFeeInr > 0 ? formatMoneyINR(doc.totals.shippingFeeInr) : 'FREE'
    ),
  ]
    .filter(Boolean)
    .join('')

  const facts: Array<[string, string]> = [
    ['Order no.', doc.orderId],
    ['Order date', formatInvoiceDate(doc.orderedAt)],
    ['Invoice no.', doc.invoiceNumber],
    ['Invoice date', formatInvoiceDate(doc.issuedAt)],
  ]
  if (doc.placeOfSupply) {
    facts.push(['Place of supply', `${doc.placeOfSupply.state} (${doc.placeOfSupply.code})`])
  }

  return (
    `<div style="${EMAIL_TEXT}background-color:${PAGE};padding:24px 12px;line-height:1.5;">` +
    // Inbox preview line: what the list view shows next to the subject. Hidden
    // in the body itself, hence the zero metrics rather than `display:none`,
    // which several clients ignore.
    `<div style="display:none;font-size:1px;color:${PAGE};max-height:0;max-width:0;opacity:0;overflow:hidden;">` +
    `${escapeHtml(`${totalLabel} ${formatMoneyINR(doc.totals.totalInr)} · order ${doc.orderId}`)}` +
    `</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:640px;margin:0 auto;background-color:#ffffff;border:1px solid ${RULE};border-radius:12px;">` +
    // 20px side padding, not the 28 the desktop width would carry happily: a
    // 320px phone has to fit the six-column tax summary between these two
    // edges, and there is no media query available to relax them there.
    `<tr><td style="padding:30px 20px 26px;">` +
    // Masthead
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr>` +
    `<td valign="top" style="${SERIF}font-size:22px;letter-spacing:0.1em;color:${ACCENT};">${escapeHtml(brand)}</td>` +
    `<td valign="top" align="right" style="${EMAIL_LABEL}padding-top:6px;">${escapeHtml(doc.title)}</td>` +
    `</tr></table>` +
    // Greeting
    `<div style="${SERIF}font-size:28px;line-height:1.25;color:${INK};margin:28px 0 0;">${escapeHtml(greeting.head)}</div>` +
    `<div style="font-size:14px;color:${MUTED};margin:10px 0 0;max-width:52em;">${escapeHtml(greeting.sub)}</div>` +
    // Facts strip
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">` +
    emailFactRows(facts) +
    `</table>` +
    // Items
    `<div style="border-top:1px solid ${INK};padding-top:14px;margin-top:8px;">` +
    `<div style="${EMAIL_LABEL}">${escapeHtml(refunded ? 'Items invoiced' : 'What you ordered')}</div>` +
    `</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:4px;">` +
    `<tbody>${itemRows}</tbody>` +
    `</table>` +
    // Totals, held right where the eye looks for a sum
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 auto;">` +
    totalsRows +
    `</table>` +
    // The amount, stated once, unmissably
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">` +
    `<tr><td style="background-color:${TINT};border-radius:10px;padding:18px 20px;">` +
    `<div style="${EMAIL_LABEL}">${escapeHtml(totalLabel)}</div>` +
    `<div style="${SERIF}font-size:32px;line-height:1.1;color:${INK};margin-top:4px;font-variant-numeric:tabular-nums;">` +
    `${escapeHtml(formatMoneyINR(doc.totals.totalInr))}</div>` +
    `<div style="font-size:12px;color:${MUTED};margin-top:6px;">${escapeHtml(doc.totals.amountInWords)}</div>` +
    `<div style="font-size:12px;color:${MUTED};margin-top:8px;">Paid by ${escapeHtml(doc.payment.mode)}` +
    (doc.payment.reference ? ` · Ref ${escapeHtml(doc.payment.reference)}` : '') +
    (refunded ? ` · <strong style="color:${ACCENT};">Refunded</strong>` : '') +
    `</div>` +
    `</td></tr></table>` +
    rateWiseTable +
    // Parties, each under its own label — the block has no title of its own,
    // because a single heading over two differently-named columns reads as if
    // it governs only the first.
    emailBlock(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        emailParty('Sold by', doc.seller.legalName, [
          doc.seller.address,
          doc.seller.supportEmail,
        ]) +
        emailParty('Delivering to', doc.buyer.name, [
          ...buyerLines,
          displayPhone(doc.buyer.phone),
        ]) +
        `</tr></table>`
    ) +
    // Manufacturer attribution
    emailSection(
      'Manufactured & marketed by',
      doc.manufacturers
        .map((block) => emailManufacturerBlock(block, doc.seller.supportEmail, showSkus))
        .join('')
    ) +
    // Notes
    `<div style="border-top:1px solid ${RULE};padding-top:16px;margin-top:24px;${EMAIL_MUTED}">` +
    `<div style="color:${INK};font-weight:bold;margin-bottom:4px;">${escapeHtml(doc.notes.gst)}</div>` +
    (doc.notes.footer
      ? `<div style="margin-bottom:4px;">${escapeHtml(doc.notes.footer)}</div>`
      : '') +
    (doc.notes.jurisdiction ? `<div>${escapeHtml(doc.notes.jurisdiction)}</div>` : '') +
    `</div>` +
    `</td></tr></table>` +
    // Off-card footer: the one thing a shopper needs that is not on the invoice.
    `<div style="max-width:640px;margin:16px auto 0;text-align:center;${EMAIL_MUTED}">` +
    `Questions about this order? Reply to this email or write to ` +
    `<a href="mailto:${escapeHtml(doc.seller.supportEmail)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(doc.seller.supportEmail)}</a>.` +
    `</div>` +
    `</div>`
  )
}

/**
 * Subject line for the customer's copy. Leads with the thing being answered —
 * the order — and carries the invoice number after it, so the message is
 * findable by either later.
 */
export function invoiceEmailSubject(doc: InvoiceDocument): string {
  const brand = doc.seller.brand || doc.seller.legalName
  return doc.status === 'refunded'
    ? `Your ${brand} refund · invoice ${doc.invoiceNumber}`
    : `Your ${brand} order is confirmed · invoice ${doc.invoiceNumber}`
}

// ── Print rendering ─────────────────────────────────────────────────────────

/**
 * One stylesheet, three surfaces: A4 paper, the admin print iframe, and the
 * app's WebView on a ~360px phone. The narrow layout is scoped to
 * `@media screen` so printing FROM a phone still emits the A4 sheet rather than
 * the stacked reading view.
 *
 * Money is set in `tabular-nums` throughout: proportional digits leave a column
 * of rupee figures visibly ragged, which is the one thing a totals column
 * cannot afford.
 */
const PRINT_STYLE = `
  :root {
    color-scheme: light;
    --ink: #2B1917;
    --muted: #7C665F;
    --rule: #E9D9CF;
    --rule-soft: #F2E8E2;
    --accent: #D81B60;
    --tint: #FCE4EC;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f2f2f2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif;
    color: var(--ink);
    font-size: 12px;
    line-height: 1.45;
    -webkit-text-size-adjust: 100%;
  }
  .sheet {
    --pad-x: 12mm;
    --pad-y: 14mm;
    width: 210mm;
    min-height: 297mm;
    margin: 12px auto;
    padding: var(--pad-y) var(--pad-x);
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.18);
  }
  .band {
    margin: calc(var(--pad-y) * -1) calc(var(--pad-x) * -1) 10mm;
    padding: 6px var(--pad-x);
    background: var(--ink);
    color: #fff;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); }
  .title { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
  .meta { font-size: 11px; min-width: 62mm; }
  .meta div { display: flex; justify-content: space-between; gap: 12px; padding: 1px 0; }
  .meta strong { font-weight: 400; color: var(--muted); }
  .meta span { font-variant-numeric: tabular-nums; }
  .parties { display: flex; gap: 12px; margin-top: 16px; }
  .party { flex: 1 1 0; border: 1px solid var(--rule); border-radius: 4px; padding: 10px 12px; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .name { font-weight: 700; margin-top: 3px; }
  .muted { color: var(--muted); }
  table.items { width: 100%; border-collapse: collapse; margin-top: 18px; }
  table.items th {
    text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); border-bottom: 1.5px solid var(--ink); padding: 0 4px 6px;
  }
  table.items td { padding: 9px 4px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  table.items tr { page-break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ctr { text-align: center; font-variant-numeric: tabular-nums; }
  .sku { color: var(--muted); font-size: 10px; margin-top: 1px; }
  /* The per-line arithmetic, spelled out only where the rate/qty columns are gone. */
  .calc { display: none; }
  /* Rate-wise GST summary (docVersion 2 only) — its own small bordered table,
     between the item table and the settle block. Wrapped in a scroll
     container on narrow screens rather than squeezed, since it is a GSTR-1
     input first and a reading surface second. */
  .ratewise-wrap { margin-top: 14px; overflow-x: auto; }
  table.ratewise { width: 100%; min-width: 100mm; border-collapse: collapse; font-size: 10.5px; }
  table.ratewise th {
    text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); border-bottom: 1px solid var(--ink); padding: 4px 6px;
  }
  table.ratewise td { padding: 5px 6px; border-bottom: 1px solid var(--rule-soft); font-variant-numeric: tabular-nums; }
  table.ratewise th.num, table.ratewise td.num { text-align: right; }
  .settle { margin-top: 14px; display: flex; justify-content: flex-end; }
  .totals { width: 62mm; border-collapse: collapse; }
  .totals td { padding: 3px 0; }
  .totals td:last-child { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .grandbox {
    margin-top: 10px; margin-left: auto; width: 62mm;
    border-left: 3px solid var(--accent);
    background: var(--tint);
    padding: 10px 12px;
    page-break-inside: avoid;
  }
  .grandbox .amount {
    font-size: 26px; font-weight: 700; line-height: 1.1; margin-top: 2px;
    font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
  }
  .grandbox .words { font-size: 10px; color: var(--muted); margin-top: 4px; }
  .pay { margin-top: 10px; font-size: 11px; color: var(--muted); }
  .section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--rule); page-break-inside: avoid; }
  .section .label { margin-bottom: 6px; }
  .mfr + .mfr { margin-top: 10px; }
  .notes { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--rule); font-size: 10.5px; color: var(--muted); }
  .notes div + div { margin-top: 3px; }
  .notes .gst { color: var(--ink); font-weight: 600; }
  .pagefoot { margin-top: 14px; text-align: center; font-size: 9.5px; color: var(--muted); }
  .cut { margin-top: 16px; border-top: 1px dashed var(--muted); padding-top: 10px; font-size: 10px; color: var(--muted); }
  .packto { font-size: 15px; font-weight: 700; color: var(--ink); }

  /* Phone reading view. \`screen\` only — printing from a handset still gets A4. */
  @media screen and (max-width: 640px) {
    body { background: #fff; font-size: 13.5px; line-height: 1.5; }
    .sheet {
      --pad-x: 16px;
      --pad-y: 18px;
      width: auto; min-height: 0; margin: 0; box-shadow: none;
    }
    .band { margin-bottom: 16px; }
    .head { flex-direction: column; gap: 12px; }
    .meta { min-width: 0; width: 100%; font-size: 12px; }
    .parties { flex-direction: column; gap: 10px; }
    /* Each line becomes its own block: title and SKU on top, the arithmetic
       beneath it, the amount held to the right where the eye scans for it. */
    table.items { display: block; margin-top: 16px; }
    table.items thead { display: none; }
    table.items tbody, table.items tr { display: block; }
    table.items tr {
      display: flex; flex-wrap: wrap; align-items: baseline;
      border-bottom: 1px solid var(--rule-soft); padding: 11px 0;
    }
    /* Every per-cell rule below has to outrank the \`table.items td\` reset
       directly above it, so they are all written at that same depth. */
    table.items td { display: block; border: none; padding: 0; }
    table.items td.idx, table.items td.qty, table.items td.rate,
    table.items td.taxable, table.items td.tax { display: none; }
    table.items td.item { flex: 1 1 60%; min-width: 0; }
    table.items td.amt { margin-left: auto; padding-left: 12px; font-weight: 600; }
    .calc { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
    .settle { display: block; }
    .totals, .grandbox { width: 100%; }
    .grandbox .amount { font-size: 30px; }
  }

  @media print {
    @page { size: A4; margin: 10mm; }
    body { background: #fff; }
    .sheet { --pad-x: 0; --pad-y: 0; width: auto; min-height: 0; margin: 0; box-shadow: none; }
    .band { margin: 0 0 8mm; padding: 5px 8px; }
    .grandbox { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .noprint { display: none !important; }
  }
`

function printParty(label: string, name: string, lines: string[], extra: string[] = []): string {
  return (
    `<div class="party">` +
    `<div class="label">${escapeHtml(label)}</div>` +
    `<div class="name">${escapeHtml(name)}</div>` +
    lines.map((l) => `<div class="muted">${escapeHtml(l)}</div>`).join('') +
    extra.map((l) => `<div class="muted">${escapeHtml(l)}</div>`).join('') +
    `</div>`
  )
}

/** One `label / value` line of the header block. */
function printMetaRow(label: string, value: string): string {
  return `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`
}

function printManufacturer(
  block: InvoiceManufacturerBlock,
  fallbackContact: string,
  showSkus: boolean
): string {
  return (
    `<div class="mfr">` +
    `<div class="name">${escapeHtml(block.legalName)}</div>` +
    (block.address ? `<div class="muted">${escapeHtml(block.address)}</div>` : '') +
    (block.licence
      ? `<div class="muted">Cosmetics manufacturing licence: ${escapeHtml(block.licence)}</div>`
      : '') +
    `<div class="muted">Country of origin: ${escapeHtml(block.countryOfOrigin)}</div>` +
    `<div class="muted">Consumer care: ${escapeHtml(consumerCare(block, fallbackContact))}</div>` +
    (showSkus ? `<div class="muted">Applies to: ${escapeHtml(block.skus.join(', '))}</div>` : '') +
    `</div>`
  )
}

/**
 * The printable page. `copy: 'delivery'` is the version that travels in the
 * parcel: it carries a DELIVERY COPY band so the two are never confused on a
 * packing bench, plus a tear-off address block below a cut line.
 *
 * Returns a complete standalone HTML document — it is served as `text/html`,
 * loaded into the admin panel's print iframe and into the app's WebView, so it
 * cannot assume any surrounding page.
 */
export function renderInvoicePrintHtml(
  doc: InvoiceDocument,
  options: { copy?: InvoiceCopy } = {}
): string {
  const copy: InvoiceCopy = options.copy ?? 'customer'
  const buyerLines = addressLines(doc.buyer)
  const showSkus = doc.manufacturers.length > 1
  const isV2 = doc.docVersion === 2

  const itemRows = doc.lines
    .map((line, index) => {
      const tax = lineTax(line)
      const hsnLine = line.hsn ? `<div class="sku">HSN ${escapeHtml(line.hsn)}</div>` : ''
      // Carries the qty/rate/taxable/tax columns' information for the narrow
      // layout, where those columns are hidden rather than squeezed.
      const calc =
        `<div class="calc">${line.qty} × ${escapeHtml(formatMoneyINR(line.unitPriceInr))}</div>` +
        (tax
          ? `<div class="calc">${escapeHtml(tax.label)} · ${escapeHtml(formatMoneyFromPaise(tax.amountPaise))}</div>`
          : '')
      const taxCells = isV2
        ? `<td class="taxable num">${escapeHtml(formatMoneyFromPaise(line.taxableValuePaise ?? 0))}</td>` +
          `<td class="tax num">${tax ? `${escapeHtml(tax.label)}<br>${escapeHtml(formatMoneyFromPaise(tax.amountPaise))}` : ''}</td>`
        : ''
      return (
        `<tr>` +
        `<td class="idx">${index + 1}</td>` +
        `<td class="item">${escapeHtml(lineTitle(line.name, line.size))}` +
        `<div class="sku">${escapeHtml(line.sku)}</div>` +
        hsnLine +
        calc +
        `</td>` +
        `<td class="qty ctr">${line.qty}</td>` +
        `<td class="rate num">${escapeHtml(formatMoneyINR(line.unitPriceInr))}</td>` +
        taxCells +
        `<td class="amt num">${escapeHtml(formatMoneyINR(line.lineTotalInr))}</td>` +
        `</tr>`
      )
    })
    .join('')

  const rateWiseBlock =
    isV2 && doc.totals.rateWise && doc.totals.rateWise.length > 0
      ? `<div class="ratewise-wrap"><table class="ratewise">` +
        `<thead><tr>` +
        `<th>Rate</th><th class="num">Taxable</th><th class="num">CGST</th>` +
        `<th class="num">SGST</th><th class="num">IGST</th><th class="num">Total tax</th>` +
        `</tr></thead><tbody>` +
        doc.totals.rateWise
          .map(
            (row) =>
              `<tr>` +
              `<td>${row.gstRatePct}%</td>` +
              `<td class="num">${escapeHtml(formatMoneyFromPaise(row.taxableValuePaise))}</td>` +
              `<td class="num">${escapeHtml(formatMoneyFromPaise(row.cgstPaise))}</td>` +
              `<td class="num">${escapeHtml(formatMoneyFromPaise(row.sgstPaise))}</td>` +
              `<td class="num">${escapeHtml(formatMoneyFromPaise(row.igstPaise))}</td>` +
              `<td class="num">${escapeHtml(formatMoneyFromPaise(row.totalTaxPaise))}</td>` +
              `</tr>`
          )
          .join('') +
        `</tbody></table></div>`
      : ''

  const discountRow =
    doc.totals.couponDiscountInr > 0
      ? `<tr><td>Discount</td><td>- ${escapeHtml(formatMoneyINR(doc.totals.couponDiscountInr))}</td></tr>`
      : ''

  const band =
    copy === 'delivery' ? `<div class="band">Delivery copy — pack with the order</div>` : ''

  const packSlip =
    copy === 'delivery'
      ? `<div class="cut">` +
        `<div class="label">Deliver to</div>` +
        `<div class="packto">${escapeHtml(doc.buyer.name)}</div>` +
        buyerLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') +
        `<div>${escapeHtml(displayPhone(doc.buyer.phone))}</div>` +
        `<div class="muted">Order ${escapeHtml(doc.orderId)} · Invoice ${escapeHtml(doc.invoiceNumber)}</div>` +
        `</div>`
      : ''

  return (
    `<!doctype html>` +
    `<html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(doc.title)} ${escapeHtml(doc.invoiceNumber)}</title>` +
    `<style>${PRINT_STYLE}</style>` +
    `</head><body>` +
    `<div class="sheet">` +
    band +
    `<div class="head">` +
    `<div>` +
    `<div class="brand">${escapeHtml(doc.seller.brand || doc.seller.legalName)}</div>` +
    `<div class="title">${escapeHtml(doc.title)}</div>` +
    `</div>` +
    `<div class="meta">` +
    printMetaRow('Invoice no.', doc.invoiceNumber) +
    printMetaRow('Invoice date', formatInvoiceDate(doc.issuedAt)) +
    printMetaRow('Order no.', doc.orderId) +
    printMetaRow('Order date', formatInvoiceDate(doc.orderedAt)) +
    (doc.paidAt ? printMetaRow('Paid on', formatInvoiceDateTime(doc.paidAt)) : '') +
    (doc.placeOfSupply
      ? printMetaRow('Place of supply', `${doc.placeOfSupply.state} (${doc.placeOfSupply.code})`)
      : '') +
    `</div>` +
    `</div>` +
    // One buyer box, not a "Billed to" and a "Shipped to": the document is
    // frozen from a single address snapshot, so the two could only ever print
    // the same lines twice.
    `<div class="parties">` +
    printParty('Sold by', doc.seller.legalName, [doc.seller.address], [doc.seller.supportEmail]) +
    printParty('Billed & shipped to', doc.buyer.name, buyerLines, [displayPhone(doc.buyer.phone)]) +
    `</div>` +
    `<table class="items">` +
    `<thead><tr>` +
    `<th style="width:8mm;">#</th><th>Item</th><th class="ctr" style="width:12mm;">Qty</th>` +
    `<th class="num" style="width:24mm;">Rate</th>` +
    (isV2
      ? `<th class="num" style="width:22mm;">Taxable</th><th class="num" style="width:28mm;">Tax</th>`
      : '') +
    `<th class="num" style="width:26mm;">Amount</th>` +
    `</tr></thead>` +
    `<tbody>${itemRows}</tbody>` +
    `</table>` +
    rateWiseBlock +
    `<div class="settle">` +
    `<table class="totals">` +
    `<tr><td>Items total</td><td>${escapeHtml(formatMoneyINR(doc.totals.goodsInr))}</td></tr>` +
    discountRow +
    `<tr><td>Delivery charges</td><td>${escapeHtml(doc.totals.shippingFeeInr > 0 ? formatMoneyINR(doc.totals.shippingFeeInr) : 'FREE')}</td></tr>` +
    `</table>` +
    `</div>` +
    `<div class="grandbox">` +
    // A refunded invoice still records the sale, so it cannot claim the money
    // is with us — it reports the total it was issued for.
    `<div class="label">${doc.status === 'refunded' ? 'Invoice total' : 'Total paid'}</div>` +
    `<div class="amount">${escapeHtml(formatMoneyINR(doc.totals.totalInr))}</div>` +
    `<div class="words">${escapeHtml(doc.totals.amountInWords)}</div>` +
    `</div>` +
    `<div class="pay">Payment: ${escapeHtml(doc.payment.mode)}` +
    (doc.payment.reference ? ` · Ref ${escapeHtml(doc.payment.reference)}` : '') +
    (doc.status === 'refunded' ? ' · <strong>REFUNDED</strong>' : '') +
    `</div>` +
    `<div class="section">` +
    `<div class="label">Manufactured &amp; marketed by</div>` +
    doc.manufacturers.map((b) => printManufacturer(b, doc.seller.supportEmail, showSkus)).join('') +
    `</div>` +
    `<div class="notes">` +
    `<div class="gst">${escapeHtml(doc.notes.gst)}</div>` +
    (doc.notes.footer ? `<div>${escapeHtml(doc.notes.footer)}</div>` : '') +
    (doc.notes.jurisdiction ? `<div>${escapeHtml(doc.notes.jurisdiction)}</div>` : '') +
    `<div>Questions about this order: ${escapeHtml(doc.seller.supportEmail)}</div>` +
    `</div>` +
    packSlip +
    // Single-sheet by construction: an order's line count cannot overflow one
    // A4 page at this catalog's size, so "1 of 1" is a statement of fact rather
    // than a guess. Revisit if orders ever grow past ~25 lines.
    `<div class="pagefoot">Page 1 of 1 · ${escapeHtml(doc.invoiceNumber)}</div>` +
    `</div>` +
    `</body></html>`
  )
}
