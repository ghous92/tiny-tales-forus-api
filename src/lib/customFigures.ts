/**
 * Custom figures (miniatures and caricatures made from a shopper's photos) are
 * sold through the ordinary cart: one sku per kind, one unit per person. They
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
