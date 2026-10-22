import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ModuleRegistry, newId, upsertSetting, type Db } from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * An agent with a ledger-only key used to create every work item as a plain Backlog task with no priority,
 * feature or milestone. These tests pin the new inputs and the catalog tools through the real dispatch path.
 */

let h: Harness;
let db: Db;
let orgId: string;
let userId: string;
let projectId: string;
let deps: McpDeps;
let seq = 0;

const CRIT = 'the tool must store the field on the work item; test:exec-work-item-fields.test.ts';

const actor = (over: Partial<Actor> = {}): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['ledger:read', 'ledger:write'],
    projectIds: [projectId],
    requestId: `req-wif-${(seq += 1)}`,
    ...over,
  }) as unknown as Actor;

const call = (name: string, args: Record<string, unknown>, who = actor()) => callTool(deps, who, name, args, who.requestId);
const text = (r: Awaited<ReturnType<typeof call>>): string => r.content.map((c) => c.text).join('\n');
const body = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> => JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

async function workItem(taskCode: string): Promise<Record<string, unknown>> {
  const r = await sql<Record<string, unknown>>`
    SELECT w.type, w.priority, w.feature_id::text AS feature_id, w.milestone_id::text AS milestone_id, s.name AS state
    FROM exec_tasks t JOIN work_items w ON w.id = t.work_item_id JOIN workflow_states s ON s.id = w.state_id
    WHERE t.project_id = ${projectId}::uuid AND t.code = ${taskCode}
  `.execute(db as never);
  return r.rows[0] ?? {};
}

let featureId = '';
let milestoneId = '';

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, { email: `wif-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass', projectKey: 'WIF' });
  orgId = seeded.organizationId;
  userId = seeded.userId;
  projectId = seeded.projectId;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  const registry = new ModuleRegistry();
  registry.register({ name: 'exec' });
  registry.invalidate();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();
});

afterAll(async () => {
  await h?.cleanup();
});

describe('catalog tools', () => {
  it('catalog tools: feature and milestone are created and listed with the ledger scopes, audited and duplicate-safe', async () => {
    const m = await call('ledger_milestone_create', { name: 'v1.5', target_date: '2026-12-31' });
    expect(m.isError, text(m)).toBe(false);
    milestoneId = body(m).id as string;
    const f = await call('ledger_feature_create', { key: 'ZFIVE', title: 'Green build', milestone_ref: 'V1.5', acceptance_criteria: ['build passes'] });
    expect(f.isError, text(f)).toBe(false);
    featureId = body(f).id as string;
    expect(body(f).milestone_id).toBe(milestoneId);

    const features = body(await call('ledger_features', {}, actor({ scopes: ['ledger:read'] })));
    expect(features.items).toEqual([{ id: featureId, key: 'ZFIVE', title: 'Green build', lifecycle_status: 'proposed', milestone_id: milestoneId }]);
    await sql`INSERT INTO milestones (id, organization_id, project_id, name, status) VALUES (${newId()}::uuid, ${orgId}::uuid, ${projectId}::uuid, 'old one', 'closed')`.execute(db as never);
    const open = body(await call('ledger_milestones', { include_closed: false }, actor({ scopes: ['ledger:read'] })));
    expect((open.items as { name: string }[]).map((x) => x.name)).toEqual(['v1.5']);
    const all = body(await call('ledger_milestones', {}));
    expect((all.items as { name: string }[]).map((x) => x.name).sort()).toEqual(['old one', 'v1.5']);

    const audits = await sql<{ action: string }>`SELECT action FROM audit_events WHERE action IN ('feature.create','milestone.create') AND organization_id = ${orgId}::uuid`.execute(db as never);
    expect(audits.rows.map((a) => a.action).sort()).toEqual(['feature.create', 'milestone.create']);

    const dupFeature = await call('ledger_feature_create', { key: 'zfive', title: 'again' });
    expect(dupFeature.isError).toBe(true);
    expect(text(dupFeature)).toContain('CONFLICT');
    const dupMilestone = await call('ledger_milestone_create', { name: 'V1.5' });
    expect(text(dupMilestone)).toContain('CONFLICT');

    const readOnly = await call('ledger_feature_create', { key: 'RO', title: 'read only key' }, actor({ scopes: ['ledger:read'] }));
    expect(readOnly.isError).toBe(true);
    expect(text(readOnly)).toContain('FORBIDDEN_SCOPE');
  });
});

describe('exec_task_start and task_split fields', () => {
  it('task start stores fields and keeps defaults: type, priority, feature and milestone land on the work item', async () => {
    const withFields = await call('exec_task_start', {
      title: 'task with every field',
      acceptance_criteria: [CRIT],
      allowed_paths: ['apps/**'],
      type: 'improvement',
      priority: 'high',
      feature_ref: 'zfive',
      milestone_ref: 'V1.5',
    });
    expect(withFields.isError, text(withFields)).toBe(false);
    expect(await workItem(body(withFields).code as string)).toEqual({ type: 'improvement', priority: 'high', feature_id: featureId, milestone_id: milestoneId, state: 'Backlog' });

    const plain = await call('exec_task_start', { title: 'task with defaults only', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'] });
    expect(plain.isError, text(plain)).toBe(false);
    expect(await workItem(body(plain).code as string)).toEqual({ type: 'task', priority: 'none', feature_id: null, milestone_id: null, state: 'Backlog' });
  });

  it('split children carry fields: each child work item gets its own type, priority and links', async () => {
    const parent = await call('exec_task_start', { title: 'parent for the split', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'] });
    const split = await call('task_split', {
      parent_ref: body(parent).code,
      children: [
        { key: 'a', title: 'first child with fields', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], type: 'bug', priority: 'urgent', feature_ref: 'ZFIVE', milestone_ref: milestoneId },
        { key: 'b', title: 'second child plain', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'] },
      ],
    });
    expect(split.isError, text(split)).toBe(false);
    const kids = body(split).children as { key: string; code: string }[];
    expect(await workItem(kids.find((k) => k.key === 'a')!.code)).toEqual({ type: 'bug', priority: 'urgent', feature_id: featureId, milestone_id: milestoneId, state: 'Backlog' });
    expect(await workItem(kids.find((k) => k.key === 'b')!.code)).toEqual({ type: 'task', priority: 'none', feature_id: null, milestone_id: null, state: 'Backlog' });
  });

  it('unknown refs list choices: a miss names the features or milestones that exist and an ambiguous name lists the matches', async () => {
    const noFeature = await call('exec_task_start', { title: 'task with a wrong feature', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], feature_ref: 'nope' });
    expect(noFeature.isError).toBe(true);
    expect(text(noFeature)).toContain('NOT_FOUND');
    expect(text(noFeature)).toContain('ZFIVE (Green build)');

    const noMilestone = await call('exec_task_start', { title: 'task with a wrong milestone', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], milestone_ref: 'v9' });
    expect(text(noMilestone)).toContain('NOT_FOUND');
    expect(text(noMilestone)).toContain('v1.5');

    const a = newId();
    const b = newId();
    for (const id of [a, b]) {
      await sql`INSERT INTO milestones (id, organization_id, project_id, name, status) VALUES (${id}::uuid, ${orgId}::uuid, ${projectId}::uuid, 'Twin', 'open')`.execute(db as never);
    }
    const ambiguous = await call('exec_task_start', { title: 'task with an ambiguous milestone', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], milestone_ref: 'twin' });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain('VALIDATION_ERROR');
    expect(text(ambiguous)).toContain(a);
    expect(text(ambiguous)).toContain(b);
  });

  it('gate sees real priority: an agent creating an urgent task needs approval while a plain one does not', async () => {
    await upsertSetting(db, 'system', null, 'approval_policy', 'auto_low_risk');
    const agent = actor({ type: 'agent' as never });
    const plain = await call('exec_task_start', { title: 'agent task, no priority', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'] }, agent);
    expect(plain.isError, text(plain)).toBe(false);
    expect(body(plain).pending).toBeUndefined();

    const urgent = await call('exec_task_start', { title: 'agent task, urgent', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], priority: 'urgent' }, agent);
    expect(urgent.isError, text(urgent)).toBe(false);
    expect(body(urgent).pending).toBe(true);
    const approval = await sql<{ payload: { priority: string; item_type: string } }>`SELECT payload FROM approval_requests WHERE id = ${body(urgent).approval_request_id as string}::uuid`.execute(db as never);
    expect(approval.rows[0]?.payload).toMatchObject({ priority: 'urgent', item_type: 'task' });

    const bug = await call('exec_task_start', { title: 'agent task, a bug', acceptance_criteria: [CRIT], allowed_paths: ['apps/**'], type: 'bug' }, agent);
    expect(body(bug).pending).toBe(true);
    await upsertSetting(db, 'system', null, 'approval_policy', 'manual');
  });
});
