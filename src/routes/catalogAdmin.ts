/**
 * `/v1/admin/catalog/*` — admin catalog CRUD (HTTP layer only). Business rules
 * live in services/catalogAdmin.ts; every route requires `app.authenticate`
 * THEN `app.requireAdmin` (see plugins/auth.ts). Zod schemas validate every
 * input and serialize every output.
 *
 * Routes (all under the /v1/admin/catalog prefix set in app.ts):
 *   GET    /products                      list products (+ variants), incl. inactive
 *   POST   /products                      create product
 *   GET    /products/:id                  one product (+ variants)
 *   PUT    /products/:id                  patch product
 *   DELETE /products/:id                  delete product (variants cascade)
 *   POST   /products/:productId/variants  add a variant to a product
 *   PUT    /variants/:sku                 patch a variant
 *   DELETE /variants/:sku                 delete a variant
 *   GET    /categories                    list categories, incl. inactive
 *   POST   /categories                    create category
 *   PUT    /categories/:slug              patch category
 *   DELETE /categories/:slug              delete category (rejected if in use)
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  AdminCategoryListSchema,
  AdminCategorySchema,
  AdminProductListSchema,
  AdminProductSchema,
  AdminVariantSchema,
  CategoryCreateSchema,
  CategoryUpdateSchema,
  ProductCreateSchema,
  ProductIdParamsSchema,
  ProductUpdateSchema,
  ProductVariantsParamsSchema,
  SkuParamsSchema,
  SlugParamsSchema,
  VariantCreateSchema,
  VariantUpdateSchema,
} from '../contracts/catalog.js'
import { ErrorEnvelopeSchema } from '../contracts/config.js'
import type { Db } from '../db/client.js'
import {
  createCategory,
  createProduct,
  createVariant,
  deleteCategory,
  deleteProduct,
  deleteVariant,
  getAdminProduct,
  listAdminCategories,
  listAdminProducts,
  updateCategory,
  updateProduct,
  updateVariant,
} from '../services/catalogAdmin.js'
import { getConfigValues } from '../services/config.js'

/**
 * Whether the seller is GST-registered right now, per `legal.company` — read
 * here (never inside `services/catalogAdmin.ts`, ARCHITECTURE.md rule 5) and
 * passed down so the product-active Legal Metrology gate can require an HSN
 * code + rate once registration is real. Defaults `false` (unregistered) if
 * the key isn't seeded, matching the seller's actual status today.
 */
async function resolveGstRegistered(db: Db): Promise<boolean> {
  const values = await getConfigValues(db, ['legal.company'])
  const company = (values.get('legal.company') ?? {}) as { gstRegistered?: unknown }
  return company.gstRegistered === true
}

const errorResponses = {
  '4xx': ErrorEnvelopeSchema,
  '5xx': ErrorEnvelopeSchema,
}

export interface CatalogAdminRoutesOptions {
  db: Db
}

/** Admin catalog routes. Mounted at '/v1/admin/catalog' by app.ts. */
export const catalogAdminRoutes: FastifyPluginAsyncZod<CatalogAdminRoutesOptions> = async (
  app,
  { db }
) => {
  app.addHook('onRequest', app.authenticate)
  app.addHook('onRequest', app.requireAdmin)

  // --- Products --------------------------------------------------------------

  app.get(
    '/products',
    { schema: { response: { 200: AdminProductListSchema, ...errorResponses } } },
    async () => listAdminProducts(db)
  )

  app.post(
    '/products',
    {
      schema: {
        body: ProductCreateSchema,
        response: { 201: AdminProductSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const gstRegistered = await resolveGstRegistered(db)
      const created = await createProduct(db, request.body, { gstRegistered })
      return reply.code(201).send(created)
    }
  )

  app.get(
    '/products/:id',
    {
      schema: {
        params: ProductIdParamsSchema,
        response: { 200: AdminProductSchema, ...errorResponses },
      },
    },
    async (request) => getAdminProduct(db, request.params.id)
  )

  app.put(
    '/products/:id',
    {
      schema: {
        params: ProductIdParamsSchema,
        body: ProductUpdateSchema,
        response: { 200: AdminProductSchema, ...errorResponses },
      },
    },
    async (request) => {
      const gstRegistered = await resolveGstRegistered(db)
      return updateProduct(db, request.params.id, request.body, { gstRegistered })
    }
  )

  app.delete(
    '/products/:id',
    {
      schema: {
        params: ProductIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteProduct(db, request.params.id)
      return reply.code(204).send(null)
    }
  )

  // --- Variants --------------------------------------------------------------

  app.post(
    '/products/:productId/variants',
    {
      schema: {
        params: ProductVariantsParamsSchema,
        body: VariantCreateSchema,
        response: { 201: AdminVariantSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const created = await createVariant(db, request.params.productId, request.body)
      return reply.code(201).send(created)
    }
  )

  app.put(
    '/variants/:sku',
    {
      schema: {
        params: SkuParamsSchema,
        body: VariantUpdateSchema,
        response: { 200: AdminVariantSchema, ...errorResponses },
      },
    },
    async (request) => updateVariant(db, request.params.sku, request.body)
  )

  app.delete(
    '/variants/:sku',
    {
      schema: {
        params: SkuParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteVariant(db, request.params.sku)
      return reply.code(204).send(null)
    }
  )

  // --- Categories ------------------------------------------------------------

  app.get(
    '/categories',
    { schema: { response: { 200: AdminCategoryListSchema, ...errorResponses } } },
    async () => listAdminCategories(db)
  )

  app.post(
    '/categories',
    {
      schema: {
        body: CategoryCreateSchema,
        response: { 201: AdminCategorySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const created = await createCategory(db, request.body)
      return reply.code(201).send(created)
    }
  )

  app.put(
    '/categories/:slug',
    {
      schema: {
        params: SlugParamsSchema,
        body: CategoryUpdateSchema,
        response: { 200: AdminCategorySchema, ...errorResponses },
      },
    },
    async (request) => updateCategory(db, request.params.slug, request.body)
  )

  app.delete(
    '/categories/:slug',
    {
      schema: {
        params: SlugParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await deleteCategory(db, request.params.slug)
      return reply.code(204).send(null)
    }
  )
}
