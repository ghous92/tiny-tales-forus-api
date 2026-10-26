#!/usr/bin/env bash
#
# Refill the local Postgres.app server from a Neon branch.
#
# Usage:  scripts/dev/sync-local-db.sh [branch]      # branch defaults to dev
#
# One-time setup before the first run: in Postgres.app, add a SEPARATE PG 17
# server (New Server → version 17, port 5433) alongside any other version
# already running — port 5433, not 5432, is what pins this to Neon's own
# major version rather than whatever Postgres.app defaults to. Then run:
#   psql -h 127.0.0.1 -p 5433 -U "$(whoami)" -d postgres \
#     -f scripts/dev/bootstrap-local-db.sql
#
# ## What this does, and the one thing it deliberately does not do
#
# Dumps the named Neon branch and restores it into the local server, schema
# and data together, so local is a byte-faithful copy rather than "migrations
# replayed and then some seeds". Those two diverge quietly: a column added by
# hand in an env, a backfill that ran once, a row someone fixed in the console.
# Replaying migrations reproduces the SCHEMA and invents the DATA.
#
# It does NOT read `.env`. The whole point of local Postgres is that `.env`
# now names it, so reading `.env` here would dump the server into itself.
# The Neon URL is minted fresh from `neonctl` on every run.
#
# ## Why --no-owner --no-privileges
#
# Neon carries roles the local server has never heard of (`cost_writer`,
# `grafana_cost_ro` from the cost tracker). Without these flags every GRANT and
# every ALTER ... OWNER TO fails, and pg_restore reports dozens of errors that
# look alarming and mean nothing. Everything lands owned by `neondb_owner`
# instead, which locally is the only role that matters.
set -euo pipefail

BRANCH="${1:-dev}"
PROJECT_ID="long-leaf-66968398"
ORG_ID="org-still-sound-69451390"
LOCAL_URL="postgres://neondb_owner:laanya_local_dev@127.0.0.1:5433/laanya"
DUMP_FILE="$(mktemp -t laanya-"$BRANCH").pgc"

# Homebrew keeps postgresql@17 out of PATH because it is versioned. Prepend it
# rather than relying on the caller's shell, because a pg_dump older than the
# server refuses outright ("server version 17.x; pg_dump version 16.x").
PG_BIN="$(brew --prefix postgresql@17)/bin"
export PATH="$PG_BIN:$PATH"

echo "==> minting a fresh connection string for Neon branch '$BRANCH'"
NEON_URL="$(npx --yes neonctl connection-string "$BRANCH" \
  --project-id "$PROJECT_ID" --org-id "$ORG_ID" \
  --database-name laanya --role-name neondb_owner)"

echo "==> checking local Postgres.app is up"
pg_isready -d "$LOCAL_URL" >/dev/null || {
  echo "Local Postgres is not answering on 127.0.0.1:5433." >&2
  echo "Open Postgres.app and make sure the server is running (green light)." >&2
  echo "First time only: run scripts/dev/bootstrap-local-db.sql — see this file's header." >&2
  exit 1
}

echo "==> dumping $BRANCH (schema + data)"
pg_dump "$NEON_URL" --format=custom --no-owner --no-privileges --file="$DUMP_FILE"
echo "    $(du -h "$DUMP_FILE" | cut -f1) written"

# Dropping and recreating rather than restoring over the top: --clean on a
# database whose schema has since MOVED ON leaves the objects the dump no
# longer knows about, which is the exact drift this script exists to remove.
echo "==> recreating the local database"
ADMIN_URL="postgres://$(whoami)@127.0.0.1:5433/postgres"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'laanya' and pid <> pg_backend_pid()" \
  -c 'drop database if exists laanya' \
  -c 'create database laanya owner neondb_owner'

echo "==> restoring into local"
pg_restore --dbname="$LOCAL_URL" --no-owner --no-privileges --exit-on-error "$DUMP_FILE"

rm -f "$DUMP_FILE"
echo "==> done. Local now mirrors Neon '$BRANCH'."
