/**
 * The first-contact auto-reply body — "here is what we have in stock".
 *
 * Pure: a catalog snapshot in, a WhatsApp text body out. No DB, no config, no
 * network, same rule as `lib/whatsapp/inbound.ts`. The route owns fetching the
 * snapshot; this file owns nothing but the words.
 *
 * **Still no AI.** This is a deterministic render of the live catalog, not an
 * answer to whatever the shopper asked. It exists because the phase-1 holding
 * message ("someone will reply shortly") answers a question nobody asked — the
 * shopper who opens this chat from a product page overwhelmingly wants to know
 * what is sold and what it costs, and that is a fact we already hold. Anything
 * beyond it stays a human's job until phase 2.
 */

import type { CatalogSnapshot } from '../../contracts/catalog.js'

/**
 * Fallback when the catalog cannot be read or has nothing sellable in it.
 *
 * A shopper who messages an unknown business and hears nothing has just had
 * their suspicion confirmed, so silence is never an option here — even a
 * catalog outage answers, it just promises a human instead of a price list.
 */
export const FALLBACK_AUTO_REPLY =
  'Thanks for reaching out to Tiny Tales! Someone from our team will reply here shortly. ' +
  'You can send your question, a photo, or the product you are looking at.'

/** Shop URL printed at the bottom of the list. */
const SHOP_URL = 'https://www.tinytalesforus.com'

/**
 * Caps. WhatsApp's own text limit is 4096 characters, but the real constraint
 * is a phone screen: a reply that has to be scrolled twice before the shopper
 * finds a price reads as a catalogue dump, not an answer. Products are capped
 * first and variants second, because a shopper needs to see that the range
 * exists more than they need every size of the first item in it.
 */
const MAX_PRODUCTS = 8
const MAX_SIZES_PER_PRODUCT = 4

/** `1299` → `₹1,299`. Indian grouping, no decimals — every price here is whole rupees. */
function formatInr(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN')}`
}

/**
 * Shorten a catalog name to something a person would say out loud.
 *
 * `products.name` is written for Amazon search — "Daniya Shampoo for Silky,
 * Long & Strong Hair with Anti-Dandruff & Anti-Hairfall Care - Men & Women".
 * Set as a bold line above three prices, that wraps to four lines and buries
 * the answer. The qualifier always starts at the first ` for `/` with `/` - `,
 * so cutting there leaves the name the shopper actually recognises and the
 * site keeps the full one.
 */
function shortName(name: string): string {
  const cut = name.split(/\s+(?:for|with)\s+|\s+[-–]\s+|,\s+/i)[0]?.trim() || name.trim()
  if (cut.length <= 52) return cut
  return `${cut.slice(0, 51).replace(/\s+\S*$/, '')}…`
}

/** `rose-pink` → `rose pink`. The slug is internal; the shopper reads the words. */
function prettyColor(color: string): string {
  return color.replace(/[-_]+/g, ' ').trim()
}

/**
 * Build the in-stock price list.
 *
 * Returns {@link FALLBACK_AUTO_REPLY} rather than an empty or apologetic
 * message when nothing is sellable: "we have nothing" is a worse first
 * impression than a human promise, and an all-dark catalog is an incident
 * somebody is already looking at.
 *
 * Only `in_stock` variants are listed. Listing an out-of-stock size would
 * invite exactly the reply this feature exists to avoid — a shopper asking for
 * something we then have to refuse.
 *
 * Variants are collapsed to one line PER SIZE, not per SKU. The body cream
 * ships three colours in every size, so a per-SKU list prints "100ml — ₹119"
 * three times over and reads like a bug. Colours are named once, under the
 * sizes, which is also how a shopper asks for one.
 */
export function buildCatalogAutoReply(snapshot: CatalogSnapshot | null): string {
  const products = (snapshot?.products ?? [])
    .map((product) => {
      // Only pieces a shopper can pay for: in stock and priced.
      const live = product.variants.filter(
        (variant): variant is typeof variant & { effective_price_inr: number } =>
          variant.in_stock && variant.effective_price_inr !== null
      )

      // Group by size, cheapest first — the price shown must be one a shopper
      // can actually pay for that size, so it tracks the variant it came from.
      const bySize = new Map<string, { price: number; mrp: number }>()
      for (const variant of live) {
        const current = bySize.get(variant.size)
        if (!current || variant.effective_price_inr < current.price) {
          bySize.set(variant.size, { price: variant.effective_price_inr, mrp: variant.mrp_inr })
        }
      }

      const colors = [
        ...new Set(live.map((variant) => variant.color ?? '').filter((color) => color !== '')),
      ]

      return {
        name: shortName(product.name),
        sizes: [...bySize.entries()].slice(0, MAX_SIZES_PER_PRODUCT),
        // One colour is not a choice, so it is not worth a line.
        colors: colors.length > 1 ? colors.map(prettyColor) : [],
      }
    })
    .filter((product) => product.sizes.length > 0)

  if (products.length === 0) return FALLBACK_AUTO_REPLY

  const shown = products.slice(0, MAX_PRODUCTS)
  const lines: string[] = [
    'Thanks for reaching out to Tiny Tales! 🌿',
    '',
    "Here's what we have in stock right now:",
    '',
  ]

  for (const product of shown) {
    // `*bold*` is WhatsApp's markup, not Markdown's `**`.
    lines.push(`*${product.name}*`)
    for (const [size, { price, mrp }] of product.sizes) {
      // Show the strike-through MRP only when there is a real saving; an
      // "offer" that equals the price reads as a trick.
      const struck = mrp > price ? ` (MRP ~${formatInr(mrp)}~)` : ''
      lines.push(`• ${size} — ${formatInr(price)}${struck}`)
    }
    if (product.colors.length > 0) lines.push(`Shades: ${product.colors.join(', ')}`)
    lines.push('')
  }

  if (products.length > shown.length) {
    lines.push(`…and ${products.length - shown.length} more on the site.`, '')
  }

  lines.push(
    `Order online: ${SHOP_URL}`,
    '',
    'Reply here with the product you want, your PIN code, or any question — a human from our team is on this chat and will get back to you shortly.'
  )

  return lines.join('\n')
}
