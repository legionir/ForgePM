import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { newId, toJsonb, upsertSetting, type Db, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { ensureWorkflow } from '../../apps/api/src/modules/work-items/states';
import { createHarness, type Harness } from './harness';
import { seedApiKey, seedOrg } from './seed';

/**
 * PE-3 penetration test (plan §8.3, acceptance C.5 + C.9b).
 *
 * `exec_task_complete` is the ONE door to `done`. A door that only one person
 * uses is not a door, it is a suggestion — so this file tries every other way
 * in and expects to be refused:
 *
 *   • the MCP tool `work_item_transition`,
 *   • the REST transition endpoint (the panel's own path),
 *   • the REST PATCH that can carry a state id,
 *   • a hand-written `status='done'` in SQL (which cannot be prevented — so it
 *     must be DETECTED and reported, which is what C.9b is for).
 *
 * The refusal has to be the same everywhere, with the same code, or the agent
 * will simply try the next door.
 */

const env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200',
  API_DOCS_ENABLED: false,
  METRICS_ENABLED: false,
  LOG_LEVEL: 'fatal',
} satisfies Env;

let h: Harness;
let db: Db;
let app: FastifyInstance;
let deps: McpDeps;
let orgId: string;
let projectId: string;
let userId: string;
let apiKey: string;
let workItemId: string;
let workItemKey: string;
let taskId: string;
let taskCode: string;
let doneStateId: string;
let firstStateId: string;
let seq = 0;

const actor = (): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['read', 'write'],
    projectIds: [projectId],
    requestId: `req-pe3-${(seq += 1)}`,
  }) as unknown as Actor;

const mcp = (name: string, args: Record<string, unknown>) => {
  const who = actor();
  return callTool(deps, who, name, args, who.requestId);
};

const json = (r: Awaited<ReturnType<typeof mcp>>): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

async function seedTask(status = 'in_progress'): Promise<void> {
  const states = await ensureWorkflow(db, projectId, orgId);
  const done = states.find((s) => s.category === 'completed');
  const first = states.slice().sort((a, b) => a.position - b.position)[0];
  if (!done || !first) throw new Error('the workflow has no completed state');
  doneStateId = done.id;
  firstStateId = first.id;
  workItemId = newId();
  await db
    .insertInto('work_items')
    .values({
      id: workItemId,
      organization_id: orgId,
      project_id: projectId,
      number: 1,
      type: 'task',
      title: 'a ledger task that wants to be finished',
      state_id: firstStateId,
    })
    .execute();
  const project = await db.selectFrom('projects').select('key').where('id', '=', projectId).executeTakeFirstOrThrow();
  workItemKey = `${project.key}-1`;
  taskId = newId();
  taskCode = 'T-001';
  await db
    .insertInto('exec_tasks')
    .values({
      id: taskId,
      organization_id: orgId,
      project_id: projectId,
      work_item_id: workItemId,
      code: taskCode,
      title: 'a ledger task that wants to be finished',
      status: status as never,
      allowed_paths: toJsonb(['packages/core/src/exec/**']) as never,
    })
    .execute();
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe3-guard-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  apiKey = await seedApiKey(db, orgId, userId, ['read', 'write'], [projectId]);
  const registry = buildRegistry();
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  registry.invalidate();
  app = await buildApp({
    env,
    db: h.db,
    registry,
    redisAvailable: () => Promise.resolve(true),
  });
  await app.ready();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();
  await seedTask();
});

afterAll(async () => {
  await app?.close();
  await h?.cleanup();
});

describe('PE-3 C.5 — no other path reaches `done`', () => {
  it('the MCP transition tool refuses to complete a ledger task', async () => {
    const res = await mcp('work_item_transition', { key: workItemKey, to_state_id: doneStateId });
    expect(res.isError, JSON.stringify(res.content)).toBe(true);
    expect(res.content[0]?.text).toMatch(/GATE_FAILED/);
  });

  it('the REST transition endpoint refuses too (the panel’s own path)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/work-items/${workItemKey}/transition`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { to_state_id: doneStateId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'GATE_FAILED' } });
  });

  it('the REST PATCH cannot carry an item into `completed` either', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${workItemKey}`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { state_id: doneStateId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'GATE_FAILED' } });
  });

  it('and the work item is still not completed after all three attempts', async () => {
    const row = await sql<{ category: string }>`
      SELECT ws.category FROM work_items wi
      JOIN workflow_states ws ON ws.id = wi.state_id
      WHERE wi.id = ${workItemId}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.category).not.toBe('completed');
  });
});

describe('PE-3 C.9b — a hand-written `done` is drift, and drift is reported', () => {
  it('the ledger status and the gate both report "drift: gate stamp missing"', async () => {
    // `closed_at` is part of the table's own law: a task may not say `done`
    // without it — which is why a hand-written `done` has to carry it too.
    await sql`UPDATE exec_tasks SET status = 'done', closed_at = now() WHERE id = ${taskId}::uuid`.execute(db as never);
    const status = json(await mcp('exec_ledger_status', { task_ref: taskCode }));
    const task = (status.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(task.drift).toBe('drift: gate stamp missing');
    expect(task.reasons_not_ready as string[]).toContain('drift: gate stamp missing');

    // The gate says the same thing, in the same words.
    const blocked = await mcp('exec_task_complete', { task_ref: taskCode });
    const body = json(blocked);
    expect(body.ok).toBe(false);
    expect((body.blocked_by as Record<string, unknown>[]).some((b) => b.ref === 'drift: gate stamp missing')).toBe(
      true,
    );
  });

  it('a stamped task is not drift, and the work item may then be completed', async () => {
    // A task the gate closed looks like this: status='done' AND a passing
    // stamp. The guard lets the board follow the ledger — and only then.
    await sql`UPDATE exec_tasks SET status = 'done', closed_at = now() WHERE id = ${taskId}::uuid`.execute(db as never);
    // A stamp always names the report it judged — the table will not accept
    // one without it, which is the point: the proof of a gate run is the
    // report it ran on.
    const reportId = newId();
    await sql`
      INSERT INTO exec_reports (id, organization_id, task_id, payload, status)
      VALUES (${reportId}, ${orgId}, ${taskId}::uuid, ${'{}'}::jsonb, 'gate_passed')
    `.execute(db as never);
    await sql`
      INSERT INTO exec_gate_checks (id, organization_id, task_id, report_id, ok, blocked_by, gate_version, tree_hash, run_source)
      VALUES (${newId()}, ${orgId}, ${taskId}::uuid, ${reportId}::uuid, true, '[]'::jsonb, 1, ${'unmeasured'}, 'human')
    `.execute(db as never);
    const status = json(await mcp('exec_ledger_status', { task_ref: taskCode }));
    const task = (status.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(task.drift).toBeNull();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/work-items/${workItemKey}/transition`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { to_state_id: doneStateId },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
