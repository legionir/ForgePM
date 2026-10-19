import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModuleRegistry,
  StubProvider,
  evaluateGate,
  loadGateContext,
  newId,
  setExecReviewSource,
  setReviewProviderResolver,
  upsertSetting,
  type Db,
  type GenerateRequest,
} from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const SOURCE_PATH = 'packages/core/src/exec/review-fixture.ts';
const BASE_PATCH = `@@ -1 +1,2 @@\n-old\n+// TODO: later: implement the required behavior\n+export const reviewWitness = 1;`;
const GOOD = 'POST /api/v1/items returns 201 for a valid item; test:review-task';

let h: Harness;
let db: Db;
let orgId: string;
let projectId: string;
let userId: string;
let deps: McpDeps;
let seq = 0;
let currentTreeHash = 'a'.repeat(64);

const actor = (over: Partial<Actor> = {}): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'lead',
    scopes: ['read', 'write', 'review'],
    projectIds: [projectId],
    requestId: `req-pe7-${(seq += 1)}`,
    ...over,
  }) as Actor;

const call = (name: string, args: Record<string, unknown>, who = actor()) =>
  callTool(deps, who, name, args, who.requestId);
const json = (result: Awaited<ReturnType<typeof call>>): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

function providerFor(producer: (request: GenerateRequest) => unknown): StubProvider {
  const provider = new StubProvider(producer, 'pe7-stub');
  setReviewProviderResolver(async () => provider);
  return provider;
}

async function createTask(title = 'adversarial review task'): Promise<Record<string, unknown>> {
  const result = json(await call('exec_task_start', {
    title,
    acceptance_criteria: [GOOD],
    allowed_paths: ['packages/core/src/exec/**'],
  }));
  await db.updateTable('exec_tasks')
    .set({ start_ref: 'test-baseline' })
    .where('id', '=', result.task_id as string)
    .execute();
  return result;
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe7-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  await upsertSetting(db, 'project', projectId, 'exec.allowed_repo_roots', ['packages']);
  await db.insertInto('ai_providers').values({
    id: newId(),
    organization_id: orgId,
    name: 'pe7-test-provider',
    kind: 'fake',
    base_url: null,
    encrypted_key: null,
    key_last4: null,
    default_model: 'pe7-stub',
  }).execute();
  setExecReviewSource({
    snapshot: async () => ({
      files: [{ path: SOURCE_PATH, change: 'M', patch: BASE_PATCH }],
      tree_hash: currentTreeHash,
    }),
    treeHash: async () => currentTreeHash,
  });
  const registry = new ModuleRegistry();
  registry.register({ name: 'exec' });
  registry.invalidate();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();
});

afterAll(async () => {
  setReviewProviderResolver(async () => null);
  setExecReviewSource(null);
  await h?.cleanup();
});

describe('PE-7 adversarial review orchestration', () => {
  it('E.1/E.2/E.7 logs only the five isolated sections and records real blocking findings', async () => {
    const task = await createTask();
    const beforeItem = await db.selectFrom('work_items').select(['state_id', 'title', 'updated_at']).where('id', '=', task.work_item_id as string).executeTakeFirstOrThrow();
    const provider = providerFor((request) => {
      if (request.system.includes('exec:requirements_coverage')) {
        return {
          verdict: 'fail',
          checked: ['acceptance criterion C-001'],
          findings: [{
            title: 'acceptance behavior is not implemented',
            type: 'incomplete_requirement',
            blocks_completion: true,
            evidence_ref: `file:${SOURCE_PATH}:1`,
            why: 'the required behavior has no implementation in the changed source',
          }],
        };
      }
      return { verdict: 'pass', checked: [request.system.split('.')[0] ?? 'review stage'], findings: [] };
    });

    const result = json(await call('review_task', { task_ref: task.code as string }));
    expect(result).toMatchObject({ status: 'completed', verdict: 'fail', round: 1, findings: 1 });
    expect(provider.calls).toBe(6);
    expect(provider.requests.every((request) => !`${request.system}\n${request.messages.map((m) => m.content).join('\n')}`.includes('agent_history'))).toBe(true);
    expect(provider.requests.every((request) => !('tools' in request))).toBe(true);
    expect(provider.requests.at(0)?.messages[0]?.content).toContain('TODO: later');

    const review = await db.selectFrom('exec_reviews').selectAll().where('task_id', '=', task.task_id as string).executeTakeFirstOrThrow();
    expect(review.input_meta).toMatchObject({ input_sections: ['user_request', 'criteria', 'diff', 'ledger_status', 'exit_report'] });
    const openItem = await db.selectFrom('exec_open_items').selectAll().where('task_id', '=', task.task_id as string).executeTakeFirstOrThrow();
    expect(openItem).toMatchObject({ type: 'incomplete_requirement', source: 'reviewer', blocks_completion: true });
    const run = await db.selectFrom('review_runs').select(['status', 'id']).where('id', '=', review.review_run_id as string).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(await db.selectFrom('review_findings').select('id').where('run_id', '=', run.id).execute()).toHaveLength(1);
    const aiCalls = await db.selectFrom('ai_calls').select(['purpose', 'status']).where('organization_id', '=', orgId).where('purpose', '=', 'exec_review').execute();
    expect(aiCalls).toHaveLength(6);
    expect(aiCalls.every((entry) => entry.status === 'ok')).toBe(true);

    const gate = await loadGateContext(db, task.task_id as string);
    const gateResult = evaluateGate(gate.ctx);
    expect(gateResult.blocked_by.some((entry) => entry.rule === 7)).toBe(true);
    // The reviewer has no path that changes either the task or its work item.
    const unchanged = await db.selectFrom('work_items').select(['state_id', 'title', 'updated_at']).where('id', '=', task.work_item_id as string).executeTakeFirstOrThrow();
    expect(unchanged.title).toBe('adversarial review task');
    expect(unchanged.state_id).toBe(beforeItem.state_id);
    expect(unchanged.updated_at).toEqual(beforeItem.updated_at);
  });

  it('E.3 flags a deferred TODO as a blocking commitment with a real witness', async () => {
    const task = await createTask('TODO commitment review task');
    const provider = providerFor((request) => request.system.includes('exec:unrecorded_decisions')
      ? {
          verdict: 'fail',
          checked: ['deferred commitments'],
          findings: [{
            title: 'deferred TODO remains unfinished',
            type: 'commitment',
            blocks_completion: true,
            evidence_ref: `file:${SOURCE_PATH}:1`,
            why: 'the changed implementation explicitly leaves this commitment for later',
          }],
        }
      : { verdict: 'pass', checked: ['reviewed'], findings: [] });

    const result = json(await call('review_task', { task_ref: task.code as string }));
    expect(result.verdict).toBe('fail');
    expect(provider.requests.some((request) => request.messages[0]?.content.includes('TODO: later'))).toBe(true);
    const item = await db.selectFrom('exec_open_items').select(['type', 'source', 'blocks_completion']).where('task_id', '=', task.task_id as string).executeTakeFirstOrThrow();
    expect(item).toEqual({ type: 'commitment', source: 'reviewer', blocks_completion: true });
  });

  it('E.4 retries malformed output once and fails closed with a review_failed run', async () => {
    const task = await createTask('invalid review response task');
    const provider = providerFor(() => 'not valid JSON');
    const before = await db.selectFrom('ai_calls').select('id').where('organization_id', '=', orgId).where('purpose', '=', 'exec_review').execute();
    const beforeIds = new Set(before.map((entry) => entry.id));

    const result = json(await call('review_task', { task_ref: task.code as string }));
    expect(result.status).toBe('review_failed');
    expect(provider.calls).toBe(2);
    const review = await db.selectFrom('exec_reviews').selectAll().where('task_id', '=', task.task_id as string).executeTakeFirstOrThrow();
    expect(review.verdict).toBe('fail');
    const run = await db.selectFrom('review_runs').select('status').where('id', '=', review.review_run_id as string).executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    const after = await db.selectFrom('ai_calls').select(['id', 'status', 'tokens_in', 'tokens_out']).where('organization_id', '=', orgId).where('purpose', '=', 'exec_review').execute();
    const newCalls = after.filter((entry) => !beforeIds.has(entry.id));
    expect(newCalls).toHaveLength(2);
    expect(newCalls.every((entry) => entry.status === 'error')).toBe(true);
  });

  it('E.5 invalidates the verdict if the worktree changes during or after review', async () => {
    const task = await createTask('stale worktree review task');
    currentTreeHash = 'b'.repeat(64);
    const original = currentTreeHash;
    providerFor((request) => {
      if (request.system.includes('exec:out_of_scope')) currentTreeHash = 'c'.repeat(64);
      return { verdict: 'pass', checked: ['reviewed'], findings: [] };
    });
    currentTreeHash = original;

    const result = json(await call('review_task', { task_ref: task.code as string }));
    expect(result.status).toBe('stale');
    expect(result.verdict).toBe('fail');
    const loaded = await loadGateContext(db, task.task_id as string);
    const gate = evaluateGate(loaded.ctx);
    expect(gate.blocked_by.some((entry) => entry.rule === 7 && entry.title.includes('stale'))).toBe(true);
  });

  it('E.6 caps the task at two rounds and creates a human arbitration blocker', async () => {
    const task = await createTask('two round arbitration task');
    const provider = providerFor((request) => request.system.includes('exec:requirements_coverage')
      ? {
          verdict: 'fail',
          checked: ['acceptance criterion'],
          findings: [{
            title: 'required behavior remains incomplete',
            type: 'bug',
            blocks_completion: true,
            evidence_ref: `file:${SOURCE_PATH}:1`,
            why: 'the requirement is still not fulfilled by the current implementation',
          }],
        }
      : { verdict: 'pass', checked: ['reviewed'], findings: [] });

    const first = json(await call('review_task', { task_ref: task.code as string }));
    const second = json(await call('review_task', { task_ref: task.code as string }));
    const callsAfterTwoRounds = provider.calls;
    const third = json(await call('review_task', { task_ref: task.code as string }));
    expect(first.round).toBe(1);
    expect(second.round).toBe(2);
    expect(third.status).toBe('human_arbitration_required');
    expect(provider.calls).toBe(callsAfterTwoRounds);
    expect(provider.calls).toBe(12);
    const arbitration = await db.selectFrom('exec_open_items').select(['title', 'type', 'blocks_completion', 'source', 'related_ref'])
      .where('task_id', '=', task.task_id as string)
      .where('title', '=', 'human arbitration required')
      .executeTakeFirstOrThrow();
    const latestReview = await db.selectFrom('exec_reviews').select('tree_hash')
      .where('task_id', '=', task.task_id as string)
      .where('round', '=', 2)
      .executeTakeFirstOrThrow();
    expect(arbitration).toEqual({
      title: 'human arbitration required',
      type: 'risk',
      blocks_completion: true,
      source: 'reviewer',
      related_ref: `review-arbitration:${task.code}:r2:${latestReview.tree_hash}`,
    });

    const blockers = await db.selectFrom('exec_open_items').select(['code', 'title'])
      .where('task_id', '=', task.task_id as string)
      .where('status', 'in', ['open', 'blocked', 'awaiting_human'])
      .execute();
    for (const item of blockers) {
      await call('ledger_resolve_item', {
        task_ref: task.code as string,
        item_ref: item.code,
        status: 'resolved',
        note: `Human arbitration reviewed and resolved: ${item.title}.`,
      });
    }
    const afterArbitration = await loadGateContext(db, task.task_id as string);
    const gate = evaluateGate(afterArbitration.ctx);
    expect(gate.blocked_by.some((entry) => entry.rule === 7)).toBe(false);
  });

  it('E.8 enforces exec.max_cost_tokens and logs a budget refusal without calling the provider', async () => {
    const task = await createTask('review token budget task');
    await upsertSetting(db, 'project', projectId, 'exec.max_cost_tokens', 10);
    const provider = providerFor(() => ({ verdict: 'pass', checked: ['reviewed'], findings: [] }));
    const before = await db.selectFrom('ai_calls').select('id').where('organization_id', '=', orgId).where('purpose', '=', 'exec_review').execute();
    const beforeIds = new Set(before.map((entry) => entry.id));

    const result = json(await call('review_task', { task_ref: task.code as string }));
    expect(result.status).toBe('review_failed');
    expect(provider.calls).toBe(0);
    const after = await db.selectFrom('ai_calls').select(['id', 'status', 'tokens_in', 'tokens_out']).where('organization_id', '=', orgId).where('purpose', '=', 'exec_review').execute();
    const newCalls = after.filter((entry) => !beforeIds.has(entry.id));
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]).toMatchObject({ status: 'error', tokens_in: 0, tokens_out: 0 });
    await upsertSetting(db, 'project', projectId, 'exec.max_cost_tokens', 0);
  });
});
