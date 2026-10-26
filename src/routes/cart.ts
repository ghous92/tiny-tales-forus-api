/**
 * /v1/cart — HTTP layer only. Zod schemas validate every input (strict:
 * unknown JSON keys are rejected) and serialize every output; business rules
 * live in `services/cart.ts`. All routes require auth via the
 * `app.authenticate` hook (see plugins/auth.ts) — no admin gate, this is a
 * per-user resource.
 */

import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  CartMergeBodySchema,
  CartMergeResponseSchema,
  CartPutBodySchema,
  CartQuerySchema,
  CartSchema,
  CartSkuParamsSchema,
  ErrorEnvelopeSchema,
} from '../contracts/cart.js'
import type { Db } from '../db/client.js'
import { addresses } from '../db/schema.js'
import type { CouponLookup } from '../lib/coupons.js'
import { notFound } from '../lib/errors.js'
import { WHOLESALE_OFF, type WholesaleRule } from '../lib/pricing.js'
import {
  clearCart,
  deleteCartLine,
  getCart,
  mergeCart,
  putCartLine,
  type CartShippingResolver,
} from '../services/cart.js'
import { getConfigValues } from '../services/config.js'
import { getCouponRuleByCode } from '../services/coupons.js'
import { loadShippingContext, priceCartShipping } from '../services/shipping.js'

/** Error envelope for every non-2xx status, declared once per route. */
const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

/** Coerce a JSON config value to a finite number, or undefined if it isn't one. */
function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * Resolve the wholesale knobs from config for this request.
 *
 * This lives in the ROUTE layer on purpose: `services/cart.ts` may not import
 * another module's service (ARCHITECTURE.md rule 2), and config must be read
 * through the config service rather than by querying `app_config` (rule 5). So
 * the route reads config the sanctioned way and hands the cart service a plain
 * value.
 *
 * Any missing or malformed key falls back to wholesale OFF — a pricing rule
 * must never switch on by accident.
 */
async function resolveWholesaleRule(db: Db): Promise<WholesaleRule> {
  // One batch read, not three round trips — this runs on every cart request,
  // and shipping added a second config-hungry rule beside it.
  const values = await getConfigValues(db, [
    'wholesale.enabled',
    'wholesale.thresholdInr',
    'wholesale.discountPct',
  ])
  if (values.get('wholesale.enabled') !== true) return WHOLESALE_OFF
  const threshold = asNumber(values.get('wholesale.thresholdInr'))
  const pct = asNumber(values.get('wholesale.discountPct'))
  if (threshold === undefined || pct === undefined) return WHOLESALE_OFF
  return { enabled: true, thresholdInr: Math.trunc(threshold), discountPct: Math.trunc(pct) }
}

/**
 * Where this cart is being delivered, in strict precedence:
 * an explicit `addressId` (which must belong to the caller — anything else is
 * 404, never a silent fallback), then a bare `?pincode=`, then the caller's
 * default address, then nowhere.
 *
 * A `?pincode=` is a PREVIEW. It prices the cart screen before an address is
 * chosen, which is the whole point — a shopper who only sees the delivery fee
 * on the final checkout screen has already decided what to buy. What stops it
 * becoming a price-tampering vector is that order creation ignores it entirely
 * and re-prices against the order's own address (see services/payments.ts).
 */
async function resolveDestination(
  db: Db,
  userId: string,
  query: { addressId?: string | undefined; pincode?: string | undefined } = {}
): Promise<string> {
  if (query.addressId) {
    const [row] = await db
      .select({ pincode: addresses.pincode })
      .from(addresses)
      .where(and(eq(addresses.id, query.addressId), eq(addresses.userId, userId)))
      .limit(1)
    if (!row) throw notFound(`Address "${query.addressId}" not found`)
    return row.pincode
  }

  if (query.pincode) return query.pincode

  const [fallback] = await db
    .select({ pincode: addresses.pincode })
    .from(addresses)
    .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)))
    .limit(1)
  return fallback?.pincode ?? ''
}

/**
 * Bind the shipping rule, the rate data and the signing key into the plain
 * function `services/cart.ts` calls.
 *
 * Same reason {@link resolveWholesaleRule} lives here: the cart service may not
 * import another module's service (ARCHITECTURE.md rule 2), so the route reads
 * shipping the sanctioned way and hands the cart service something it can call
 * without knowing where any of it came from.
 */
async function resolveShippingResolver(
  db: Db,
  userId: string,
  query: { addressId?: string | undefined; pincode?: string | undefined } = {}
): Promise<CartShippingResolver> {
  const destPincode = await resolveDestination(db, userId, query)
  const context = await loadShippingContext(db, destPincode)
  return (input) => priceCartShipping({ context, destPincode, ...input })
}

/**
 * Resolve a client-supplied coupon code (`?coupon=CODE`) into a
 * {@link CouponLookup} for `services/cart.ts`'s coupon folding.
 *
 * Lives in the ROUTE layer for the same reason {@link resolveWholesaleRule}
 * does: `services/cart.ts` may not import another module's service
 * (ARCHITECTURE.md rule 2), so the route reads `services/coupons.ts` the
 * sanctioned way and hands the cart service a plain value. Blank/absent code
 * resolves to `COUPON_NONE` (services/coupons.ts's default) — a caller that
 * omits `coupon` gets a cart with no coupon requested.
 */
async function resolveCouponRule(
  db: Db,
  code: string | undefined,
  userId: string
): Promise<CouponLookup> {
  return getCouponRuleByCode(db, code, userId)
}

export interface CartRoutesOptions {
  db: Db
}

export const cartRoutes: FastifyPluginAsyncZod<CartRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    { schema: { querystring: CartQuerySchema, response: { 200: CartSchema, ...errorResponses } } },
    async (request) => {
      // `skus`: a comma-separated allowlist previewing a subset of the cart
      // (the mobile cart-screen selection) — same filter payments/orders
      // applies via its own `skus` body field, so the preview and the charge
      // always agree. Omitted → the full cart.
      const skus = request.query.skus?.split(',').filter(Boolean)
      return getCart(
        db,
        request.user.id,
        await resolveWholesaleRule(db),
        skus,
        await resolveCouponRule(db, request.query.coupon, request.user.id),
        await resolveShippingResolver(db, request.user.id, request.query)
      )
    }
  )

  app.put(
    '/items/:sku',
    {
      schema: {
        params: CartSkuParamsSchema,
        body: CartPutBodySchema,
        response: { 200: CartSchema, ...errorResponses },
      },
    },
    async (request) =>
      putCartLine(
        db,
        request.user.id,
        request.params.sku,
        request.body.qty,
        await resolveWholesaleRule(db),
        // The write endpoints have no destination query, so they price against
        // the caller's default address. Without this the fee would blink out of
        // the cart the moment a shopper changed a quantity.
        await resolveShippingResolver(db, request.user.id)
      )
  )

  app.delete(
    '/items/:sku',
    {
      schema: {
        params: CartSkuParamsSchema,
        response: { 200: CartSchema, ...errorResponses },
      },
    },
    async (request) =>
      deleteCartLine(
        db,
        request.user.id,
        request.params.sku,
        await resolveWholesaleRule(db),
        await resolveShippingResolver(db, request.user.id)
      )
  )

  app.delete(
    '/',
    {
      // Fastify sends no body for a 204; z.null() documents "empty".
      schema: { response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      await clearCart(db, request.user.id)
      return reply.code(204).send(null)
    }
  )

  app.post(
    '/merge',
    {
      schema: {
        body: CartMergeBodySchema,
        response: { 200: CartMergeResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      mergeCart(
        db,
        request.user.id,
        request.body.items,
        await resolveWholesaleRule(db),
        await resolveShippingResolver(db, request.user.id)
      )
  )
}
