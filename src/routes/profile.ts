/**
 * /v1/me — the caller's own profile (name + email captured by the app's
 * post-login prompt). HTTP layer only: Zod validates every input (strict) and
 * serializes every output; the rules live in `services/profile.ts`. Both
 * routes require auth via the `app.authenticate` hook (plugins/auth.ts), which
 * is also what identifies "me" — there is no id in the path, so one user can
 * never address another's profile.
 */

import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { ErrorEnvelopeSchema, ProfileSchema, ProfileUpdateSchema } from '../contracts/profile.js'
import type { Db } from '../db/client.js'
import type { Analytics } from '../lib/analytics.js'
import type { FirebaseTokenRevoker, FirebaseUserDeleter } from '../plugins/auth.js'
import { deleteFromImageIntake, ImageIntakeError } from '../lib/imageIntake.js'
import {
  assertNoCustomPieceInProgress,
  deleteAccount,
  getProfile,
  listAccountImageKeys,
  revokeTokens,
  updateProfile,
} from '../services/profile.js'

/** Error envelope for every non-2xx status, declared once per route. */
const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface ProfileRoutesOptions {
  db: Db
  /** Optional server-side identify sink; absent analytics is a supported no-op. */
  analytics?: Analytics | undefined
  /** Revokes the caller's Firebase account on `DELETE /`. Tests inject a fake. */
  deleteFirebaseUser: FirebaseUserDeleter
  /** Ends the caller's Firebase refresh tokens on `POST /logout`. Tests inject a fake. */
  revokeFirebaseTokens: FirebaseTokenRevoker
  /** Where an account's photos are deleted from. `uploadToken` absent -> a delete with photos answers 503. */
  imageIntake?: { baseUrl: string; uploadToken?: string | undefined; fetchImpl?: typeof fetch }
}

export const profileRoutes: FastifyPluginAsyncZod<ProfileRoutesOptions> = async (
  app,
  { db, deleteFirebaseUser, revokeFirebaseTokens, analytics, imageIntake }
) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    { schema: { response: { 200: ProfileSchema, ...errorResponses } } },
    async (request) => getProfile(db, request.user.id)
  )

  app.patch(
    '/',
    {
      schema: {
        body: ProfileUpdateSchema,
        response: { 200: ProfileSchema, ...errorResponses },
      },
    },
    async (request) => {
      const profile = await updateProfile(db, request.user.id, request.body)
      analytics?.userProfileUpdated({
        userId: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        gender: profile.gender,
        dob: profile.dob,
        marketingWhatsappOptIn: profile.marketingWhatsappOptIn,
        adAudienceOptIn: profile.adAudienceOptIn,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })
      return profile
    }
  )

  // Firebase can only revoke per account, not per device, so this signs the
  // shopper out everywhere. The stored cutoff goes first: it is what stops
  // already-issued ID tokens here, whatever happens to the Firebase call.
  app.post(
    '/logout',
    { schema: { response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      await revokeTokens(db, request.user.id)
      app.invalidateAuthUser(request.user.uid)
      await revokeFirebaseTokens(request.user.uid)
      return reply.code(204).send(null)
    }
  )

  // In-app account deletion (Apple Guideline 5.1.1(v)). Anonymizes the row
  // (see services/profile.ts deleteAccount — payment/order history is kept
  // for tax retention) THEN revokes the Firebase account, in that order: if
  // the Firebase call fails, the account is already unusable (tombstoned
  // phone/uid can never authenticate again) rather than left deletable-looking
  // but still Firebase-live.
  app.delete(
    '/',
    { schema: { response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      await assertNoCustomPieceInProgress(db, request.user.id)
      // Files first: if the image host fails, the account and its list of keys
      // are still here, so the shopper can simply try again.
      const keys = await listAccountImageKeys(db, request.user.id)
      if (keys.length > 0) {
        if (!imageIntake?.uploadToken) {
          return reply.code(503).send({
            error: { code: 'media_disabled', message: 'Account deletion is not available right now.' },
          })
        }
        try {
          for (const key of keys) {
            await deleteFromImageIntake({
              fetchImpl: imageIntake.fetchImpl ?? fetch,
              baseUrl: imageIntake.baseUrl,
              uploadToken: imageIntake.uploadToken,
              key,
            })
          }
        } catch (err) {
          if (!(err instanceof ImageIntakeError)) throw err
          request.log.error({ err }, 'account deletion could not remove images')
          return reply.code(502).send({
            error: {
              code: 'media_delete_failed',
              message: 'We could not remove your photos just now. Please try again.',
            },
          })
        }
      }
      const { firebaseUid } = await deleteAccount(db, request.user.id)
      // Drop the cached identity before anything else can present the same
      // (still-unexpired) ID token; otherwise the deleted account keeps
      // resolving to its old row for the rest of the cache TTL. Per-instance
      // only — see lib/authCache.ts on why the TTL stays short.
      app.invalidateAuthUser(firebaseUid)
      await deleteFirebaseUser(firebaseUid)
      return reply.code(204).send(null)
    }
  )
}
