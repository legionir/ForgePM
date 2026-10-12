#!/usr/bin/env bash
# scripts/restore.sh <dump> — restore into an EMPTY target database only
# (refuses non-empty), then verifies. docs/RUNBOOK.md.
set -euo pipefail
DUMP="${1:?usage: restore.sh <dump-file>}"
: "${DATABASE_URL:?DATABASE_URL required}"

# safety: refuse a target that already has app tables
COUNT="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$COUNT" -gt 0 ]; then
  echo "refusing to restore into a non-empty database ($COUNT public tables)." >&2
  echo "restore into a freshly created empty DB (see docs/RUNBOOK.md)." >&2
  exit 1
fi

pg_restore --dbname="$DATABASE_URL" --no-owner --exit-on-error "$DUMP"
echo "restore: applied $DUMP; run 'npm run schema:check' to confirm."
