/**
 * The colours a piece can be printed in: the common PLA filament shades every
 * Indian reseller stocks, so a colour offered here can always be bought.
 *
 * Each colour is its own variant and sku (`product_variants.color` holds the
 * slug), so cart, payments, invoices and fulfilment carry it with no extra
 * column. The variant with `color = null` is the piece as photographed.
 *
 * Seeded by `npm run db:color-variants` (scripts/seed-color-variants.ts). The
 * storefront's copy, with swatch values, is web `src/data/filamentColors.ts`;
 * keep the two in step.
 */
export const FILAMENT_COLORS = [
  { slug: 'black', label: 'Black', skuCode: 'BLK' },
  { slug: 'white', label: 'White', skuCode: 'WHT' },
  { slug: 'grey', label: 'Grey', skuCode: 'GRY' },
  { slug: 'red', label: 'Red', skuCode: 'RED' },
  { slug: 'orange', label: 'Orange', skuCode: 'ORG' },
  { slug: 'yellow', label: 'Yellow', skuCode: 'YLW' },
  { slug: 'green', label: 'Green', skuCode: 'GRN' },
  { slug: 'blue', label: 'Blue', skuCode: 'BLU' },
  { slug: 'pink', label: 'Pink', skuCode: 'PNK' },
  { slug: 'gold', label: 'Gold', skuCode: 'GLD' },
] as const

/**
 * `catalog_items.size` for a variant: the size, plus the colour when it has
 * one. Every order line, invoice and ops message is built from this column, so
 * this is what puts "Red" in front of whoever prints the order.
 */
export function catalogItemSize(size: string, color: string | null): string {
  if (!color) return size
  const label = FILAMENT_COLORS.find((c) => c.slug === color)?.label ?? color
  return `${size} · ${label}`
}
