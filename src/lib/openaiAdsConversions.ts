/**
 * ChatGPT Ads Conversions API — the server half of the OpenAI Ads conversion
 * stream. The browser half is `tiny-tales-forus`'s `lib/openaiAds.ts`.
 *
 * WHY BOTH. Same split as Meta. The browser pixel is the only side that holds
 * `oppref`, OpenAI's click identifier, which it reads from the landing-page URL
 * and keeps in a first-party `__oppref` cookie. This side survives an ad
 * blocker, a killed tab, and a payment confirmed by webhook rather than by a
 * returning shopper — the cases where the browser event never fires at all.
 *
 * DE-DUPLICATION. Both sides send `id` / `event_id` = the order id. OpenAI keys
 * the duplicate check on (pixel id, event name, id) and keeps the FIRST arrival,
 * so the pair collapses into one conversion. This is the same contract
 * `analytics.ts` already relies on for Meta and GA4, and it is why the order id
 * is the only acceptable value here.
 *
 * NO `oppref` ON THIS SIDE. Unlike the pixel, the Conversions API does not
 * capture it for us and the order row does not carry one — so a server event
 * matches through advanced matching (hashed email / phone) rather than the click
 * id. That is the documented fallback, and it is why the browser pixel is not
 * redundant. Persisting `__oppref` onto the order at create, the way `gclid`
 * already is, would close the gap; it needs a migration and is not done here.
 *
 * MINOR UNITS. `amount` is an integer in the currency's minor unit — paise for
 * INR. The order carries rupees, so every amount is converted exactly once, on
 * the way out. Sending rupees would under-report revenue 100x and corrupt oCPC
 * bidding on the receiving side.
 *
 * API KEY SENSITIVITY. Same class as the RudderStack write key: it can forge
 * conversions, which is spend that gets optimised toward a lie. Secret Manager
 * only, never a client bundle, never a repo.
 *
 * UNCONFIGURED IS A SUPPORTED STATE. With no pixel id or key the module is an
 * inert no-op, so local development and tests need no OpenAI account.
 *
 * NOTHING HERE MAY THROW. This runs on the heels of a captured payment. Every
 * entry point swallows, logs, and returns.
 */

import { createHash } from 'node:crypto'

const ENDPOINT = 'https://bzr.openai.com/v1/events'

/** Minimal logger shape — matches `analytics.ts`, plus `info` for accepted sends. */
export interface OpenAiAdsLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

export interface OpenAiAdsConfig {
  pixelId?: string | undefined
  apiKey?: string | undefined
  /** Events are only real in production; anything else is dropped unsent. */
  appEnv: string
  log: OpenAiAdsLogger
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch | undefined
}

export interface OpenAiOrderCreatedInput {
  orderId: string
  /** Original OpenAI click ID captured with advertising consent at landing. */
  oppref?: string | undefined
  /** The confirmation URL the shopper would have landed on. */
  sourceUrl: string
  /** Rupees, as stored on the order. Converted to paise on the way out. */
  totalInr: number
  /** Raw email; hashed here and never sent in the clear. */
  email?: string | null
  /** Raw phone, any format; normalised and hashed here. */
  phone?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  products: Array<{
    sku: string
    name?: string | undefined
    priceInr: number
    quantity: number
  }>
}

export interface OpenAiAdsConversions {
  readonly enabled: boolean
  orderCreated(input: OpenAiOrderCreatedInput): void
}

const DISABLED: OpenAiAdsConversions = { enabled: false, orderCreated: () => {} }

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** Trim, lowercase. The exact normalisation OpenAI specifies for emails. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Keep the country calling code; strip whitespace, brackets, dots and hyphens,
 * then a leading `+` and any leading zeroes. `+91 (98250) 12345` → `919825012345`.
 * Returns null when the result is not the 8–15 digits the API accepts.
 */
export function normalizePhone(phone: string): string | null {
  const digits = phone
    .replace(/[\s().-]/g, '')
    .replace(/^\+/, '')
    .replace(/^0+/, '')
  return /^\d{8,15}$/.test(digits) ? digits : null
}

/** ₹ → paise, the ISO 4217 minor unit for INR. */
export function inrToMinorUnit(valueInr: number): number {
  return Math.round(valueInr * 100)
}

export function createOpenAiAdsConversions(config: OpenAiAdsConfig): OpenAiAdsConversions {
  const { pixelId, apiKey, appEnv, log } = config
  if (!pixelId || !apiKey) return DISABLED

  const doFetch = config.fetchImpl ?? fetch

  return {
    enabled: true,

    orderCreated(input) {
      // A staging or dev order is a real conversion to OpenAI — there is no
      // environment dimension on the receiving side to filter it out later.
      if (appEnv !== 'production') return

      const emailHash = input.email ? sha256(normalizeEmail(input.email)) : null
      const phoneDigits = input.phone ? normalizePhone(input.phone) : null

      const body = {
        events: [
          {
            id: input.orderId,
            ...(input.oppref ? { oppref: input.oppref } : {}),
            type: 'order_created',
            timestamp_ms: Date.now(),
            action_source: 'web',
            source_url: input.sourceUrl,
            user: {
              ...(emailHash ? { emails_sha256: [emailHash] } : {}),
              ...(phoneDigits ? { phone_numbers_sha256: [sha256(phoneDigits)] } : {}),
              countries: ['IN'],
              ...(input.city ? { cities: [input.city] } : {}),
              ...(input.region ? { regions: [input.region] } : {}),
              ...(input.postalCode ? { postal_codes: [input.postalCode] } : {}),
            },
            data: {
              type: 'contents',
              amount: inrToMinorUnit(input.totalInr),
              currency: 'INR',
              contents: input.products.map((p) => ({
                id: p.sku,
                ...(p.name ? { name: p.name } : {}),
                content_type: 'product',
                quantity: p.quantity,
                amount: inrToMinorUnit(p.priceInr),
                currency: 'INR',
              })),
            },
          },
        ],
      }

      // Fire-and-forget: the caller is inside the paid transition and must not
      // wait on, or fail because of, an ad platform.
      void doFetch(`${ENDPOINT}?pid=${encodeURIComponent(pixelId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          if (!res.ok) {
            log.warn(
              { orderId: input.orderId, status: res.status, body: await res.text() },
              'openai-ads: order_created rejected'
            )
            return
          }
          // Logged so delivery is provable when OpenAI reports zero conversions;
          // without it an accepted send leaves no trace. The body is OpenAI's reply,
          // not the hashed request.
          log.info(
            {
              orderId: input.orderId,
              status: res.status,
              hasOppref: Boolean(input.oppref),
              body: (await res.text()).slice(0, 500),
            },
            'openai-ads: order_created accepted'
          )
        })
        .catch((err: unknown) => {
          log.error({ err, orderId: input.orderId }, 'openai-ads: order_created not sent')
        })
    },
  }
}
