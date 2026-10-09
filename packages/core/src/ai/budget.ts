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
