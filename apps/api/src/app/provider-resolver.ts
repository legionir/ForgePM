import { buildProvider, FakeProvider, type AiProvider } from '@forgepm/core';
import { decryptKey, listProviders } from '../modules/ai-providers/service';
import type { Db } from '@forgepm/core';
import type { PlanContent } from '@forgepm/shared';

/**
 * Default provider resolver: pick the org's first enabled ai_providers row and
 * build a live AiProvider. Returns null when none is configured, letting the
 * planner fall back to the manual flow (plan §7 acceptance: planner works with
 * no provider). `fixtures` is a test-only map (planId -> fixture responses)
 * that makes generation deterministic and fully offline.
 */
export function makeProviderResolver(
  db: Db,
  fixtures: Map<string, unknown[]> = new Map(),
): (orgId: string, planId?: string) => Promise<AiProvider | null> {
  return async (orgId: string, planId?: string) => {
    if (planId && fixtures.has(planId)) {
      return new FakeProvider({ model: 'fake-planner', responses: fixtures.get(planId)! });
    }
    const providers = await listProviders(db, orgId);
    const enabled = providers.find((p) => p.enabled);
    if (!enabled) return null;
    if (enabled.kind === 'fake') return new FakeProvider({ model: enabled.default_model ?? 'fake', responses: [] });
    const key = await decryptKey(db, enabled.id, orgId);
    return buildProvider(enabled.kind, {
      apiKey: key ?? '',
      baseUrl: enabled.base_url ?? undefined,
      model: enabled.default_model ?? 'default',
    });
  };
}

export type { PlanContent };
