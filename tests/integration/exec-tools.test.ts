import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ModuleRegistry, newId, upsertSetting, type Db } from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * PE-2 acceptance (docs/EXECUTION_CONTROL_PLAN.md §7): the five ledger tools over the
 * real dispatch path — module gate, scopes, validation, call logging, idempotency —
 * against a real PostgreSQL. Everything goes through `callTool`, because a unit test of
 * a handler would prove the handler works and say nothing about the tool the agent
 * actually calls (B.6/B.7 are dispatch properties, not service properties).
 */

let h: Harness;
let db: Db;
let orgId: string;
let projectId: string;
let userId: string;
let deps: McpDeps;
let seq = 0;

const GOOD = 'exec_ledger_status returns the blocking item code in blockers; test:exec-tools.test.ts';
const NOTE = 'closed because the ledger records the decision in prose, not in a flag';

const actor = (over: Partial<Actor> = {}): Actor =>
  ({
    type: 'agent',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['read', 'write'],
    projectIds: [projectId],
    requestId: `req-pe2-${(seq += 1)}`,
    ...over,
  }) as Actor;

/**
 * A user actor writes through without the approval gate; an agent does not (the policy
 * is fail-closed by default). The ledger laws are the same for both, which is exactly
 * what the two helpers below are for.
 */
const writer = (over: Partial<Actor> = {}): Actor => actor({ type: 'user', ...over });

const call = (name: string, args: Record<string, unknown>, who = writer()) =>
  callTool(deps, who, name, args, who.requestId);

const json = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

async function count(table: string, where = ''): Promise<number> {
  const r = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
  ).execute(db as never);
  return Number(r.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe2-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  // The module must be ON for its tools to be listable/callable at all (PE-0 shipped
  // it registered and off); the setting is the only switch, so this is also the proof
  // that the gate is a switch and not a hard-coded flag.
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

describe('PE-2 B.4 — exec_task_start writes the whole task in one shot', () => {
  it('creates work item + task + criteria, one event, one audit row', async () => {
    const res = await call('exec_task_start', {
      title: 'ledger tools over dispatch',
      acceptance_criteria: [
        GOOD,
        'npm run test:unit returns exit code 0 and prints the passing count; cmd:npm run test:unit',
      ],
      req_ids: [],
      allowed_paths: ['packages/core/src/exec/**', 'apps/api/src/modules/exec/**'],
    });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(typeof body.task_id).toBe('string');
    expect(body.code).toMatch(/^T-\d+$/);
    expect((body.criterion_ids as string[]).length).toBe(2);
    expect((body.criterion_codes as string[]).length).toBe(2);
    expect((body.allowed_paths as string[]).sort()).toEqual([
      'apps/api/src/modules/exec/**',
      'packages/core/src/exec/**',
    ]);

    const workItemId = body.work_item_id as string;
    expect(await count('work_items', `id = '${workItemId}'::uuid AND type = 'task'`)).toBe(1);
    expect(await count('exec_criteria', `task_id = '${body.task_id}'::uuid`)).toBe(2);
    // B.4's other half: the ledger and the board agree — exec_tasks.work_item_id is the row just made.
    expect(await count('exec_tasks', `id = '${body.task_id}'::uuid AND work_item_id = '${workItemId}'::uuid`)).toBe(1);
    expect(await count('exec_events', `task_id = '${body.task_id}'::uuid AND action = 'task.created'`)).toBe(1);
    expect(await count('audit_events', `action = 'exec.task_start' AND resource_id = '${body.task_id}'::uuid`)).toBe(1);
  });

  it('refuses a vague criterion with CRITERION_NOT_CHECKABLE and writes nothing (B.2)', async () => {
    const before = await count('exec_tasks');
    const res = await call(
      'exec_task_start',
      {
        title: 'vague criteria cannot start a task',
        acceptance_criteria: ['the feature works well'],
        allowed_paths: ['apps/**'],
      },
      actor(),
    ); // an agent: the refusal lands before any approval request exists
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/CRITERION_NOT_CHECKABLE/);
    expect(res.content[0]?.text).toMatch(/works well|no measurable verb/);
    expect(await count('exec_tasks')).toBe(before);
    expect(await count('approval_requests')).toBe(0); // no approval spent on an unexecutable payload
  });

  it('refuses a requirement that was never recorded, and names it (A.8 for req refs)', async () => {
    const res = await call('exec_task_start', {
      title: 'a claimed requirement must exist',
      acceptance_criteria: [GOOD],
      allowed_paths: ['apps/**'],
      req_ids: [newId()],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/NOT_FOUND/);
  });

  it('req_ids declares a requirement; it never covers it (D-049 #2)', async () => {
    // Its own project on purpose: `requirements_uncovered` is read project-wide, so seeding
    // this requirement into the shared fixture would quietly change what every other status
    // assertion in this file sees.
    const where = await seedOrg(db, {
      email: `pe2-reqs-${process.pid}-${Date.now()}@example.invalid`,
      password: 'sup3r-s3cret-pass',
    });
    const who = writer({ organizationId: where.organizationId, id: where.userId, projectIds: [where.projectId] });
    const reqId = newId();
    const reqCode = `REQ-PE2-${(seq += 1)}`;
    await db
      .insertInto('exec_requirements')
      .values({
        id: reqId,
        organization_id: where.organizationId,
        project_id: where.projectId,
        code: reqCode,
        text: 'a requirement the ledger must keep visible until evidence closes it',
        quote: 'a declaration is not a coverage claim',
        source: 'human',
      })
      .execute();
    const started = json(
      await call(
        'exec_task_start',
        {
          title: 'a declared requirement stays uncovered',
          acceptance_criteria: [GOOD],
          allowed_paths: ['apps/**'],
          req_ids: [reqId],
        },
        who,
      ),
    );
    // The declaration is heard — it comes back on the result and into the event — but
    // coverage is a property of the criteria, so the task must not be able to erase it.
    expect(started.req_ids).toEqual([reqId]);
    const linked = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM exec_criteria WHERE req_id = ${reqId}`.execute(db as never);
    expect(Number(linked.rows[0]?.n)).toBe(0);
    const status = json(await call('exec_ledger_status', { task_ref: started.code as string }, who));
    const view = (status.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(view.requirements_uncovered).toContain(reqCode);
  });

  it('an agent task_start goes through the approval gate and writes no ledger row', async () => {
    const before = {
      tasks: await count('exec_tasks'),
      items: await count('work_items'),
      events: await count('exec_events'),
    };
    const res = await call(
      'exec_task_start',
      { title: 'an agent may need a human first', acceptance_criteria: [GOOD], allowed_paths: ['apps/**'] },
      actor(),
    );
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.pending).toBe(true);
    expect(typeof body.approval_request_id).toBe('string');
    expect(await count('exec_tasks')).toBe(before.tasks);
    expect(await count('work_items')).toBe(before.items);
    expect(await count('exec_events')).toBe(before.events);
  });
});

describe('PE-2 B.5 — an empty project says so and points somewhere', () => {
  it('returns {empty:true} with a needed_action instead of an empty list', async () => {
    const other = await seedOrg(db, {
      email: `pe2-empty-${process.pid}-${Date.now()}@example.invalid`,
      password: 'sup3r-s3cret-pass',
    });
    const res = await call(
      'exec_ledger_status',
      {},
      { ...actor(), organizationId: other.organizationId, id: other.userId, projectIds: [other.projectId] },
    );
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.empty).toBe(true);
    expect(body.tasks).toEqual([]);
    expect(String(body.needed_action)).toMatch(/exec_task_start/);
  });

  it('answers with the projection over the rows that exist (A.1)', async () => {
    const started = json(
      await call('exec_task_start', {
        title: 'status over real rows',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
    const item = json(
      await call('ledger_add_open_item', {
        task_ref: started.code as string,
        title: 'a commitment the task must keep',
        type: 'commitment',
      }),
    );
    expect(item.code).toMatch(/^OI-\d+$/);
    const status = json(await call('exec_ledger_status', { task_ref: started.code as string }));
    const task = (status.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(task.ready_to_submit).toBe(false);
    expect(task.blockers).toEqual([item.code]);
    expect(task.reasons_not_ready).toHaveLength(2); // the blocker + the criterion without evidence
    expect((task.criteria_without_evidence as string[]).length).toBe(1);
  });
});

describe('PE-2 B.6/B.7 — the dispatch layer keeps its promises', () => {
  it('logs every call, including a refusal, with the input masked', async () => {
    const before = await count('mcp_tool_calls');
    const res = await call('ledger_add_open_item', {
      task_ref: 'T-999',
      title: 'unknown task',
      type: 'question',
      api_key: 'fpm_leaked_secret',
    });
    expect(res.isError).toBe(true); // unknown field: strictObject refuses it (B.1)
    expect(res.content[0]?.text).toMatch(/VALIDATION_ERROR|api_key|Unrecognized/);
    expect(await count('mcp_tool_calls')).toBe(before + 1);
    const row = await sql<{ input_summary: Record<string, unknown> }>`
      SELECT input_summary FROM mcp_tool_calls
      WHERE tool = 'ledger_add_open_item' ORDER BY created_at DESC LIMIT 1
    `.execute(db as never);
    const summary = row.rows[0]?.input_summary ?? {};
    expect(summary.api_key).toBe('[MASKED]');
    expect(JSON.stringify(summary)).not.toContain('fpm_leaked_secret');
    expect(summary.task_ref).toBe('T-999');
  });

  it('a read-only key cannot write to the ledger, and nothing is written', async () => {
    const started = json(
      await call('exec_task_start', {
        title: 'scope check target',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
    const before = await count('exec_open_items');
    const res = await call(
      'ledger_add_open_item',
      { task_ref: started.code as string, title: 'should not be allowed', type: 'question' },
      actor({ scopes: ['read'] }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/FORBIDDEN_SCOPE/);
    expect(await count('exec_open_items')).toBe(before);
    // ...while the same key may still read the ledger.
    const read = await call('exec_ledger_status', { task_ref: started.code as string }, actor({ scopes: ['read'] }));
    expect(read.isError).toBe(false);
  });
});

describe('PE-2 B.8 + A.3 — idempotency and the soft-closure rule at the tool boundary', () => {
  it('repeating exec_task_start with one idempotency_key creates one task', async () => {
    const key = `pe2-idem-${process.pid}-${Date.now()}`;
    const payload = {
      title: 'created once, retried safely',
      acceptance_criteria: [GOOD],
      allowed_paths: ['apps/**'],
      idempotency_key: key,
    };
    const first = json(await call('exec_task_start', payload));
    const tasksBefore = await count('exec_tasks');
    const second = json(await call('exec_task_start', payload));
    expect(second.task_id).toBe(first.task_id);
    expect(second.replayed).toBe(true);
    expect(await count('exec_tasks')).toBe(tasksBefore);
  });

  it('an agent cannot soft-close a blocking item; the human can, and the refusal writes no event', async () => {
    const started = json(
      await call('exec_task_start', {
        title: 'soft closure needs a human',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
    const item = json(
      await call('ledger_add_open_item', {
        task_ref: started.code as string,
        title: 'a blocker to be deferred',
        type: 'commitment',
      }),
    );
    const eventsBefore = await count('exec_events', `task_id = '${started.task_id}'::uuid`);
    // The refusal is about *who* closes it, so this call must be the agent's; the
    // default actor in this file is a human (writes are not approval-gated for them).
    const denied = await call(
      'ledger_resolve_item',
      { task_ref: started.code as string, item_ref: item.code as string, status: 'deferred', note: NOTE },
      actor(),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/LEDGER_TRANSITION_NOT_ALLOWED/);
    expect(await count('exec_events', `task_id = '${started.task_id}'::uuid`)).toBe(eventsBefore);
    expect(json(await call('ledger_list_open', { task_ref: started.code as string })).items).toHaveLength(1);

    const allowed = await call(
      'ledger_resolve_item',
      { task_ref: started.code as string, item_ref: item.code as string, status: 'deferred', note: NOTE },
      actor({ type: 'user' }),
    );
    expect(allowed.isError, JSON.stringify(allowed.content)).toBe(false);
    expect(json(allowed).status).toBe('deferred');
    expect(await count('exec_events', `task_id = '${started.task_id}'::uuid`)).toBe(eventsBefore + 1);
    // history, not cleanup (A.2): the item is still there, just no longer open.
    const listed = json(await call('ledger_list_open', { task_ref: started.code as string, active_only: false }));
    expect((listed.items as Record<string, unknown>[]).map((i) => i.status)).toEqual(['deferred']);
    expect(json(await call('ledger_list_open', { task_ref: started.code as string })).items).toHaveLength(0);
  });

  it('a duplicate commitment is answered with the existing code, not a second row (C.4)', async () => {
    const started = json(
      await call('exec_task_start', {
        title: 'dedup through the tool',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
    const first = json(
      await call('ledger_add_open_item', {
        task_ref: started.code as string,
        title: 'Ship the ledger dedup gate',
        type: 'commitment',
      }),
    );
    const again = await call('ledger_add_open_item', {
      task_ref: started.code as string,
      title: 'Ship the ledger dedup gate!',
      type: 'commitment',
    });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/CONFLICT/);
    expect(String(again.content[0]?.text)).toContain(String(first.code));
    expect(json(await call('ledger_list_open', { task_ref: started.code as string })).items).toHaveLength(1);
  });
});
