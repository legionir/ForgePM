import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { newId, toJsonb, upsertSetting, type Db, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { ensureWorkflow } from '../../apps/api/src/modules/work-items/states';
import { createHarness, type Harness } from './harness';
import { seedApiKey, seedOrg } from './seed';
async function loginAs(app: FastifyInstance, email: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${email}: ${res.body}`);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  return { cookie: `${session}; fpm_csrf=${csrf}`, csrf };
}


/**
 * The human's other verbs (plan §9.5): waive, drop, widen the scope, promote
 * a fact — and the gate, asked without closing anything.
 *
 * Every one of these is something the agent must never do for itself, so each
 * test also checks the boundary: the human's key decides, the agent's key is
 * refused, and what the human decided is written into the LEDGER (an approval
 * row, an event, a reason) — not into a log line nobody reads.
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
let orgId: string;
let projectId: string;
let userId: string;
let humanKey: string;
let agentKey: string;
let taskId: string;
let taskCode: string;
let workItemId: string;
let requirementId: string;
let criterionCode: string;
let requirementCode: string;
let factCode: string;

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe4-actions-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  await upsertSetting(db, 'project', projectId, 'exec.allowed_repo_roots', ['docs']);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  humanKey = await seedApiKey(db, orgId, userId, ['read', 'write', 'ledger:read', 'ledger:decide'], [projectId]);
  agentKey = await seedApiKey(db, orgId, userId, ['read', 'write', 'ledger:read', 'ledger:write'], [projectId]);
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

  workItemId = newId();
  const states = await ensureWorkflow(db, projectId, orgId);
  await db
    .insertInto('work_items')
    .values({
      id: workItemId,
      organization_id: orgId,
      project_id: projectId,
      number: 1,
      type: 'task',
      title: 'a task the human is allowed to change',
      state_id: states[0]?.id as string,
    })
    .execute();
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
      title: 'a task the human is allowed to change',
      status: 'in_progress',
      allowed_paths: toJsonb(['packages/core/src/exec/**']) as never,
    })
    .execute();

  requirementCode = 'REQ-001';
  requirementId = newId();
  await db
    .insertInto('exec_requirements')
    .values({
      id: requirementId,
      organization_id: orgId,
      project_id: projectId,
      code: requirementCode,
      text: 'the ledger must keep the promise it makes to the user',
      quote: 'the ledger must keep the promise',
      source: 'human',
    })
    .execute();

  criterionCode = 'C-001';
  await db
    .insertInto('exec_criteria')
    .values({
      id: newId(),
      task_id: taskId,
      req_id: requirementId,
      code: criterionCode,
      text: 'the ledger refuses to close a task while a requirement is uncovered',
      status: 'pending',
    })
    .execute();

  factCode = 'F-001';
  await db
    .insertInto('exec_facts')
    .values({
      id: newId(),
      organization_id: orgId,
      project_id: projectId,
      code: factCode,
      key: 'ledger.close_needs_a_stamp',
      value: 'the ledger refuses to close a task without a passing gate stamp',
      kind: 'assumption',
      source: 'agent_guess',
    })
    .execute();
});

afterAll(async () => {
  await app?.close();
  await h?.cleanup();
});

async function count(table: string, where = ''): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(table)}${sql.raw(
    where ? ` WHERE ${where}` : '',
  )}`.execute(db as never);
  return Number(r.rows[0]?.n ?? 0);
}

const asHuman = (key: string) => ({ authorization: `Bearer ${key}` });
async function asHumanSession(): Promise<{ cookie: string; 'x-csrf-token': string }> {
  const u = await db.selectFrom('users').select(['email']).where('id', '=', userId).executeTakeFirstOrThrow();
  const { cookie, csrf } = await loginAs(app, u.email, 'sup3r-s3cret-pass');
  return { cookie, 'x-csrf-token': csrf };
}

describe('the human removes a demand', () => {
  it('waives a criterion, and the waiver points at the approval that made it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/criteria/${criterionCode}/waive`,
      headers: await asHumanSession(),
      payload: { reason: 'the requirement behind it is not part of this release' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: criterionCode, status: 'waived' });

    const row = await sql<{ status: string; waiver_approval_id: string | null }>`
      SELECT status, waiver_approval_id::text AS waiver_approval_id FROM exec_criteria WHERE code = ${criterionCode}
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('waived');
    expect(row.rows[0]?.waiver_approval_id).toBeTruthy();

    const approval = await sql<{ action: string; status: string; reason: string }>`
      SELECT action, status, reason FROM approval_requests WHERE id = ${row.rows[0]?.waiver_approval_id}::uuid
    `.execute(db as never);
    expect(approval.rows[0]?.action).toBe('exec.waive_criterion');
    expect(approval.rows[0]?.status).toBe('approved');
    expect(approval.rows[0]?.reason).toContain('not part of this release');

    // The ledger's own event stream says it too.
    const events = await sql<{ action: string }>`
      SELECT action FROM exec_events WHERE entity_code = ${criterionCode} AND action = 'task.waived'
    `.execute(db as never);
    expect(events.rows.length).toBe(1);
  });

  it('refuses a waiver with no reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/criteria/${criterionCode}/waive`,
      headers: await asHumanSession(),
      payload: { reason: 'because' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('cancels a linked child only through the human route and records approval', async () => {
    const states = await ensureWorkflow(db, projectId, orgId);
    const childWorkItemId = newId();
    await db.insertInto('work_items').values({
      id: childWorkItemId,
      organization_id: orgId,
      project_id: projectId,
      number: 2,
      type: 'task',
      title: 'a linked child task to cancel',
      state_id: states[0]?.id as string,
      parent_id: workItemId,
    }).execute();
    const childId = newId();
    await db.insertInto('exec_tasks').values({
      id: childId,
      organization_id: orgId,
      project_id: projectId,
      work_item_id: childWorkItemId,
      parent_id: taskId,
      code: 'T-002',
      title: 'a linked child task to cancel',
      status: 'not_started',
      allowed_paths: toJsonb(['packages/core/src/exec/**']) as never,
    }).execute();
    await db.insertInto('exec_criteria').values({
      id: newId(),
      task_id: childId,
      req_id: requirementId,
      code: 'C-002',
      text: 'the child task checks the requirement before it completes',
      status: 'pending',
    }).execute();

    const url = `/api/v1/exec/tasks/${taskCode}/children/T-002/cancel`;
    const refused = await app.inject({ method: 'POST', url, headers: asHuman(agentKey), payload: { reason: 'the agent cannot cancel this child' } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'FORBIDDEN_SCOPE' } });

    const canceled = await app.inject({
      method: 'POST',
      url,
      headers: await asHumanSession(),
      payload: { reason: 'human approved cancellation because the requirement moved out of scope' },
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json()).toMatchObject({ task: 'T-002', parent: taskCode, status: 'canceled', linked_requirements: [requirementCode] });
    const approval = await sql<{ action: string; status: string }>`
      SELECT action, status FROM approval_requests WHERE id = ${canceled.json().approval_id}::uuid
    `.execute(db as never);
    expect(approval.rows[0]).toMatchObject({ action: 'exec.cancel_subtask', status: 'approved' });
  });

  it('drops a requirement, keeps the promise with a reason, and waives its criteria', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/requirements/${requirementCode}/drop`,
      headers: await asHumanSession(),
      payload: { reason: 'the product owner moved this promise to the next quarter' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: requirementCode, status: 'dropped' });

    const row = await sql<{ status: string; drop_reason: string; dropped_by: string }>`
      SELECT status, drop_reason, dropped_by FROM exec_requirements WHERE code = ${requirementCode}
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('dropped');
    expect(row.rows[0]?.dropped_by).toBe('human');
    expect(row.rows[0]?.drop_reason).toContain('next quarter');
  });

  it('an agent key may not waive or drop', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/requirements/${requirementCode}/drop`,
      headers: asHuman(agentKey),
      payload: { reason: 'the agent decided to drop it on its own' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_SCOPE' } });
  });
});

describe('the human widens what the task may touch', () => {
  it('adds paths to the task, and the old ones stay', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/scope/${taskCode}/expand`,
      headers: await asHumanSession(),
      payload: { paths: ['apps/api/src/modules/exec/**'], reason: 'the route file has to change too' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ task_code: taskCode, added_paths: ['apps/api/src/modules/exec/**'] });

    const row = await sql<{ allowed_paths: unknown }>`
      SELECT allowed_paths FROM exec_tasks WHERE id = ${taskId}::uuid
    `.execute(db as never);
    const paths = row.rows[0]?.allowed_paths as string[];
    expect(paths).toContain('packages/core/src/exec/**');
    expect(paths).toContain('apps/api/src/modules/exec/**');

    const events = await sql<{ action: string }>`
      SELECT action FROM exec_events WHERE task_id = ${taskId}::uuid AND action = 'scope.expanded'
    `.execute(db as never);
    expect(events.rows.length).toBe(1);
  });
});

describe('the human promotes a guess into a fact', () => {
  it('records where the knowledge came from', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/facts/${factCode}/promote`,
      headers: await asHumanSession(),
      payload: { source: 'docs', source_ref: 'docs/EXECUTION_CONTROL_PLAN.md', reason: 'the plan says so, in writing' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: factCode, source: 'docs' });

    const row = await sql<{ kind: string; source: string; source_ref: string | null; verified_at: Date | null }>`
      SELECT kind, source, source_ref, verified_at FROM exec_facts WHERE code = ${factCode}
    `.execute(db as never);
    expect(row.rows[0]?.kind).toBe('fact');
    expect(row.rows[0]?.source).toBe('docs');
    expect(row.rows[0]?.source_ref).toBe('docs/EXECUTION_CONTROL_PLAN.md');
    expect(row.rows[0]?.verified_at).toBeTruthy();
  });

  it('a fact whose source is code must say which code', async () => {
    const second = newId();
    await db
      .insertInto('exec_facts')
      .values({
        id: second,
        organization_id: orgId,
        project_id: projectId,
        code: 'F-002',
        key: 'ledger.answer_needs_a_reason',
        value: 'the ledger refuses an answer that carries no reason',
        kind: 'assumption',
        source: 'agent_guess',
      })
      .execute();
    const u = await db.selectFrom('users').select(['email']).where('id', '=', userId).executeTakeFirstOrThrow();
    const { cookie, csrf } = await loginAs(app, u.email, 'sup3r-s3cret-pass');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/exec/facts/F-002/promote',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { source: 'code', reason: 'the human checked the code and says it is true' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('the gate, asked without closing anything', () => {
  it('answers like the gate and writes nothing', async () => {
    const before = await count('exec_gate_checks');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/gate/${taskCode}`,
      headers: await asHumanSession(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { ok: boolean; dry_run: boolean; blocked_by: unknown[] };
    expect(body.dry_run).toBe(true);
    expect(body.ok).toBe(false); // no exit report, no evidence — the gate says no
    expect(Array.isArray(body.blocked_by)).toBe(true);
    expect(body.blocked_by.length).toBeGreaterThan(0);

    // A dry run is not an attempt: nothing was stamped.
    expect(await count('exec_gate_checks')).toBe(before);
    expect(await count('exec_events', `action = 'exec.gate.dry_run'`)).toBe(0);
  });
});
