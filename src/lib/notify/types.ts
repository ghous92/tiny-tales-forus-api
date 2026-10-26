/**
 * Notification channel abstraction (docs/SPEC-MANUAL-FULFILMENT.md §4A).
 * Shaped like `lib/delhivery.ts`'s `CarrierAdapter`: no DB imports, no config
 * imports, credentials arrive as plain values from the caller — so a second
 * channel (Telegram, the unofficial bridge) is an added file, not a refactor
 * of anything that already sends WhatsApp.
 *
 * Only `whatsappCloud.ts` is built at v1 (SPEC §8 decision 2 — 1:1 fan-out
 * only, no group channel). This file exists so that decision doesn't have to
 * be re-litigated in every caller: `services/opsNotifications.ts` and the
 * route-layer senders only ever talk to {@link NotificationChannel}.
 */

/**
 * Which approved template to render this message with.
 *
 * Deliberately NOT frozen onto the enqueued payload the way {@link
 * NotificationMessage.params} are. The two have opposite failure modes: params
 * describe an order that already happened and must never drift, whereas the
 * template is *plumbing* — if it is wrong, every send fails with Meta 132000 /
 * 132001, and freezing it would mean the dead rows keep failing on every retry
 * even after an operator fixed the name. Resolving it at send time makes the
 * fix retroactive: correct the config, and the retry sweep drains the backlog.
 */
export interface NotificationTemplate {
  /** Approved template name, matched exactly by Meta (mismatch → 132001). */
  name: string
  /** Approved language code, e.g. `en` or `en_US` — also matched exactly. */
  locale: string
}

/**
 * A media header on a template that was APPROVED with one.
 *
 * Meta accepts either a resumable-upload media handle or a plain public `link`
 * at send time. `link` is deliberately the only shape here: product images are
 * already served publicly from the image worker, so a URL costs nothing, while
 * a handle would drag in an upload lifecycle (upload, store the handle, notice
 * it expired) for a picture that is already on a CDN.
 *
 * Header presence is fixed by the APPROVAL, not by the caller: a template
 * approved with an image header fails without one, and a template approved
 * without one fails with it. Both are 132000. This field must therefore track
 * the template the kind resolves to, which is why it is frozen onto the payload
 * beside {@link NotificationMessage.params} rather than decided in the adapter.
 */
export interface NotificationHeaderImage {
  /** Publicly fetchable image URL. Meta fetches it server-side at send time. */
  link: string
}

/**
 * The dynamic suffix for a URL button on a template approved with one.
 *
 * WhatsApp URL buttons are approved as a static prefix plus at most ONE
 * variable, and the send supplies only that variable — never the whole URL. So
 * a template approved as `https://laanya.shop/{{1}}` takes `account/orders/A123`
 * here. Sending an absolute URL produces a 132000 that reads as if the button
 * itself were wrong.
 *
 * `index` is the button's position in the approved template, zero-based. Meta
 * addresses buttons positionally, and a mismatch silently fills the wrong
 * button rather than erroring.
 */
export interface NotificationUrlButton {
  index: number
  /** Path suffix only — appended by Meta to the approved prefix. */
  suffix: string
}

/**
 * One outbound message, already reduced to what a template send needs.
 * `params` are POSITIONAL — WhatsApp template variables are `{{1}}..{{n}}`,
 * not named — and are frozen into `ops_notifications.payload` at enqueue time
 * (docs/SPEC-MANUAL-FULFILMENT.md §4A step 1), so a channel adapter never
 * builds its own copy from live order data.
 *
 * `header` and `buttons` are frozen for the same reason and with one extra
 * constraint: they are only valid at all if the approved template declares the
 * matching component. See {@link NotificationHeaderImage}.
 */
export interface NotificationMessage {
  params: string[]
  /**
   * Per-send template override. Absent means "use whatever the adapter was
   * built with", which keeps every existing caller and the env-var path
   * working unchanged.
   */
  template?: NotificationTemplate | undefined
  /** Image header, for kinds whose template was approved with one. Absent ⇒ body-only. */
  header?: NotificationHeaderImage | undefined
  /** URL-button variables, for kinds whose template was approved with buttons. */
  buttons?: readonly NotificationUrlButton[] | undefined
}

/** What a channel adapter reports back per send attempt. */
export interface SendResult {
  ok: boolean
  /** The provider's own message id (e.g. Meta's `messages[0].id`), when `ok`. */
  providerMessageId?: string | undefined
  /** Human-readable failure reason, when `!ok`. Truncated by the caller before storage. */
  error?: string | undefined
}

/**
 * One outbound channel. `target` is channel-specific — a WhatsApp msisdn
 * today, a Telegram chat id if that channel is ever added.
 *
 * Implementations must not throw: a transport failure is a `SendResult`
 * with `ok: false`, not an exception — the caller (the post-commit sender and
 * the retry sweep) treats both a thrown error and an `ok: false` result as
 * "failed, retry later", but keeping the contract exception-free means every
 * caller only has to handle one shape.
 */
export interface NotificationChannel {
  send(target: string, message: NotificationMessage): Promise<SendResult>
}
