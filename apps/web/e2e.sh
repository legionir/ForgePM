#!/usr/bin/env bash
# apps/web/e2e.sh — reproducible panel E2E gate (plan §11/§15).
# Resets a throwaway DB, boots the real API + Angular dev-server (which proxies
# /api to it), runs Playwright chromium, then tears everything down.
# Requires: a reachable Postgres (or boot one with `node apps/web/scripts/dev-postgres.mjs`),
# chromium (`npx playwright install`, or CHROMIUM_PATH to an extracted binary), and a Redis only
# if a spec touches the queue — the API's client just logs connect retries, so the flagship
# chain runs without one. No `psql` anywhere: the DB work goes through node/pg (D-048).
set -euo pipefail
WEB_DIR="$(cd "$(dirname "$0")" && pwd)"   # apps/web
ROOT="$(cd "$WEB_DIR/../.." && pwd)"        # repo root
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-4200}"
E2E_DB="${E2E_DB:-forgepm_e2e}"
RESET_DB="${RESET_DB:-1}"
PGURI="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
API_URL="${PGURI%/*}/$E2E_DB"
SECRET="$(openssl rand -base64 32)"

cleanup() { [[ -n "${API_PID:-}" ]] && kill -9 "$API_PID" 2>/dev/null || true; [[ -n "${WEB_PID:-}" ]] && kill -9 "$WEB_PID" 2>/dev/null || true; }
trap cleanup EXIT
# Free the ports in case an orphaned run left a dev-server/api behind (subshell
# PIDs aren't the actual listeners).
pkill -9 -f 'apps/api/dist/main.js' 2>/dev/null || true
pkill -9 -f 'ng serve' 2>/dev/null || true
sleep 1

if [[ "$RESET_DB" == "1" ]]; then
  echo "e2e: reset $E2E_DB"
  DATABASE_URL="$PGURI" E2E_DB="$E2E_DB" node "$WEB_DIR/scripts/e2e-db.mjs" >/dev/null
fi
echo "e2e: migrate + build api"
( cd "$ROOT" && DATABASE_URL="$API_URL" npm run migrate >/dev/null && npm run build -w @forgepm/shared -w @forgepm/core -w @forgepm/api >/dev/null )

echo "e2e: api on :$API_PORT"
( cd "$ROOT" && DATABASE_URL="$API_URL" REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  FORGEPM_SECRET_KEY="$SECRET" PORT="$API_PORT" HOST=127.0.0.1 LOG_LEVEL=warn \
  node apps/api/dist/main.js > /tmp/forgepm-e2e-api.log 2>&1 ) & API_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$API_PORT/health/live" >/dev/null && break; [[ $i -eq 30 ]] && { echo "api down:"; cat /tmp/forgepm-e2e-api.log; exit 1; }; sleep 1; done

echo "e2e: Angular dev-server on :$WEB_PORT (proxy -> :$API_PORT)"
( cd "$WEB_DIR" && npx ng serve --port "$WEB_PORT" --host 127.0.0.1 --proxy-config proxy.e2e.json > /tmp/forgepm-e2e-web.log 2>&1 ) & WEB_PID=$!
for i in $(seq 1 90); do curl -sf "http://127.0.0.1:$WEB_PORT/" >/dev/null && break; [[ $i -eq 90 ]] && { echo "web down:"; cat /tmp/forgepm-e2e-web.log; exit 1; }; sleep 1; done
# The Angular dev-server does on-demand JIT; warm every route once so the
# first real browser navigation is not billed the cold compile (slower CI).
for path in /auth /projects /api-keys /work-items /features /planner /ai-providers /approvals /reviews /github /mcp /settings /system /admin; do curl -sf "http://127.0.0.1:$WEB_PORT$path" -o /dev/null || true; done

echo "e2e: Playwright (per-file DB reset: every spec starts on a brand-new install)"
STATUS=0
# perf.spec.ts (P-05) needs the seeded dataset, not a clean install — it is
# driven by e2e-perf.sh instead. The flagship/chain specs use the setup-first
# flow and get a fresh DB each file.
for spec in $(cd "$WEB_DIR" && ls e2e/*.spec.ts | grep -v 'perf.spec.ts'); do
  if [[ "$RESET_DB" == "1" ]]; then
    ( cd "$WEB_DIR" && DATABASE_URL="$API_URL" node scripts/e2e-reset.mjs >/dev/null )
  fi
  ( cd "$WEB_DIR" && PANEL_URL="http://127.0.0.1:$WEB_PORT" npx playwright test --project=chromium "$spec" ) || STATUS=1
done
exit "$STATUS"
