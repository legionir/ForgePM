# Runbook

## Start the stack with `forgepm`

Once, from the repository root: `npm run build && npm run build --prefix apps/web` and `npm link` (undo with
`npm unlink -g forgepm`). Afterwards `forgepm` in any terminal runs the **built** stack — API (`:3001`) and worker
from `dist/`, the panel's static build on `:4200` with `/api/`, `/health/` and `/mcp` proxied to the API — with no
build step and no file watchers. `forgepm --build` rebuilds everything first. `npm start` / `npm run dev` remain
the watch-mode developer stack (`--dev`). `FORGEPM_PANEL_PORT` overrides the panel port. It needs PostgreSQL
reachable at `DATABASE_URL`; Redis is optional (without it the worker runs degraded and webhook deliveries are not
processed).

## Backup & restore

- `scripts/backup.sh` — `pg_dump` (custom format, compressed) into
  `./backups/<timestamp>.dump` plus the storage dir; keeps the last
  `BACKUP_KEEP` copies (default 7).
- `scripts/restore.sh <dump>` — drops into an empty target DB only
  (refuses a non-empty one), restores, then runs `npm run schema:check`.
- Nightly CI test: backup → fresh DB → restore → row-count + checksum
  comparison of key tables.

## Key rotation (`FORGEPM_SECRET_KEY`)

1. Generate a new 32-byte base64 key.
2. `scripts/rotate-secret.ts --old <env:OLD> --new <env:NEW>` re-encrypts all
   `secrets`/`ai_providers.encrypted_key` rows (old `key_version` read path →
   new version), then roll env and restart. Rows carry `key_version` so
   mid-rotation reads never fail.

## CI baseline for execution tasks

- ForgePM does not run repository tests, builds, or scripts. To enable Rule 12, configure `exec.ci_log_endpoint` and `exec.ci_log_secret_name` at the system, organization or project scope; store the read-only CI token in the encrypted `secrets` store under that name and never paste it into task data or logs.
- The endpoint must be HTTPS and return a JSON envelope for the requested commit: `{ "sha": "<full commit SHA>", "run_id": "…", "job": "…", "provider": "…", "log": "<bounded test log>" }`. Put `{sha}` in the endpoint URL to substitute the measured SHA; otherwise ForgePM adds a `sha` query parameter. The endpoint must return named per-test result markers and a compatible summary, not totals alone.
- Redirects are rejected; timeout is 8 seconds and the entire response is capped at 1 MiB. The SSRF guard blocks private/reserved/link-local targets unless `network.allow_private_targets` is explicitly enabled. The raw log and token are not persisted or returned; the ledger stores parsed outcomes plus run/job/SHA and the log SHA-256.
- Call MCP `baseline_capture` for a task. It fetches only the server-measured start and current clean commit SHAs. A missing/unparseable/mismatched log returns `BASELINE_UNAVAILABLE` and Rule 12 blocks; only a human may use `POST /api/v1/exec/tasks/:taskId/baseline/waive`, with a reason and an approval/event trail. The waiver does not excuse red CI results or measured test weakening.
- If the service has no Git commit, task start attempts a bounded, two-pass server-side hash-only scope manifest. A successful manifest keeps scope measurable; if capture is unavailable or unstable, Rule 11 fails closed and only then can a human use the scope waiver. Baseline still requires a commit SHA and therefore needs CI evidence or an explicit human baseline waiver.
- Scope measurement can be waived only when the server cannot measure it, via human-only `POST /api/v1/exec/tasks/:taskId/scope/waive`; the API refuses waivers while measurement is available. Measured out-of-scope changes must be fixed or explicitly covered by a human scope expansion (`POST /api/v1/exec/scope/:taskId/expand`); a deletion still needs separate approval or restoration.

## Upgrade

1. `npm run schema:check` on the current DB (must pass).
2. Take a backup (above).
3. Deploy the new image; migrations run forward-only at boot and are
   idempotent; never edit a merged migration.
4. CI additionally verifies upgrade from `tests/schema-snapshots/<prev-tag>.sql`.

Rollback = restore the backup or ship a corrective migration; no down-migrations.

## Health & queues

- `GET /health/live` 200 while the process is up.
- `GET /health/ready` 503 when Postgres or Redis is unreachable.
- Panel → System Health flags: queue depth > 1,000, consecutive failed jobs,
  disk near full. Jobs page: retry failed, inspect `dead`.
- Workers are stateless: `docker compose up --scale worker=N`; heavy reviews
  run on the `forgepm.review` queue with configurable concurrency.

## Ops endpoints/vars quick ref

`API_DOCS_ENABLED`, `METRICS_ENABLED` (`/metrics` Prometheus), `WEB_ORIGIN`,
`BACKUP_KEEP`, `REPO_MOUNT_ROOT` (refactor `local` sources).
