/**
 * Custom figures (miniatures and caricatures made from a shopper's photos) are
 * sold through the ordinary cart: one product per kind, one sku per group size.
 * One unit is one piece, made from one photo of up to four people or pets. They
 * live in the catalog so cart, payments, tax and invoices treat them like any
 * other line, but they are kept out of `GET /v1/catalog` (services/catalogRead.ts)
 * because they cannot be bought without photos. The /custom/ page adds them.
 *
 * Seeded by `npm run db:custom-figures` (scripts/seed-custom-figures.ts).
 */
export const CUSTOM_FIGURE_CATEGORY = 'custom-figures'

export const CUSTOM_FIGURE_SKUS = {
  miniature: 'TT-CUSTOM-MINIATURE',
  caricature: 'TT-CUSTOM-CARICATURE',
} as const

export type CustomFigureKind = keyof typeof CUSTOM_FIGURE_SKUS

/** More than this in one piece is too hard to model and print. */
export const MAX_FIGURE_CHARACTERS = 4

export const CUSTOM_FIGURE_BASE_PRICE_INR = 1600

/**
 * Price of a piece against the price of one figure, by how many are in it. The
 * first extra is 0.7 and each one after is 0.6: a group costs less per head,
 * but every character is still modelled and painted, so the step never shrinks
 * further. Keep in step with the storefront's src/data/customFigures.ts.
 */
const GROUP_MULTIPLIER = [1, 1.7, 2.3, 2.9] as const

export function customFigureSku(kind: CustomFigureKind, characters: number): string {
  const sku = CUSTOM_FIGURE_SKUS[kind]
  return characters === 1 ? sku : `${sku}-${characters}`
}

/** To the nearest ₹10, so a changed base price still reads cleanly. */
export function customFigurePriceInr(basePriceInr: number, characters: number): number {
  const multiplier = GROUP_MULTIPLIER[characters - 1]
  if (multiplier === undefined) throw new RangeError(`No price for ${characters} characters`)
  return Math.round((basePriceInr * multiplier) / 10) * 10
}
