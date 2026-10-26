/**
 * The support follow-up template — the one thing that can be sent into a thread
 * whose 24-hour service window has shut.
 *
 * ## Why this exists
 *
 * `windowOpen` (see `inbound.ts`) closes free-form replies 24 hours after the
 * shopper's last message, because Meta closes them: a free-form send past that
 * point is refused with error 131047. The only way to reach the shopper again
 * is a pre-approved template, and their reply to it reopens the window for
 * another 24 hours. So this is not a message worth sending for its own sake —
 * it is the key that unlocks the conversation the operator actually wants.
 *
 * ## Why it is MARKETING, and what follows from that
 *
 * The body deliberately references no order, because the threads worth
 * rescuing are mostly pre-purchase ("what products do you have available?") and
 * an order-referencing template cannot reach them at all. The cost of that
 * reach is the category: Meta reads a generic re-engagement as MARKETING, not
 * UTILITY — roughly seven times the price per send, and policy-wise it wants
 * consent.
 *
 * Laanya's consent record (`services/marketingConsent.ts`) is keyed on an
 * ORDER, so a shopper who never bought has no consent row to check. That is
 * why this send is OPERATOR-TRIGGERED ONLY and has no scheduler behind it: a
 * human looking at a thread where the shopper wrote first is the consent
 * story. Automating it would turn a judgement call into a bulk unsolicited
 * send, which is how a number's quality rating gets burned.
 *
 * ## {@link FOLLOW_UP_BODY} is the source of truth for BOTH sides
 *
 * Meta stores the approved body text; we never see it at send time — the API
 * takes a template name plus positional parameters and renders it server-side.
 * So the transcript row we write would read as a blank or a placeholder unless
 * we keep our own copy of the wording.
 *
 * That copy is {@link FOLLOW_UP_BODY}, and it is what should be pasted into
 * Meta's template editor verbatim when submitting `laanya_support_followup`.
 * One string, used to render the stored transcript and to author the approval.
 * If someone edits the template at Meta without editing this constant, nothing
 * breaks at send time — Meta only matches the NAME and the parameter count —
 * but /admin starts showing a transcript that differs from what the shopper
 * received, which is worse than an error because it is silent.
 */

/** Config key holding the approved template name. Unset ⇒ the feature is off. */
export const FOLLOW_UP_TEMPLATE_KEY = 'notify.supportFollowupTemplate'

/** Config key holding the approved language code. Meta matches it exactly. */
export const FOLLOW_UP_LOCALE_KEY = 'notify.supportFollowupLocale'

/**
 * The approved body, with `{{1}}` where the shopper's name goes.
 *
 * One variable, not two. Every additional parameter is another way to earn a
 * 132000 ("components do not match the approval"), and the obvious second
 * variable — what the shopper asked about — would have to be summarised from
 * the transcript, which is a guess rendered as if it were a quote.
 */
export const FOLLOW_UP_BODY =
  "Hi {{1}}, following up on your message to Laanya — reply here and we'll help with anything you need."

/** What `{{1}}` becomes when the shopper has no usable profile name. */
export const FOLLOW_UP_FALLBACK_NAME = 'there'

/**
 * Coerce a shopper-supplied profile name into something Meta will accept as a
 * template parameter.
 *
 * Meta rejects a parameter containing a newline, a tab, or four or more
 * consecutive spaces with error 132000, and `whatsappCloud.ts` states plainly
 * that it does not sanitise — the caller must. This is that caller, and its
 * input is `contacts[].profile.name`, a string the shopper controls entirely.
 * An emoji-and-newline display name is not an attack, it is Tuesday, so this
 * flattens rather than refuses.
 *
 * The length cap is ours, not Meta's: a 300-character display name would push
 * the rendered body past what reads as a greeting.
 */
export function followUpParam(profileName: string | null | undefined): string {
  if (typeof profileName !== 'string') return FOLLOW_UP_FALLBACK_NAME
  const flattened = profileName.replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return FOLLOW_UP_FALLBACK_NAME
  return flattened.length > 60 ? flattened.slice(0, 60).trimEnd() : flattened
}

/**
 * The text stored in the transcript, rendered exactly as Meta will render it.
 *
 * Kept beside the parameter builder so the two can never disagree about which
 * value lands in `{{1}}`.
 */
export function renderFollowUp(profileName: string | null | undefined): string {
  return FOLLOW_UP_BODY.replace('{{1}}', followUpParam(profileName))
}
