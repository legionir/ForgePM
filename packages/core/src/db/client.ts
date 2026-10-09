import { Kysely, Migrator, PostgresDialect, sql, type Migration } from 'kysely';
import pg from 'pg';
import type { DB } from './types';

export { Kysely, type DB };

/**
 * Raw DB access is confined to infrastructure/ (plan §3b-2 ESLint rule).
 * Everything else goes through services/repositories.
 */
export function createDb(url: string): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Ordered, forward-only migrations from NNNN_slug SQL entries (plan §12).
 * Multi-statement scripts run on a single connection via raw SQL.
 */
export function migrationsFromSql(entries: Array<{ name: string; sql: string }>): Record<string, Migration> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const out: Record<string, Migration> = {};
  for (const e of sorted) {
    out[e.name] = {
      async up(db) {
        await sql.raw(e.sql).execute(db);
      },
    };
  }
  return out;
}

export function createMigrator(db: Kysely<DB>, migrations: Record<string, Migration>): Migrator {
  return new Migrator({ db, provider: { async getMigrations() { return migrations; } } });
}

/** Liveness/readiness probe: SELECT 1. Throws if the DB is unreachable. */
export async function pingDb(db: Kysely<DB>): Promise<void> {
  await sql`select 1`.execute(db);
}

/** Run all pending migrations; throws on first failure. */
export async function runMigrations(db: Kysely<DB>, migrations: Record<string, Migration>): Promise<void> {
  const migrator = createMigrator(db, migrations);
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') throw new Error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
}
