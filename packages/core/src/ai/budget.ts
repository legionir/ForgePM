import { sql } from 'kysely';
import type { DbLike } from '../db/unitOfWork';

/**
 * Sum AI tokens used by an organization in the last 24h (plan §7 daily budget).
 * Kept in core so feature modules never touch a raw connection.
 */
export async function tokensUsedToday(db: DbLike, orgId: string): Promise<number> {
  const r = await sql<{ total: number | string | null }>`
    SELECT COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)), 0) AS total
    FROM ai_calls
    WHERE organization_id = ${orgId}
      AND created_at >= now() - interval '24 hours'
  `.execute(db);
  return Number(r.rows[0]?.total ?? 0);
}

/**
 * Remaining tokens for a configured budget. A limit of zero is the existing
 * settings convention for "unlimited"; callers still pass provider output
 * limits when their SDK has a conservative default.
 */
export function remainingTokenBudget(limit: number, used: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.floor(limit) - Math.max(0, Math.floor(used)));
}

/** True when the estimated input can fit before any provider request is sent. */
export function fitsTokenBudget(limit: number, used: number, estimatedInput: number): boolean {
  const remaining = remainingTokenBudget(limit, used);
  return remaining === null || Math.max(0, Math.ceil(estimatedInput)) < remaining;
}
