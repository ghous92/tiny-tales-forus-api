/**
 * /v1/addresses — HTTP layer only. Zod schemas validate every input (strict:
 * unknown JSON keys are rejected) and serialize every output; business rules
 * live in `services/addresses.ts`. All routes require auth via the
 * `app.authenticate` hook (see plugins/auth.ts).
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  AddressCreateSchema,
  AddressListSchema,
  AddressParamsSchema,
  AddressSchema,
  AddressUpdateSchema,
  ErrorEnvelopeSchema,
} from '../contracts/address.js'
import type { Db } from '../db/client.js'
import {
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  updateAddress,
} from '../services/addresses.js'

/** Error envelope for every non-2xx status, declared once per route. */
const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface AddressRoutesOptions {
  db: Db
}

export const addressRoutes: FastifyPluginAsyncZod<AddressRoutesOptions> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    { schema: { response: { 200: AddressListSchema, ...errorResponses } } },
    async (request) => listAddresses(db, request.user.id)
  )

  app.post(
    '/',
    {
      schema: {
        body: AddressCreateSchema,
        response: { 201: AddressSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const address = await createAddress(db, request.user.id, request.body)
      return reply.code(201).send(address)
    }
  )

  app.get(
    '/:id',
    {
      schema: {
        params: AddressParamsSchema,
        response: { 200: AddressSchema, ...errorResponses },
      },
    },
    async (request) => getAddress(db, request.user.id, request.params.id)
  )

  app.patch(
    '/:id',
    {
      schema: {
        params: AddressParamsSchema,
        body: AddressUpdateSchema,
        response: { 200: AddressSchema, ...errorResponses },
      },
    },
    async (request) => updateAddress(db, request.user.id, request.params.id, request.body)
  )

  app.delete(
    '/:id',
    {
      schema: {
        params: AddressParamsSchema,
        // Fastify sends no body for a 204; z.null() documents "empty".
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteAddress(db, request.user.id, request.params.id)
      return reply.code(204).send(null)
    }
  )
}
