/**
 * `ErrorAlerter` — turns a server 500 or a batch of client-reported errors
 * (`routes/clientErrors.ts`) into an email an operator will actually read,
 * and (best-effort) a GitHub issue an automated fixer agent can act on.
 *
 * WHY THIS EXISTS: Cloud Logging holds every error already, but nobody is
 * paged by a log line. This is the app-level substitute for a log-based
 * alerting policy — cheap to run (no extra GCP product), and it can write
 * content a non-engineer (or a fixer agent) can act on directly, which a
 * generic "error rate exceeded threshold" alert cannot.
 *
 * FIRE-AND-FORGET CONTRACT: both public methods are synchronous `void`. They
 * kick off async work and swallow every failure internally — an alerting
 * bug or a Brevo/GitHub outage must NEVER affect the response the caller
 * already sent (or is about to send) to the real user. Every failure that is
 * swallowed is still logged at `error` level with full detail; "swallowed"
 * means "does not propagate," never "silently dropped."
 *
 * DEDUPE / COOLDOWN / STORM BRAKE state below is **per-process, in memory,
 * with no `setInterval`** — Cloud Run scales to zero, so a timer would either
 * leak (never fires before the instance is killed) or need its own shutdown
 * hook for no real benefit; every window is instead pruned lazily, on the
 * next event that touches it. MULTI-INSTANCE CAVEAT: with N Cloud Run
 * instances each dedupes independently, so the effective ceiling on cooldowns
 * and the storm brake is really N x every threshold here — same tradeoff
 * `routes/geocode.ts`'s per-IP limiter makes, and acceptable for the same
 * reason: this service rarely runs more than one or two instances even under
 * an error spike. A DB-backed dedupe table is the upgrade path if that ever
 * stops being true.
 *
 * EMAIL HTML: inline-styled only, no `<style>` blocks — most email clients
 * strip `<style>` and some strip `<head>` entirely, so anything not inlined
 * on the element itself silently vanishes. Every interpolated string is
 * HTML-escaped (`escapeHtml`) before it touches a template literal; the one
 * thing worse than an ugly alert email is one an attacker can use to inject
 * markup into an operator's inbox via a crafted error message.
 */

import { createHash } from 'node:crypto'

import type { FastifyBaseLogger } from 'fastify'

// --- Public types -------------------------------------------------------------

export type AppEnv = 'development' | 'staging' | 'production'

export interface BrevoConfig {
  apiKey: string
  emailFrom: string
  emailTo: string
}

export interface GithubConfig {
  token: string
  /** `"owner/name"`. */
  repo: string
}

export interface ErrorAlerterConfig {
  appEnv: AppEnv
  log: FastifyBaseLogger
  /** Absent => alerting is suppressed (logged at debug), never sent. */
  brevo?: BrevoConfig
  /** Absent => alert emails are sent (if `brevo` is set) without a GitHub issue. */
  github?: GithubConfig
  /** Test seam: injected fetch. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam: injected clock. Defaults to `Date.now`. */
  now?: () => number
}

/** Context the error-handler in `app.ts` has on hand for a 500. */
export interface ServerErrorCtx {
  method: string
  /** Route TEMPLATE where available (e.g. `/v1/addresses/:id`), not the raw URL — see fingerprint docs below. */
  path: string
  requestId: string
  userId?: string
  statusCode: number
}

export type ClientEventType = 'error' | 'unhandledrejection' | 'console.error' | 'memory' | 'rerender'

/**
 * One client-reported event — mirrors `contracts/clientErrors.ts`'s Zod shape
 * structurally. Optional fields are `T | undefined`, not bare `T`, because
 * that's what `z.infer` produces for `.optional()` under
 * `exactOptionalPropertyTypes: true` — the route hands a validated batch
 * straight from that inferred type to `notifyClientEvents`.
 */
export interface ClientErrorEvent {
  type: ClientEventType
  message: string
  stack?: string | undefined
  url?: string | undefined
  userAgent?: string | undefined
  meta?: Record<string, string | number | boolean> | undefined
}

export interface ClientEventCtx {
  ip: string
  source: 'web' | 'mobile'
  userAgent?: string
}

// --- Tuning constants -----------------------------------------------------

const SERVER_COOLDOWN_MS = 30 * 60 * 1000
/** 'error' | 'unhandledrejection' — real client crashes, same cooldown class as a server 500. */
const CLIENT_ERROR_COOLDOWN_MS = 30 * 60 * 1000
/** 'console.error' | 'memory' | 'rerender' — noisier signal classes; a longer cooldown avoids a chatty inbox. */
const NOISY_CLIENT_COOLDOWN_MS = 60 * 60 * 1000
const NOISY_CLIENT_TYPES = new Set<ClientEventType>(['console.error', 'memory', 'rerender'])

const HOUR_MS = 60 * 60 * 1000
/** Global storm brake — independent of per-fingerprint cooldowns, guards against many DISTINCT fingerprints firing at once (e.g. a bad deploy). */
const GLOBAL_MAX_EMAILS_PER_HOUR = 20

/** Cap on tracked fingerprints, mirroring `routes/geocode.ts`'s `RATE_MAX_IPS` — an abuse/bug brake on the dedupe map itself, not a real capacity plan. */
const DEDUPE_MAX_ENTRIES = 5_000

// --- Fingerprinting ---------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * Collapse the parts of a message that make two occurrences of the SAME bug
 * look like different fingerprints: ids. UUIDs first (they contain digits, so
 * doing this after the digit pass would leave mangled fragments instead of one
 * clean placeholder), then any run of digits. `"user 123 not found"` and
 * `"user 456 not found"` both become `"user # not found"`.
 */
function normalizeMessage(message: string): string {
  return message.replace(UUID_RE, '#').replace(/\d+/g, '#')
}

/**
 * Top `limit` stack frames, PATHS ONLY — no `:line:col`. Line numbers churn on
 * every unrelated commit (a line added above the bug shifts every frame below
 * it), which would fingerprint the same bug differently on every deploy and
 * defeat dedupe entirely. The file/function identity is what actually
 * identifies a bug.
 *
 * APPLICATION FRAMES ONLY (Sentry's "in-app" rule): frames in `node_modules`,
 * Node's own `node:` internals, and non-file frames like `<anonymous>` are
 * dropped before taking the top `limit`. Those are RUNTIME frames — the async
 * scheduler / framework machinery below the throw site — and they shift with
 * how deep an await chain the same bug happens to be thrown from. Two 500s
 * from the exact same line of our code can carry different runtime tails (e.g.
 * one thrown synchronously in a handler, one thrown after an `await`), and
 * fingerprinting on those tails would page twice for one bug. Our own source
 * files are the stable identity. Fall back to the raw frames only when there
 * are NO application frames at all (an error thrown entirely inside a
 * dependency), so such errors still group by their library location instead of
 * collapsing to nothing.
 */
function topStackFramePaths(stack: string | undefined, limit: number): string[] {
  if (!stack) return []
  const paths: string[] = []
  // First line is "Name: message", not a frame.
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line.startsWith('at ')) continue
    const parenMatch = /\(([^)]+)\)\s*$/.exec(line)
    const location = parenMatch?.[1] ?? line.slice('at '.length)
    paths.push(location.replace(/:\d+(:\d+)?$/, ''))
  }
  // A real application frame is an actual file path (has a separator), and is
  // neither a dependency (`node_modules`) nor a Node internal (`node:` prefix).
  // `<anonymous>`, `new Promise`, etc. have no separator and drop out here too.
  const appFrames = paths.filter(
    (p) => /[\\/]/.test(p) && !p.includes('node_modules') && !p.startsWith('node:')
  )
  return (appFrames.length > 0 ? appFrames : paths).slice(0, limit)
}

/** Best-effort pathname from a client-reported `url` — may be a bare path, a full URL, or a mobile route name (none of which are guaranteed to parse as a URL). */
function pathnameOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).pathname
  } catch {
    return url.split('?')[0] ?? url
  }
}

export type FingerprintInput =
  | { kind: 'server'; name: string; message: string; stack?: string; route: string }
  | { kind: 'client'; type: ClientEventType; message: string; urlPathname: string }

/**
 * Stable identity for "this is the same bug" — sha256 hex, first 12 chars
 * (plenty of collision resistance for a dedupe key at this volume, and short
 * enough to read in a GitHub issue title / email subject).
 *
 * Server: error name + normalized message + top 3 stack frame paths + route
 * (method + path TEMPLATE, e.g. `POST /v1/addresses/:id` — a raw URL would
 * fingerprint every resource id as a different bug).
 * Client: event type + normalized message + url pathname (no stack — client
 * stacks are far less stable across browsers/bundles than server ones, so
 * they'd hurt dedupe more than help it).
 */
export function fingerprintError(input: FingerprintInput): string {
  const parts =
    input.kind === 'server'
      ? [input.name, normalizeMessage(input.message), topStackFramePaths(input.stack, 3).join('|'), input.route]
      : [input.type, normalizeMessage(input.message), input.urlPathname]
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 12)
}

// --- Error normalization ------------------------------------------------------

interface NormalizedError {
  name: string
  message: string
  stack?: string
}

/** `unknown` -> a name/message/stack triple, however un-Error-like the thrown value was. */
function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || 'Unknown error',
      ...(err.stack ? { stack: err.stack } : {}),
    }
  }
  if (typeof err === 'string') return { name: 'Error', message: err }
  try {
    return { name: 'Error', message: JSON.stringify(err) ?? String(err) }
  } catch {
    return { name: 'Error', message: String(err) }
  }
}

// --- HTML helpers --------------------------------------------------------

/** `&` first, or it would double-escape the entities produced by the other replacements. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function preBlock(content: string | undefined): string {
  if (!content) return '<p>(none)</p>'
  return `<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f5f5f5;padding:8px;border-radius:4px;">${escapeHtml(content)}</pre>`
}

function emailSection(heading: string, bodyHtml: string): string {
  return `<div style="margin:0 0 20px;"><h2 style="font-size:15px;margin:0 0 8px;color:#111;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(heading)}</h2><div style="font-size:14px;color:#222;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${bodyHtml}</div></div>`
}

// --- Layman reproduction steps --------------------------------------------

interface RouteStepRule {
  /** Omitted = any method. */
  method?: string
  pathPrefix: string
  steps: string[]
}

/**
 * Human, shopper-language reproduction steps per route family — this is what
 * lets a non-engineer (or an on-call person skimming on a phone) understand
 * "what were they doing" without reading a stack trace.
 */
const ROUTE_STEP_RULES: RouteStepRule[] = [
  {
    method: 'POST',
    pathPrefix: '/v1/payments',
    steps: [
      'Open the Laanya app and sign in.',
      'Add any item to your bag.',
      'Go to checkout and tap Pay.',
      'The error happens at this point — the payment screen fails.',
    ],
  },
  {
    pathPrefix: '/v1/payments',
    steps: [
      'Open the Laanya app and sign in.',
      'Go to your orders to check on a payment.',
      'The error happens while the app checks the payment status.',
    ],
  },
  {
    pathPrefix: '/v1/addresses',
    steps: [
      'Open the Laanya app and sign in.',
      'Go to "My Addresses" (or add a new delivery address at checkout).',
      'The error happens while saving, loading, or deleting an address.',
    ],
  },
  {
    pathPrefix: '/v1/cart',
    steps: [
      'Open the Laanya app and sign in.',
      'Add, remove, or update the quantity of an item in the shopping bag.',
      'The error happens while updating the bag.',
    ],
  },
  {
    pathPrefix: '/v1/catalog',
    steps: [
      'Open the Laanya app (signed in or not).',
      'Browse products, or open a product page.',
      'The error happens while loading the product catalog.',
    ],
  },
  {
    pathPrefix: '/v1/me',
    steps: [
      'Open the Laanya app and sign in.',
      'Go to "My Profile" and view or edit your name, email, or other details.',
      'The error happens while loading or saving the profile.',
    ],
  },
  {
    pathPrefix: '/v1/config',
    steps: [
      'Open the Laanya app (signed in or not).',
      'The app quietly checks for the latest settings in the background — a shopper would not tap anything for this.',
      'The error happens during that background check.',
    ],
  },
  {
    pathPrefix: '/v1/geocode',
    steps: [
      'Open the Laanya app and tap to pick a delivery location on the map.',
      'The app tries to turn the map pin into an address.',
      'The error happens at this point — the address may not auto-fill.',
    ],
  },
]

const FALLBACK_STEPS = [
  'A customer was using the app when this happened.',
  'The exact screen could not be determined — see technical details below.',
]

function laymanSteps(method: string, path: string): string[] {
  const rule = ROUTE_STEP_RULES.find((r) => path.startsWith(r.pathPrefix) && (!r.method || r.method === method))
  return rule?.steps ?? FALLBACK_STEPS
}

function laymanStepsForPath(path: string): string[] {
  const rule = ROUTE_STEP_RULES.find((r) => path.startsWith(r.pathPrefix))
  return rule?.steps ?? FALLBACK_STEPS
}

function clientWhatHappened(type: ClientEventType): string {
  switch (type) {
    case 'error':
      return "The app crashed or hit an unexpected problem on a customer's device."
    case 'unhandledrejection':
      return "Something the app was waiting on failed silently on a customer's device."
    case 'console.error':
      return "The app logged an internal error message while a customer was using it — nothing necessarily broke on screen, but it's worth a look."
    case 'memory':
      return "The app used an unusually large amount of memory on a customer's device, which can make it feel slow or get closed by the phone."
    case 'rerender':
      return "A screen in the app kept redrawing itself far more than normal on a customer's device, which can make it feel slow or unresponsive."
  }
}

// --- GitHub issue markdown -------------------------------------------------

function githubIssueMarkdown(input: { whatHappened: string; laymanSteps: string[]; technicalMarkdown: string }): string {
  return [
    '## What happened',
    input.whatHappened,
    '',
    '## How to see it yourself',
    ...input.laymanSteps.map((step, i) => `${i + 1}. ${step}`),
    '',
    '## Technical details',
    input.technicalMarkdown,
    '',
    '## Instructions for the automated fixer',
    '1. Reproduce this issue first with a failing automated test.',
    '2. Make the minimal code change that fixes it — avoid unrelated refactors.',
    "3. Open a pull request against `main` (the branch that deploys to staging) referencing this issue.",
  ].join('\n')
}

// --- Per-alert-case assembly -------------------------------------------------

/**
 * Everything about ONE alert that's independent of dedupe/storm-brake/GitHub
 * state — built once per `notifyServerError` call or per event in a
 * `notifyClientEvents` batch, then handed to `dispatch`.
 */
interface AlertCase {
  fingerprint: string
  subjectGlyph: string
  subjectErrorLabel: string
  subjectRoute: string
  whatHappenedText: string
  laymanSteps: string[]
  statusLine: string
  technicalDetailsHtml: string
  githubTitle: string
  githubBodyMarkdown: string
}

function buildServerAlertCase(input: {
  normalized: NormalizedError
  ctx: ServerErrorCtx
  route: string
  fingerprint: string
  appEnv: AppEnv
}): AlertCase {
  const { normalized, ctx, route, fingerprint, appEnv } = input
  const steps = laymanSteps(ctx.method, ctx.path)
  const whatHappenedText = `Something went wrong on the server while a customer was using the app (a "${normalized.name}" error handling ${route}).`

  const technicalDetailsHtml =
    `<ul style="margin:0 0 8px;padding-left:18px;">` +
    `<li>Error: <code>${escapeHtml(normalized.name)}</code>: ${escapeHtml(normalized.message)}</li>` +
    `<li>Request: <code>${escapeHtml(route)}</code></li>` +
    `<li>Request id: <code>${escapeHtml(ctx.requestId)}</code></li>` +
    `<li>User id: <code>${ctx.userId ? escapeHtml(ctx.userId) : 'n/a (unauthenticated request)'}</code></li>` +
    `<li>Fingerprint: <code>${escapeHtml(fingerprint)}</code></li>` +
    `</ul>` +
    preBlock(normalized.stack)

  const technicalMarkdown = [
    `- Error: \`${normalized.name}\`: ${normalized.message}`,
    `- Request: \`${route}\``,
    `- Request id: \`${ctx.requestId}\``,
    `- User id: \`${ctx.userId ?? 'n/a (unauthenticated request)'}\``,
    `- Fingerprint: \`${fingerprint}\``,
    '',
    'Stack:',
    '```',
    normalized.stack ?? '(no stack trace)',
    '```',
  ].join('\n')

  return {
    fingerprint,
    subjectGlyph: '🚨',
    subjectErrorLabel: normalized.name,
    subjectRoute: route,
    whatHappenedText,
    laymanSteps: steps,
    statusLine: `HTTP ${ctx.statusCode}`,
    technicalDetailsHtml,
    githubTitle: `[${appEnv}] ${normalized.name}: ${route} [fp:${fingerprint}]`,
    githubBodyMarkdown: githubIssueMarkdown({ whatHappened: whatHappenedText, laymanSteps: steps, technicalMarkdown }),
  }
}

function buildClientAlertCase(input: {
  event: ClientErrorEvent
  ctx: ClientEventCtx
  pathname: string
  fingerprint: string
  appEnv: AppEnv
}): AlertCase {
  const { event, ctx, pathname, fingerprint, appEnv } = input
  const noisy = NOISY_CLIENT_TYPES.has(event.type)
  const whatHappenedText = clientWhatHappened(event.type)
  const steps = pathname ? laymanStepsForPath(pathname) : FALLBACK_STEPS
  const subjectRoute = pathname ? `${ctx.source} ${pathname}` : `${ctx.source} client`
  const userAgent = ctx.userAgent ?? event.userAgent

  const metaJson = event.meta && Object.keys(event.meta).length > 0 ? JSON.stringify(event.meta) : undefined

  const technicalDetailsHtml =
    `<ul style="margin:0 0 8px;padding-left:18px;">` +
    `<li>Type: <code>${escapeHtml(event.type)}</code></li>` +
    `<li>Message: ${escapeHtml(event.message)}</li>` +
    `<li>URL: <code>${event.url ? escapeHtml(event.url) : 'n/a'}</code></li>` +
    `<li>Source: <code>${escapeHtml(ctx.source)}</code></li>` +
    `<li>Client IP: <code>${escapeHtml(ctx.ip)}</code></li>` +
    `<li>User agent: <code>${userAgent ? escapeHtml(userAgent) : 'n/a'}</code></li>` +
    `<li>Fingerprint: <code>${escapeHtml(fingerprint)}</code></li>` +
    `</ul>` +
    preBlock(event.stack) +
    (metaJson ? preBlock(metaJson) : '')

  const technicalMarkdown = [
    `- Type: \`${event.type}\``,
    `- Message: ${event.message}`,
    `- URL: \`${event.url ?? 'n/a'}\``,
    `- Source: \`${ctx.source}\``,
    `- Client IP: \`${ctx.ip}\``,
    `- User agent: \`${userAgent ?? 'n/a'}\``,
    `- Fingerprint: \`${fingerprint}\``,
    '',
    'Stack:',
    '```',
    event.stack ?? '(no stack trace)',
    '```',
    ...(metaJson ? ['', 'Meta:', '```json', metaJson, '```'] : []),
  ].join('\n')

  return {
    fingerprint,
    subjectGlyph: noisy ? '⚠️' : '🚨',
    subjectErrorLabel: event.type,
    subjectRoute,
    whatHappenedText,
    laymanSteps: steps,
    statusLine: `Client-reported (${ctx.source}) — no HTTP status; this did not originate from a server response`,
    technicalDetailsHtml,
    githubTitle: `[${appEnv}] ${event.type}: ${subjectRoute} [fp:${fingerprint}]`,
    githubBodyMarkdown: githubIssueMarkdown({ whatHappened: whatHappenedText, laymanSteps: steps, technicalMarkdown }),
  }
}

// --- Email rendering -------------------------------------------------------

function buildNextStepHtml(
  issueUrl: string | undefined,
  issueCreationFailed: boolean,
  github: GithubConfig | undefined
): string {
  const instruction =
    '<p>To start an automated fix, add the <code>auto-fix</code> label to the GitHub issue for this error. ' +
    'Claude will then open a pull request against staging for human review.</p>'

  if (github && issueUrl) {
    return `${instruction}<p>GitHub issue: <a href="${escapeHtml(issueUrl)}">${escapeHtml(issueUrl)}</a></p>`
  }
  // Only render a prefilled "new issue" link when github config IS present
  // but creation failed — without config we don't know the repo, so there is
  // no URL we could construct at all.
  if (github && issueCreationFailed) {
    return `${instruction}<p>The GitHub issue could not be created automatically. Open one yourself instead.</p>`
  }
  return instruction
}

function renderEmailHtml(
  alertCase: AlertCase,
  meta: {
    appEnv: AppEnv
    now: number
    occurrence: number
    firstSeen: number
    issueUrl: string | undefined
    issueCreationFailed: boolean
    github: GithubConfig | undefined
  }
): string {
  const nowIso = new Date(meta.now).toISOString()
  const firstSeenIso = new Date(meta.firstSeen).toISOString()
  const stepsHtml = alertCase.laymanSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')

  const sections = [
    emailSection('What happened', `<p>${escapeHtml(alertCase.whatHappenedText)}</p>`),
    emailSection(
      'How to see it yourself (steps in plain words)',
      `<ol style="margin:0 0 8px;padding-left:18px;">${stepsHtml}</ol>` +
        `<p>It happened on the ${escapeHtml(meta.appEnv)} system at ${escapeHtml(nowIso)}.</p>`
    ),
    emailSection(
      'Impact',
      `<ul style="margin:0;padding-left:18px;">` +
        `<li>${escapeHtml(alertCase.statusLine)}</li>` +
        `<li>Environment: ${escapeHtml(meta.appEnv)}</li>` +
        `<li>This is occurrence #${meta.occurrence} of this specific problem since ${escapeHtml(firstSeenIso)}.</li>` +
        `</ul>`
    ),
    emailSection('Technical details', alertCase.technicalDetailsHtml),
    emailSection('Next step', buildNextStepHtml(meta.issueUrl, meta.issueCreationFailed, meta.github)),
  ]

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;">${sections.join('')}</div>`
}

// --- Dedupe bookkeeping ------------------------------------------------------

interface DedupeEntry {
  firstSeen: number
  lastSent: number
  count: number
}

interface DedupeCheckResult {
  send: boolean
  occurrence: number
  firstSeen: number
}

// --- The class ---------------------------------------------------------------

export class ErrorAlerter {
  private readonly appEnv: AppEnv
  private readonly log: FastifyBaseLogger
  private readonly brevo: BrevoConfig | undefined
  private readonly github: GithubConfig | undefined
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  /** Alerts fire ONLY in staging/production AND with Brevo configured (see class docs). */
  private readonly enabled: boolean

  // Per-fingerprint dedupe. See file header: process-local, no timer, lazily pruned.
  private readonly dedupe = new Map<string, DedupeEntry>()
  // Rolling one-hour windows for the global storm brake; pruned lazily on every check.
  private readonly sentTimestamps: number[] = []
  private readonly suppressedTimestamps: number[] = []

  constructor(config: ErrorAlerterConfig) {
    this.appEnv = config.appEnv
    this.log = config.log
    this.brevo = config.brevo
    this.github = config.github
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.now = config.now ?? Date.now
    this.enabled = (config.appEnv === 'staging' || config.appEnv === 'production') && config.brevo !== undefined
  }

  /**
   * Fire-and-forget: report a server-side 500. Synchronous by design — the
   * caller (the `setErrorHandler` in `app.ts`) is already mid-response and
   * must never await alerting, and any failure here must never surface.
   */
  notifyServerError(err: unknown, ctx: ServerErrorCtx): void {
    this.fireAndForget('notifyServerError', () => this.runServerError(err, ctx))
  }

  /** Fire-and-forget: report a batch of client-side events. Same contract as {@link notifyServerError}. */
  notifyClientEvents(events: ClientErrorEvent[], ctx: ClientEventCtx): void {
    this.fireAndForget('notifyClientEvents', () => this.runClientEvents(events, ctx))
  }

  // --- internals -------------------------------------------------------------

  private fireAndForget(label: string, work: () => Promise<void>): void {
    work().catch((caught: unknown) => {
      // Backstop only — `dispatch` below already catches everything it can
      // reach. This exists so a bug in fingerprinting/building an alert case
      // (i.e. code that runs BEFORE `dispatch`) can never throw into caller
      // code either.
      this.logAlertingError({ err: caught }, `${label} crashed unexpectedly — this is a bug in the alerter itself`)
    })
  }

  private async runServerError(err: unknown, ctx: ServerErrorCtx): Promise<void> {
    const normalized = normalizeError(err)
    const route = `${ctx.method} ${ctx.path}`
    const fingerprint = fingerprintError({
      kind: 'server',
      name: normalized.name,
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      route,
    })

    if (!this.enabled) {
      this.log.debug({ fingerprint, route }, 'alert suppressed: alerting disabled (development, or Brevo not configured)')
      return
    }

    await this.dispatch(
      SERVER_COOLDOWN_MS,
      buildServerAlertCase({ normalized, ctx, route, fingerprint, appEnv: this.appEnv })
    )
  }

  private async runClientEvents(events: ClientErrorEvent[], ctx: ClientEventCtx): Promise<void> {
    for (const event of events) {
      const pathname = pathnameOf(event.url)
      const fingerprint = fingerprintError({
        kind: 'client',
        type: event.type,
        message: event.message,
        urlPathname: pathname,
      })

      if (!this.enabled) {
        this.log.debug(
          { fingerprint, type: event.type },
          'alert suppressed: alerting disabled (development, or Brevo not configured)'
        )
        continue
      }

      const cooldownMs = NOISY_CLIENT_TYPES.has(event.type) ? NOISY_CLIENT_COOLDOWN_MS : CLIENT_ERROR_COOLDOWN_MS
      // Sequential await is fine — the route caps a batch at 20 events.
      await this.dispatch(cooldownMs, buildClientAlertCase({ event, ctx, pathname, fingerprint, appEnv: this.appEnv }))
    }
  }

  /** Shared pipeline for one alert case: dedupe -> storm brake -> GitHub (best-effort) -> email. */
  private async dispatch(cooldownMs: number, alertCase: AlertCase): Promise<void> {
    try {
      const now = this.now()

      const dedupeResult = this.checkDedupe(alertCase.fingerprint, cooldownMs, now)
      if (!dedupeResult.send) return

      if (this.consumesStormBudget(now)) return

      let issueUrl: string | undefined
      let issueCreationFailed = false
      if (this.github) {
        const result = await this.findOrCreateGithubIssue(alertCase)
        issueUrl = result.url
        issueCreationFailed = result.failed
      }

      const subject = `${alertCase.subjectGlyph} [${this.appEnv}] ${alertCase.subjectErrorLabel}: ${alertCase.subjectRoute}`
      const htmlContent = renderEmailHtml(alertCase, {
        appEnv: this.appEnv,
        now,
        occurrence: dedupeResult.occurrence,
        firstSeen: dedupeResult.firstSeen,
        issueUrl,
        issueCreationFailed,
        github: this.github,
      })

      await this.sendEmail(subject, htmlContent, alertCase.fingerprint)
    } catch (caught) {
      this.logAlertingError({ err: caught, fingerprint: alertCase.fingerprint }, 'failed to process an alert')
    }
  }

  private checkDedupe(fingerprint: string, cooldownMs: number, now: number): DedupeCheckResult {
    const existing = this.dedupe.get(fingerprint)
    if (!existing) {
      if (this.dedupe.size >= DEDUPE_MAX_ENTRIES) {
        // Insertion-ordered Map: oldest tracked fingerprint is first.
        const oldest = this.dedupe.keys().next()
        if (!oldest.done) this.dedupe.delete(oldest.value)
      }
      this.dedupe.set(fingerprint, { firstSeen: now, lastSent: now, count: 1 })
      return { send: true, occurrence: 1, firstSeen: now }
    }
    existing.count += 1
    if (now - existing.lastSent < cooldownMs) {
      return { send: false, occurrence: existing.count, firstSeen: existing.firstSeen }
    }
    existing.lastSent = now
    return { send: true, occurrence: existing.count, firstSeen: existing.firstSeen }
  }

  /**
   * Rolling one-hour storm brake, independent of per-fingerprint cooldowns —
   * guards against many DISTINCT fingerprints firing at once (e.g. a bad
   * deploy breaking several endpoints), which cooldown alone wouldn't catch.
   * Returns true (and logs a warning) when this send should be suppressed;
   * otherwise reserves this send's slot in the rolling window.
   */
  private consumesStormBudget(now: number): boolean {
    while (this.sentTimestamps.length > 0 && now - this.sentTimestamps[0]! >= HOUR_MS) {
      this.sentTimestamps.shift()
    }
    if (this.sentTimestamps.length >= GLOBAL_MAX_EMAILS_PER_HOUR) {
      while (this.suppressedTimestamps.length > 0 && now - this.suppressedTimestamps[0]! >= HOUR_MS) {
        this.suppressedTimestamps.shift()
      }
      this.suppressedTimestamps.push(now)
      this.log.warn(
        { suppressedLastHour: this.suppressedTimestamps.length, capPerHour: GLOBAL_MAX_EMAILS_PER_HOUR },
        'alerting: storm brake tripped — suppressing this alert email'
      )
      return true
    }
    this.sentTimestamps.push(now)
    return false
  }

  /**
   * GET the search endpoint for an open issue tagged with this fingerprint;
   * reuse it if found, else POST a new one. Best-effort: every failure is
   * logged and returns `{ failed: true }` rather than throwing — a GitHub
   * outage must never block the alert email itself.
   */
  private async findOrCreateGithubIssue(alertCase: AlertCase): Promise<{ url: string | undefined; failed: boolean }> {
    const github = this.github
    if (!github) return { url: undefined, failed: false }
    const { token, repo } = github

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'laanya-api-alerter',
    }

    try {
      // GitHub's search API 422s without an explicit `is:issue` qualifier
      // (confirmed live: "Query must include 'is:issue' or 'is:pull-request'")
      // — without it, EVERY search fails and falls through to "create new",
      // silently defeating dedupe (a duplicate issue every cooldown-elapsed
      // occurrence of the same fingerprint instead of reusing the first one).
      const query = `repo:${repo} is:issue in:title state:open "fp:${alertCase.fingerprint}"`
      const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`
      const searchRes = await this.fetchImpl(searchUrl, { headers })
      if (searchRes.ok) {
        const body = (await searchRes.json()) as { items?: Array<{ html_url?: string }> }
        const existingUrl = body.items?.[0]?.html_url
        if (existingUrl) return { url: existingUrl, failed: false }
      } else {
        const text = await searchRes.text()
        this.logAlertingError(
          { status: searchRes.status, body: text, fingerprint: alertCase.fingerprint },
          'GitHub issue search failed; proceeding to create (may duplicate)'
        )
      }

      const createRes = await this.fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: alertCase.githubTitle,
          labels: ['auto-fix-candidate', this.appEnv],
          body: alertCase.githubBodyMarkdown,
        }),
      })
      if (!createRes.ok) {
        const text = await createRes.text()
        this.logAlertingError(
          { status: createRes.status, body: text, fingerprint: alertCase.fingerprint },
          'GitHub issue creation failed'
        )
        return { url: undefined, failed: true }
      }
      const created = (await createRes.json()) as { html_url?: string }
      return { url: created.html_url, failed: false }
    } catch (err) {
      this.logAlertingError({ err, fingerprint: alertCase.fingerprint }, 'GitHub issue creation threw')
      return { url: undefined, failed: true }
    }
  }

  private async sendEmail(subject: string, htmlContent: string, fingerprint: string): Promise<void> {
    if (!this.brevo) return // `enabled` already gates this; defensive only.
    const { apiKey, emailFrom, emailTo } = this.brevo
    try {
      const res = await this.fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: emailFrom, name: 'Laanya Alerts' },
          to: [{ email: emailTo }],
          subject,
          htmlContent,
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        this.logAlertingError({ status: res.status, body: text, fingerprint }, 'Brevo email send failed')
      }
    } catch (err) {
      this.logAlertingError({ err, fingerprint }, 'Brevo email send threw')
    }
  }

  /** Every swallowed failure goes through here — logged at error level with full detail, never silently dropped. Logging itself must never throw into caller code either. */
  private logAlertingError(fields: Record<string, unknown>, msg: string): void {
    try {
      this.log.error(fields, `alerting: ${msg}`)
    } catch {
      // Deliberately empty — see the doc comment above.
    }
  }
}
