/**
 * Server-side analytics — the RudderStack Node SDK behind a small facade.
 *
 * This is the AUTHORITATIVE side of the tracking plan (docs/ANALYTICS.md §7).
 * The app reports intent; this reports what actually happened to money. The one
 * event that matters most, `Order Completed`, is emitted here and NOWHERE else:
 * a client can be replayed, backgrounded mid-request, or simply lie, and a
 * purchase event is what every ad platform bids on. The client emits
 * `Order Confirmation Viewed` for the same moment, which is deliberately named
 * so it can never be mistaken for a conversion.
 *
 * WRITE KEY SENSITIVITY. The mobile write key is public by design — it can only
 * write events. THIS one is not: it can forge `Order Completed`, which
 * fabricates revenue in the warehouse and conversions at Meta and Google Ads.
 * It belongs in Secret Manager, never in a client bundle or a repo.
 *
 * UNCONFIGURED IS A SUPPORTED STATE. With no write key the module is an inert
 * no-op — every call returns immediately and nothing is queued. That is what
 * makes local development and tests work without a RudderStack account, and it
 * is why every call site can fire-and-forget without a guard of its own.
 *
 * NOTHING HERE MAY THROW. Callers are inside or immediately after a payment
 * transition; an analytics failure must never surface as a failed payment.
 * Every entry point swallows, logs, and returns.
 */

import RudderAnalytics from '@rudderstack/rudder-sdk-node'

/** Minimal logger shape — matches what Fastify hands around elsewhere. */
export interface AnalyticsLogger {
  error: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

export interface AnalyticsConfig {
  writeKey?: string | undefined
  dataPlaneUrl?: string | undefined
  /** Echoed on every event as `context.app_env`; the transformation filters on it. */
  appEnv: string
  log: AnalyticsLogger
}

export interface OrderCompletedInput {
  orderId: string
  /** Our own user id — becomes `userId`, the identity the warehouse joins on. */
  userId: string
  /** The client's RudderStack anonymous id, if the order carried one. */
  anonymousId: string | null
  /** Razorpay payment reference; the ONLY payment detail that travels. */
  paymentReference: string | null
  paymentMethod?: string | null
  currency: string
  /** Rupees, not paise — the ad platforms and GA4 both expect major units. */
  total: number
  revenue: number
  shipping: number
  discount: number
  coupon?: string | null
  products: Array<{
    product_id: string
    sku: string
    name?: string | undefined
    price: number
    quantity: number
  }>
  storeCode?: string | null
  /**
   * The campaign that produced the sale, frozen onto the order at create.
   * Becomes RudderStack's `context.campaign`, which is the field GA4 and the
   * warehouse both read for attribution — without it a server-side purchase
   * arrives with no path back to the ad that paid for it.
   */
  campaign?: {
    source?: string | undefined
    medium?: string | undefined
    name?: string | undefined
    content?: string | undefined
  } | null
  /** Google's click id, for offline conversion upload back to Ads. */
  gclid?: string | null
}

/**
 * The canonical profile traits written by `PATCH /v1/me`. Keeping this input
 * independent of the HTTP contract makes the analytics boundary explicit and
 * prevents callers from accidentally forwarding arbitrary request fields.
 */
export interface UserProfileUpdatedInput {
  userId: string
  name: string | null
  email: string | null
  phone: string
  gender: 'miss' | 'mr' | null
  dob: string | null
  marketingWhatsappOptIn: boolean | null
  adAudienceOptIn: boolean | null
  createdAt: string
  updatedAt: string
}

export interface Analytics {
  /** True when a write key is configured. Exposed so the bootstrap can say so out loud. */
  readonly enabled: boolean
  /** Sends an identify call, which RudderStack maps to Mixpanel People `$set`. */
  userProfileUpdated(input: UserProfileUpdatedInput): void
  orderCompleted(input: OrderCompletedInput): void
  /** Flush anything queued. Called from the shutdown path; never throws. */
  flush(): Promise<void>
}

/** The inert instance used when no write key is configured. */
const DISABLED: Analytics = {
  enabled: false,
  userProfileUpdated: () => {},
  orderCompleted: () => {},
  flush: async () => {},
}

export function createAnalytics(config: AnalyticsConfig): Analytics {
  const { writeKey, dataPlaneUrl, appEnv, log } = config
  if (!writeKey || !dataPlaneUrl) return DISABLED

  const client = new RudderAnalytics(writeKey, {
    dataPlaneUrl,
    // Orders are low-volume and every one of them is a conversion signal that
    // Meta and Google Ads are waiting on. Latency to the ad platforms is worth
    // far more here than batching efficiency, so each event goes out on its own.
    flushAt: 1,
    flushInterval: 1000,
  })

  return {
    enabled: true,

    userProfileUpdated(input) {
      try {
        client.identify({
          userId: input.userId,
          traits: {
            // RudderStack maps these standard traits to Mixpanel's reserved
            // `$name`, `$email`, `$phone`, and `$created` People properties.
            ...(input.name !== null ? { name: input.name } : {}),
            ...(input.email !== null ? { email: input.email } : {}),
            phone: input.phone,
            ...(input.gender !== null ? { gender: input.gender } : {}),
            ...(input.dob !== null ? { dob: input.dob } : {}),
            marketing_whatsapp_opt_in: input.marketingWhatsappOptIn,
            ad_audience_opt_in: input.adAudienceOptIn,
            createdAt: input.createdAt,
            updated_at: input.updatedAt,
            app_env: appEnv,
          },
          context: {
            app_env: appEnv,
            // A server-side profile write must not make the API server's IP or
            // request time look like the shopper's location / last activity.
            active: false,
          },
        })
      } catch (err) {
        // Profile persistence is authoritative. Analytics remains best-effort
        // and must never turn a successful profile save into an API failure.
        log.error({ err, userId: input.userId }, 'analytics: user profile not enqueued')
      }
    },

    orderCompleted(input) {
      try {
        // SDK runtime preserves supplied messageId; its v3 public type omits it.
        const message: Parameters<typeof client.track>[0] & { messageId: string } = {
          // Stable across any retry of this one committed-order event. Actual
          // destination deduplication still depends on its configured mapping.
          messageId: `order-completed:${input.orderId}`,
          userId: input.userId,
          // Sent alongside `userId` so the warehouse can stitch this purchase to
          // the pre-purchase session the app recorded against the same anonymous
          // id. RudderStack accepts both; without it the sale arrives with no
          // path back to the search, the product view, or the ad that led to it.
          ...(input.anonymousId ? { anonymousId: input.anonymousId } : {}),
          event: 'Order Completed',
          properties: {
            app_env: appEnv,
            funnel_name: 'commerce',
            funnel_version: 2,
            ...(input.campaign?.source ? { campaign_source: input.campaign.source } : {}),
            ...(input.campaign?.medium ? { campaign_medium: input.campaign.medium } : {}),
            ...(input.campaign?.name ? { campaign_name: input.campaign.name } : {}),
            ...(input.campaign?.content ? { campaign_creative: input.campaign.content } : {}),
            // `order_id` is the ecommerce-spec field GA4 and Meta map from.
            order_id: input.orderId,
            checkout_id: input.orderId,
            /**
             * Stable destination deduplication key. Map this to the destination's
             * event/transaction identifier; the property alone does not guarantee
             * deduplication. The client must not emit `Order Completed`.
             */
            event_id: input.orderId,
            total: input.total,
            revenue: input.revenue,
            shipping: input.shipping,
            discount: input.discount,
            currency: input.currency,
            ...(input.coupon ? { coupon: input.coupon } : {}),
            ...(input.paymentMethod ? { payment_method: input.paymentMethod } : {}),
            // The gateway reference, so a finance question ("which Razorpay
            // payment is this row?") is answerable from the warehouse without a
            // second system. It identifies a transaction, not a person, and no
            // card, UPI handle or bank detail ever reaches this process.
            ...(input.paymentReference ? { payment_reference: input.paymentReference } : {}),
            ...(input.storeCode ? { store_code: input.storeCode } : {}),
            products: input.products,
          },
          context: {
            app_env: appEnv,
            // `campaign` is the RudderStack-spec context object; GA4 and the
            // warehouse map UTMs from it. Omitted entirely for an organic
            // order so an empty object never reads as "campaign: unknown".
            ...(input.campaign &&
            (input.campaign.source ||
              input.campaign.medium ||
              input.campaign.name ||
              input.campaign.content)
              ? { campaign: input.campaign }
              : {}),
            ...(input.gclid ? { gclid: input.gclid } : {}),
          },
        }
        client.track(message)
      } catch (err) {
        // Swallowed on purpose: this runs on the heels of a captured payment.
        // A lost analytics event costs a row in a report; a thrown one here
        // would cost a shopper their order confirmation.
        log.error({ err, orderId: input.orderId }, 'analytics: Order Completed not enqueued')
      }
    },

    async flush() {
      try {
        await client.flush()
      } catch (err) {
        log.warn({ err }, 'analytics: flush failed on shutdown; queued events may be lost')
      }
    },
  }
}
