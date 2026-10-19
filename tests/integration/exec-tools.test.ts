import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  GATE_VERSION,
  ModuleRegistry,
  newId,
  setExecReviewSource,
  toJsonb,
  upsertSetting,
  waiveBaseline,
  waiveScopeMeasurement,
  type Db,
  type LedgerActor,
} from '@forgepm/core';
import { ensureWorkflow } from '../../apps/api/src/modules/work-items/states';
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

async function waiveUnavailableMeasurements(taskRef: string): Promise<void> {
  const human: LedgerActor = {
    organizationId: orgId,
    projectId,
    actorType: 'human',
    actorId: userId,
    tool: 'test:human-waiver',
  };
  await waiveScopeMeasurement(db, human, taskRef, 'accept unavailable scope measurement for this test');
  await waiveBaseline(db, human, taskRef, 'accept unavailable CI evidence for this test');
}

const json = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

async function count(table: string, where = ''): Promise<number> {
  // The table name and the filter are test-side literals, not user input, so
  // `sql.raw` is the honest way to splice them in.
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(table)}${sql.raw(
    where ? ` WHERE ${where}` : '',
  )}`.execute(db as never);
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
  await upsertSetting(db, 'project', projectId, 'exec.allowed_repo_roots', ['apps', 'packages', 'docs']);
  setExecReviewSource({
    snapshot: async () => ({ files: [], tree_hash: 't'.repeat(40) }),
    treeHash: async () => 't'.repeat(40),
  });
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

  it('the ledger scopes work on their own (plan §4.0)', async () => {
    // A key that may drive the execution ledger and nothing else: no general
    // `read`, no general `write`. The ledger tools accept the generic scope OR
    // the ledger's own, so this key can run the whole ledger and still cannot
    // touch the product's write surface.
    // A user actor: an agent's write would (correctly) stop at the approval
    // gate, which is a different test.
    const ledgerOnly = writer({ scopes: ['ledger:read', 'ledger:write'] });
    const started = json(
      await call(
        'exec_task_start',
        {
          title: 'a task started with a ledger-only key',
          acceptance_criteria: [GOOD],
          allowed_paths: ['apps/**'],
        },
        ledgerOnly,
      ),
    );
    expect(started.code, JSON.stringify(started)).toBeTruthy();
    const read = await call('exec_ledger_status', { task_ref: started.code as string }, ledgerOnly);
    expect(read.isError, JSON.stringify(read.content)).toBe(false);
    const item = await call(
      'ledger_add_open_item',
      { task_ref: started.code as string, title: 'a ledger-only key may file this', type: 'suggestion' },
      ledgerOnly,
    );
    expect(item.isError, JSON.stringify(item.content)).toBe(false);
    // ...and a ledger-read key may not write.
    const refused = await call(
      'ledger_add_open_item',
      { task_ref: started.code as string, title: 'this one is not allowed', type: 'suggestion' },
      writer({ scopes: ['ledger:read'] }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/FORBIDDEN_SCOPE/);
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

/**
 * PE-3 acceptance (plan §8): the exit report and the finalization gate, over
 * the real dispatch path. The gate is the last door to `done`, so these tests
 * are about what it REFUSES as much as about what it allows: a rule that
 * blocks nothing is indistinguishable from a rule that is not there.
 */
describe('PE-3 — the exit report (plan §8.1)', () => {
  const SUMMARY = 'the exit report records what was done and what was left, in the ledger itself';

  async function startTask(): Promise<Record<string, unknown>> {
    return json(
      await call('exec_task_start', {
        title: 'the exit report closes the loop',
        acceptance_criteria: [GOOD],
        allowed_paths: ['packages/core/src/exec/**'],
      }),
    );
  }

  const report = (task: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    task_ref: task.code as string,
    summary: SUMMARY,
    changed_files: ['packages/core/src/exec/gate.ts'],
    completed_items: ['the report becomes open items'],
    incomplete: [],
    assumptions: [],
    decisions_made: [],
    risks_found: [],
    tests_executed: [],
    tests_not_run: [],
    out_of_scope_findings: [],
    criteria_status: [],
    req_ids_covered: [],
    scope_deviations: [],
    facts_recorded: [],
    none_confirmed: {
      incomplete: true,
      assumptions: true,
      decisions_made: true,
      risks_found: true,
      tests_not_run: true,
      out_of_scope_findings: true,
      req_ids_covered: true,
      scope_deviations: true,
    },
    ...over,
  });

  it('C.3 a dropped field is refused, and nothing is written', async () => {
    const task = await startTask();
    const payload = report(task) as Record<string, unknown>;
    delete payload.incomplete;
    const res = await call('exec_submit_exit_report', payload);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/incomplete: Required/);
    expect(await count('exec_reports', `task_id = '${task.task_id}'::uuid`)).toBe(0);
    expect(await count('exec_open_items', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('C.3 an empty list without none_confirmed is refused', async () => {
    const task = await startTask();
    const payload = report(task) as Record<string, unknown>;
    delete payload.none_confirmed;
    const res = await call('exec_submit_exit_report', payload);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/UNPROCESSABLE/);
    expect(await count('exec_reports', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('C.3 an empty list WITH none_confirmed is accepted', async () => {
    const task = await startTask();
    const res = await call('exec_submit_exit_report', report(task));
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    expect(json(res).report_id).toBeTruthy();
  });

  it('C.4 every finding becomes an open item with source=exit_report', async () => {
    const task = await startTask();
    const res = await call(
      'exec_submit_exit_report',
      report(task, {
        incomplete: ['the migration for the new column was not written'],
        assumptions: ['the CI log endpoint stays readable for this project'],
        risks_found: ['the panel may lag behind the ledger by one refresh'],
        out_of_scope_findings: ['no admin UI was added for this change'],
        tests_not_run: [
          {
            name: 'e2e > checkout',
            reason: 'the CI run for this commit has not finished, so no log exists yet',
          },
        ],
        none_confirmed: {
          incomplete: false,
          assumptions: false,
          decisions_made: true,
          risks_found: false,
          tests_not_run: false,
          out_of_scope_findings: false,
          req_ids_covered: true,
          scope_deviations: true,
        },
      }),
    );
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect((body.promoted as string[]).length).toBe(5);
    const items = await sql<{ type: string; source: string; title: string }>`
      SELECT type, source, title FROM exec_open_items WHERE task_id = ${task.task_id}::uuid ORDER BY code
    `.execute(db as never);
    expect(items.rows.length).toBe(5);
    expect(items.rows.every((r) => r.source === 'exit_report')).toBe(true);
    expect(items.rows.map((r) => r.type).sort()).toEqual([
      'assumption',
      'incomplete_requirement',
      'out_of_scope',
      'risk',
      'test_gap',
    ]);
    // The incomplete requirement blocks; an assumption does not.
    const blocking = await sql<{ title: string; blocks_completion: boolean }>`
      SELECT title, blocks_completion FROM exec_open_items WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(blocking.rows.filter((r) => r.blocks_completion).length).toBe(2); // R-07: both incomplete_requirement + out_of_scope block
  });

  it('a declared scope deviation is filed as an out_of_scope item', async () => {
    // The report's `changed_files` are what rule 11 measures; a declared
    // deviation is the part the agent volunteers, and it belongs in the
    // ledger too — the completion report must be able to name it.
    const task = await startTask();
    const res = await call(
      'exec_submit_exit_report',
      report(task, {
        scope_deviations: ['the panel was touched although the plan said backend only'],
        none_confirmed: {
          incomplete: true,
          assumptions: true,
          decisions_made: true,
          risks_found: true,
          tests_not_run: true,
          out_of_scope_findings: true,
          req_ids_covered: true,
          scope_deviations: false,
        },
      }),
    );
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const items = await sql<{ type: string; source: string; title: string }>`
      SELECT type, source, title FROM exec_open_items WHERE task_id = ${task.task_id}::uuid ORDER BY code
    `.execute(db as never);
    expect(items.rows.length).toBe(1);
    expect(items.rows[0]?.type).toBe('out_of_scope');
    expect(items.rows[0]?.source).toBe('exit_report');
    expect(items.rows[0]?.title).toMatch(/scope deviation/);
  });

  it('C.4 the same report twice does not file the same item twice', async () => {
    const task = await startTask();
    const payload = report(task, {
      incomplete: ['the migration for the new column was not written'],
      none_confirmed: {
        incomplete: false,
        assumptions: true,
        decisions_made: true,
        risks_found: true,
        tests_not_run: true,
        out_of_scope_findings: true,
        req_ids_covered: true,
        scope_deviations: true,
      },
    });
    await call('exec_submit_exit_report', payload);
    await call('exec_submit_exit_report', payload);
    const items = await count('exec_open_items', `task_id = '${task.task_id}'::uuid`);
    expect(items).toBe(1);
  });

  it('a test result that cites no evidence row is refused with EVIDENCE_INVALID', async () => {
    const task = await startTask();
    const res = await call(
      'exec_submit_exit_report',
      report(task, {
        tests_executed: [{ name: 'exec > gate', result: 'pass', evidence_id: newId() }],
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/EVIDENCE_INVALID/);
    expect(await count('exec_reports', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });
});

/**
 * PE-4 §9.2/§9.3 — the decision and the question (acceptance B.9, B.11).
 *
 * The point of both tools is that the AGENT does not get the last word: the
 * risk level comes from the policy table, and a blocking question parks the
 * task until a human answers. There is no timeout on the human.
 */
describe('PE-4 — the decision and the question (plan §9.2, §9.3)', () => {
  const DECISION = {
    title: 'the shape of the public API',
    context: 'the endpoint changes and every client has to follow it',
    options: ['keep the old shape and add a new one', 'replace the old shape'],
    selected: 'keep the old shape and add a new one',
    rationale: 'the old shape is used by two other services that cannot change in this release',
    reversible: true,
    touches: ['public_api'],
  };
  const QUESTION = {
    question: 'should the panel show the gate stamp next to the task?',
    options: ['yes, show it', 'no, keep the panel simple'],
    recommendation: 'yes, show it',
    impact_per_option: [
      'one more column in the board, and the drift becomes visible at a glance',
      'the board stays small, but a drifted task is only visible in the API',
    ],
    why_it_matters: 'a drifted task looks finished on the board while the ledger says it is not',
    blocking: true,
  };

  async function startTask(): Promise<Record<string, unknown>> {
    return json(
      await call('exec_task_start', {
        title: 'the decision and the question',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
  }

  it('B.9 a public_api decision is always approval, whatever the agent says', async () => {
    const task = await startTask();
    const res = await call('ledger_record_decision', { ...DECISION, task_ref: task.code });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.risk_level).toBe('approval');
    expect(body.approval_state).toBe('pending');
    expect(body.do_not_apply_until_human_approval).toBe(true);
    expect(body.approval_id).toBeTruthy();

    // The approval is a real row a human can decide.
    const approvals = await count('approval_requests', `action = 'exec.decision'`);
    expect(approvals).toBe(1);
  });

  it('F.3 db_schema always needs human approval; a low-risk rationale does not lower it', async () => {
    const task = await startTask();
    const res = await call('ledger_record_decision', {
      ...DECISION,
      task_ref: task.code,
      rationale: 'this is risk-free and needs no review, even though it changes the database schema',
      touches: ['db_schema'],
    });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const decision = json(res);
    expect(decision).toMatchObject({ risk_level: 'approval', approval_state: 'pending', do_not_apply_until_human_approval: true });

    const gate = json(await call('exec_task_complete', { task_ref: task.code }));
    expect(gate.ok).toBe(false);
    expect((gate.blocked_by as Record<string, unknown>[]).find((b) => b.rule === 4)).toMatchObject({ ref: decision.code });
  });

  it('B.9 the agent may not send its own risk level', async () => {
    const task = await startTask();
    const res = await call('ledger_record_decision', {
      ...DECISION,
      task_ref: task.code,
      risk_level: 'auto',
    });
    expect(res.isError).toBe(true);
    expect(await count('exec_decisions', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('B.11 a question without a matching impact per option is refused', async () => {
    const task = await startTask();
    const res = await call('ledger_ask_human', {
      ...QUESTION,
      task_ref: task.code,
      impact_per_option: ['only one impact for two options'],
    });
    expect(res.isError).toBe(true);
    expect(await count('exec_questions', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('a blocking question parks the task until a human answers', async () => {
    const task = await startTask();
    const res = await call('ledger_ask_human', { ...QUESTION, task_ref: task.code });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.code).toBeTruthy();
    expect(body.task_status).toBe('awaiting_review');

    const row = await sql<{ status: string; blocked_on_kind: string; unblock_condition: string }>`
      SELECT status, blocked_on_kind, unblock_condition FROM exec_tasks WHERE id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('awaiting_review');
    expect(row.rows[0]?.blocked_on_kind).toBe('question');
    expect(row.rows[0]?.unblock_condition).toContain(String(body.code));

    // The question is still open: there is no timeout, so the gate keeps refusing.
    const questions = await sql<{ status: string }>`
      SELECT status FROM exec_questions WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(questions.rows[0]?.status).toBe('open');
  });
});

/**
 * PE-4 §9.1 — `ledger_add_evidence` (acceptance B.10, B.16).
 *
 * "A claim without proof is forbidden" is only true if the write path READS
 * what it is told to record. These cases are about the refusals: a path that
 * is not there, a paraphrase that has no result line, and a secret that must
 * never reach the ledger.
 */
describe('PE-4 — evidence (plan §9.1)', () => {
  const SUMMARY = 'ran the vitest suite for the exec gate, 12 passed and 0 failed';
  const REAL_OUTPUT = `RUN START\n${'x'.repeat(240)}\nTests  12 passed | 0 failed (12)\nTest Files  3 passed (3)\nRUN END`;

  async function startTask(): Promise<Record<string, unknown>> {
    return json(
      await call('exec_task_start', {
        title: 'the evidence proves the criterion',
        acceptance_criteria: [GOOD],
        allowed_paths: ['apps/**'],
      }),
    );
  }

  it('B.10 a real test output proves the criterion and verifies it', async () => {
    const task = await startTask();
    const criterion = (task.criterion_codes as string[])[0];
    const res = await call('ledger_add_evidence', {
      task_ref: task.code,
      criterion_ref: criterion,
      kind: 'test_output',
      ref: 'test:exec > gate',
      summary: SUMMARY,
      payload: REAL_OUTPUT,
    });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.verified).toBe(true);
    expect(body.criterion_code).toBe(criterion);

    const row = await sql<{ status: string; verified_at: Date | null }>`
      SELECT status, verified_at FROM exec_criteria WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('verified');
    expect(row.rows[0]?.verified_at).not.toBeNull();

    // The event says what happened, in the same transaction.
    const events = await count('exec_events', `task_id = '${task.task_id}'::uuid AND action = 'evidence.added'`);
    expect(events).toBe(1);
  });

  it('B.10 a path that does not exist is refused, and nothing is written', async () => {
    const task = await startTask();
    const res = await call('ledger_add_evidence', {
      task_ref: task.code,
      kind: 'file',
      ref: 'file:apps/web/src/does-not-exist.ts',
      summary: 'the file that the change touched, which is not there',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/EVIDENCE_INVALID/);
    expect(await count('exec_evidence', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('B.10 a three-line paraphrase with no result line is refused', async () => {
    const task = await startTask();
    const res = await call('ledger_add_evidence', {
      task_ref: task.code,
      kind: 'test_output',
      ref: 'test:exec > gate',
      summary: SUMMARY,
      payload: 'the suite ran\nall green\nnothing to report here\n'.repeat(8),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/EVIDENCE_INVALID/);
    expect(await count('exec_evidence', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('B.16 a secret in the payload is masked before it is stored', async () => {
    const task = await startTask();
    const res = await call('ledger_add_evidence', {
      task_ref: task.code,
      kind: 'command_output',
      ref: 'cmd:npm run build',
      summary: SUMMARY,
      payload: `${REAL_OUTPUT}\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123`,
    });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const row = await sql<{ payload: string; meta: Record<string, unknown> }>`
      SELECT payload, meta FROM exec_evidence WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.payload).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect((row.rows[0]?.meta as { redacted?: number })?.redacted).toBeGreaterThan(0);
  });

  it('B.16 six kinds of secret never reach the ledger', async () => {
    const task = await startTask();
    const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Zm\n-----END RSA PRIVATE KEY-----';
    // One secret per field per write: the summary, the ref and the payload
    // are all places a secret hides.
    const cases: { secret: string; where: 'summary' | 'ref' | 'payload' }[] = [
      { secret: 'fpm_abcdefgh12345678', where: 'summary' },
      { secret: 'AKIAIOSFODNN7EXAMPLE', where: 'ref' },
      { secret: PEM, where: 'payload' },
      { secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123', where: 'summary' },
      { secret: 'sk-abcdefghijklmnopqrstuvwxyz0123', where: 'payload' },
      { secret: 'password: "hunter2hunter2"', where: 'summary' },
    ];
    for (const one of cases) {
      const summary =
        one.where === 'summary'
          ? `the log printed ${one.secret} and the run continued afterwards`
          : SUMMARY;
      const ref = one.where === 'ref' ? `cmd:cat ${one.secret}` : 'cmd:npm run build';
      const payload = one.where === 'payload' ? `${REAL_OUTPUT}\n${one.secret}` : REAL_OUTPUT;
      const res = await call('ledger_add_evidence', {
        task_ref: task.code,
        kind: 'command_output',
        ref,
        summary,
        payload,
      });
      expect(res.isError, `${one.secret}: ${JSON.stringify(res.content)}`).toBe(false);
    }
    // Nothing that was written may contain a secret, in any column.
    const rows = await sql<{ ref: string; summary: string; payload: string | null; meta: Record<string, unknown> }>`
      SELECT ref, summary, payload, meta FROM exec_evidence WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(rows.rows.length).toBe(cases.length);
    for (const one of cases) {
      for (const row of rows.rows) {
        expect(row.ref).not.toContain(one.secret);
        expect(row.summary).not.toContain(one.secret);
        expect(row.payload ?? '').not.toContain(one.secret);
      }
    }
    const redacted = rows.rows.reduce((sum, r) => sum + Number((r.meta as { redacted?: number })?.redacted ?? 0), 0);
    expect(redacted).toBeGreaterThanOrEqual(cases.length);
  });

  // The "a manual check may only be recorded by a human" law is a unit case
  // (`evidence.test.ts`, B.10c): it depends on WHO is calling, and an agent's
  // write stops at the approval gate before it ever reaches the service.
});

/** PE-5 F.7 — a policy denial is an auditable blocked attempt. */
describe('PE-5 — denied policy checks leave an exec event (F.7)', () => {
  it('denies secrets, root deletion and rm -rf /, and records each as blocked', async () => {
    const prefix = `pe5-${process.pid}-${Date.now()}`;
    const cases = [
      { action_kind: 'write_secret', target: `${prefix}/secret` },
      { action_kind: 'delete_root_folder', target: `${prefix}/workspace` },
      { action_kind: 'destructive_command', target: '/', command: 'rm -rf /' },
    ];
    for (const input of cases) {
      const result = await call('exec_policy_check', input);
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(json(result).level).toBe('deny');
    }

    const targets = cases.map((item) => item.target);
    const events = await sql<{ entity: string; category: string; target: string; outcome: string }>`
      SELECT entity, payload->>'category' AS category, payload->>'target' AS target,
             payload->>'outcome' AS outcome
      FROM exec_events
      WHERE organization_id = ${orgId}::uuid AND action = 'policy.denied'
        AND payload->>'target' = ANY(${targets}::text[])
    `.execute(db as never);
    expect(events.rows).toHaveLength(3);
    expect(events.rows.map((row) => row.entity)).toEqual(['policy', 'policy', 'policy']);
    expect(events.rows.map((row) => row.outcome)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(events.rows.map((row) => row.category)).toEqual(
      expect.arrayContaining(['write_secret', 'delete_root_folder', 'destructive_command']),
    );
  });
});

/**
 * PE-4 B.13 — the ledger answers a session that has never touched it.
 *
 * The status tool is the one a fresh session reaches for first ("what is
 * going on here?"), so it must not depend on anything the session said
 * before. The rows below are another session's leftovers, written straight
 * to the database: this session has not called a single tool, and the answer
 * still has to be the whole picture.
 */
describe('PE-4 B.13 — a fresh session gets the whole ledger', () => {
  it('ledger_status is complete with no context of its own', async () => {
    const other = await seedOrg(db, {
      email: `pe4-fresh-${process.pid}-${Date.now()}@example.invalid`,
      password: 'sup3r-s3cret-pass',
    });
    const states = await ensureWorkflow(db, other.projectId, other.organizationId);
    const workItemId = newId();
    await db
      .insertInto('work_items')
      .values({
        id: workItemId,
        organization_id: other.organizationId,
        project_id: other.projectId,
        number: 1,
        type: 'task',
        title: 'a task another session left behind',
        state_id: states[0]?.id as string,
      })
      .execute();
    const taskId = newId();
    await db
      .insertInto('exec_tasks')
      .values({
        id: taskId,
        organization_id: other.organizationId,
        project_id: other.projectId,
        work_item_id: workItemId,
        code: 'T-001',
        title: 'a task another session left behind',
        status: 'in_progress',
        allowed_paths: toJsonb(['apps/**']) as never,
      })
      .execute();
    await db
      .insertInto('exec_criteria')
      .values({
        id: newId(),
        task_id: taskId,
        code: 'C-001',
        text: 'the ledger tells the whole story of the task in one answer',
        status: 'pending',
      })
      .execute();
    await db
      .insertInto('exec_open_items')
      .values({
        id: newId(),
        organization_id: other.organizationId,
        task_id: taskId,
        code: 'OI-001',
        title: 'the migration is still missing from the branch',
        type: 'commitment',
        blocks_completion: true,
        source: 'agent',
        status: 'open',
      })
      .execute();
    await db
      .insertInto('exec_requirements')
      .values({
        id: newId(),
        organization_id: other.organizationId,
        project_id: other.projectId,
        code: 'REQ-001',
        text: 'the project keeps every promise it makes in writing',
        quote: 'the project keeps every promise',
        source: 'human',
      })
      .execute();

    // The first call of this session: no earlier tool, no earlier task.
    const res = await call(
      'exec_ledger_status',
      {},
      { ...actor(), organizationId: other.organizationId, id: other.userId, projectIds: [other.projectId] },
    );
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.empty).toBe(false);
    const view = (body.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect((view.task as { code: string }).code).toBe('T-001');
    expect((view.counts as { criteria: number }).criteria).toBe(1);
    expect(view.criteria_without_evidence).toEqual(['C-001']);
    expect(view.blockers).toEqual(['OI-001']);
    expect(view.requirements_uncovered).toContain('REQ-001');
    expect(view.ready_to_submit).toBe(false);
    expect((view.reasons_not_ready as string[]).length).toBeGreaterThan(0);
  });
});

describe('PE-3 — the finalization gate (plan §8.2)', () => {
  const SUMMARY = 'the gate now closes a task only when the ledger can prove every criterion';

  async function readyTask(
    opts: { verifiable?: boolean } = {},
  ): Promise<{ task: Record<string, unknown>; evidenceId: string; criterionCode: string }> {
    const task = json(
      await call('exec_task_start', {
        title: 'a task the gate may close',
        acceptance_criteria: [GOOD],
        allowed_paths: ['packages/core/src/exec/**'],
      }),
    );
    await db.updateTable('exec_tasks').set({ start_ref: 'test-baseline' }).where('id', '=', task.task_id as string).execute();
    const criterionId = (task.criterion_ids as string[])[0];
    const evidenceId = newId();
    const verifiable = opts.verifiable !== false;
    await db
      .insertInto('exec_evidence')
      .values({
        id: evidenceId,
        organization_id: orgId,
        task_id: task.task_id as string,
        criterion_id: criterionId,
        kind: 'test_output',
        // An unverifiable row: the ref points nowhere and nothing was captured.
        ref: verifiable ? 'test:exec-gate' : 'test:unverifiable',
        summary: 'the gate refuses a task whose criterion has no evidence at all',
        payload: verifiable ? '1 passed' : null,
        sha256: verifiable ? 'a'.repeat(64) : null,
        size_bytes: verifiable ? 9 : null,
        recorded_by: userId,
      })
      .execute();
    await db
      .insertInto('exec_reviews')
      .values({
        id: newId(),
        organization_id: orgId,
        task_id: task.task_id as string,
        round: 1,
        verdict: 'pass',
        findings: toJsonb([]) as never,
        checked: toJsonb(['the diff']) as never,
        tree_hash: 't'.repeat(40),
      })
      .execute();
    return { task, evidenceId, criterionCode: (task.criterion_codes as string[])[0] };
  }

  const report = (
    task: Record<string, unknown>,
    evidenceId: string,
    over: Record<string, unknown> = {},
    criterionCode?: string,
  ) => ({
    task_ref: task.code as string,
    summary: SUMMARY,
    changed_files: ['packages/core/src/exec/gate.ts'],
    completed_items: ['the gate is split into one file per rule'],
    incomplete: [],
    assumptions: [],
    decisions_made: [],
    risks_found: [],
    tests_executed: [{ name: 'exec > gate', result: 'pass', evidence_id: evidenceId }],
    tests_not_run: [],
    out_of_scope_findings: [],
    criteria_status: criterionCode ? [{ criterion_ref: criterionCode, evidence_refs: [evidenceId] }] : [],
    req_ids_covered: [],
    scope_deviations: [],
    facts_recorded: [],
    none_confirmed: {
      incomplete: true,
      assumptions: true,
      decisions_made: true,
      risks_found: true,
      tests_not_run: true,
      out_of_scope_findings: true,
      req_ids_covered: true,
      scope_deviations: true,
    },
    ...over,
  });

  it('a task with a blocking item is refused, with the rule and the item code', async () => {
    const { task } = await readyTask();
    const item = json(
      await call('ledger_add_open_item', {
        task_ref: task.code as string,
        title: 'the migration is still missing',
        type: 'commitment',
      }),
    );
    const res = await call('exec_task_complete', { task_ref: task.code as string });
    expect(res.isError).toBe(false); // a refusal is an answer, not an error
    const body = json(res);
    expect(body.ok).toBe(false);
    const blocked = (body.blocked_by as Record<string, unknown>[]).find((b) => b.rule === 2);
    expect(blocked?.ref).toBe(item.code);
    expect(String(blocked?.needed)).toMatch(/resolve/);
    expect(blocked?.tool_to_call).toBe('ledger_resolve_item');
    // ...and the task is not closed.
    const row = await sql<{ status: string }>`
      SELECT status FROM exec_tasks WHERE id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.status).not.toBe('done');
  });

  it('a criterion without verifiable evidence keeps the task open (C.2)', async () => {
    // The evidence row exists, but it points nowhere and captured nothing: the
    // ledger has a row, not a proof. (`exec_evidence` is append-only, so the
    // only honest way to have "no proof" is to have written one that is not one.)
    const { task, evidenceId } = await readyTask({ verifiable: false });
    const submitted = await call('exec_submit_exit_report', report(task, evidenceId, {}, undefined));
    expect(submitted.isError, JSON.stringify(submitted.content)).toBe(false);
    const body = json(await call('exec_task_complete', { task_ref: task.code as string }));
    expect(body.ok).toBe(false);
    const blocked = (body.blocked_by as Record<string, unknown>[]).find((b) => b.rule === 3);
    expect(blocked).toBeDefined();
    expect(String(blocked?.needed)).toMatch(/not verifiable/);
  });

  it('a clean task closes and automatically unblocks its dependent', async () => {
    const { task, evidenceId, criterionCode } = await readyTask();
    const dependent = json(await call('exec_task_start', {
      title: 'the dependent task resumes after its prerequisite closes',
      acceptance_criteria: [GOOD],
      allowed_paths: ['packages/core/src/exec/**'],
    }));
    const dependency = await call('exec_link_dep', { task_ref: dependent.code as string, depends_on_ref: task.code as string });
    expect(dependency.isError, dependency.content[0]?.text).toBe(false);
    const blocked = await call('task_block', {
      task_ref: dependent.code as string,
      reason: 'waiting for the prerequisite task to finish before implementation can resume',
      blocked_on_kind: 'task',
      blocked_on_ref: task.code as string,
      unblock_condition: 'the prerequisite task must be done',
    });
    expect(blocked.isError).toBe(false);
    await waiveUnavailableMeasurements(task.code as string);
    const submitted = await call('exec_submit_exit_report', report(task, evidenceId, {}, criterionCode));
    expect(submitted.isError, JSON.stringify(submitted.content)).toBe(false);
    const res = await call('exec_task_complete', { task_ref: task.code as string });
    expect(res.isError, JSON.stringify(res.content)).toBe(false);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('done');

    const stamp = await sql<{ ok: boolean; gate_version: number; tree_hash: string; run_source: string }>`
      SELECT ok, gate_version, tree_hash, run_source FROM exec_gate_checks WHERE task_id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(stamp.rows.length).toBe(1);
    expect(stamp.rows[0]?.ok).toBe(true);
    expect(stamp.rows[0]?.gate_version).toBe(GATE_VERSION);
    expect(stamp.rows[0]?.run_source).toBe('human');
    const row = await sql<{ status: string; closed_at: Date | null; gate_stamp_id: string | null }>`
      SELECT status, closed_at, gate_stamp_id::text AS gate_stamp_id FROM exec_tasks WHERE id = ${task.task_id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('done');
    expect(row.rows[0]?.closed_at).not.toBeNull();
    expect(row.rows[0]?.gate_stamp_id).toBeTruthy();
    const resumed = await sql<{ status: string }>`SELECT status FROM exec_tasks WHERE id = ${dependent.task_id}::uuid`.execute(db as never);
    expect(resumed.rows[0]?.status).toBe('in_progress');
    const unblocked = await sql<{ action: string }>`
      SELECT action FROM exec_events WHERE task_id = ${dependent.task_id}::uuid AND action = 'task.unblocked'
    `.execute(db as never);
    expect(unblocked.rows).toHaveLength(1);
    const session = json(await call('session_start', {}));
    expect((session.recently_unblocked as Record<string, unknown>[]).map((item) => item.task_code)).toContain(dependent.code);
  });

  it('C.6 the completion report is the ledger, not the message', async () => {
    const { task, evidenceId, criterionCode } = await readyTask();
    await waiveUnavailableMeasurements(task.code as string);
    await call('exec_submit_exit_report', report(task, evidenceId, {}, criterionCode));
    const body = json(await call('exec_task_complete', { task_ref: task.code as string }));
    const final = body.final_report as Record<string, unknown>;
    expect(final.task).toBe(task.code);
    // The criterion was declared met in the report, and the ledger recorded it —
    // so the completion report lists it, with the number of proofs behind it.
    expect((final.counts as Record<string, number>).criteria_verified).toBe(1);
    expect((final.counts as Record<string, number>).criteria_pending).toBe(0);
    expect((final.completed as Record<string, unknown>[])[0]?.criterion).toBe(GOOD);
    expect((final.completed as Record<string, unknown>[])[0]?.evidence).toBe(1);
  });

  it('a criterion the report declares met without a proof is refused', async () => {
    const { task, evidenceId, criterionCode } = await readyTask();
    const res = await call(
      'exec_submit_exit_report',
      report(task, evidenceId, { criteria_status: [{ criterion_ref: criterionCode, evidence_refs: [newId()] }] }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/EVIDENCE_INVALID/);
    expect(await count('exec_reports', `task_id = '${task.task_id}'::uuid`)).toBe(0);
  });

  it('the gate does not close the open items for you', async () => {
    const { task, evidenceId, criterionCode } = await readyTask();
    const item = json(
      await call('ledger_add_open_item', {
        task_ref: task.code as string,
        title: 'an accepted note stays visible',
        type: 'suggestion',
      }),
    );
    await call('exec_submit_exit_report', report(task, evidenceId, {}, criterionCode));
    await call('exec_task_complete', { task_ref: task.code as string });
    const row = await sql<{ status: string; resolved_by: string | null }>`
      SELECT status, resolved_by FROM exec_open_items WHERE id = ${item.id}::uuid
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('open');
    expect(row.rows[0]?.resolved_by).toBeNull();
  });

  it('the refusal is recorded too — a refused close is evidence as well', async () => {
    const { task, evidenceId } = await readyTask({ verifiable: false });
    await call('exec_submit_exit_report', report(task, evidenceId, {}, undefined));
    await call('exec_task_complete', { task_ref: task.code as string });
    const stamps = await count('exec_gate_checks', `task_id = '${task.task_id}'::uuid`);
    expect(stamps).toBe(1);
    const events = await count('exec_events', `task_id = '${task.task_id}'::uuid AND action = 'gate.failed'`);
    expect(events).toBe(1);
  });

  it('a task with no report is refused by rule 1 — and no stamp pretends otherwise', async () => {
    // The schema makes a stamp reference a report (report_id is NOT NULL, a
    // foreign key), so a task with no report leaves an event, not a row that
    // points at nothing.
    const { task } = await readyTask();
    const body = json(await call('exec_task_complete', { task_ref: task.code as string }));
    expect(body.ok).toBe(false);
    expect((body.blocked_by as Record<string, unknown>[]).some((b) => b.rule === 1)).toBe(true);
    expect(await count('exec_gate_checks', `task_id = '${task.task_id}'::uuid`)).toBe(0);
    expect(await count('exec_events', `task_id = '${task.task_id}'::uuid AND action = 'gate.failed'`)).toBe(1);
  });
});
