-- Run once, right after the PG17 server started (port 5433 — see
-- sync-local-db.sh's header for why it must be 17, matching Neon, and on a
-- separate port from any other Postgres.app server already running).
--
-- Postgres.app boots each server with a superuser matching your macOS
-- username (no password, trusted over local TCP) and no `laanya` database.
-- This creates the role and database SHAPED LIKE NEON — same name, same owner
-- name — so a connection string only ever differs by host and port between
-- environments.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'neondb_owner') THEN
    CREATE ROLE neondb_owner WITH LOGIN PASSWORD 'laanya_local_dev' CREATEDB;
  END IF;
END
$$;

SELECT 'CREATE DATABASE laanya OWNER neondb_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'laanya')
\gexec
