#!/usr/bin/env bash
#
# Prove local matches the Neon branch it was synced from — not "close enough",
# byte-identical schema and matching row counts per table.
#
# Usage:  scripts/dev/verify-local-sync.sh [branch]      # defaults to dev
set -euo pipefail

BRANCH="${1:-dev}"
PROJECT_ID="long-leaf-66968398"
ORG_ID="org-still-sound-69451390"
LOCAL_URL="postgres://neondb_owner:tinytales_local_dev@127.0.0.1:5433/tinytales"

PG_BIN="$(brew --prefix postgresql@17)/bin"
export PATH="$PG_BIN:$PATH"

NEON_URL="$(npx --yes neonctl connection-string "$BRANCH" \
  --project-id "$PROJECT_ID" --org-id "$ORG_ID" \
  --database-name tinytales --role-name neondb_owner)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Dump to FILES and check each exit code before diffing, rather than diffing two
# process substitutions directly. A `diff <(cmd) <(cmd)` swallows the exit code
# of both commands, so a Neon dump that failed — and Neon's `.c-2.` hostnames do
# intermittently fail DNS resolution — produces an EMPTY left side. The diff
# then reports every line of the local schema as an addition, which reads
# exactly like a catastrophic mismatch and is in fact a network blip. Verifying
# is the one job here; a check that cries wolf is worse than no check.
run_dump() {
  local url="$1" out="$2" label="$3"
  if ! pg_dump "$url" --schema-only --no-owner --no-privileges >"$out" 2>"$out.err"; then
    echo "    could not dump $label:" >&2
    sed 's/^/      /' "$out.err" >&2
    exit 2
  fi
}

run_query() {
  local url="$1" out="$2" label="$3"
  if ! psql "$url" -tA -F'|' -v ON_ERROR_STOP=1 -c "$COUNT_QUERY" >"$out" 2>"$out.err"; then
    echo "    could not read row counts from $label:" >&2
    sed 's/^/      /' "$out.err" >&2
    exit 2
  fi
}

echo "==> schema diff (structure only — owners/privileges excluded, they differ by design)"
run_dump "$NEON_URL"  "$WORK/neon.sql"  "Neon '$BRANCH'"
run_dump "$LOCAL_URL" "$WORK/local.sql" "local"

# Strip the two things that differ for reasons that are not schema:
#
#   \restrict / \unrestrict — a per-dump random token (pg_dump 17.6+
#   psql-injection hardening). Differs on every invocation, including two dumps
#   of the SAME database.
#
#   "Dumped from database version" — carries the BUILD string, not just the
#   version: Neon reports `17.11 (32e7196)` and Postgres.app reports
#   `17.11 (Postgres.app)`. Same Postgres, different packager. Comparing it
#   would leave this check permanently red over a comment.
#
# Everything else is compared verbatim, deliberately — including column order,
# defaults, constraints and indexes.
strip_tokens() {
  grep -vE '^\\(un)?restrict |^-- Dumped (from database|by pg_dump) version ' "$1"
}

if diff <(strip_tokens "$WORK/neon.sql") <(strip_tokens "$WORK/local.sql"); then
  echo "    schema: IDENTICAL"
else
  echo "    schema: MISMATCH — see diff above" >&2
  exit 1
fi

echo "==> row counts per table"
COUNT_QUERY="select table_name, (xpath('/row/c/text()',
    query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n
  from information_schema.tables
  where table_schema in ('public','ops') and table_type = 'BASE TABLE'
  order by table_name"

run_query "$NEON_URL"  "$WORK/neon.counts"  "Neon '$BRANCH'"
run_query "$LOCAL_URL" "$WORK/local.counts" "local"

if diff "$WORK/neon.counts" "$WORK/local.counts"; then
  echo "    row counts: IDENTICAL"
else
  echo "    row counts: MISMATCH — see diff above" >&2
  exit 1
fi

echo "==> local mirrors Neon '$BRANCH' exactly."
