import { sql } from 'kysely';
import { getEffective } from './settings';
import { settingDefault } from './settings-registry';
import type { DbLike } from './db/unitOfWork';

/**
 * Retention job (plan §14 "مقیاس‌پذیری"): nightly pruning of the fast-growing
 * append-only tables — audit_events, mcp_tool_calls, ai_calls and
 * webhook_deliveries — according to their `retention.*_days` settings.
 *
 * Semantics:
 *  - The effective value per key is resolved once (system-level scope); an
 *    organization-level override for a key is applied to that org's rows only
 *    (tenancy per §3b-2 — one org's aggressive retention must never delete
 *    another org's rows).
 *  - Rows with created_at older than the cutoff are hard-deleted; newer rows
 *    are left untouched. Deletion is bounded per statement (LIMIT-style via
 *    ctid subselect) so a huge backlog doesn't lock the table for minutes.
 */
export const RETENTION_KEYS = [
  'retention.audit_days',
  'retention.mcp_call_days',
  'retention.ai_call_days',
  'retention.webhook_days',
] as const;

export type RetentionKey = (typeof RETENTION_KEYS)[number];

const KEY_TABLE: Record<RetentionKey, { table: string; column: string }> = {
  'retention.audit_days': { table: 'audit_events', column: 'created_at' },
  'retention.mcp_call_days': { table: 'mcp_tool_calls', column: 'created_at' },
  'retention.ai_call_days': { table: 'ai_calls', column: 'created_at' },
  'retention.webhook_days': { table: 'webhook_deliveries', column: 'received_at' },
};

export type RetentionResult = Partial<Record<string, number>>;

async function effectiveDays(db: DbLike, key: RetentionKey, orgId: string | null): Promise<number> {
  const found = orgId ? await getEffective(db, key, orgId, null) : await getEffective(db, key, null, null);
  if (found && typeof found.value === 'number') return found.value;
  return settingDefault(key) as number;
}

async function deleteOlder(
  db: DbLike,
  table: string,
  column: string,
  days: number,
  orgId: string,
): Promise<number> {
  const res = await sql`
    DELETE FROM ${sql.table(table)}
    WHERE id IN (
      SELECT id FROM ${sql.table(table)}
      WHERE organization_id = ${orgId}
        AND ${sql.ref(column)} < now() - (${days}::double precision * interval '1 day')
      LIMIT 50000
    )
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/**
 * One retention pass. For every organization we resolve its OWN effective
 * retention days (organization override -> system override -> registry default)
 * and prune only that org's rows (tenancy per §3b-2: one org's aggressive
 * retention must never touch another org's data). Returns deleted counts per
 * table, aggregated across orgs.
 *
 * `onDeleted` (optional) fires per (org, table) whenever rows are removed so
 * the caller can emit an audit_event (Definition of Done: every mutation is
 * audited). The core stays storage-only; the worker wires recordAudit.
 */
export async function runRetention(
  db: DbLike,
  onDeleted?: (orgId: string, table: string, count: number) => Promise<void>,
): Promise<RetentionResult> {
  const out: RetentionResult = {};
  const orgs = await db.selectFrom('organizations').select('id').execute();
  for (const { id: orgId } of orgs) {
    for (const key of RETENTION_KEYS) {
      const { table, column } = KEY_TABLE[key];
      const days = await effectiveDays(db, key, orgId);
      const deleted = await deleteOlder(db, table, column, days, orgId);
      if (deleted > 0 && onDeleted) await onDeleted(orgId, table, deleted);
      out[table] = (out[table] ?? 0) + deleted;
    }
  }
  return out;
}
