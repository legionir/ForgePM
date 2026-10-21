#!/usr/bin/env tsx
/**
 * PE-12 E2E — 13 scenes (docs/EXECUTION_CONTROL_PLAN.md §13)
 * Runs against a real Postgres via the test harness (embedded-postgres locally,
 * or the CI's postgres service). Exit non-zero on any deviation.
 */
import { resolve } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { sql } from 'kysely';
import {
  ModuleRegistry,
  StubProvider,
  answerQuestion,
  waiveBaseline,
  waiveCriterion,
  setReviewProviderResolver,
  newId,
  setExecReviewSource,
  upsertSetting,
  toJsonb,
  type Db,
  type LedgerActor,
} from '@forgepm/core';
import { GitExecReviewSource } from '../apps/api/src/modules/exec/review-source';
import { buildToolRegistry } from '../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../apps/api/src/app/auth-context';
import { createHarness, type Harness } from '../tests/integration/harness';
import { seedOrg } from '../tests/integration/seed';

const GOOD_CRIT = 'POST /api/items returns 201 and persists one row; test:exec-e2e good';

let h: Harness;
let db: Db;
let deps: McpDeps;
let seq = 0;

const json = async (p: ReturnType<typeof callTool>) => {
  const r = await p;
  if (r.isError) throw new Error(r.content[0]?.text ?? 'tool failed');
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
};

async function main(): Promise<void> {
  console.log('exec:e2e — 13 scenes');
  try {
    h = await createHarness();
  } catch (e) {
    console.warn('exec:e2e: no DB harness available locally — skipping (CI will run with postgres)');
    console.warn(String(e));
    process.exit(0);
  }
  db = h.db;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  // allow private CI targets for scene 8
  await upsertSetting(db, 'system', null, 'network.allow_private_targets', true);
  const baseSource = {
    snapshot: async () => ({ files: [], tree_hash: 'a'.repeat(64) }),
    treeHash: async () => 'a'.repeat(64),
    headSha: async () => 'b'.repeat(40),
    fileManifest: async () => ({ hash: 'c'.repeat(64), files: [] }),
    captureJournalPreState: async () => 'd'.repeat(64),
  };
  setExecReviewSource(baseSource);
  // Rule 11 needs a measurable scope: a clean worktree at the task's start commit and a code-measured diff.
  const cleanScopeSource = { ...baseSource, isWorktreeClean: async () => true, changedFiles: async () => [] };
  // Fact verification hashes real files under the allowed roots (read-only), as the API adapter does.
  const gitSource = new GitExecReviewSource(process.cwd());
  const factSource = {
    ...baseSource,
    hashFiles: gitSource.hashFiles.bind(gitSource),
    fileSnapshot: gitSource.fileSnapshot.bind(gitSource),
  };
  const registry = new ModuleRegistry();
  registry.register({ name: 'exec' });
  registry.invalidate();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();

  const results: { scene: number; ok: boolean; note: string }[] = [];

  async function runScene(n: number, title: string, fn: (ctx: SceneCtx) => Promise<void>): Promise<void> {
    const seeded = await seedOrg(db, { email: `e2e-${n}-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-pass' });
    // The tool calls are the AGENT's; the human acts only through `ctx.ledger` (the human path).
    const actor: Actor = {
      type: 'agent',
      id: seeded.userId,
      organizationId: seeded.organizationId,
      orgRole: 'owner',
      projectRole: () => 'lead',
      scopes: ['read', 'write', 'ledger:read', 'ledger:write', 'review'],
      projectIds: [seeded.projectId],
      requestId: `e2e-${n}-${(seq += 1)}`,
    } as Actor;
    // evidence and fact refs resolve only under a root the operator opened on purpose
    await upsertSetting(db, 'project', seeded.projectId, 'exec.allowed_repo_roots', ['packages']);
    const ledger: LedgerActor = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      actorType: 'human',
      actorId: seeded.userId,
      tool: `e2e:${n}`,
    };
    // Like the integration suites: a task is started through the human-typed caller (an agent's start
    // or split is parked for approval); every other call in a scene is the agent's.
    const starter: Actor = { ...actor, type: 'user' } as Actor;
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(deps, name === 'exec_task_start' || name === 'task_split' ? starter : actor, name, args, `${actor.requestId}-${(seq += 1)}`);
    const ctx: SceneCtx = { n, title, orgId: seeded.organizationId, projectId: seeded.projectId, userId: seeded.userId, actor, ledger, call, db };
    try {
      await fn(ctx);
      console.log(`✓ S${n} ${title}`);
      results.push({ scene: n, ok: true, note: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ S${n} ${title}: ${msg}`);
      results.push({ scene: n, ok: false, note: msg });
    }
  }

  /** Evidence for the only criterion plus a complete exit report: what a finished task hands the gate. */
  async function submitCleanReport(ctx: SceneCtx, task: Record<string, unknown>): Promise<void> {
    const crit = (task.criterion_codes as string[])[0] as string;
    const ev = await json(ctx.call('ledger_add_evidence', { task_ref: task.code, criterion_ref: crit, kind: 'file', ref: 'file:packages/core/src/exec/gate.ts', summary: 'the gate file exists and holds the gate logic for this task' }));
    const report = await json(ctx.call('exec_submit_exit_report', {
      task_ref: task.code,
      summary: 'All work done and verified with tests and evidence for the final task completion report',
      changed_files: [],
      completed_items: ['did thing'],
      incomplete: [],
      assumptions: [],
      decisions_made: [],
      risks_found: [],
      tests_executed: [],
      tests_not_run: [],
      out_of_scope_findings: [],
      criteria_status: [{ criterion_ref: crit, evidence_refs: [ev.id] }],
      req_ids_covered: [],
      scope_deviations: [],
      facts_recorded: [],
      none_confirmed: { incomplete: true, assumptions: true, decisions_made: true, risks_found: true, tests_not_run: true, out_of_scope_findings: true, req_ids_covered: true, scope_deviations: true },
    }));
    if (!report.report_id) throw new Error('no report_id');
  }

  // Scene 1: 12 REQs with quote
  await runScene(1, '12 REQs with verbatim quote', async (ctx) => {
    const base = 'Add login with token: ';
    for (let i = 1; i <= 12; i++) {
      const text = `The login endpoint must return token on valid credentials and audit the login (test:req-${i}, file:apps/api/src/routes/auth.ts) — ${base} sentence ${i}`;
      const quote = `sentence ${i}`;
      const r = await json(ctx.call('req_add', { text, quote, source: 'user_message', kind: 'functional', priority: 'medium' }));
      if (!r.code) throw new Error(`req ${i} no code`);
    }
    const count = await db.selectFrom('exec_requirements').select(sql<string>`count(*)::text`.as('c')).where('organization_id', '=', ctx.orgId).where('project_id', '=', ctx.projectId).executeTakeFirstOrThrow();
    if (count.c !== '12') throw new Error(`expected 12 reqs, got ${count.c}`);
  });

  // Scene 2: an active REQ with no task is refused when a task starts (REQUIREMENT_UNCOVERED)
  await runScene(2, 'one REQ without task => uncovered', async (ctx) => {
    await json(ctx.call('req_add', { text: 'Coverage: uncovered REQ must be reported; test:req-uncovered', quote: 'uncovered REQ', source: 'user_message', kind: 'functional' }));
    const refused = await ctx.call('exec_task_start', { title: 'Task without REQ', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/core/src/exec/**'] });
    if (!refused.isError || !refused.content[0]?.text.includes('REQUIREMENT_UNCOVERED')) {
      throw new Error(`expected REQUIREMENT_UNCOVERED, got ${refused.content[0]?.text}`);
    }
  });

  // Scene 3: task_split with dependency, early completion of the dependent is blocked
  await runScene(3, 'task_split with depends_on, early start blocked', async (ctx) => {
    const parent = await json(ctx.call('exec_task_start', { title: 'Parent plan', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const split = await json(ctx.call('task_split', { parent_ref: parent.code as string, children: [
      { key: 'a', title: 'Child A task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] },
      { key: 'b', title: 'Child B depends on A', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'], depends_on: ['a'] },
    ] }));
    const children = split.children as { code: string; key: string }[] | undefined;
    if (!children || children.length !== 2) throw new Error('split did not return two children');
    const bCode = children.find((t) => t.key === 'b')?.code;
    if (!bCode) throw new Error('no b code');
    const gate = await json(ctx.call('exec_task_complete', { task_ref: bCode }));
    if (gate.ok) throw new Error('expected gate to block dependent');
    const parentGate = await json(ctx.call('exec_task_complete', { task_ref: parent.code as string }));
    if (parentGate.ok) throw new Error('expected the parent to be blocked by unfinished children');
  });

  // Scene 4: "later" -> OI blocking
  await runScene(4, 'later refresh token => OI blocking', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Token task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const oi = await json(ctx.call('ledger_add_open_item', { task_ref: task.code, title: 'later: add refresh token', detail: 'will add refresh token later', type: 'commitment', blocks_completion: true }));
    if (!oi.code) throw new Error('no OI code');
    const gate = await json(ctx.call('exec_task_complete', { task_ref: task.code }));
    if (gate.ok) throw new Error('expected blocked by OI');
    const blocked = (gate.blocked_by as { rule: number }[]).some((b) => b.rule === 2);
    if (!blocked) throw new Error('expected rule 2 block');
  });

  // Scene 5: touches=['public_api'] => approval pending
  await runScene(5, 'public_api touches => approval pending', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'API task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const dec = await json(ctx.call('ledger_record_decision', { task_ref: task.code, title: 'Change public API', context: 'need to change response shape for clients and document it', options: ['keep', 'change'], selected: 'change', rationale: 'clients need new field for feature X and we have to evolve the contract with care for versioning', touches: ['public_api'], reversible: false }));
    if (dec.approval_state !== 'pending') throw new Error(`expected pending, got ${dec.approval_state}`);
    // gate should block because decision needs approval
    const gate = await json(ctx.call('exec_task_complete', { task_ref: task.code }));
    if (gate.ok) throw new Error('expected blocked by approval');
  });

  // Scene 6: task_complete early => ok:false blocked_by
  await runScene(6, 'task_complete early => blocked', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Early complete', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const gate = await json(ctx.call('exec_task_complete', { task_ref: task.code }));
    if (gate.ok !== false) throw new Error('expected ok:false');
    if (!Array.isArray(gate.blocked_by) || gate.blocked_by.length === 0) throw new Error('expected blocked_by');
  });

  // Scene 7: a measured file outside allowed_paths blocks completion (Rule 11, code-measured, never report-claimed)
  await runScene(7, 'out-of-scope file => blocking item', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Scope task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/core/src/exec/**'] }));
    setExecReviewSource({ ...cleanScopeSource, changedFiles: async () => [{ path: 'docs/outside.md', status: 'M' }] });
    try {
      const measured = await json(ctx.call('scope_check', { task_ref: task.code }));
      if (measured.outside_count !== 1) throw new Error(`scope_check should measure one outside file, got ${JSON.stringify(measured)}`);
      await submitCleanReport(ctx, task);
      const gate = await json(ctx.call('exec_task_complete', { task_ref: task.code }));
      const blocks = (gate.blocked_by as { rule: number; ref?: string }[]) ?? [];
      if (gate.ok || !blocks.some((b) => b.rule === 11)) {
        throw new Error(`expected a rule 11 block, got rules ${blocks.map((b) => `${b.rule}:${b.ref}`).join(', ')}`);
      }
    } finally {
      setExecReviewSource(baseSource);
    }
  });

  // Scene 8: delete baseline test => rule 12
  await runScene(8, 'baseline deletion => rule 12', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Baseline task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const taskId = task.task_id as string;
    // Seed baseline with 2 passing tests
    await db.insertInto('exec_baseline_tests').values({ id: newId(), task_id: taskId, test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: toJsonb({ sha: 'b'.repeat(40), run_id: '1', job: 'test' }) }).execute();
    await db.insertInto('exec_baseline_tests').values({ id: newId(), task_id: taskId, test_name: 'auth > refreshes token', result_at_start: 'pass', source: 'ci', provenance: toJsonb({ sha: 'b'.repeat(40), run_id: '1', job: 'test' }) }).execute();
    // Current log has only 1 (simulate deletion by not inserting second)
    // Gate will compare and should detect vanished
    const { compareBaseline } = await import('@forgepm/core');
    const verdict = compareBaseline([{ name: 'auth > logs in', result: 'pass' }, { name: 'auth > refreshes token', result: 'pass' }], ['auth > logs in'], { 'auth > logs in': 'pass' });
    if (verdict.vanished.length === 0) throw new Error('expected vanished');
    if (!verdict.needs_human) throw new Error('expected needs_human');
  });

  // Scene 9: a fact whose file changed goes stale on verify (needs_revisit)
  await runScene(9, 'fact stale => needs_revisit', async (ctx) => {
    const rel = `packages/core/.e2e-fact-${process.pid}.tmp`;
    const abs = resolve(process.cwd(), rel);
    await writeFile(abs, 'original contents\n', 'utf8');
    setExecReviewSource(factSource);
    try {
      const fact = await json(ctx.call('fact_record', { key: 'fact-stale-key', value: 'the tmp file holds the original contents', kind: 'fact', source: 'code', source_ref: `file:${rel}`, files: [rel] }));
      if (!fact.code) throw new Error('no fact code');
      await writeFile(abs, 'changed contents\n', 'utf8');
      const verified = await json(ctx.call('fact_verify', { fact_ref: fact.code as string }));
      const row = await db.selectFrom('exec_facts').select('status').where('code', '=', fact.code as string).where('project_id', '=', ctx.projectId).executeTakeFirstOrThrow();
      if (row.status !== 'stale') throw new Error(`expected stale after the file changed, got ${row.status} (${JSON.stringify(verified)})`);
    } finally {
      setExecReviewSource(baseSource);
      await rm(abs, { force: true });
    }
  });

  // Scene 10: a journal action that is left `unknown` blocks a non-idempotent retry
  await runScene(10, 'journal crash => unknown', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Journal task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const start = { task_ref: task.code, action: 'migrate', target: 'db', idempotent: false, expected_effect: 'migrate adds column and preserves rows for existing data' };
    const j = await json(ctx.call('journal_start', start));
    if (!j.code) throw new Error('no journal code');
    // The crash: the agent never settled `j`. A new session reconciles it to `unknown`.
    await json(ctx.call('session_start', {}));
    const retry = await ctx.call('journal_start', start);
    if (!retry.isError || !retry.content[0]?.text.includes('JOURNAL_UNRESOLVED')) {
      throw new Error(`a non-idempotent retry after unknown must be refused with JOURNAL_UNRESOLVED, got ${retry.content[0]?.text}`);
    }
  });

  // Scene 11: adversarial review with a stub provider records a TODO finding
  await runScene(11, 'review stub => TODO finding', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Review task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/core/src/exec/**'] }));
    await db.updateTable('exec_tasks').set({ start_ref: 'test-baseline' }).where('id', '=', task.task_id as string).execute();
    await db.insertInto('ai_providers').values({ id: newId(), organization_id: ctx.orgId, name: 'e2e-stub', kind: 'fake', base_url: null, encrypted_key: null, key_last4: null, default_model: 'e2e-stub' }).execute();
    const todoPath = 'packages/core/src/exec/review-fixture.ts';
    const stub = new StubProvider((request) => request.system.includes('exec:requirements_coverage')
      ? { verdict: 'fail', checked: ['acceptance criterion C-1'], findings: [{ title: 'TODO: later is left in the change', type: 'incomplete_requirement', blocks_completion: true, evidence_ref: `file:${todoPath}:1`, why: 'the changed source still says TODO: later' }] }
      : { verdict: 'pass', checked: ['review stage'], findings: [] }, 'e2e-stub');
    setReviewProviderResolver(async () => stub);
    setExecReviewSource({ ...baseSource, snapshot: async () => ({ files: [{ path: todoPath, change: 'M', patch: '@@ -1 +1 @@\n+// TODO: later' }], tree_hash: 'a'.repeat(64) }) });
    try {
      const result = await json(ctx.call('review_task', { task_ref: task.code }));
      if (result.verdict !== 'fail' || result.findings !== 1) throw new Error(`expected one blocking finding, got ${JSON.stringify(result)}`);
    } finally {
      setReviewProviderResolver(async () => null);
      setExecReviewSource(baseSource);
    }
  });

  // Scene 12: the human answers a question and waives a criterion through the human service path
  await runScene(12, 'human answer+waive via the human path', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Human unlock task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    const asked = await json(ctx.call('ledger_ask_human', { task_ref: task.code, question: 'Should we use JWT?', options: ['yes', 'no'], recommendation: 'yes', impact_per_option: ['JWT adds overhead but is stateless and scalable', 'No JWT keeps it simple but less scalable'], why_it_matters: 'Auth choice affects scalability and security for the whole system and future features' }));
    const answered = await answerQuestion(db, ctx.ledger, asked.code as string, 'yes, use JWT: the human decided this');
    if (answered.status === 'open') throw new Error('the question is still open after the human answered');
    const waived = await waiveCriterion(db, ctx.ledger, (task.criterion_codes as string[])[0] as string, 'the requirement behind it moved to the next release');
    if (waived.status !== 'waived') throw new Error(`expected waived, got ${waived.status}`);
  });

  // Scene 13: with evidence, an exit report, a passing review and a measurable clean scope, the gate lets the task finish
  await runScene(13, 'task_complete final => done', async (ctx) => {
    const task = await json(ctx.call('exec_task_start', { title: 'Final task', acceptance_criteria: [GOOD_CRIT], allowed_paths: ['packages/**'] }));
    await db.insertInto('ai_providers').values({ id: newId(), organization_id: ctx.orgId, name: 'e2e-pass', kind: 'fake', base_url: null, encrypted_key: null, key_last4: null, default_model: 'e2e-pass' }).execute();
    setReviewProviderResolver(async () => new StubProvider(() => ({ verdict: 'pass', checked: ['review stage'], findings: [] }), 'e2e-pass'));
    setExecReviewSource(cleanScopeSource);
    try {
      await submitCleanReport(ctx, task);
      await json(ctx.call('review_task', { task_ref: task.code }));
      // No CI log exists for this fixture commit, so the baseline is a human decision (D-041), never an agent's.
      await waiveBaseline(db, ctx.ledger, task.code as string, 'e2e fixture has no CI log; the human accepts the missing baseline');
      const gate = await json(ctx.call('exec_task_complete', { task_ref: task.code }));
      if (gate.ok !== true) throw new Error(`expected the gate to pass, blocked by ${JSON.stringify(gate.blocked_by)}`);
    } finally {
      setReviewProviderResolver(async () => null);
      setExecReviewSource(baseSource);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nexec:e2e finished: ${results.length} scenes, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`  S${f.scene} ${f.note}`);
    process.exit(1);
  }
  console.log('exec:e2e OK — 13 scenes, 0 unexpected errors');
  await h.cleanup();
}

interface SceneCtx {
  n: number;
  title: string;
  orgId: string;
  projectId: string;
  userId: string;
  actor: Actor;
  ledger: LedgerActor;
  call: (name: string, args: Record<string, unknown>) => ReturnType<typeof callTool>;
  db: Db;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
