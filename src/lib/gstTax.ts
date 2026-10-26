/**
 * The GST decomposition (docs plan `there-s-a-big-strategy-validated-clover.md`
 * §2.3). Pure, paise-based, no DB/config/clock — same reason `lib/pricing.ts`
 * and `lib/invoiceDocument.ts` are pure: a legal document's arithmetic has to
 * be independently testable and never depend on what else happens to be true
 * at call time.
 *
 * **Tax is a decomposition of an unchanged total, never an addition to it.**
 * `cart.totalInr` / `payments.amount_paise` / the Razorpay amount are byte-
 * identical before and after this module exists — it only SPLITS the already-
 * final rupee amount into taxable value + tax. Nothing here may change what a
 * shopper pays.
 *
 * Two legal points encoded here, so nobody "simplifies" them later:
 * - **Shipping is apportioned into the goods, not taxed separately** (s.15(2)(c)
 *   — any amount charged for delivery is part of the value of supply, taxed at
 *   the goods' own rate). A mixed-rate cart apportions pro-rata.
 * - **The coupon is deducted before tax** (s.15(3)(a) — a discount known at the
 *   time of supply reduces the transaction value).
 *
 * Invariant, asserted here and in `test/lib/gstTax.test.ts`:
 * `Σ(taxableValuePaise + taxPaise) === totalInr × 100`.
 */

/** One priced order line, exactly as frozen in `payments.cart_snapshot` at order time. */
export interface GstLineInput {
  sku: string
  qty: number
  /** Price actually charged per unit, whole rupees (post-discount, as frozen). */
  priceInr: number
  /** Frozen at order time alongside the price — see `products.gstRatePct`. */
  gstRatePct: number
}

/** One line's tax decomposition. */
export interface GstDecomposedLine {
  sku: string
  gstRatePct: number
  /** qty × priceInr × 100, before coupon/shipping apportionment. */
  lineGrossPaise: number
  /** This line's largest-remainder share of the order's coupon discount. */
  couponSharePaise: number
  /** This line's largest-remainder share of the order's shipping fee. */
  shippingSharePaise: number
  /** lineGrossPaise − couponSharePaise + shippingSharePaise. */
  lineInclusivePaise: number
  taxableValuePaise: number
  /** cgstPaise + sgstPaise + igstPaise for this line. */
  taxPaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
}

/** One row of the invoice footer's rate-wise summary (also the GSTR-1 rate-wise input). */
export interface GstRateSummaryRow {
  gstRatePct: number
  taxableValuePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalTaxPaise: number
}

export interface GstDecomposeInput {
  lines: GstLineInput[]
  /** Whole rupees — `cart_snapshot.couponDiscountInr`. */
  couponDiscountInr: number
  /** Whole rupees — `cart_snapshot.shippingFeeInr`. */
  shippingFeeInr: number
  /** Whole rupees — `cart_snapshot.totalInr`, the amount actually charged. */
  totalInr: number
  /** True ⇒ IGST (delivery state ≠ seller's registered state). False ⇒ CGST+SGST. */
  interState: boolean
}

export interface GstDecomposeResult {
  lines: GstDecomposedLine[]
  rateWise: GstRateSummaryRow[]
  totals: {
    taxableValuePaise: number
    cgstPaise: number
    sgstPaise: number
    igstPaise: number
    totalTaxPaise: number
  }
}

/**
 * Split `amountPaise` across `weights` proportionally so the parts sum
 * EXACTLY to `amountPaise` — floor division alone leaves paise unassigned;
 * whoever has the largest fractional remainder receives the leftover, one
 * paisa at a time (the standard largest-remainder / Hamilton apportionment
 * method). Serves both the coupon and shipping splits (docs plan §2.3).
 *
 * All-zero weights (e.g. an all-free-item cart) return all zeros rather than
 * dividing by zero.
 */
export function apportionByWeight(amountPaise: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  if (amountPaise === 0 || totalWeight === 0 || weights.length === 0) {
    return weights.map(() => 0)
  }

  const raw = weights.map((w) => (amountPaise * w) / totalWeight)
  const floors = raw.map(Math.floor)
  const allocated = floors.reduce((sum, f) => sum + f, 0)
  const remaining = amountPaise - allocated

  const byRemainderDesc = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac)

  const result = [...floors]
  for (let k = 0; k < remaining; k += 1) {
    const slot = byRemainderDesc[k % byRemainderDesc.length]!
    result[slot.i] = result[slot.i]! + 1
  }
  return result
}

function sumRateWise(lines: GstDecomposedLine[]): GstRateSummaryRow[] {
  const byRate = new Map<number, GstRateSummaryRow>()
  for (const line of lines) {
    const row = byRate.get(line.gstRatePct) ?? {
      gstRatePct: line.gstRatePct,
      taxableValuePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      totalTaxPaise: 0,
    }
    row.taxableValuePaise += line.taxableValuePaise
    row.cgstPaise += line.cgstPaise
    row.sgstPaise += line.sgstPaise
    row.igstPaise += line.igstPaise
    row.totalTaxPaise += line.taxPaise
    byRate.set(line.gstRatePct, row)
  }
  return [...byRate.values()].sort((a, b) => a.gstRatePct - b.gstRatePct)
}

/**
 * Decompose a priced order into its GST components. Throws if the result
 * doesn't reconcile to `totalInr` — that can only happen if a caller passed a
 * `totalInr` inconsistent with `goodsInr − couponDiscountInr + shippingFeeInr`
 * (the identity the rest of the codebase already guarantees), and printing a
 * tax invoice whose lines don't sum to the amount charged is worse than
 * throwing before it's issued.
 */
export function decomposeCartGst(input: GstDecomposeInput): GstDecomposeResult {
  const { lines, couponDiscountInr, shippingFeeInr, totalInr, interState } = input

  const lineGrossPaise = lines.map((line) => line.qty * line.priceInr * 100)
  const couponShares = apportionByWeight(couponDiscountInr * 100, lineGrossPaise)
  const shippingShares = apportionByWeight(shippingFeeInr * 100, lineGrossPaise)

  const decomposed: GstDecomposedLine[] = lines.map((line, i) => {
    const lineGrossPaiseI = lineGrossPaise[i]!
    const couponSharePaise = couponShares[i]!
    const shippingSharePaise = shippingShares[i]!
    const lineInclusivePaise = lineGrossPaiseI - couponSharePaise + shippingSharePaise

    const taxableValuePaise = Math.round((lineInclusivePaise * 100) / (100 + line.gstRatePct))
    const taxPaise = lineInclusivePaise - taxableValuePaise

    const cgstPaise = interState ? 0 : Math.floor(taxPaise / 2)
    const sgstPaise = interState ? 0 : taxPaise - cgstPaise
    const igstPaise = interState ? taxPaise : 0

    return {
      sku: line.sku,
      gstRatePct: line.gstRatePct,
      lineGrossPaise: lineGrossPaiseI,
      couponSharePaise,
      shippingSharePaise,
      lineInclusivePaise,
      taxableValuePaise,
      taxPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
    }
  })

  const totals = decomposed.reduce(
    (acc, line) => ({
      taxableValuePaise: acc.taxableValuePaise + line.taxableValuePaise,
      cgstPaise: acc.cgstPaise + line.cgstPaise,
      sgstPaise: acc.sgstPaise + line.sgstPaise,
      igstPaise: acc.igstPaise + line.igstPaise,
      totalTaxPaise: acc.totalTaxPaise + line.taxPaise,
    }),
    { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalTaxPaise: 0 }
  )

  const expectedPaise = totalInr * 100
  const actualPaise = totals.taxableValuePaise + totals.totalTaxPaise
  if (actualPaise !== expectedPaise) {
    throw new Error(
      `decomposeCartGst: invariant violated — Σ(taxable+tax) ${actualPaise} !== totalInr×100 ${expectedPaise}`
    )
  }

  return { lines: decomposed, rateWise: sumRateWise(decomposed), totals }
}
