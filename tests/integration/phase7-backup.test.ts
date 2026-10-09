import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { newId, createDb, runMigrations, migrations } from '@forgepm/core';

/**
 * Plan §14 acceptance: scripts/backup.sh -> empty DB -> scripts/restore.sh
 * returns identical data (row counts + a checksum over key tables). Real
 * pg_dump/pg_restore against the native Postgres (D-001/D-009) and the CI
 * postgres:16 service container.
 */
const BASE = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test';
const ADMIN = (() => {
  const u = new URL(BASE);
  u.pathname = '/postgres';
  return u.toString();
})();

const srcDb = newId().replace(/-/g, '').slice(0, 12);
const dstDb = newId().replace(/-/g, '').slice(0, 12);
const SRC_URL = (() => { const u = new URL(BASE); u.pathname = `/bk_src_${srcDb}`; return u.toString(); })();
const DST_URL = (() => { const u = new URL(BASE); u.pathname = `/bk_dst_${dstDb}`; return u.toString(); })();
let tmp: string;

function psql(url: string, q: string): string {
  return execSync(`psql ${JSON.stringify(url)} -tAc ${JSON.stringify(q)}`).toString().trim();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'forgepm-backup-'));
  execSync(`psql ${JSON.stringify(ADMIN)} -c ${JSON.stringify(`CREATE DATABASE bk_src_${srcDb}`)}`);
  execSync(`psql ${JSON.stringify(ADMIN)} -c ${JSON.stringify(`CREATE DATABASE bk_dst_${dstDb}`)}`);

  // migrate the source and insert 200 audit rows + one org
  const db = createDb(SRC_URL);
  try {
    await runMigrations(db, migrations);
    const orgId = newId();
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'BK', 'bk-src')`.execute(db);
    for (let i = 0; i < 200; i++) {
      const action = `act${i}`; // bind as a value, not inside a string literal
      await sql`
        INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, resource_type, resource_id)
        VALUES (${newId()}, ${orgId}, 'system', ${orgId}, ${action}, 'res', ${orgId})
      `.execute(db);
    }
  } finally {
    await db.destroy();
  }
});

afterAll(() => {
  try { execSync(`psql ${JSON.stringify(ADMIN)} -c ${JSON.stringify(`DROP DATABASE IF EXISTS bk_src_${srcDb}`)}`); } catch { /* ignore */ }
  try { execSync(`psql ${JSON.stringify(ADMIN)} -c ${JSON.stringify(`DROP DATABASE IF EXISTS bk_dst_${dstDb}`)}`); } catch { /* ignore */ }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('backup/restore round-trip (plan §14)', () => {
  it('restores an identical dataset into an empty DB', () => {
    const dump = join(tmp, 'dump');
    execSync(`DATABASE_URL=${JSON.stringify(SRC_URL)} BACKUP_DIR=${JSON.stringify(tmp)} BACKUP_KEEP=1 bash scripts/backup.sh`, { stdio: 'pipe' });
    // backup.sh writes forgepm-<ts>.dump — find it
    const files = execSync(`ls ${JSON.stringify(tmp)}/*.dump`).toString().trim().split('\n');
    expect(files.length).toBeGreaterThanOrEqual(1);
    execSync(`mv ${JSON.stringify(files[0])} ${JSON.stringify(dump)}`, { stdio: 'pipe' });

    execSync(`DATABASE_URL=${JSON.stringify(DST_URL)} bash scripts/restore.sh ${JSON.stringify(dump)}`, { stdio: 'pipe' });

    const srcAudit = Number(psql(SRC_URL, 'SELECT count(*) FROM audit_events'));
    const dstAudit = Number(psql(DST_URL, 'SELECT count(*) FROM audit_events'));
    expect(dstAudit).toBe(srcAudit);
    expect(dstAudit).toBe(200);

    // checksum: identical md5 over ordered (id, action) of audit_events
    const sum = (u: string) =>
      psql(u, "SELECT md5(string_agg(id::text || action, ',' order by created_at, id)) FROM audit_events");
    expect(sum(DST_URL)).toBe(sum(SRC_URL));
  });

  it('restore.sh refuses a non-empty target database', () => {
    const dump = join(tmp, 'dump2');
    execSync(`mv ${JSON.stringify(join(tmp, 'dump'))} ${JSON.stringify(dump)} 2>/dev/null || cp ${JSON.stringify(join(tmp, 'dump'))} ${JSON.stringify(dump)}`, { stdio: 'pipe' });
    let threw = false;
    try {
      execSync(`DATABASE_URL=${JSON.stringify(DST_URL)} bash scripts/restore.sh ${JSON.stringify(dump)}`, { stdio: 'pipe' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
