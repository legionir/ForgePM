import { buildProvider } from '../ai/providers';
import { activeCipher } from '../crypto';
import type { AiProvider } from '../ai/provider';
import type { Db } from '../db/unitOfWork';
import { StubProvider } from './stub-provider';

/**
 * DB-backed review provider resolver (plan §7/§10): the org's first enabled
 * ai_providers row — identical selection to the planner. Lives in core so the
 * api and the worker resolve providers through ONE code path and never import
 * each other. `fake` rows produce an inert StubProvider (no findings).
 */
export async function dbReviewProvider(db: Db, orgId: string): Promise<AiProvider | null> {
  const row = await db
    .selectFrom('ai_providers')
    .select(['id', 'kind', 'base_url', 'default_model', 'encrypted_key'])
    .where('organization_id', '=', orgId)
    .where('enabled', '=', true)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  if (row.kind === 'fake') return new StubProvider(() => ({ findings: [] }), row.default_model ?? 'fake');
  const key = row.encrypted_key ? activeCipher().decrypt(row.encrypted_key as Buffer) : '';
  return buildProvider(row.kind, {
    apiKey: key,
    baseUrl: row.base_url ?? undefined,
    model: row.default_model ?? 'default',
  });
}
