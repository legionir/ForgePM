import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  GATE_VERSION,
  MCP_MAX_OUTPUT_BYTES,
  ModuleRegistry,
  dryRunGate,
  makeScopeManifest,
  newId,
  setExecReviewSource,
  toJsonb,
  upsertSetting,
  type Db,
} from '@forgepm/core';
import { sessionSnapshotSchema } from '@forgepm/shared';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const GOOD = 'The journal must record its result before Gate closes the task; test:exec-journal-session';
const ROOTS = ['packages/core/src/exec'];
const FILE = 'packages/core/src/exec/journal.ts';

let h: Harness;
let db: Db;
let deps: McpDeps;
let liveManifest = makeScopeManifest([{ path: FILE, sha256: 'a'.repeat(64) }]);
let measuredChanges: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'T' }[] = [];
let sequence = 0;

async function context(): Promise<{ actor: Actor; projectId: string; userId: string; call: (name: string, args: Record<string, unknown>) => ReturnType<typeof callTool> }> {
  const seeded = await seedOrg(db, {
    email: `pe10-${process.pid}-${Date.now()}-${(sequence += 1)}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  const actor = {
    type: 'agent',
    id: seeded.userId,
    organizationId: seeded.organizationId,
    orgRole: 'owner',
    projectRole: () => 'lead',
    scopes: ['read', 'write', 'ledger:read', 'ledger:write'],
    projectIds: [seeded.projectId],
    requestId: `pe10-${sequence}`,
  } as Actor;
  return {
    actor,
    projectId: seeded.projectId,
    userId: seeded.userId,
    call: (name, args) => callTool(deps, actor, name, args, `${actor.requestId}-${(sequence += 1)}`),
  };
}

async function json(result: ReturnType<typeof callTool>): Promise<Record<string, unknown>> {
  const response = await result;
  if (response.isError) throw new Error(response.content[0]?.text ?? 'MCP call failed');
  return JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function createTask(ctx: Awaited<ReturnType<typeof context>>, suffix: string): Promise<Record<string, unknown>> {
  // Seed tasks through the human path; every journal and recovery assertion below uses the agent actor.
  const human = { ...ctx.actor, type: 'user', requestId: `${ctx.actor.requestId}-task-start` } as Actor;
  return json(callTool(deps, human, 'exec_task_start', {
    title: `PE-10 ${suffix} task`,
    acceptance_criteria: [GOOD],
    allowed_paths: ['packages/core/src/exec/**'],
  }, human.requestId));
}

async function startJournal(
  ctx: Awaited<ReturnType<typeof context>>,
  taskCode: string,
  idempotent: boolean,
  action = 'apply migration',
  target = 'schema:alpha',
): Promise<Record<string, unknown>> {
  return json(ctx.call('journal_start', {
    task_ref: taskCode,
    action,
    target,
    idempotent,
    expected_effect: 'the requested schema change is applied exactly once',
  }));
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  setExecReviewSource({
    snapshot: async () => ({ files: [], tree_hash: liveManifest.hash }),
    treeHash: async () => liveManifest.hash,
    headSha: async () => 'b'.repeat(40),
    isWorktreeClean: async () => true,
    captureJournalPreState: async () => 'git rev-parse HEAD:.\n' + 'c'.repeat(40) + '\ngit status --porcelain\n',
    fileSnapshot: async () => liveManifest,
    changedFiles: async () => measuredChanges,
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

describe('PE-10 journal, session resume, and reconciliation', () => {
  it('K.1 marks started actions unknown on a new session and puts them first in the journal section', async () => {
    const ctx = await context();
    await upsertSetting(db, 'project', ctx.projectId, 'exec.allowed_repo_roots', ROOTS);
    const task = await createTask(ctx, 'crash resume');
    const journal = await startJournal(ctx, String(task.code), false);
    const stored = await sql<{ pre_state_ref: string | null; status: string }>`
      SELECT pre_state_ref, status FROM exec_action_journal WHERE id = ${String(journal.id)}::uuid
    `.execute(db as never);
    expect(stored.rows[0]?.pre_state_ref).toContain('git rev-parse HEAD:.');
    expect(stored.rows[0]?.pre_state_ref).toContain('git status --porcelain');
    expect(stored.rows[0]?.status).toBe('started');

    const session = await json(ctx.call('session_start', {}));
    expect(sessionSnapshotSchema.safeParse(session).success).toBe(true);
    const sections = session.sections as Record<string, unknown>[];
    expect(sections.map((section) => section.key)).toEqual([
      'human_pending',
      'journal_unknown',
      'blocking_open_items',
      'stale_facts_and_revisits',
      'uncovered_requirements',
      'tasks',
    ]);
    const journalSection = sections[1] as { shown: Record<string, unknown>[] };
    expect(journalSection.shown[0]).toMatchObject({ code: journal.code, status: 'unknown' });
    const reset = await sql<{ status: string; finished_at: Date | null }>`
      SELECT status, finished_at FROM exec_action_journal WHERE id = ${String(journal.id)}::uuid
    `.execute(db as never);
    expect(reset.rows[0]).toMatchObject({ status: 'unknown' });
    expect(reset.rows[0]?.finished_at).not.toBeNull();
    const event = await sql<{ action: string }>`
      SELECT action FROM exec_events WHERE entity_id = ${String(journal.id)}::uuid
        AND action = 'journal.unknown_after_session_start'
    `.execute(db as never);
    expect(event.rows).toHaveLength(1);
    const failed = await json(ctx.call('journal_fail', {
      journal_ref: journal.code,
      note: 'inspected the migration state and confirmed it did not complete',
    }));
    expect(failed.status).toBe('failed');
  });

  it('K.2 locks agent writes while unknown, then releases the lock after journal_done', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'write lock');
    const journal = await startJournal(ctx, String(task.code), false);
    await json(ctx.call('session_start', {}));

    const blocked = await ctx.call('ledger_add_open_item', {
      task_ref: task.code,
      title: 'defer a follow-up',
      type: 'suggestion',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain('JOURNAL_UNRESOLVED');
    expect(blocked.content[0]?.text).toContain(String(journal.code));
    const recoveryRead = await json(ctx.call('exec_ledger_reconcile', {}));
    expect((recoveryRead.unsettled_journal as Record<string, unknown>[]).some((row) => row.code === journal.code)).toBe(true);

    const settled = await json(ctx.call('journal_done', {
      journal_ref: journal.code,
      result_ref: 'cmd:migration-status',
      note: 'inspected the schema and confirmed the migration completed',
    }));
    expect(settled.status).toBe('done');
    const allowed = await json(ctx.call('ledger_add_open_item', {
      task_ref: task.code,
      title: 'defer a follow-up',
      type: 'suggestion',
    }));
    expect(allowed.type).toBe('suggestion');
  });

  it('K.3 refuses a non-idempotent retry but records an exact idempotent retry event', async () => {
    const unsafe = await context();
    const unsafeTask = await createTask(unsafe, 'unsafe retry');
    const unsafeJournal = await startJournal(unsafe, String(unsafeTask.code), false);
    await json(unsafe.call('session_start', {}));
    const refused = await unsafe.call('journal_start', {
      task_ref: unsafeTask.code,
      action: 'apply migration',
      target: 'schema:alpha',
      idempotent: false,
      expected_effect: 'the requested schema change is applied exactly once',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('JOURNAL_UNRESOLVED');
    expect(refused.content[0]?.text).toContain(String(unsafeJournal.code));
    const approvalDecision = await json(unsafe.call('ledger_record_decision', {
      task_ref: unsafeTask.code,
      title: 'Approve migration recovery',
      context: 'The migration outcome is unknown and must be reviewed before any retry.',
      options: ['hold for inspection', 'retry only after approval'],
      selected: 'hold for inspection',
      rationale: 'Do not repeat the migration until a human approves the safe recovery path.',
      reversible: false,
      touches: ['migration'],
    }));
    expect(approvalDecision).toMatchObject({ approval_state: 'pending', do_not_apply_until_human_approval: true });
    const ordinaryDecision = await unsafe.call('ledger_record_decision', {
      task_ref: unsafeTask.code,
      title: 'Ordinary internal choice',
      context: 'This low-risk choice does not request human approval.',
      options: ['first option', 'second option'],
      selected: 'first option',
      rationale: 'The choice is local and reversible, with no high-risk external effect.',
      reversible: true,
      touches: ['internal_edit'],
    });
    expect(ordinaryDecision.isError).toBe(true);
    expect(ordinaryDecision.content[0]?.text).toContain('JOURNAL_UNRESOLVED');

    const safe = await context();
    const safeTask = await createTask(safe, 'safe retry');
    const first = await startJournal(safe, String(safeTask.code), true);
    await json(safe.call('session_start', {}));
    const mismatchedEffect = await safe.call('journal_start', {
      task_ref: safeTask.code,
      action: 'apply migration',
      target: 'schema:alpha',
      idempotent: true,
      expected_effect: 'a different schema change is applied',
    });
    expect(mismatchedEffect.isError).toBe(true);
    expect(mismatchedEffect.content[0]?.text).toContain('JOURNAL_UNRESOLVED');
    const retry = await startJournal(safe, String(safeTask.code), true);
    expect(retry.retry_of).toEqual([first.code]);
    const retryEvent = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM exec_events
      WHERE task_id = ${String(safeTask.task_id)}::uuid AND action = 'journal.retry_started'
    `.execute(db as never);
    expect(Number(retryEvent.rows[0]?.n)).toBe(1);
  });

  it('K.4 reports per-file hash drift after close and discrepancies against changed_files claims', async () => {
    const ctx = await context();
    await upsertSetting(db, 'project', ctx.projectId, 'exec.allowed_repo_roots', ROOTS);
    const task = await createTask(ctx, 'post-close drift');
    const reportId = newId();
    await sql`
      INSERT INTO exec_reports (id, organization_id, task_id, payload)
      VALUES (${reportId}::uuid, ${ctx.actor.organizationId}::uuid, ${String(task.task_id)}::uuid,
        ${toJsonb({ changed_files: [] }) as never})
    `.execute(db as never);
    const closeManifest = {
      ...makeScopeManifest([{ path: FILE, sha256: 'a'.repeat(64) }]),
      roots: ROOTS,
      allowed_paths: ['packages/core/src/exec/**'],
    };
    const gateId = newId();
    await sql`
      INSERT INTO exec_gate_checks (
        id, organization_id, task_id, report_id, ok, blocked_by, gate_version,
        tree_hash, run_source, file_manifest
      ) VALUES (
        ${gateId}::uuid, ${ctx.actor.organizationId}::uuid, ${String(task.task_id)}::uuid,
        ${reportId}::uuid, true, '[]'::jsonb, ${GATE_VERSION}, ${liveManifest.hash}, 'test',
        ${toJsonb(closeManifest) as never}
      )
    `.execute(db as never);
    await sql`
      UPDATE exec_tasks SET status = 'done', closed_at = now(), gate_stamp_id = ${gateId}::uuid
      WHERE id = ${String(task.task_id)}::uuid
    `.execute(db as never);
    await sql`
      INSERT INTO exec_facts (
        id, organization_id, project_id, code, key, value, kind, source, files, file_hashes, status
      ) VALUES (
        ${newId()}::uuid, ${ctx.actor.organizationId}::uuid, ${ctx.projectId}::uuid,
        'F-PE10', 'pe10.stale-source', 'This source fact is stale after close.', 'fact', 'human',
        '[]'::jsonb, '[]'::jsonb, 'stale'
      )
    `.execute(db as never);

    liveManifest = makeScopeManifest([
      { path: FILE, sha256: 'd'.repeat(64) },
      { path: 'README.md', sha256: 'e'.repeat(64) },
    ]);
    measuredChanges = [{ path: FILE, status: 'M' }];
    const result = await json(ctx.call('exec_ledger_reconcile', {}));
    const drift = result.completed_task_drift as Record<string, unknown>[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ task_code: task.code, changed_count: 1 });
    expect(drift[0]?.changed_files).toMatchObject([{ path: FILE, status: 'M' }]);
    const mismatches = result.changed_file_diffs as Record<string, unknown>[];
    expect(mismatches.some((item) => item.task_code === task.code && item.matches === false)).toBe(true);
    expect((result.stale_facts as Record<string, unknown>[]).some((fact) => fact.code === 'F-PE10')).toBe(true);
    const events = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM exec_events
      WHERE entity = 'project' AND entity_id = ${ctx.projectId}::uuid AND action = 'ledger.reconciled'
    `.execute(db as never);
    expect(Number(events.rows[0]?.n)).toBe(1);
  });

  it('K.5/K.7 returns six schema-valid priority sections within the configured byte budget for 200 items', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'bounded session');
    await upsertSetting(db, 'project', ctx.projectId, 'exec.session_output_max_bytes', 2048);
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: newId(),
      organization_id: ctx.actor.organizationId,
      task_id: String(task.task_id),
      code: `OI-${String(index + 1).padStart(3, '0')}`,
      title: `Blocking commitment item ${String(index + 1).padStart(3, '0')}`,
      detail: 'A blocking item seeded to exercise the bounded session snapshot.',
      type: 'commitment' as const,
      blocks_completion: true,
      source: 'human' as const,
      status: 'open' as const,
    }));
    await db.insertInto('exec_open_items').values(items as never).execute();

    const session = await json(ctx.call('session_start', {}));
    expect(sessionSnapshotSchema.safeParse(session).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(session), 'utf8')).toBeLessThanOrEqual(2048);
    expect(session.meta).toMatchObject({ truncated: true, within_budget: true });
    const sections = session.sections as Record<string, unknown>[];
    expect(sections).toHaveLength(6);
    const blocking = sections.find((section) => section.key === 'blocking_open_items') as Record<string, unknown>;
    expect(blocking.total).toBe(200);
    expect(Number(blocking.more)).toBeGreaterThan(0);
  });

  it('K.5 keeps a schema-valid session below the MCP dispatch cap when the setting is larger', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'MCP output cap');
    await upsertSetting(db, 'project', ctx.projectId, 'exec.session_output_max_bytes', 262144);
    const detail = 'bounded session output payload '.repeat(16);
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: newId(),
      organization_id: ctx.actor.organizationId,
      task_id: String(task.task_id),
      code: `OI-${String(index + 1).padStart(3, '0')}`,
      title: `Large blocking item ${String(index + 1).padStart(3, '0')}`,
      detail,
      type: 'commitment' as const,
      blocks_completion: true,
      source: 'human' as const,
      status: 'open' as const,
    }));
    await db.insertInto('exec_open_items').values(items as never).execute();

    const session = await json(ctx.call('session_start', {}));
    expect(sessionSnapshotSchema.safeParse(session).success).toBe(true);
    expect(session.max_bytes).toBe(MCP_MAX_OUTPUT_BYTES - 512);
    expect(Buffer.byteLength(JSON.stringify(session), 'utf8')).toBeLessThan(MCP_MAX_OUTPUT_BYTES);
    expect(session.meta).toMatchObject({ truncated: true, within_budget: true });
  });

  it('K.6 Gate rule 13 blocks both started and resumed-unknown journal rows', async () => {
    const ctx = await context();
    const task = await createTask(ctx, 'gate journal block');
    const journal = await startJournal(ctx, String(task.code), false);
    const startedGate = await dryRunGate(db, String(task.task_id));
    expect(startedGate.blocked_by.some((entry) => entry.rule === 13 && entry.ref === journal.code)).toBe(true);
    await json(ctx.call('session_start', {}));
    const unknownGate = await dryRunGate(db, String(task.task_id));
    expect(unknownGate.blocked_by.some((entry) => entry.rule === 13 && entry.ref === journal.code)).toBe(true);
  });
});
