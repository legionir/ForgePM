import type { Migration } from 'kysely';
import { MIGRATION_0001_INFRA } from './0001_infra.migration';
import { MIGRATION_0002_CORE } from './0002_core.migration';
import { MIGRATION_0003_DOMAIN } from './0003_domain.migration';
import { MIGRATION_0005_PLANNER } from './0005_planner.migration';
import { migrationsFromSql } from '../client';

/**
 * Ordered migration registry. Append future phases' SQL here as
 * `0002_*.migration.ts` … `NNNN_*.migration.ts` (forward-only, plan §3b-4).
 */
const entries = [
  { name: '0001_infra', sql: MIGRATION_0001_INFRA },
  { name: '0002_core', sql: MIGRATION_0002_CORE },
  { name: '0003_domain', sql: MIGRATION_0003_DOMAIN },
  { name: '0005_planner', sql: MIGRATION_0005_PLANNER },
];

export const migrations: Record<string, Migration> = migrationsFromSql(entries);
