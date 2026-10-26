# laanya-api — Backend Service Spec (v1: Address CRUD)

## Goal

Standalone backend service for Laanya (beauty & personal care ecommerce, India).
First feature: **saved addresses with full CRUD**, authenticated via Firebase
phone auth. Architecture must cleanly extend to future APIs (orders, payments,
returns, notifications) without restructuring.

## Constraints

- **Runtime:** Node 22, TypeScript (strict), ESM.
- **Framework:** Fastify 5 + `fastify-type-provider-zod` (Zod schemas are the
  single source of truth for validation AND OpenAPI-ready types).
- **DB:** Neon Postgres via Drizzle ORM (`drizzle-kit` for migrations,
  `pg` Pool against the Neon **pooled** endpoint).
- **Auth:** Firebase Admin SDK (project `laanya-prod`), verify `Bearer <ID token>`
  on every non-health route. On first authed request, upsert a `users` row from
  the token (uid + phone_number).
- **Deploy:** Docker → GCP Cloud Run `asia-southeast1` (colocated with Neon
  `aws-ap-southeast-1`). Firebase Admin uses ADC on Cloud Run — no key files.
- **Secrets:** No secrets in repo, ever. DB URL from env (`DATABASE_URL`),
  supplied by GCP Secret Manager in prod, `.env` (gitignored) locally.
  `.env.example` with placeholders only.
- **Layering:** `routes → services → db`. Routes do HTTP+validation only,
  services own business rules, `db/` owns schema + queries. Contracts (Zod) in
  `src/contracts/` importable in isolation (future: shared with mobile).
- **Logging:** pino via Fastify built-in; request-id on every log line; never
  log tokens, phone numbers in full (mask to last 4), or DB URLs.
- **Tests:** vitest. Unit tests for contracts + service rules (mock db layer),
  route tests via `fastify.inject` with auth stubbed at the plugin seam.

## Frontend alignment (source: mobile/src/components/AddressForm.tsx)

JSON field names mirror the mobile form exactly. Validation regexes are
byte-identical to mobile:

- phone: `^[6-9]\d{9}$` (10-digit Indian mobile; store normalized E.164 `+91…`,
  serve back as 10-digit)
- pincode: `^[1-9][0-9]{5}$`

Address resource (API JSON):

```jsonc
{
  "id": "uuid",
  "name": "string", // contact name, required, 1..100
  "phone": "string", // 10-digit, required
  "pincode": "string", // required
  "city": "string", // optional, may be ""
  "state": "string", // optional, may be ""
  "houseNumber": "string", // required, 1..200  (mobile: houseNumber)
  "roadArea": "string", // required, 1..200  (mobile: roadArea)
  "isDefault": true, // mobile sends useAsDefault -> maps to isDefault
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
}
```

## Endpoints (all under /v1, auth required unless noted)

| Method | Path                | Behavior                                                       |
| ------ | ------------------- | -------------------------------------------------------------- |
| GET    | `/livez`            | no auth, `{ ok: true }`, no DB touch                           |
| GET    | `/readyz`           | no auth, DB `select 1`, 503 if down                            |
| GET    | `/v1/addresses`     | list caller's addresses, default first, then newest            |
| POST   | `/v1/addresses`     | create; 201 + resource. First address forced `isDefault=true`  |
| GET    | `/v1/addresses/:id` | 200 or 404 (also 404 for another user's id — never 403)        |
| PATCH  | `/v1/addresses/:id` | partial update; same validation per-field                      |
| DELETE | `/v1/addresses/:id` | 204; deleting the default promotes newest remaining to default |

Rules:

- `isDefault=true` on create/update atomically unsets the previous default
  (single transaction; partial unique index enforces at DB level).
- Setting `isDefault=false` on the current default is rejected 422 (there must
  always be a default while addresses exist) unless it is being deleted.
- Max 50 addresses per user → 422 on create past limit.
- Error envelope everywhere: `{ "error": { "code": "string", "message": "string" } }`
  with codes: `unauthorized`, `not_found`, `validation_failed`, `limit_exceeded`,
  `default_required`, `internal`.
- Unknown JSON fields rejected (Zod strict).

## DB schema (Drizzle, migrations committed)

```
users:      id uuid pk default, firebase_uid text unique not null,
            phone text unique not null (E.164), name text,
            created_at/updated_at timestamptz not null default now()
addresses:  id uuid pk default, user_id uuid not null fk->users(id) on delete cascade,
            name text not null, phone text not null (E.164),
            pincode text not null, city text not null default '',
            state text not null default '', house_number text not null,
            road_area text not null, is_default boolean not null default false,
            created_at/updated_at timestamptz not null default now()
index:      unique (user_id) where is_default  -- one default per user
index:      (user_id, created_at desc)
```

## Repo layout

```
src/
  index.ts            # bootstrap: env -> app -> listen
  app.ts              # buildApp(): plugins, routes, error handler (exported for tests)
  env.ts              # Zod-validated process.env, fail-fast
  plugins/auth.ts     # firebase token verify -> request.user {id, uid, phone}; user upsert
  contracts/address.ts# Zod schemas: AddressCreate, AddressUpdate, Address (response)
  routes/health.ts
  routes/addresses.ts
  services/addresses.ts
  db/client.ts        # pg Pool + drizzle instance
  db/schema.ts
drizzle/              # generated SQL migrations (committed)
test/                 # vitest
Dockerfile            # multi-stage, distroless or node:22-slim runtime, non-root
.github/workflows/ci.yml      # PR: lint+typecheck+test
.github/workflows/deploy.yml  # main: WIF auth -> build -> Artifact Registry -> migrate -> Cloud Run
docs/CONTRACTS.md     # frontend<->backend field mapping + invariants
.env.example  .gitignore  package.json  tsconfig.json  drizzle.config.ts
eslint (flat config) + prettier defaults matching laanya-shop style (no semicolons per mobile style)
```

## Definition of done (checkable)

1. `npm run typecheck`, `npm run lint`, `npm test` all pass locally.
2. `npm run dev` boots against real Neon; `GET /livez` 200, `GET /readyz` 200.
3. All 5 CRUD endpoints behave per table above, verified by vitest route tests
   covering: happy paths, 401 (no/bad token), 404 (other user's address),
   422 (bad phone/pincode, unknown field, default rules, >10 limit),
   default-promotion on delete, default-swap transactionality.
4. Migrations apply cleanly to a fresh Neon database via `npm run db:migrate`.
5. No secret material anywhere in the repo (grep for `neon.tech`, `AIza`,
   `-----BEGIN`, `firebase_admin` keys returns nothing sensitive).
6. Deployed on Cloud Run; live `GET /livez` 200; authed smoke CRUD round-trip
   passes against the live URL.
7. `docs/CONTRACTS.md` documents field mapping to `AddressForm.tsx`, the
   E.164/10-digit convention, both regexes, and the default-address invariants.
