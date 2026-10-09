import type { Migration } from 'kysely';
import { MIGRATION_0001_INFRA } from './0001_infra.migration';
import { migrationsFromSql } from '../client';

/**
 * Ordered migration registry. Append future phases' SQL here as
 * `0002_*.migration.ts` … `NNNN_*.migration.ts` (forward-only, plan §3b-4).
 */
const entries = [{ name: '0001_infra', sql: MIGRATION_0001_INFRA }];

export const migrations: Record<string, Migration> = migrationsFromSql(entries);
