#!/usr/bin/env bash
# scripts/backup.sh — pg_dump (custom format, compressed) + storage tarball,
# keeps the last BACKUP_KEEP copies (plan §14, docs/RUNBOOK.md).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
KEEP="${BACKUP_KEEP:-7}"
OUT_DIR="${BACKUP_DIR:-./backups}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$OUT_DIR/forgepm-$TS.dump"

pg_dump --format=custom --compress=6 --dbname="$DATABASE_URL" --file="$DUMP"
if [ -d "$STORAGE_DIR" ]; then
  tar czf "$OUT_DIR/forgepm-storage-$TS.tar.gz" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
fi

# keep only the newest N of each kind
ls -1t "$OUT_DIR"/forgepm-*.dump 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$OUT_DIR"/forgepm-storage-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "backup: wrote $DUMP"
