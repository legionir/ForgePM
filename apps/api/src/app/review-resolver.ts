import { dbReviewProvider, type AiProvider, type Db } from '@forgepm/core';
import type { GenerateRequest } from '@forgepm/core';
import { StubProvider } from '@forgepm/core';

/**
 * Review provider resolver for the api process (plan §10): a fixture map
 * (keyed by runId, orgId or "*" for the default; value = findings array or a
 * function of the stage request) installs a deterministic StubProvider so the
 * offline suite drives every acceptance case without any network. Otherwise
 * the org's first enabled ai_providers row is used — one core code path
 * shared with the worker. Tests that build their own app can also override
 * the core slot directly (setReviewProviderResolver), the same injection
 * style as the github fake client.
 */
export type ReviewFixture = unknown[] | ((req: GenerateRequest) => unknown);

export function makeReviewProviderResolver(
  db: Db,
  fixtures: Map<string, ReviewFixture> = new Map(),
): (orgId: string, runId?: string) => Promise<AiProvider | null> {
  return async (orgId: string, runId?: string) => {
    const fixture = (runId ? fixtures.get(runId) : undefined) ?? fixtures.get(orgId) ?? fixtures.get('*');
    if (fixture) {
      const producer = typeof fixture === 'function' ? fixture : () => ({ findings: fixture });
      return new StubProvider(producer);
    }
    return dbReviewProvider(db, orgId);
  };
}
