/**
 * Web push to an admin's browsers — "a customer just messaged you".
 *
 * This is the alerting half of the WhatsApp inbox. The inbox itself is a page
 * somebody has to remember to open, and the owner's stated problem is that they
 * cannot sit in front of it. A notification is the whole point; the screen is
 * just where it lands.
 *
 * **Delivered by FCM rather than raw Web Push on purpose.** The standard
 * protocol would mean implementing RFC 8291 payload encryption (ECDH + HKDF +
 * AES128GCM) or taking a dependency for it, and `firebase-admin` is already in
 * this service for token verification. Same wire format at the browser, no new
 * package.
 *
 * **iOS is the target and it constrains the shape.** Safari only delivers push
 * to a web app the user added to their Home Screen, and every such push MUST
 * result in a visible notification — there is no silent/data-only push to lean
 * on. So the alert carries its own title and body rather than waking the page
 * to go fetch them.
 */

/** What the person sees on the lock screen, plus where a tap should land. */
export interface AdminPushMessage {
  title: string
  body: string
  /** Absolute URL opened on tap — the thread, not the inbox root. */
  link: string
}

export interface AdminPushResult {
  sent: number
  /**
   * Tokens FCM says are dead. The caller deletes these.
   *
   * Reported rather than thrown because a stale token is the NORMAL end of a
   * browser's life — the user cleared site data or removed the home-screen app.
   * Treating it as an error would make routine cleanup look like an incident.
   */
  staleTokens: string[]
}

export type AdminPushSender = (
  tokens: string[],
  message: AdminPushMessage
) => Promise<AdminPushResult>

/**
 * FCM codes that mean "this token will never work again".
 *
 * Everything else — a timeout, a 503, a quota trip — is transient and must NOT
 * delete the registration, or one bad minute at Google silently unsubscribes
 * the owner from their own alerts.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
])

/**
 * Production sender. `firebase-admin` is imported lazily and the app instance
 * is shared with `plugins/auth.ts`, matching how the verifier does it — the SDK
 * is heavy and most requests never touch it.
 */
export function createFcmPushSender(projectId: string): AdminPushSender {
  return async (tokens, message) => {
    if (tokens.length === 0) return { sent: 0, staleTokens: [] }

    const { getApps, initializeApp } = await import('firebase-admin/app')
    const { getMessaging } = await import('firebase-admin/messaging')
    const messaging = getMessaging(getApps()[0] ?? initializeApp({ projectId }))

    const response = await messaging.sendEachForMulticast({
      tokens,
      webpush: {
        notification: {
          title: message.title,
          body: message.body,
          icon: '/brand/icon-192.png',
          badge: '/brand/badge-72.png',
          // Collapse to one notification per thread: a shopper sending three
          // messages should update the banner, not stack three of them.
          tag: message.link,
          renotify: true,
        },
        fcmOptions: { link: message.link },
      },
    })

    const staleTokens = response.responses.flatMap((result, index) =>
      !result.success && DEAD_TOKEN_CODES.has(result.error?.code ?? '') ? [tokens[index]!] : []
    )

    return { sent: response.successCount, staleTokens }
  }
}
