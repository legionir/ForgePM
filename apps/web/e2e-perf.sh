#!/usr/bin/env bash
# apps/web/e2e-perf.sh — the P-05 first-paint gate (PERFORMANCE_BUDGET.md) run
# through Playwright against the `npm run seed:perf` dataset. Kept separate from
# e2e.sh because that suite resets a brand-new install DB (setup-first chain),
# while P-05 needs the 500k-row seeded DB. Docker-less local path (B-001);
# CI adds the compose-backed equivalent.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$WEB_DIR/../.." && pwd)"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-4200}"
PERF_DB="${PERF_DB:-forgepm_perf}"
PGURI="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
API_URL="${PGURI%/*}/$PERF_DB"
SECRET="$(openssl rand -base64 32)"

cleanup() { [[ -n "${API_PID:-}" ]] && kill -9 "$API_PID" 2>/dev/null || true; [[ -n "${WEB_PID:-}" ]] && kill -9 "$WEB_PID" 2>/dev/null || true; }
trap cleanup EXIT
pkill -9 -f 'apps/api/dist/main.js' 2>/dev/null || true
pkill -9 -f 'ng serve' 2>/dev/null || true
sleep 1

# Ensure the perf dataset exists (seed is idempotent).
( cd "$ROOT" && DATABASE_URL="$API_URL" npm run seed:perf >/dev/null )
BIG_PROJECT="$(psql "$API_URL" -tAc "SELECT project_id FROM work_items GROUP BY project_id ORDER BY count(*) DESC LIMIT 1")"
echo "e2e-perf: big project $BIG_PROJECT"

( cd "$ROOT" && npm run build -w @forgepm/shared -w @forgepm/core -w @forgepm/api >/dev/null )
echo "e2e-perf: api on :$API_PORT (perf DB)"
( cd "$ROOT" && DATABASE_URL="$API_URL" REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  FORGEPM_SECRET_KEY="$SECRET" PORT="$API_PORT" HOST=127.0.0.1 LOG_LEVEL=fatal \
  node apps/api/dist/main.js > /tmp/forgepm-e2e-perf-api.log 2>&1 ) & API_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$API_PORT/health/live" >/dev/null && break; [[ $i -eq 30 ]] && { echo "api down:"; cat /tmp/forgepm-e2e-perf-api.log; exit 1; }; sleep 1; done

echo "e2e-perf: Angular dev-server on :$WEB_PORT"
( cd "$WEB_DIR" && npx ng serve --port "$WEB_PORT" --host 127.0.0.1 --proxy-config proxy.e2e.json > /tmp/forgepm-e2e-perf-web.log 2>&1 ) & WEB_PID=$!
for i in $(seq 1 90); do curl -sf "http://127.0.0.1:$WEB_PORT/" >/dev/null && break; [[ $i -eq 90 ]] && { echo "web down:"; cat /tmp/forgepm-e2e-perf-web.log; exit 1; }; sleep 1; done
for path in /login /work-items; do curl -sf "http://127.0.0.1:$WEB_PORT$path" -o /dev/null || true; done

echo "e2e-perf: Playwright P-05"
( cd "$WEB_DIR" && PANEL_URL="http://127.0.0.1:$WEB_PORT" PERF_PROJECT_ID="$BIG_PROJECT" \
  npx playwright test --project=chromium e2e/perf.spec.ts )
