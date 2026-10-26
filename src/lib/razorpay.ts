/**
 * Razorpay client seam — the payments module's ONLY door to the Razorpay SDK.
 *
 * The SDK client is lazy-initialized on first use (same pattern as the
 * firebase-admin verifier in plugins/auth.ts): constructing it does a dynamic
 * `import('razorpay')`, so boot time is unchanged and an unconfigured deploy
 * (no keys) never loads the SDK at all. Credentials arrive as plain values —
 * the ROUTE layer reads them from `env` and hands them in, exactly as it does
 * for the wholesale rule (services never read env or config directly).
 *
 * `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` are all
 * optional; when any is missing the client is `undefined` and every payments
 * route that needs Razorpay returns 503 `payments_disabled`
 * (SPEC-PAYMENTS.md strategy #4). Only the public `keyId` and derived `mode`
 * are ever exposed to clients — key secret + webhook secret never leave here.
 */

/** The subset of the Razorpay SDK the payments service uses (keeps the mock small + typed). */
export interface RazorpayApi {
  orders: {
    create(params: {
      amount: number
      currency: string
      receipt?: string
      notes?: Record<string, string>
      payment_capture?: 0 | 1
    }): Promise<{ id: string; amount: number | string; currency: string; status: string }>
    fetchPayments(orderId: string): Promise<{
      items: Array<{ id: string; status: string; amount: number | string; currency?: string }>
    }>
  }
  payments: {
    /**
     * Full refund of a captured payment (amount in paise, same unit as
     * everywhere else). `status` is Razorpay's refund lifecycle
     * ('pending' | 'processed' | 'failed') and `speed_processed` is the speed
     * it actually went out at, which is not always the speed requested — both
     * are mirrored onto the order so the shopper is told what is true rather
     * than a flat "Success".
     */
    refund(
      paymentId: string,
      params: { amount: number }
    ): Promise<{
      id: string
      status: string
      amount?: number | string
      speed_processed?: string
    }>
    /**
     * The payment entity. Beyond `status` (used to capture-before-refund), this
     * is the ONLY place the instrument lives: a refund entity never carries
     * one, and a refund always returns to the source. Every instrument field is
     * optional — which ones are present depends on `method`, and Razorpay adds
     * methods over time.
     */
    fetch(paymentId: string): Promise<{
      id: string
      status: string
      amount: number | string
      method?: string
      vpa?: string
      bank?: string
      wallet?: string
      card_id?: string
      card?: { last4?: string; network?: string } | null
      upi?: { vpa?: string } | null
      acquirer_data?: Record<string, unknown> | null
    }>
    /** Captures an authorized (not-yet-captured) payment — required before it can be refunded. */
    capture(
      paymentId: string,
      amount: number,
      currency: string
    ): Promise<{ id: string; status: string }>
    /**
     * S2S (server-to-server) payment creation — the ONLY method here that opens
     * a payment without Razorpay Checkout. Used for the UPI *intent* flow: we
     * create the payment ourselves and Razorpay hands back a `upi://pay?…`
     * link, which the mobile app fires as an Android/iOS intent so the
     * shopper's installed UPI app opens straight at the confirm screen — no
     * typed VPA, no Checkout webview.
     *
     * `POST /v1/payments/create/upi` under the hood. Requires S2S to be enabled
     * on the merchant account (it is — verified against the test key on
     * 2026-09-02); an account without it gets a 400 from the gateway, which
     * `gatewayErrorDescription` turns into a 422 rather than a 500.
     *
     * `link` is optional in the SDK's own types and IS absent for the `collect`
     * flow (which we do not use); for `intent` it is the whole point, so the
     * service treats a missing one as a gateway failure.
     */
    createUpi(params: {
      amount: number
      currency: string
      order_id: string
      email: string
      contact: string
      method: 'upi'
      /** The shopper's IP — Razorpay requires it on every S2S create. */
      ip: string
      referer: string
      user_agent: string
      description?: string
      notes: Record<string, string>
      upi: { flow: 'intent'; expiry_time?: number }
    }): Promise<{ razorpay_payment_id: string; link?: string }>
  }
}

/** Resolved Razorpay configuration for a single request path. */
export interface PaymentsConfig {
  keyId: string
  keySecret: string
  webhookSecret: string
  /** Derived from the KEY_ID prefix — surfaced to the client for a TEST-MODE banner. */
  mode: 'test' | 'live'
}

/**
 * The Razorpay-facing capabilities the payments SERVICE depends on. Bundling
 * the (lazy) SDK client with the resolved secrets behind this interface lets
 * tests inject a fake with real HMAC math and a mocked SDK, while production
 * gets the lazy real client. `keyId`/`mode` are safe to echo to clients;
 * `keySecret`/`webhookSecret` are consumed only for signature math and never
 * returned.
 */
export interface PaymentsGateway {
  config: PaymentsConfig
  /** Lazily returns the SDK client, constructing it on first call. */
  client(): Promise<RazorpayApi>
}

/** `rzp_test_*` → 'test', `rzp_live_*` → 'live'; anything else defaults to 'test' (never assume live). */
export function modeFromKeyId(keyId: string): 'test' | 'live' {
  return keyId.startsWith('rzp_live_') ? 'live' : 'test'
}

/**
 * The shape razorpay-node rejects with on a 4xx (e.g.
 * `{ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: '...' } }`).
 * Distinguishes "Razorpay rejected this request" (a real, if opaque, business
 * outcome — the payment isn't in a refundable state, an auth window lapsed,
 * etc.) from an actual bug/outage, so callers can surface it as a 4xx instead
 * of letting it fall into the generic 500 catch-all.
 */
export function gatewayErrorDescription(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { statusCode, error } = err as { statusCode?: unknown; error?: unknown }
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return undefined
  if (typeof error !== 'object' || error === null) return undefined
  const { description } = error as { description?: unknown }
  return typeof description === 'string' ? description : undefined
}

/**
 * Build a {@link PaymentsGateway} from raw env values, or `undefined` when any
 * of the three secrets is absent (→ the route answers 503 `payments_disabled`).
 * The SDK is imported lazily inside `client()`, so this call itself is cheap
 * and side-effect-free.
 */
export function createPaymentsGateway(env: {
  keyId?: string | undefined
  keySecret?: string | undefined
  webhookSecret?: string | undefined
}): PaymentsGateway | undefined {
  const { keyId, keySecret, webhookSecret } = env
  if (!keyId || !keySecret || !webhookSecret) return undefined

  const config: PaymentsConfig = {
    keyId,
    keySecret,
    webhookSecret,
    mode: modeFromKeyId(keyId),
  }

  let instance: RazorpayApi | undefined
  return {
    config,
    async client() {
      if (!instance) {
        const { default: Razorpay } = await import('razorpay')
        instance = new Razorpay({ key_id: keyId, key_secret: keySecret }) as unknown as RazorpayApi
      }
      return instance
    },
  }
}
