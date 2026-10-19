import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import {
  ModuleRegistry,
  answerQuestion,
  applyExecApprovalDecision,
  cancelSubtask,
  newId,
  setExecReviewSource,
  toJsonb,
  unblockDependencyTasks,
  unitOfWork,
  upsertSetting,
  type Db,
  type LedgerActor,
} from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const GOOD = 'POST /api/items returns 201 and persists one row; test:exec-requirements-plan_create';
const NEW_REQUIREMENT = 'The API returns status 202 for accepted events and writes one outbox row; test:req_change_202';

interface Context {
  orgId: string;
  projectId: string;
  userId: string;
  actor: Actor;
  ledger: LedgerActor;
  call(name: string, args: Record<string, unknown>): ReturnType<typeof callTool>;
}

let h: Harness;
let db: Db;
let deps: McpDeps;
let sequence = 0;

const json = async (promise: ReturnType<Context['call']>): Promise<Record<string, unknown>> => {
  const result = await promise;
  if (result.isError) throw new Error(result.content[0]?.text ?? 'MCP call failed');
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
};

async function context(): Promise<Context> {
  const seeded = await seedOrg(db, {
    email: `pe9-${process.pid}-${Date.now()}-${(sequence += 1)}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  const actor = {
    type: 'user',
    id: seeded.userId,
    organizationId: seeded.organizationId,
    orgRole: 'owner',
    projectRole: () => 'lead',
    scopes: ['read', 'write', 'ledger:read', 'ledger:write'],
    projectIds: [seeded.projectId],
    requestId: `pe9-${sequence}`,
  } as Actor;
  const ledger: LedgerActor = {
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    actorType: 'human',
    actorId: seeded.userId,
    tool: 'test:pe9',
  };
  return {
    orgId: seeded.organizationId,
    projectId: seeded.projectId,
    userId: seeded.userId,
    actor,
    ledger,
    call: (name, args) => callTool(deps, actor, name, args, `${actor.requestId}-${(sequence += 1)}`),
  };
}

async function addReq(ctx: Context, text = 'The API returns status 201 for valid items and writes one row; test:req_create_201', quote = 'The API returns status 201 for valid items', contradicts: string[] = []) {
  return json(ctx.call('req_add', { text, quote, source: 'user_message', kind: 'functional', priority: 'high', contradicts }));
}

async function createTask(
  ctx: Context,
  title: string,
  reqIds: string[] = [],
  criteria: string[] = [GOOD],
): Promise<Record<string, unknown>> {
  return json(ctx.call('exec_task_start', {
    title,
    acceptance_criteria: criteria,
    req_ids: reqIds,
    allowed_paths: ['packages/core/src/exec/**'],
  }));
}

async function row<T>(query: RawBuilder<T>): Promise<T> {
  const result = await query.execute(db as never);
  const first = result.rows[0];
  if (!first) throw new Error('expected database row');
  return first;
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  setExecReviewSource({
    snapshot: async () => ({ files: [], tree_hash: 'a'.repeat(64) }),
    treeHash: async () => 'a'.repeat(64),
    headSha: async () => 'b'.repeat(40),
  });
  const registry = new ModuleRegistry();
  registry.register({ name: 'exec' });
  registry.invalidate();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();
});

afterAll(async () => {
  setExecReviewSource(null);
  await h?.cleanup();
});

describe('PE-9 requirements and planning tools', () => {
  it('requires exact quotes, assigns uncovered requirements, and keeps declarations separate from coverage', async () => {
    const ctx = await context();
    const invalid = await ctx.call('req_add', {
      text: 'The API returns status 201 for valid items and writes one row; test:req_create_201',
      quote: 'The API should return 201',
      source: 'user_message',
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toMatch(/UNPROCESSABLE/);

    const req = await addReq(ctx);
    const uncoveredSession = await json(ctx.call('session_start', {}));
    expect(uncoveredSession.uncovered_requirements).toContain(req.code);
    const uncoveredPlan = await json(ctx.call('exec_plan_view', {}));
    const unassignedRequirement = (uncoveredPlan.requirements as Record<string, unknown>).requirements as Record<string, unknown>[];
    expect(unassignedRequirement.find((item) => item.code === req.code)).toMatchObject({ coverage: 'unassigned' });
    const unassignedStart = await ctx.call('exec_task_start', {
      title: 'task start must cover unassigned requirements',
      acceptance_criteria: [GOOD],
      allowed_paths: ['packages/core/src/exec/**'],
    });
    expect(unassignedStart.isError).toBe(true);
    expect(unassignedStart.content[0]?.text).toMatch(/REQUIREMENT_UNCOVERED/);
    expect(unassignedStart.content[0]?.text).toContain(String(req.code));

    const task = await createTask(ctx, 'declared requirement task', [String(req.id)], [
      GOOD,
      'The API returns status 201 and persists one audit row; test:req_audit_201',
    ]);
    const initialCoverage = await json(ctx.call('req_coverage', {}));
    const requirement = (initialCoverage.requirements as Record<string, unknown>[]).find((item) => item.code === req.code);
    expect(requirement).toMatchObject({ coverage: 'assigned', assignment_tasks: [task.code], linked_criteria: [] });
    expect(task.req_ids).toEqual([req.id]);
    const assignedSession = await json(ctx.call('session_start', {}));
    expect(assignedSession.uncovered_requirements).not.toContain(req.code);

    const linked = await json(ctx.call('req_link_task', {
      requirement_ref: req.code,
      task_ref: task.code,
      criterion_refs: (task.criterion_codes as string[]).map(String),
    }));
    expect(linked).toMatchObject({ requirement: req.code, task: task.code, criteria: task.criterion_codes });
    const coverage = await json(ctx.call('req_coverage', {}));
    const linkedRequirement = (coverage.requirements as Record<string, unknown>[]).find((item) => item.code === req.code);
    expect(linkedRequirement).toMatchObject({ coverage: 'in_progress', assignment_tasks: [task.code] });
    expect(linkedRequirement?.linked_criteria).toMatchObject([
      { status: 'pending', evidence_count: 0 },
      { status: 'pending', evidence_count: 0 },
    ]);

    const criterionIds = task.criterion_ids as string[];
    for (const [index, criterionId] of criterionIds.entries()) {
      await sql`
        INSERT INTO exec_evidence (id, organization_id, task_id, criterion_id, kind, ref, summary, recorded_by)
        VALUES (${newId()}::uuid, ${ctx.orgId}::uuid, ${String(task.task_id)}::uuid, ${criterionId}::uuid,
          'manual_check', ${`manual:req-coverage-${index}`}, 'human confirmed the criterion with a repeatable check', ${ctx.userId})
      `.execute(db as never);
      if (index === 0) {
        await db.updateTable('exec_criteria').set({ status: 'verified', verified_at: new Date() }).where('id', '=', criterionId).execute();
      }
    }
    const partialCoverage = await json(ctx.call('req_coverage', {}));
    const partiallyCovered = (partialCoverage.requirements as Record<string, unknown>[]).find((item) => item.code === req.code);
    expect(partiallyCovered).toMatchObject({ coverage: 'in_progress' });

    const lastCriterionId = criterionIds[1]!;
    await db.updateTable('exec_criteria').set({ status: 'verified', verified_at: new Date() }).where('id', '=', lastCriterionId).execute();
    const verifiedCoverage = await json(ctx.call('req_coverage', {}));
    const covered = (verifiedCoverage.requirements as Record<string, unknown>[]).find((item) => item.code === req.code);
    expect(covered).toMatchObject({ coverage: 'covered' });
  });

  it('reopens changed requirements without deleting evidence and marks dependent decisions for revisit', async () => {
    const ctx = await context();
    const req = await addReq(ctx);
    const task = await createTask(ctx, 'requirement change reopens completed work', [String(req.id)]);
    const criterionId = String((task.criterion_ids as string[])[0]);
    const criterionCode = String((task.criterion_codes as string[])[0]);
    await json(ctx.call('req_link_task', {
      requirement_ref: req.code,
      task_ref: task.code,
      criterion_refs: [criterionCode],
    }));
    const evidenceId = newId();
    await sql`
      INSERT INTO exec_evidence (id, organization_id, task_id, criterion_id, kind, ref, summary, recorded_by)
      VALUES (${evidenceId}::uuid, ${ctx.orgId}::uuid, ${String(task.task_id)}::uuid, ${criterionId}::uuid,
        'manual_check', 'manual:req-change', 'human confirmed the previous requirement wording', ${ctx.userId})
    `.execute(db as never);
    const decisionId = newId();
    await sql`
      INSERT INTO exec_decisions (id, organization_id, task_id, code, title, context, options, selected, rationale,
        touches, reversible, risk_level, approval_state, status, review_trigger)
      VALUES (${decisionId}::uuid, ${ctx.orgId}::uuid, ${String(task.task_id)}::uuid, 'D-001',
        'choose the response contract', 'The requirement informs the response code.',
        ${toJsonb(['201', '202']) as never}::jsonb, '201',
        'This selection follows the quoted requirement and keeps the API contract stable.',
        ARRAY['none']::text[], true, 'auto', 'not_required', 'active',
        ${toJsonb({ req_codes: [req.code] }) as never}::jsonb)
    `.execute(db as never);
    await db.updateTable('exec_tasks').set({ status: 'done', closed_at: new Date() }).where('id', '=', String(task.task_id)).execute();

    const changed = await json(ctx.call('req_change', {
      requirement_ref: req.code,
      text: NEW_REQUIREMENT,
      quote: 'The API returns status 202 for accepted events',
      source: 'user_message',
      kind: 'functional',
      priority: 'high',
    }));
    expect(changed).toMatchObject({
      status: 'changed',
      revisited_criteria: [criterionCode],
      stale_evidence: [evidenceId],
      revisited_decisions: ['D-001'],
      reopened_tasks: [task.code],
    });
    expect((changed.blocker_items as string[])).toHaveLength(1);
    const criterion = await row(sql<{ status: string }>`SELECT status FROM exec_criteria WHERE id = ${criterionId}::uuid`);
    const decision = await row(sql<{ status: string }>`SELECT status FROM exec_decisions WHERE id = ${decisionId}::uuid`);
    const reopened = await row(sql<{ status: string }>`SELECT status FROM exec_tasks WHERE id = ${String(task.task_id)}::uuid`);
    const blocker = await row(sql<{ type: string; blocks_completion: boolean; status: string }>`
      SELECT type, blocks_completion, status FROM exec_open_items WHERE code = ${(changed.blocker_items as string[])[0]}
    `);
    const evidence = await row(sql<{ id: string }>`SELECT id::text AS id FROM exec_evidence WHERE id = ${evidenceId}::uuid`);
    expect(criterion.status).toBe('pending');
    expect(decision.status).toBe('needs_revisit');
    expect(reopened.status).toBe('in_progress');
    expect(blocker).toMatchObject({ type: 'incomplete_requirement', blocks_completion: true, status: 'open' });
    expect(evidence.id).toBe(evidenceId);
  });

  it('materializes an explicit same-kind/priority conflict as a blocking item and human question', async () => {
    const ctx = await context();
    const left = await addReq(ctx, 'The API returns status 201 for created events and writes one row; test:req_201', 'The API returns status 201');
    const right = await addReq(
      ctx,
      'The API returns status 202 for created events and writes one row; test:req_202',
      'The API returns status 202',
      [String(left.code)],
    );
    const task = await createTask(ctx, 'task with explicitly conflicting requirements', [String(left.id), String(right.id)]);
    const result = await json(ctx.call('req_link_task', {
      requirement_ref: left.code,
      task_ref: task.code,
      criterion_refs: [String((task.criterion_codes as string[])[0])],
    }));
    expect(result.conflicts).toMatchObject([{ conflict: `${left.code}:${right.code}`, task: task.code }]);
    const item = await row(sql<{ type: string; blocks_completion: boolean }>`
      SELECT type, blocks_completion FROM exec_open_items WHERE task_id = ${String(task.task_id)}::uuid
    `);
    const question = await row(sql<{ blocking: boolean; status: string }>`
      SELECT blocking, status FROM exec_questions WHERE task_id = ${String(task.task_id)}::uuid
    `);
    const status = await row(sql<{ status: string }>`SELECT status FROM exec_tasks WHERE id = ${String(task.task_id)}::uuid`);
    expect(item).toMatchObject({ type: 'design_gap', blocks_completion: true });
    expect(question).toMatchObject({ blocking: true, status: 'open' });
    expect(status.status).toBe('awaiting_review');
  });

  it('splits tasks, rejects cycle lengths one through three, and returns the exact pending dependency', async () => {
    const ctx = await context();
    const parent = await createTask(ctx, 'task plan parent');
    const child = (key: string, depends_on: string[] = []) => ({
      key,
      title: `Implement ${key} child`,
      acceptance_criteria: [GOOD],
      allowed_paths: ['packages/core/src/exec/**'],
      depends_on,
    });
    const cycles = [
      [child('one', ['one']), child('two')],
      [child('one', ['two']), child('two', ['one'])],
      [child('one', ['two']), child('two', ['three']), child('three', ['one'])],
    ];
    for (const children of cycles) {
      const result = await ctx.call('task_split', { parent_ref: parent.code, children });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/DEPENDENCY_CYCLE/);
    }

    const split = await json(ctx.call('task_split', {
      parent_ref: parent.code,
      children: [child('prepare'), child('finish', ['prepare'])],
    }));
    const children = split.children as Record<string, unknown>[];
    const prepare = children.find((item) => item.key === 'prepare')!;
    const finish = children.find((item) => item.key === 'finish')!;
    const early = await ctx.call('task_start', { task_ref: finish.code });
    expect(early.isError).toBe(true);
    expect(early.content[0]?.text).toContain(String(prepare.code));
    expect(early.content[0]?.text).toMatch(/pending dependencies/);
    await json(ctx.call('task_block', {
      task_ref: finish.code,
      reason: 'waiting for the prerequisite child task to finish before continuing',
      blocked_on_kind: 'task',
      blocked_on_ref: String(prepare.code),
      unblock_condition: `${prepare.code} must be done`,
    }));
    const started = await json(ctx.call('task_start', { task_ref: prepare.code }));
    expect(started.status).toBe('in_progress');

    await db.updateTable('exec_tasks').set({ status: 'done', closed_at: new Date() }).where('id', '=', String(prepare.task_id)).execute();
    let unblocked: string[] = [];
    await unitOfWork(db, async ({ tx }) => {
      unblocked = await unblockDependencyTasks(tx, String(prepare.task_id));
    });
    expect(unblocked).toEqual([finish.code]);
    const current = await row(sql<{ status: string }>`SELECT status FROM exec_tasks WHERE id = ${String(finish.task_id)}::uuid`);
    expect(current.status).toBe('in_progress');
    const session = await json(ctx.call('session_start', {}));
    expect(session.uncovered_requirement_count).toBe(0);
    expect((session.recently_unblocked as Record<string, unknown>[]).map((item) => item.task_code)).toContain(finish.code);
  });

  it('persists blockers outside in-progress, serializes blocked distinctly, and human-cancels a linked child', async () => {
    const ctx = await context();
    const parent = await createTask(ctx, 'parent for block and cancellation');
    const req = await addReq(ctx);
    const split = await json(ctx.call('task_split', {
      parent_ref: parent.code,
      children: [
        {
          key: 'linked',
          title: 'Linked requirement child',
          acceptance_criteria: [GOOD],
          req_ids: [String(req.id)],
          allowed_paths: ['packages/core/src/exec/**'],
        },
        {
          key: 'blocked',
          title: 'Externally blocked child',
          acceptance_criteria: [GOOD],
          allowed_paths: ['packages/core/src/exec/**'],
        },
      ],
    }));
    const children = split.children as Record<string, unknown>[];
    const linked = children.find((item) => item.key === 'linked')!;
    const blocked = children.find((item) => item.key === 'blocked')!;
    await json(ctx.call('req_link_task', {
      requirement_ref: req.code,
      task_ref: linked.code,
      criterion_refs: [String((linked.criterion_codes as string[])[0])],
    }));

    await expect(
      cancelSubtask(db, { ...ctx.ledger, actorType: 'agent' }, String(parent.code), String(linked.code), 'human reviewed cancellation'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const canceled = await cancelSubtask(db, ctx.ledger, String(parent.code), String(linked.code), 'human reviewed cancellation');
    expect(canceled).toMatchObject({ status: 'canceled', parent: parent.code, task: linked.code, linked_requirements: [req.code] });
    const approval = await row(sql<{ action: string; status: string }>`
      SELECT action, status FROM approval_requests WHERE id = ${canceled.approval_id}::uuid
    `);
    expect(approval).toMatchObject({ action: 'exec.cancel_subtask', status: 'approved' });

    const missingCondition = await ctx.call('task_block', {
      task_ref: blocked.code,
      reason: 'waiting for an external service contract before this child can proceed',
      blocked_on_kind: 'external',
    });
    expect(missingCondition.isError).toBe(true);
    expect(missingCondition.content[0]?.text).toMatch(/unblock_condition/);
    const blockedResult = await json(ctx.call('task_block', {
      task_ref: blocked.code,
      reason: 'waiting for an external service contract before this child can proceed',
      blocked_on_kind: 'external',
      unblock_condition: 'the service endpoint is available',
    }));
    expect(blockedResult.status).toBe('blocked');
    const workItem = await row(sql<{ category: string }>`
      SELECT s.category FROM exec_tasks t JOIN work_items w ON w.id = t.work_item_id
      JOIN workflow_states s ON s.id = w.state_id WHERE t.id = ${String(blocked.task_id)}::uuid
    `);
    expect(['backlog', 'unstarted']).toContain(workItem.category);
    const plan = await json(ctx.call('exec_plan_view', { task_ref: parent.code }));
    const root = (plan.roots as Record<string, unknown>[])[0]!;
    const planChildren = root.children as Record<string, unknown>[];
    expect(planChildren.find((item) => item.code === blocked.code)).toMatchObject({ status: 'blocked', display_status: 'blocked' });
    expect(planChildren.find((item) => item.code === linked.code)).toMatchObject({ display_status: 'canceled', canceled_by_human: true });
  });

  it('automatically unblocks a task after its blocking question is answered', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'task waiting for human answer');
    const asked = await json(ctx.call('ledger_ask_human', {
      task_ref: task.code,
      question: 'Should the new endpoint return 201 or 202?',
      options: ['Return 201', 'Return 202'],
      recommendation: 'Return 201',
      impact_per_option: ['Preserves the current client contract.', 'Requires client updates before rollout.'],
      why_it_matters: 'The response code is part of the public contract and drives downstream retries.',
      blocking: true,
      kind: 'generic',
    }));
    expect(asked.task_status).toBe('awaiting_review');
    let answer: Awaited<ReturnType<typeof answerQuestion>> | undefined;
    await unitOfWork(db, async ({ tx }) => {
      answer = await answerQuestion(tx, ctx.ledger, String(asked.code), 'Return 201');
    });
    expect(answer?.task_status).toBe('in_progress');
    const event = await row(sql<{ action: string; actor_type: string; payload: Record<string, unknown> }>`
      SELECT action, actor_type, payload FROM exec_events
      WHERE task_id = ${String(task.task_id)}::uuid AND action = 'task.unblocked'
    `);
    expect(event).toMatchObject({ action: 'task.unblocked', actor_type: 'system' });
    expect(event.payload).toMatchObject({ reason: 'question_answered', blocker_kind: 'question' });
  });

  it('unblocks a decision blocker only after the human approval is applied', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'task waiting for decision approval');
    const decision = await json(ctx.call('ledger_record_decision', {
      task_ref: task.code,
      title: 'choose the database change',
      context: 'The implementation needs a new nullable database column.',
      options: ['Add the column', 'Keep the existing schema'],
      selected: 'Add the column',
      rationale: 'The existing data shape cannot express the requested state without the new nullable column.',
      reversible: true,
      touches: ['db_schema'],
    }));
    expect(decision.approval_state).toBe('pending');
    await json(ctx.call('task_block', {
      task_ref: task.code,
      reason: 'waiting for human approval before applying the database decision',
      blocked_on_kind: 'decision',
      blocked_on_ref: String(decision.code),
      unblock_condition: 'a human approves the linked decision',
    }));
    await unitOfWork(db, async ({ tx }) => {
      await tx.updateTable('approval_requests').set({
        status: 'approved',
        decided_by: ctx.userId,
        decided_at: new Date(),
        reason: 'approved in PE-9 integration test',
      }).where('id', '=', String(decision.approval_id)).execute();
      await applyExecApprovalDecision(tx, {
        action: 'exec.decision',
        payload: { decision_id: decision.id },
        decision: 'approved',
        reason: 'approved in PE-9 integration test',
        actorId: ctx.userId,
        organizationId: ctx.orgId,
        tool: 'test:approval',
      });
    });
    const current = await row(sql<{ status: string }>`SELECT status FROM exec_tasks WHERE id = ${String(task.task_id)}::uuid`);
    expect(current.status).toBe('in_progress');
  });
});
