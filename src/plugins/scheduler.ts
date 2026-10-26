/**
 * Machine authentication for the background sweeps (`routes/internalSweeps.ts`).
 *
 * Every sweep in this codebase — `manifest`, `reconcile`, `retry-emails`,
 * `notifications/dispatch` — is gated `authenticate` + `requireAdmin`, i.e. a
 * Firebase ID token carrying a verified `phone_number` claim. That is the right
 * gate for a human pressing a button in the admin SPA and the wrong one for a
 * scheduler: Cloud Scheduler cannot mint a Firebase token, and there is no way
 * to give it one that does not amount to parking a long-lived credential
 * somewhere. `routes/notificationsAdmin.ts` names this as the open follow-up.
 *
 * So machines get their own gate rather than a share of the human one:
 * a Google-signed OIDC ID token, minted per-invocation by Cloud Scheduler from
 * a dedicated service account (`--oidc-service-account-email`). It expires in an
 * hour, it is issued by Google rather than stored by us, and revoking it is an
 * IAM edit rather than a redeploy.
 *
 * **Deliberately NOT reusing `request.user`.** A synthetic admin principal would
 * have to invent a `users.id`, and several admin routes write that value into
 * `ndr_requests.requested_by` / `shipments.acknowledged_by` as a real FK. A
 * machine caller that looks like a user is one refactor away from writing a
 * dangling foreign key into an audit column. The scheduler identity is a
 * separate decoration on a separate route tree, and the two never meet.
 *
 * Unconfigured is CLOSED, not open: with no audience or no allowlist, every
 * call answers 503 `scheduler_disabled`. This is the one place the codebase's
 * usual "absent credentials degrade gracefully" posture is inverted, because
 * here the absent credential IS the lock.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { forbidden, schedulerDisabled, unauthorized } from '../lib/errors.js'

/** The claims we consume from a verified Google OIDC ID token. */
export interface VerifiedOidcToken {
  /** The calling service account's email, e.g. `tinytales-scheduler@tinytalesforus-prod.iam.gserviceaccount.com`. */
  email: string
  /** Google sets this true for service-account identities; a false value is rejected. */
  emailVerified: boolean
}

/**
 * Verifies a raw Google-signed OIDC ID token against `audience`, throwing on
 * any invalid/expired/wrong-audience token. Injected so tests exercise the real
 * header parsing and allowlist logic with a fake verifier.
 */
export type OidcVerifier = (token: string, audience: string) => Promise<VerifiedOidcToken>

/** The verified machine caller, on routes that register the hook. */
export interface SchedulerPrincipal {
  email: string
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * onRequest hook: verify a Google OIDC bearer token and populate
     * `request.scheduler`. 503 when unconfigured, 401 on a bad token, 403 when
     * the identity is not on the allowlist.
     */
    authenticateScheduler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    /** Set by `authenticateScheduler`; only defined on the internal sweep routes. */
    scheduler: SchedulerPrincipal
  }
}

/**
 * Production {@link OidcVerifier}: `google-auth-library`'s `verifyIdToken`,
 * lazy-loaded on first use the same way `createFirebaseVerifier` lazy-loads
 * firebase-admin. The client caches Google's signing certificates internally,
 * so steady-state verification is local CPU, not a network round-trip — which
 * is why this is a library call rather than a `tokeninfo` fetch.
 */
export function createGoogleOidcVerifier(): OidcVerifier {
  let client:
    | { verifyIdToken: (o: { idToken: string; audience: string }) => Promise<unknown> }
    | undefined
  return async (token, audience) => {
    if (!client) {
      const { OAuth2Client } = await import('google-auth-library')
      client = new OAuth2Client()
    }
    const ticket = (await client.verifyIdToken({ idToken: token, audience })) as {
      getPayload: () => { email?: string; email_verified?: boolean } | undefined
    }
    const payload = ticket.getPayload()
    return {
      email: payload?.email ?? '',
      emailVerified: payload?.email_verified === true,
    }
  }
}

export interface SchedulerPluginOptions {
  /**
   * The `aud` claim every accepted token must carry, matching Cloud Scheduler's
   * `--oidc-token-audience`. Set explicitly rather than defaulting to the
   * request URL: the service answers on three hostnames (the `*.run.app` URL,
   * `www.tinytalesforus.com/api`, and localhost in dev) and an audience derived from
   * whichever one the caller happened to use would accept a token minted for
   * any of them. Absent ⇒ the gate is closed.
   */
  audience?: string | undefined
  /**
   * Service-account emails permitted to call the sweeps. Absent or empty ⇒ the
   * gate is closed. A valid Google token proves only that SOME Google identity
   * signed it — any GCP customer can mint one for any audience — so the
   * allowlist, not the signature, is what actually restricts this.
   */
  allowedServiceAccounts?: readonly string[] | undefined
  /** Test seam. Production uses {@link createGoogleOidcVerifier}. */
  verifyOidc?: OidcVerifier
}

export const schedulerPlugin = fp<SchedulerPluginOptions>(
  (app, opts, done) => {
    const audience = opts.audience?.trim() ?? ''
    const allowed = new Set(
      (opts.allowedServiceAccounts ?? []).map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
    )
    const verifyOidc = opts.verifyOidc ?? createGoogleOidcVerifier()
    const configured = audience !== '' && allowed.size > 0

    app.decorateRequest('scheduler')

    if (!configured) {
      app.log.warn(
        { hasAudience: audience !== '', allowedCount: allowed.size },
        'scheduler auth is not configured (SCHEDULER_OIDC_AUDIENCE / SCHEDULER_SERVICE_ACCOUNTS); ' +
          'every /v1/internal route will answer 503 and no background sweep can run'
      )
    }

    app.decorate('authenticateScheduler', async (request: FastifyRequest) => {
      if (!configured) {
        throw schedulerDisabled(
          'Scheduler auth is not configured (SCHEDULER_OIDC_AUDIENCE / SCHEDULER_SERVICE_ACCOUNTS)'
        )
      }

      const header = request.headers.authorization
      if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token')
      const token = header.slice('Bearer '.length).trim()
      if (token.length === 0) throw unauthorized('Missing bearer token')

      let verified: VerifiedOidcToken
      try {
        verified = await verifyOidc(token, audience)
      } catch {
        // Swallowed for the same reason `authenticate` swallows: verifier
        // failures must not leak detail (or the token) into a response or a log.
        throw unauthorized('Invalid or expired token')
      }

      const email = verified.email.trim().toLowerCase()
      if (email === '' || !verified.emailVerified) {
        throw unauthorized('Token is missing required claims')
      }
      if (!allowed.has(email)) {
        // Logged at warn: a correctly-signed token from an unexpected identity
        // is the signal worth alerting on, unlike a malformed one.
        request.log.warn(
          { email },
          'scheduler token from a service account that is not allowlisted'
        )
        throw forbidden()
      }

      request.scheduler = { email }
    })

    done()
  },
  { name: 'scheduler', fastify: '5.x' }
)
