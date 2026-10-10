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
    if (enabled.kind === 'fake') return new FakeProvider({ model: enabled.default_model ?? 'fake', responses: fakePlanFor });
    const key = await decryptKey(db, enabled.id, orgId);
    return buildProvider(enabled.kind, {
      apiKey: key ?? '',
      baseUrl: enabled.base_url ?? undefined,
      model: enabled.default_model ?? 'default',
    });
  };
}

export type { PlanContent };

/**
 * Deterministic offline plan producer for an enabled `fake` ai_provider row
 * (plan §7 "fake (قطعی، برای تست‌ها)"; §11 E2E "plan با Provider فیک").
 * Mirrors the fixture shape the integration suite injects: one milestone, one
 * feature with a single acceptance criterion, two tasks with a dependency —
 * so a real server booted with a fake provider generates a validatable plan
 * without any network. Never used when a planId-specific fixture exists.
 */
function fakePlanFor(req: { messages: { content: string }[] }): unknown {
  const goal = (req.messages[req.messages.length - 1]?.content ?? 'fake plan').split('\n')[0].slice(0, 80);
  return {
    milestones: [
      {
        temp_id: 'm1',
        name: goal || 'Fake milestone',
        features: [
          {
            temp_id: 'f1',
            key: 'FAKE',
            title: goal || 'Fake feature',
            acceptance_criteria: [{ text: 'fake provider produced a plan', done: false }],
            work_items: [
              { temp_id: 'w1', title: 'fake: implement', type: 'task', priority: 'medium', depends_on: [], acceptance_criteria: [] },
              { temp_id: 'w2', title: 'fake: verify', type: 'task', priority: 'medium', depends_on: ['w1'], acceptance_criteria: [] },
            ],
          },
        ],
      },
    ],
    features: [],
    work_items: [],
    open_questions: [],
  };
}
