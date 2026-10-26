/**
 * `/v1/admin/cod` — the COD ops surface (docs/SPEC-COD.md, P7.3).
 * `authenticate` then `requireAdmin`, mirroring routes/shippingAdmin.ts.
 *
 * Read-only, and one route. **There is deliberately no kill-switch endpoint
 * here.** Switching COD off is `PUT /v1/admin/config/payments.cod.enabled` —
 * the generic config route that already audits who changed what and when. A
 * bespoke `POST /disable` would be a second write path to the same row, and the
 * one that skipped the audit trail would be the one used in an emergency, which
 * is exactly the change you most want a record of. The readout names the key
 * (`killSwitchKey`) so the admin UI does not have to hardcode it.
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import { CodHealthSchema, ErrorEnvelopeSchema } from '../contracts/cod.js'
import type { Db } from '../db/client.js'
import { codHealth } from '../services/cod.js'

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface CodAdminRoutesOptions {
  db: Db
}

export const codAdminRoutes: FastifyPluginAsyncZod<CodAdminRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  app.get(
    '/health',
    { schema: { response: { 200: CodHealthSchema, ...errorResponses } } },
    async () => codHealth(db)
  )
}
