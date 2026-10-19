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
 * The HUMAN side of the ledger (plan §9.5, acceptance B.15).
 *
 * The agent can ask; only a human can answer. These routes are where that
 * boundary is enforced in code, and the test is about the boundary: the human's
 * key decides, the agent's key is refused, and what the human does is written
 * into the ledger (not into a log line nobody reads).
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
let agentKey: string;
let taskId: string;
let taskCode: string;
let questionId: string;
let questionCode: string;
let decisionCode: string;

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe4-human-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  // The human's key may decide; the agent's key may not (D-040: `ledger:decide`
  // is human-only, and B.15 says an agent's key gets FORBIDDEN_SCOPE).
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

  // A task with a blocking question and a decision that needs an approval.
  const workItemId = newId();
  const states = await ensureWorkflow(db, projectId, orgId);
  await db
    .insertInto('work_items')
    .values({
      id: workItemId,
      organization_id: orgId,
      project_id: projectId,
      number: 1,
      type: 'task',
      title: 'a task the human has to answer for',
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
      title: 'a task the human has to answer for',
      status: 'in_progress',
      allowed_paths: toJsonb(['packages/core/src/exec/**']) as never,
    })
    .execute();
  questionCode = 'Q-001';
  questionId = newId();
  await db
    .insertInto('exec_questions')
    .values({
      id: questionId,
      organization_id: orgId,
      task_id: taskId,
      code: questionCode,
      question: 'should the panel show the gate stamp next to the task?',
      options: toJsonb(['yes, show it', 'no, keep the panel simple']) as never,
      recommendation: 'yes, show it',
      why_it_matters: 'a drifted task looks finished on the board while the ledger says it is not',
      impact: toJsonb(['one more column in the board', 'the board stays small']) as never,
      blocking: true,
      status: 'open',
    })
    .execute();
  await db
    .updateTable('exec_tasks')
    .set({
      status: 'awaiting_review',
      blocked_on_kind: 'question',
      blocked_on_ref: questionId,
      unblock_condition: `a human answers ${questionCode}`,
    })
    .where('id', '=', taskId)
    .execute();

  decisionCode = 'D-001';
  const decisionId = newId();
  const approvalId = newId();
  await db
    .insertInto('approval_requests')
    .values({
      id: approvalId,
      organization_id: orgId,
      project_id: projectId,
      requested_by: userId,
      action: 'exec.decision',
      payload: { decision_id: decisionId, code: decisionCode } as never,
      risk: 'sensitive',
      status: 'pending',
    })
    .execute();
  await db
    .insertInto('exec_decisions')
    .values({
      id: decisionId,
      organization_id: orgId,
      task_id: taskId,
      code: decisionCode,
      title: 'the shape of the public API',
      context: 'the endpoint changes and every client has to follow it',
      options: toJsonb(['keep the old shape', 'replace the old shape']) as never,
      selected: 'keep the old shape',
      rationale: 'the old shape is used by two other services that cannot change in this release',
      touches: ['public_api'] as never,
      reversible: true,
      risk_level: 'approval',
      approval_state: 'pending',
      approval_id: approvalId,
    })
    .execute();
});

afterAll(async () => {
  await app?.close();
  await h?.cleanup();
});

describe('the human decides — and the ledger records it', () => {
  it('answering a question unblocks the task', async () => {
    const u = await db.selectFrom('users').select(['email']).where('id', '=', userId).executeTakeFirstOrThrow();
    const { cookie, csrf } = await loginAs(app, u.email, 'sup3r-s3cret-pass');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/questions/${questionCode}/answer`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { answer: 'yes, show it — the drift must be visible' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: questionCode, status: 'answered' });

    const row = await sql<{ status: string; answer: string; answered_by: string }>`
      SELECT status, answer, answered_by FROM exec_questions WHERE code = ${questionCode}
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('answered');
    expect(row.rows[0]?.answer).toContain('the drift must be visible');

    const task = await sql<{ status: string; blocked_on_kind: string | null }>`
      SELECT status, blocked_on_kind FROM exec_tasks WHERE id = ${taskId}::uuid
    `.execute(db as never);
    expect(task.rows[0]?.status).toBe('in_progress');
    expect(task.rows[0]?.blocked_on_kind).toBeNull();
  });

  it('approving a decision flips the ledger, not only the approval row', async () => {
    const pending = await sql<{ id: string }>`
      SELECT id::text AS id FROM approval_requests WHERE action = 'exec.decision' AND status = 'pending'
    `.execute(db as never);
    const approvalId = pending.rows[0]?.id as string;
    const u = await db.selectFrom('users').select(['email']).where('id', '=', userId).executeTakeFirstOrThrow();
    const { cookie, csrf } = await loginAs(app, u.email, 'sup3r-s3cret-pass');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/approvals/${approvalId}/decide`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { decision: 'approved', reason: 'the old shape stays for one release' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const decision = await sql<{ approval_state: string }>`
      SELECT approval_state FROM exec_decisions WHERE code = ${decisionCode}
    `.execute(db as never);
    expect(decision.rows[0]?.approval_state).toBe('approved');

    // The ledger says who decided, in its own event stream.
    const events = await sql<{ action: string }>`
      SELECT action FROM exec_events WHERE entity_code = ${decisionCode} AND action = 'decision.approved'
    `.execute(db as never);
    expect(events.rows.length).toBe(1);
  });

  it('B.15 an agent key may not decide', async () => {
    // A fresh pending approval: the scope check happens before the handler
    // even looks at it, but the route must have a real id to be refused on.
    const approvalId = newId();
    await db
      .insertInto('approval_requests')
      .values({
        id: approvalId,
        organization_id: orgId,
        project_id: projectId,
        requested_by: userId,
        action: 'exec.decision',
        payload: { decision_id: newId(), code: 'D-002' } as never,
        risk: 'sensitive',
        status: 'pending',
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/exec/approvals/${approvalId}/decide`,
      headers: { authorization: `Bearer ${agentKey}` },
      payload: { decision: 'approved' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_SCOPE' } });
  });
});
