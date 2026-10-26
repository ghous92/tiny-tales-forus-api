--> The `GET /v1/catalog` ETag is the `catalog_version` counter, NOT a hash of
--> the payload (unlike /v1/config, whose version is a sha256 over its canonical
--> JSON and is therefore self-healing). A counter is only correct while every
--> writer remembers to bump it — and on 2026-07-31 one did not: a hand-run
--> `UPDATE products SET images = ...` against the DB changed the catalog without
--> touching the counter, so the API kept answering `304 Not Modified` to a
--> client asking "anything new since version 11?". The data was new; the
--> validator said it wasn't. No client-side cache clear could fix that, because
--> the client was behaving correctly.
-->
--> Application discipline cannot close this: psql, the Neon console, a one-off
--> node script and a future service in another language all bypass
--> `services/catalogAdmin.ts`. So the bump moves DOWN to the table itself, where
--> nothing can route around it.
-->
--> Semantics: the version increments ONCE PER TRANSACTION that touches any
--> catalog table, not once per row and not once per statement. That keeps the
--> counter meaning "the catalog changed N times" — an admin write that touches
--> `products` and `product_variants` together is one change, and a bulk seed of
--> the whole catalog in one transaction is one change. The guard is a
--> transaction-local GUC holding the current xid: `set_config(..., is_local =>
--> true)` is discarded at COMMIT/ROLLBACK, and comparing against `txid_current()`
--> means a value that somehow outlived its transaction (pooled connection,
--> subtransaction abort) still cannot suppress the next transaction's bump.
-->
--> Because the trigger now owns the bump, `bumpCatalogVersion()` is removed from
--> the TypeScript services in the same commit — keeping both would double-count.
--> `test/arch/catalog-version-trigger.test.ts` writes raw SQL that deliberately
--> bypasses every service and asserts the version still moves, so deleting this
--> trigger fails the suite rather than silently reintroducing stale ETags.
CREATE OR REPLACE FUNCTION bump_catalog_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Already counted this transaction: the catalog changed once, not once per
  -- statement. `current_setting(..., true)` yields NULL when unset, and
  -- `NULL = <text>` is NULL, so the first statement of a transaction falls
  -- through to the bump below.
  IF current_setting('tinytales.catalog_version_bumped', true) = txid_current()::text THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('tinytales.catalog_version_bumped', txid_current()::text, true);

  INSERT INTO catalog_version (id, version) VALUES ('catalog', 1)
  ON CONFLICT (id) DO UPDATE SET version = catalog_version.version + 1, updated_at = now();

  RETURN NULL;
END $$;--> statement-breakpoint

--> Statement-level, so a bulk insert of every variant costs one counter write,
--> and `AFTER` so a statement rolled back by a later error takes its bump too.
--> Each is dropped first so the whole migration is re-runnable: a database that
--> got the trigger by hand (a dev box patched ahead of the release) still
--> applies this file cleanly when the migration ledger catches up.
DROP TRIGGER IF EXISTS categories_bump_catalog_version ON "categories";--> statement-breakpoint
CREATE TRIGGER categories_bump_catalog_version
  AFTER INSERT OR UPDATE OR DELETE ON "categories"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();--> statement-breakpoint

DROP TRIGGER IF EXISTS products_bump_catalog_version ON "products";--> statement-breakpoint
CREATE TRIGGER products_bump_catalog_version
  AFTER INSERT OR UPDATE OR DELETE ON "products"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();--> statement-breakpoint

DROP TRIGGER IF EXISTS product_variants_bump_catalog_version ON "product_variants";--> statement-breakpoint
CREATE TRIGGER product_variants_bump_catalog_version
  AFTER INSERT OR UPDATE OR DELETE ON "product_variants"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();

--> Deliberately NOT bumping catalog_version here. This file replays against
--> every fresh environment (CI, `createTestDb()` in every test, a new
--> engineer's local DB) via drizzle's migrator, and `services/catalogVersion.ts`
--> documents 0 as the valid "no catalog yet" starting value —
--> `test/scripts/seed-catalog.test.ts` asserts exactly that. A bump baked into
--> this migration would make every fresh DB start at 1 instead, silently
--> breaking that contract everywhere, forever, to fix a staleness problem that
--> exists on exactly one already-running database. Any catalog whose ETag was
--> already stale before this migration lands gets a ONE-OFF manual bump against
--> that specific database after the trigger is installed — not a statement here.
