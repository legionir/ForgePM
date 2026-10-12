# Runbook

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
