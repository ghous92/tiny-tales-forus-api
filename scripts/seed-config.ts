#!/usr/bin/env tsx
/**
 * `npm run db:seed-config` — inserts the SPEC-V2.md §2 default config values,
 * ONLY where the key is absent (never overwrites an existing value; if you
 * want to change a value, use the admin PUT route or re-run with a fresh
 * database). Values mirror `tiny-tales-forus/mobile/src/lib/config.ts`'s current
 * constants at the time SPEC-V2 was written.
 *
 * The core logic (`seedConfigDefaults`) takes a `Db` and is unit-testable
 * against PGlite; this file's top-level code is just the CLI wrapper that
 * reads `DATABASE_URL` and calls it.
 *
 * Usage: `npm run db:seed-config` (tsx + `--env-file=.env` picks up
 * DATABASE_URL locally; CI/CD supplies it as an env var).
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'

/** One default entry: key, its JSON value, and an admin-facing description. */
export interface ConfigDefault {
  key: string
  value: unknown
  description: string
}

/** SPEC-V2.md §2 "Seed" table — the exact defaults, in the spec's order. */
export const CONFIG_DEFAULTS: ConfigDefault[] = [
  {
    key: 'checkout.mode',
    // WhatsApp checkout was removed from both apps (2026-07-16); the flow is
    // "unavailable" until the in-app (Razorpay) path ships. The old
    // `checkout.whatsappNumber` key was deleted in prod and is intentionally
    // NOT seeded here — do not re-add it.
    value: 'unavailable',
    description:
      'Checkout flow the app uses: "unavailable" (no checkout yet) or a future in-app flow.',
  },
  {
    key: 'pdp.deliveryPromise',
    value: 'Printed and dispatched in India · delivery across India',
    description: 'Delivery promise line shown on the product detail page.',
  },
  {
    key: 'pdp.returnPolicy',
    value: 'Returns for damage on delivery only',
    description: 'Return policy line shown on the product detail page.',
  },
  {
    key: 'pdp.sellerName',
    value: 'Tiny Tales',
    description: '"Sold by {sellerName}" line on the product detail page.',
  },
  {
    key: 'pdp.genuineSourceName',
    value: 'Tiny Tales (a brand of Adix AI)',
    description: 'Manufacturer name shown in the PDP\'s "100% Genuine" disclosure.',
  },
  {
    key: 'legal.termsUrl',
    value: 'https://www.tinytalesforus.com/terms',
    description: 'Terms & Conditions URL linked from the auth sheet legal footer.',
  },
  {
    key: 'legal.privacyUrl',
    value: 'https://www.tinytalesforus.com/privacy',
    description: 'Privacy Policy URL linked from the auth sheet legal footer.',
  },
  {
    // The seller of record. Mirrors `tiny-tales-forus/src/data/legal.ts`'s
    // `COMPANY` const. Server-side consumers (invoice generator, complaint
    // ticket emails) read this instead of hardcoding the entity's details a
    // second time.
    //
    // Adix AI is the seller of record and Tiny Tales its brand (owner,
    // 2026-10-27); same entity, GSTIN and Razorpay KYC name as Laanya. The
    // GSTIN is printed on tax invoices (CGST Rule 46) but never on the website:
    // the public `/v1/config` snapshot strips it (services/config.ts). It is
    // read from TT_LEGAL_GSTIN (secrets file) so it is not committed to this
    // public repo; sync-legal-config refuses to write a registered seller
    // without one.
    //
    // NO PERSONAL DATA HERE. `supportEmail` is the single published contact —
    // a role mailbox, not an individual — and it is what the invoice footer
    // and the complaint notification both use.
    key: 'legal.company',
    value: {
      legalName: 'Adix AI',
      brand: 'Tiny Tales',
      address:
        '3, Qamar Makhdumi Road, near Noori Masjid, Bhuli Road, Wasseypur, Dhanbad, Jharkhand 826001',
      jurisdictionCity: 'Dhanbad',
      jurisdictionState: 'Jharkhand',
      gstRegistered: true,
      gstin: process.env.TT_LEGAL_GSTIN ?? '',
      gstStateCode: '20',
      registeredStateName: 'Jharkhand',
      supportEmail: 'hello@adix.ai',
      // Mirrors `invoice.sellerOfRecord` below, and MUST equal it.
      // `db:sync-legal-config` writes both keys in one run.
      sellerOfRecord: 'company',
    },
    description:
      'Seller-of-record entity details (E-Commerce Rules disclosures): registered office, GST status, and the single published contact mailbox. No personal names/emails/phones. Mirrors tiny-tales-forus/src/data/legal.ts COMPANY.',
  },
  {
    // Adix AI (Tiny Tales) prints every piece itself, so the maker is the seller. The
    // invoice's manufacturer block falls back to this row for any product
    // that declares no maker of its own. No licence: 3D-printed collectibles
    // need no manufacturing licence.
    key: 'legal.manufacturer',
    value: {
      legalName: 'Adix AI',
      address:
        '3, Qamar Makhdumi Road, near Noori Masjid, Bhuli Road, Wasseypur, Dhanbad, Jharkhand 826001',
      licence: '',
      gstin: process.env.TT_LEGAL_GSTIN ?? '',
      gstStateCode: '20',
      registeredStateName: 'Jharkhand',
    },
    description:
      'Maker attribution printed on invoices for products that declare none of their own. Adix AI makes its own pieces under the Tiny Tales brand.',
  },
  {
    /*
     * WHO THE INVOICE SAYS SOLD THE GOODS.
     *
     * `company`  — Adix AI makes and sells its own pieces as principal.
     *              Current owner decision.
     * `manufacturer` — legacy vendor fulfilment: the goods are sold by the
     *              entity in `legal.manufacturer` under their GSTIN. This is
     *              retained for historic documents, not the current model.
     *
     * Must agree with `COMPANY.sellerOfRecord` in `tiny-tales-forus/src/data/legal.ts`
     * (mirrored to mobile), which decides what the published Terms say about
     * who sold you the goods. Terms naming one seller while the invoice names
     * another is the failure mode both fields exist to prevent.
     *
     * The legacy `manufacturer` mode requires `legal.manufacturer` to carry a `legalName`
     * exactly as it appears on the GST certificate (CGST r.46(a) — a trade
     * name is not enough), an `address`, a `gstin` and a `registeredStateName`.
     * A missing legalName or address makes invoice issuance fail closed with
     * 503 `invoice_unavailable`, the same refusal a blank `legal.company`
     * has always produced.
     */
    key: 'invoice.sellerOfRecord',
    value: 'company',
    description:
      'Which config row names the seller on a customer invoice: "company" (Adix AI sells its own pieces) or "manufacturer" (legacy vendor-fulfilment mode).',
  },
  {
    // Invoice numbering: "<prefix>/<FY>/<000123>", e.g. "TT/26-27/000142".
    // The series is gapless and restarts each Indian financial year, so this
    // prefix is effectively permanent — changing it mid-year produces two
    // series for one FY, which is exactly what an auditor asks about. Change
    // it only between financial years, if at all.
    key: 'invoice.numberPrefix',
    value: 'TT',
    description:
      'Prefix of the invoice number series ("TT/26-27/000142"). Change only between financial years — a mid-year change splits one FY across two series.',
  },
  {
    // Kill switch for the CUSTOMER'S EMAILED COPY only. Invoices are still
    // issued and stored when this is false — the document is the legal record
    // of the sale and does not depend on whether an email went out.
    key: 'invoice.emailEnabled',
    value: true,
    description:
      'Send the customer their invoice by email on payment. Turning this off stops the emails only — invoices are still issued, stored and printable from the admin panel.',
  },
  {
    // The GST sentence is NOT configurable — it is derived from
    // `legal.company.gstRegistered` in lib/invoiceDocument.ts so it can never
    // contradict the flag. This key is the rest of the footer.
    key: 'invoice.footerNote',
    value: 'This is a computer-generated invoice and does not require a signature.',
    description:
      'Footer line printed on every invoice. The GST-applicability sentence is NOT here — it is derived from legal.company.gstRegistered so the two can never disagree.',
  },
  {
    key: 'cart.maxQtyPerLine',
    value: 99,
    description: 'Maximum quantity allowed on a single cart line.',
  },
  {
    key: 'cart.maxLines',
    value: 50,
    description: 'Maximum number of distinct lines allowed in a cart.',
  },
  {
    key: 'payments.enabled',
    value: false,
    description: 'Master switch for the in-app payments flow (off until Razorpay account exists).',
  },
  {
    key: 'payments.upiIntent.enabled',
    // Seeded ON, unlike `payments.enabled`: this switch does not decide whether
    // money can move, only whether the mobile app may skip the typed-VPA step.
    // Off means Checkout, which is where every client already falls back.
    value: true,
    description:
      'Mobile UPI intent flow (Razorpay S2S): open the shopper’s installed UPI app instead of asking for a VPA in Checkout. Off ⇒ the endpoint 503s and clients use Checkout.',
  },
  {
    key: 'payments.upiIntent.expiryMinutes',
    value: 5,
    description:
      'How long a UPI intent link stays payable, in minutes. Past it the shopper must request a fresh one (a new payment attempt on the same order).',
  },
  {
    key: 'wholesale.enabled',
    // Seeded OFF: a pricing rule must never switch itself on. Flip it in the
    // admin once the threshold + percent are set to the intended values.
    value: false,
    description:
      'Master switch for wholesale pricing (a cart at or above wholesale.thresholdInr is billed at wholesale rates).',
  },
  {
    key: 'wholesale.thresholdInr',
    value: 5000,
    description:
      'Cart subtotal (INR, at retail prices) at which a cart qualifies for wholesale pricing. Reaching it exactly qualifies.',
  },
  {
    key: 'wholesale.discountPct',
    value: 10,
    description:
      'Percent off each cart line once the wholesale threshold is met (0..90). Applies on top of any seasonal discount.',
  },
  {
    key: 'app.minSupportedVersion',
    value: '1.0.0',
    description: 'Minimum mobile app version the API will serve without prompting an update.',
  },
  {
    key: 'orders.cancelReasons',
    value: [
      'Forgot to apply coupon/reward points',
      'Found a better price somewhere else',
      'Duplicate order',
      'Delivery date is too late',
      'Change address/phone number',
      'Wrong size/colour',
      'No longer need the product',
    ],
    description: 'Reason options shown on the order cancellation screen, in display order.',
  },
  {
    key: 'refunds.creditDays',
    value: 5,
    description:
      'Working days (weekends skipped) from refund initiation to the "credit by" date shown on a refunded order. Razorpay publishes no per-refund ETA; widen this during a banking incident rather than deploying.',
  },
  {
    key: 'coupons.autoSuggestCount',
    value: 3,
    description:
      'How many coupon cards GET /v1/coupons (the offers strip) returns, ordered by sortOrder.',
  },

  // --- Shipping (docs/SPEC-SHIPPING.md §7) -----------------------------------
  //
  // EVERY value below is a placeholder derived from PUBLIC rate ranges. The
  // negotiated rate cards, the pickup node addresses and the measured SKU
  // weights are what make these real, and none of them exist until an operator
  // enters them. That is why the master switch seeds OFF and why the admin
  // simulator (POST /v1/admin/shipping/simulate) is the gate before flipping
  // it: the customer slabs below deliberately run at a LOSS above 500 g, and
  // that subsidy has to be a decision, not a discovery.
  {
    key: 'shipping.enabled',
    value: false,
    description:
      'Master switch for delivery fees. Seeded OFF — with it off, every cart total is identical to before shipping existed.',
  },
  {
    key: 'shipping.freeAboveTiers',
    // THE DECOY LIVES HERE. ₹249 against a ₹119 cream is a ₹130 gap, which the
    // ₹140 hair oil and ₹149 serum both clear — so the shopper trades a ₹60
    // courier charge for a second full-size product. Note 119 + 99 = 218 does
    // NOT clear it: the qualifying band is narrow and worth re-checking
    // whenever prices move.
    //
    // The WEIGHT CEILING is what keeps it affordable. A single value threshold
    // applied to a 3 kg cart gives away ~₹425 of freight on a ₹249 order; above
    // 5 kg nothing is ever free.
    //
    // EACH TIER'S THRESHOLD IS SET AGAINST THE FREIGHT AT ITS OWN CEILING, which
    // is the step the previous version of this table missed: it let a 2 kg cart
    // ship free at ₹249, and a 2 kg parcel costs ₹143 (Zone A) to ₹189 (Zone B)
    // — more freight than the gross margin on a ₹249 order. Measured with
    // `npm run shipping:report`, the worst-case true cost at each ceiling is:
    //
    //     500 g  → ₹36–45     ⇒ ₹249  threshold (freight ≤18% of it)
    //   2,000 g  → ₹143–189   ⇒ ₹699  threshold (freight ≤27%)
    //   5,000 g  → ₹320–412   ⇒ ₹1499 threshold (freight ≤27%)
    //
    // The 500 g first tier is what preserves the decoy: the ₹119 cream + ₹140
    // serum pairing is ~270 g with tare, comfortably inside it. Re-run the
    // report and re-check these ratios whenever a rate card or a price moves.
    value: [
      { uptoG: 500, freeAboveInr: 249 },
      { uptoG: 2000, freeAboveInr: 699 },
      { uptoG: 5000, freeAboveInr: 1499 },
    ],
    description:
      'Free-delivery thresholds by chargeable weight. First tier whose uptoG covers the cart applies; no matching tier means delivery is never free.',
  },
  {
    key: 'shipping.thresholdBasis',
    value: 'preCoupon',
    description:
      'Which subtotal the free-delivery threshold is measured against: "preCoupon" (default) or "postCoupon". A clamp guarantees applying a coupon can never raise the amount due under either.',
  },
  {
    key: 'shipping.marginBps',
    // What the SHOPPER pays: true courier cost (base freight + fuel + docket +
    // GST, see lib/shipping.ts trueCostInr) plus this markup, uniformly across
    // every zone and weight tier. Replaces the old hand-typed customer slab
    // table — no separate price list to drift out of sync with the real rate
    // card. 1000 bps = 10%.
    value: 1000,
    description:
      'Markup on true courier cost, in basis points (1000 = 10%). Customer fee = trueCostInr * (1 + marginBps/10000).',
  },
  {
    key: 'shipping.feeDiscountBps',
    // Seeded at the code default (no discount) so an insert-only seed never
    // changes what a shopper pays; the live discount is an admin decision.
    value: 0,
    description:
      'Basis points taken OFF the shopper delivery fee after margin (5000 = half price, 10000 = free). 0 = no discount.',
  },
  {
    key: 'shipping.packagingTareG',
    value: 60,
    description: 'Outer packaging weight in grams, added once per cart.',
  },
  {
    key: 'shipping.volumetricPackFactor',
    value: 1,
    description:
      'Multiplier on the cart volumetric estimate (the largest single carton). Raise it if the boxes actually used run bigger than one product carton.',
  },
  {
    key: 'shipping.unknownWeightBehavior',
    value: 'block',
    description:
      '"block" (default): a sku with no measured weight refuses to quote. "assume": substitute shipping.assumedWeightG and log. Blocking fails loud; assuming ships parcels priced at a guess.',
  },
  {
    key: 'shipping.assumedWeightG',
    value: 300,
    description:
      'Stand-in weight for an unweighed sku. Only read when unknownWeightBehavior is "assume".',
  },
  {
    key: 'shipping.unserviceableBehavior',
    value: 'block',
    description:
      '"block" (default): a destination no courier serves refuses checkout with 422. "flat": charge shipping.fallbackFeeInr and let ops book a courier by hand.',
  },
  {
    key: 'shipping.fallbackFeeInr',
    value: 99,
    description:
      'Fee charged for an unserviceable destination. Only read when unserviceableBehavior is "flat".',
  },
  {
    key: 'shipping.serviceableStates',
    // The hard scope fence, and it is READ by the zone derivation — a
    // destination outside it has no zone at all, so it can never fall through
    // to a missing slab and ship free.
    //
    // 2026-08-14: GST/legal clearance for PAN-India sale confirmed, so the
    // fence is opened to every GST state/UT (canonical spellings, see
    // lib/gstStates.ts CANONICAL_CODES) instead of just Gujarat. NOTE this
    // does not by itself make non-Gujarat pincodes serviceable: `pincodes` is
    // still Gujarat-only (PAN-India import is Phase 4, deferred) and courier
    // service areas/rate slabs only cover Zones A/B — a non-Gujarat address
    // still fails `zoneFor` with `not_serviceable` until that data lands. This
    // only removes the LEGAL block, not the logistics gap.
    value: [
      'Jammu and Kashmir',
      'Himachal Pradesh',
      'Punjab',
      'Chandigarh',
      'Uttarakhand',
      'Haryana',
      'Delhi',
      'Rajasthan',
      'Uttar Pradesh',
      'Bihar',
      'Sikkim',
      'Arunachal Pradesh',
      'Nagaland',
      'Manipur',
      'Mizoram',
      'Tripura',
      'Meghalaya',
      'Assam',
      'West Bengal',
      'Jharkhand',
      'Odisha',
      'Chhattisgarh',
      'Madhya Pradesh',
      'Gujarat',
      'Daman and Diu',
      'Dadra and Nagar Haveli',
      'Maharashtra',
      'Andhra Pradesh',
      'Karnataka',
      'Goa',
      'Lakshadweep',
      'Kerala',
      'Tamil Nadu',
      'Puducherry',
      'Andaman and Nicobar Islands',
      'Telangana',
      'Ladakh',
    ],
    description:
      'States we deliver to. A destination outside this list is not serviceable. An EMPTY list serves nobody (fail-closed), it does not mean "everywhere". PAN-India as of 2026-08-14 — see comment above re: pincode/courier data still being Gujarat-only.',
  },
  {
    key: 'shipping.rankBy',
    value: 'cost',
    description:
      'Primary key for choosing among (pickup node, courier) candidates: "cost" (default), "sla" or "reliability". The remaining keys always break ties.',
  },
  // --- Returns: damage only ---------------------------------------------------
  {
    key: 'returns.damageWindowHours',
    // PENDING OWNER CONFIRMATION (docs/PLAN.md open question 6). 48 hours from
    // the recorded delivery is the proposed window.
    value: 48,
    description:
      'Hours after the recorded delivery within which a damaged piece can be reported. Tiny Tales takes damage claims only, no change-of-mind returns.',
  },
  {
    key: 'shipping.refundFeeAfterDispatch',
    // INERT UNTIL FULFILMENT STATE EXISTS. There is no dispatch state on an
    // order today, so cancelOrder refunds the full amount including delivery
    // regardless of this key. Stated here rather than left to be discovered.
    value: false,
    description:
      'When true, a post-dispatch cancellation refunds goods only (the freight is already spent). Currently INERT: orders have no dispatch state yet, so every cancellation refunds in full.',
  },
  // --- Fulfilment (docs/SPEC-LOGISTICS.md §7) --------------------------------
  {
    key: 'fulfilment.enabled',
    value: false,
    description:
      'Master switch for carrier fulfilment. Seeded OFF — with it off no shipment row is created and no carrier call is ever made, so the system behaves exactly as it did before this module existed.',
  },
  {
    key: 'fulfilment.carrier',
    value: 'delhivery',
    description:
      'Which carrier adapter handles fulfilment. Delhivery per docs/FEASIBILITY-LOGISTICS.md; the adapter seam exists so a second carrier is a new implementation, not a re-plumb.',
  },
  {
    key: 'fulfilment.autoManifest',
    value: false,
    description:
      'When true, the manifest sweep ships pending orders without an operator pressing anything. Seeded OFF so the first real parcels are deliberate.',
  },
  {
    key: 'fulfilment.pickupLocationName',
    // EMPTY BLOCKS MANIFESTING, on purpose. Delhivery matches this against the
    // registered warehouse name EXACTLY and case-sensitively; a guess produces
    // a rejected manifest per order rather than one loud failure.
    value: '',
    description:
      'Exact, case-sensitive registered Delhivery warehouse name. Empty blocks manifesting entirely — set it from the account, never guess it from pickup_nodes.',
  },
  {
    key: 'fulfilment.manifestMaxAttempts',
    value: 5,
    description:
      'How many times a shipment may fail to manifest before it stops being retried and waits for an operator.',
  },
  {
    key: 'fulfilment.reconcileStaleMinutes',
    value: 180,
    description:
      'How quiet a non-terminal shipment must go before the reconcile sweep pulls its tracking. This is the backstop that makes an unsigned webhook safe to depend on.',
  },
  {
    key: 'fulfilment.reconcileBatchSize',
    value: 100,
    description:
      'Shipments per reconcile run. One shipment is one tracking request, and Delhivery throttles at 750 requests / 5 minutes / IP.',
  },
  {
    key: 'fulfilment.ndrAutoReattempt',
    value: false,
    description:
      'When true, a failed delivery is automatically re-attempted with the carrier. Seeded OFF — a policy that costs money must never switch itself on.',
  },
  {
    key: 'fulfilment.trackingUrlTemplate',
    value: 'https://www.delhivery.com/track/package/{awb}',
    description:
      'Shopper-facing carrier tracking deep link. `{awb}` is substituted; empty hides the link.',
  },
  {
    key: 'fulfilment.mode',
    // Seeded 'manual' — carrier onboarding is blocked (docs/SPEC-MANUAL-FULFILMENT.md
    // §1), so orders are worked by hand until an operator flips this to 'carrier'.
    // Matches the code default in `parseFulfilmentRule`; seeding it explicitly
    // just makes the running policy visible in the admin config screen.
    value: 'manual',
    description:
      "'carrier' | 'manual' — who moves the parcel. In 'manual' mode the manifest and reconcile sweeps are no-ops regardless of fulfilment.enabled, so no Delhivery call can fire by accident.",
  },
  // --- Ops notifications (docs/SPEC-MANUAL-FULFILMENT.md §4A) ----------------
  {
    key: 'ops.notifyNumbers',
    // EMPTY ON PURPOSE. Recipients are config, not env, so the on-call list
    // changes without a deploy — but an empty list means zero notifications
    // are enqueued, which is the correct state until an operator adds real
    // numbers. E.164 without the leading '+' (e.g. "9198…"), matching what the
    // WhatsApp Cloud API expects as `to`.
    value: [],
    description:
      'WhatsApp numbers (E.164, no leading "+") that get the order_paid ops fan-out. Empty = nothing is enqueued. Each number must have messaged the business number once, or be added as a Meta test recipient, before its first template send will land.',
  },
  {
    key: 'notify.orderPaidTemplate',
    // EMPTY = use whatever WHATSAPP_TEMPLATE_ORDER_PAID was deployed with.
    // Template identity lives in config, not only env, because it is the piece
    // most likely to be wrong and most urgent to fix: Meta matches name and
    // language EXACTLY, and a mismatch fails every send (132001) with all the
    // credentials perfectly valid. As env that costs a build and two pipeline
    // runs; as config it is one admin edit, after which the retry sweep drains
    // the rows that already failed.
    value: '',
    description:
      'Approved WhatsApp template name for the order_paid ops notification. Empty falls back to the WHATSAPP_TEMPLATE_ORDER_PAID env var. Must be set together with notify.orderPaidLocale — a half-set pair is ignored.',
  },
  {
    key: 'notify.orderPaidLocale',
    value: '',
    description:
      'Approved language code for notify.orderPaidTemplate, e.g. "en" or "en_US" — Meta matches it exactly. Empty falls back to the WHATSAPP_TEMPLATE_LOCALE env var. Ignored unless notify.orderPaidTemplate is also set.',
  },
  {
    key: 'notify.orderCancelledTemplate',
    // EMPTY here does NOT fall back to the env var, unlike the order_paid pair
    // above. That env template's body reads "New paid order {{1}} …", so a
    // fallback would render a refund into a purchase announcement and tell ops
    // the opposite of what happened. Unset ⇒ the row sits as
    // `skipped_unconfigured`, costs no retry attempt, and the backlog delivers
    // itself the moment this is filled in.
    value: '',
    description:
      'Approved WhatsApp template name for the order_cancelled ops notification (6 body params: order id, customer, city, refunded amount, reason, admin link). Empty = nothing is sent for this kind; there is NO env fallback. Must be set together with notify.orderCancelledLocale.',
  },
  {
    key: 'notify.orderCancelledLocale',
    value: '',
    description:
      'Approved language code for notify.orderCancelledTemplate, e.g. "en" or "en_US" — Meta matches it exactly. Ignored unless notify.orderCancelledTemplate is also set.',
  },
  {
    key: 'notify.shipmentCancelFailedTemplate',
    // Same no-fallback rule as the cancelled pair, and for the same reason.
    value: '',
    description:
      'Approved WhatsApp template name for the shipment_cancel_failed ops alert — a refunded order whose parcel the carrier would not recall (4 body params: order id, AWB(s), carrier remark, admin link). Empty = nothing is sent for this kind; there is NO env fallback. Must be set together with notify.shipmentCancelFailedLocale.',
  },
  {
    key: 'notify.shipmentCancelFailedLocale',
    value: '',
    description:
      'Approved language code for notify.shipmentCancelFailedTemplate, e.g. "en" or "en_US" — Meta matches it exactly. Ignored unless notify.shipmentCancelFailedTemplate is also set.',
  },

  // ── Customer-facing WhatsApp (docs/kb/tasks/TASK-01-whatsapp-retention.md) ──
  //
  // All three ship EMPTY and must stay that way until Meta approves the
  // matching template. These kinds are in `TEMPLATE_REQUIRED_KINDS`, so empty
  // means `skipped_unconfigured` — no attempt burned, and the backlog delivers
  // itself the moment the pair is filled in. Setting either half early would
  // send a shopper an ops message, which is what that gate exists to prevent.
  {
    key: 'notify.orderConfirmedCustomerTemplate',
    value: '',
    description:
      'Approved WhatsApp template name for the order_confirmed_customer message to the SHOPPER. NO SUCH TEMPLATE IS APPROVED YET (verified against the WABA 2026-08-31) — this kind stays silent until one is. The param builder in routes/customerNotifications.ts is TASK-01 draft shape (5 body params, image header, 1 URL button with a suffix) and MUST be re-checked against the real approval before this key is set. Empty = nothing is sent; there is NO env fallback.',
  },
  {
    key: 'notify.orderConfirmedCustomerLocale',
    value: '',
    description:
      'Approved language code for notify.orderConfirmedCustomerTemplate, e.g. "en" or "gu" — Meta matches it exactly. Ignored unless notify.orderConfirmedCustomerTemplate is also set.',
  },
  {
    key: 'notify.orderOutForDeliveryCustomerTemplate',
    value: '',
    description:
      'WhatsApp UTILITY template for the out-for-delivery customer update. Set to `tinytales_order_out_for_delivery` only after Meta approves it. It takes exactly 2 body params (first name, order id), no header, and one static URL button. Empty = no send; must be set together with notify.orderOutForDeliveryCustomerLocale.',
  },
  {
    key: 'notify.orderOutForDeliveryCustomerLocale',
    value: '',
    description:
      'Language code for notify.orderOutForDeliveryCustomerTemplate — `en` for tinytales_order_out_for_delivery. Empty until the template is approved.',
  },
  {
    key: 'notify.orderDeliveredCustomerTemplate',
    // Approved and ready: `tinytales_order_delivered`. Left EMPTY here so enabling
    // it stays a deliberate admin action after a staging send is verified —
    // seeding a live template name would start messaging shoppers on deploy.
    value: '',
    description:
      'Approved WhatsApp template name for the order_delivered_customer message to the SHOPPER. Set to `tinytales_order_delivered` (APPROVED, UTILITY, en) to enable. That template takes exactly 2 body params (first name, product name), has NO header, and its single URL button is STATIC — the code must send no header and no button params. Empty = nothing is sent; there is NO env fallback. Must be set together with notify.orderDeliveredCustomerLocale.',
  },
  {
    key: 'notify.orderDeliveredCustomerLocale',
    value: '',
    description:
      'Approved language code for notify.orderDeliveredCustomerTemplate — `en` for tinytales_order_delivered. Meta matches it exactly. Ignored unless notify.orderDeliveredCustomerTemplate is also set.',
  },
  {
    key: 'notify.supportFollowupTemplate',
    value: '',
    description:
      'Approved WhatsApp template name for the SUPPORT FOLLOW-UP an operator sends from /admin into a thread whose 24-hour service window has closed. Submit as `tinytales_support_followup` with EXACTLY 1 body param (the shopper name) and NO header and NO buttons — the body text to submit is FOLLOW_UP_BODY in src/lib/whatsapp/followUp.ts, and that constant is also what /admin shows in the transcript, so keep the two identical. Meta reads this generic re-engagement as MARKETING, not UTILITY: it costs roughly 7x a utility send and it reaches shoppers who never ordered and therefore have no marketing_whatsapp_opt_in row to check, which is why it is operator-triggered only with no scheduler. Empty = the /admin button refuses; there is NO env fallback. Must be set together with notify.supportFollowupLocale.',
  },
  {
    key: 'notify.supportFollowupLocale',
    value: '',
    description:
      'Approved language code for notify.supportFollowupTemplate, e.g. "en" — Meta matches it exactly. Defaults to "en" when unset, but set it explicitly alongside the template name.',
  },
  {
    key: 'notify.replenishmentTemplate',
    value: '',
    description:
      'Approved WhatsApp template name for the replenishment_reminder. Set to `tinytales_refill_reminder` (APPROVED, MARKETING, en) to enable. That template takes exactly 2 body params (first name, product name), REQUIRES an image header (so notify.customerHeaderImageUrl must be set or every send is 132000), and its single URL button is STATIC — send no button params. Its body also promises 10% OFF + Free Express Shipping under code REFILL10, which must exist in `coupons`. MARKETING sends additionally require users.marketing_whatsapp_opt_in. Empty = nothing is sent. Must be set together with notify.replenishmentLocale.',
  },
  {
    key: 'notify.replenishmentLocale',
    value: '',
    description:
      'Approved language code for notify.replenishmentTemplate, e.g. "en" or "gu" — Meta matches it exactly. Ignored unless notify.replenishmentTemplate is also set.',
  },
  {
    key: 'notify.replenishmentDelayDays',
    value: 60,
    description:
      'Days after DELIVERY that the replenishment reminder fires. Read when the delayed Cloud Task is scheduled, so a change affects orders delivered from then on, never the reminders already in flight. Cloud Tasks caps scheduleTime at 30 days, so anything above that becomes a chain of hops (lib/replenishmentTask.ts).',
  },
  {
    key: 'notify.paymentReminderCustomerTemplate',
    value: '',
    description:
      'WhatsApp MARKETING template for the unpaid-order nudge (payment_reminder_customer), sent once to a shopper whose order is still `pending` notify.paymentReminderDelayMinutes after it was created. Submit as `tinytales_payment_reminder` with EXACTLY 2 body params (first name, product name), NO header, and one STATIC URL button to https://www.tinytalesforus.com/cart/ — send no button params. Only enqueued when this pair is set AND the shopper has opted in (users.marketing_whatsapp_opt_in) AND their cart still holds items AND no newer order exists. Time sensitive, so an unset template drops the nudge instead of holding it. Empty = nothing is sent. Must be set together with notify.paymentReminderCustomerLocale.',
  },
  {
    key: 'notify.paymentReminderCustomerLocale',
    value: '',
    description:
      'Approved language code for notify.paymentReminderCustomerTemplate, e.g. "en" — Meta matches it exactly. Ignored unless notify.paymentReminderCustomerTemplate is also set.',
  },
  {
    key: 'notify.paymentReminderDelayMinutes',
    value: 45,
    description:
      'Minutes after an order is CREATED that the unpaid-order nudge checks whether it is still pending. Read at order creation. Keep it well under 24h: the payments-recover sweep marks an unpaid order failed after 24 hours.',
  },
  {
    key: 'notify.reviewRequestCustomerTemplate',
    value: '',
    description:
      'WhatsApp UTILITY template for the post-delivery review ask (review_request_customer). Submit as `tinytales_review_request` with EXACTLY 2 body params (first name, product name), NO header, and one DYNAMIC URL button `https://www.tinytalesforus.com/{{1}}` (example suffix `products/cream/?review=1`) — the code sends the suffix as the button param. Skipped when the shopper already reviewed the product or the order was refunded. Empty = nothing is sent. Must be set together with notify.reviewRequestCustomerLocale.',
  },
  {
    key: 'notify.reviewRequestCustomerLocale',
    value: '',
    description:
      'Approved language code for notify.reviewRequestCustomerTemplate, e.g. "en" — Meta matches it exactly. Ignored unless notify.reviewRequestCustomerTemplate is also set.',
  },
  {
    key: 'notify.reviewRequestDelayDays',
    value: 4,
    description:
      'Days after DELIVERY that the review ask fires. Read when the delivery scan schedules it. Clamped to 1–28 days so it stays a single Cloud Tasks hop.',
  },
  {
    key: 'notify.customerHeaderImageUrl',
    value: '',
    description:
      'Publicly fetchable image URL used as the header on every customer WhatsApp template. Meta fetches it server-side at send time, so it must need no auth. Empty = a body-only send, which is correct ONLY if the approved template has no header — a template approved WITH one fails (132000) without it.',
  },
  {
    key: 'notify.customerEtaCopy',
    value: 'in 3–5 days',
    description:
      'The "Arriving by" line in the customer order-confirmed and shipped templates. Deliberately vague rather than a date: a promised date we then miss is worse than no date, and at confirmation time no AWB exists to derive a real one from.',
  },
]

/**
 * Insert every default whose key is absent; leave existing keys untouched.
 * Returns the keys actually inserted, in `CONFIG_DEFAULTS` order.
 */
export async function seedConfigDefaults(
  db: Db,
  defaults: ConfigDefault[] = CONFIG_DEFAULTS
): Promise<string[]> {
  const inserted: string[] = []
  for (const entry of defaults) {
    const result = await db
      .insert(appConfig)
      .values({ key: entry.key, value: entry.value, description: entry.description })
      .onConflictDoNothing({ target: appConfig.key })
      .returning({ key: appConfig.key })
    if (result.length > 0) inserted.push(entry.key)
  }
  return inserted
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!connectionString) {
    console.error('db:seed-config: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    const db = drizzle(pool) as unknown as Db
    // Fail fast if the app_config table doesn't exist yet (migrations not run).
    await db.execute(sql`select 1 from app_config limit 1`)
    const inserted = await seedConfigDefaults(db)
    if (inserted.length === 0) {
      // eslint-disable-next-line no-console
      console.log('db:seed-config: nothing to do, all default keys already present')
    } else {
      // eslint-disable-next-line no-console
      console.log(`db:seed-config: inserted ${inserted.length} key(s): ${inserted.join(', ')}`)
    }
  } finally {
    await pool.end()
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
