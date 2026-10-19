import type { Migration } from 'kysely';
import { MIGRATION_0001_INFRA } from './0001_infra.migration';
import { MIGRATION_0002_CORE } from './0002_core.migration';
import { MIGRATION_0003_DOMAIN } from './0003_domain.migration';
import { MIGRATION_0005_PLANNER } from './0005_planner.migration';
import { MIGRATION_0006_MCP } from './0006_mcp.migration';
import { MIGRATION_0007_GITHUB } from './0007_github.migration';
import { MIGRATION_0008_REVIEWS } from './0008_reviews.migration';
import { MIGRATION_0009_PERF } from './0009_perf.migration';
import { MIGRATION_0010_EXEC } from './0010_exec.migration';
import { MIGRATION_0011_EXEC_JOURNAL_RECONCILE } from './0011_exec_journal_reconcile.migration';
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
  { name: '0006_mcp', sql: MIGRATION_0006_MCP },
  { name: '0007_github', sql: MIGRATION_0007_GITHUB },
  { name: '0008_reviews', sql: MIGRATION_0008_REVIEWS },
  { name: '0009_perf', sql: MIGRATION_0009_PERF },
  { name: '0010_exec', sql: MIGRATION_0010_EXEC },
  { name: '0011_exec_journal_reconcile', sql: MIGRATION_0011_EXEC_JOURNAL_RECONCILE },
];

export const migrations: Record<string, Migration> = migrationsFromSql(entries);
