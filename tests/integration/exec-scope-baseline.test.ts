import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ModuleRegistry,
  createCipher,
  evaluateGate,
  expandTaskScope,
  loadGateContext,
  makeScopeManifest,
  putSecret,
  setActiveCipher,
  setExecReviewSource,
  upsertSetting,
  waiveBaseline,
  waiveScopeMeasurement,
  type Db,
  type LedgerActor,
  type ScopeFileManifest,
} from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

let h: Harness;
let db: Db;
let orgId: string;
let projectId: string;
let userId: string;
let deps: McpDeps;
let sequence = 0;

const GOOD = 'exec_ledger_status returns the blocking item code in blockers; test:exec-scope-baseline.test.ts';
const actor = (over: Partial<Actor> = {}): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'lead',
    scopes: ['read', 'write', 'ledger:read', 'ledger:write'],
    projectIds: [projectId],
    requestId: `req-pe8-scope-${(sequence += 1)}`,
    ...over,
  }) as Actor;

const call = (name: string, args: Record<string, unknown>, who = actor()) =>
  callTool(deps, who, name, args, who.requestId);
const json = (result: Awaited<ReturnType<typeof call>>): Record<string, unknown> => {
  const text = result.content[0]?.text ?? '{}';
  if (result.isError) throw new Error(`MCP tool error: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
};

function installManifestSource(current: () => ScopeFileManifest | null): void {
  setExecReviewSource({
    snapshot: async () => ({ files: [], tree_hash: 'a'.repeat(64) }),
    treeHash: async () => 'a'.repeat(64),
    ...(current() ? { fileManifest: async () => current()! } : {}),
  });
}

async function createTask(title: string): Promise<Record<string, unknown>> {
  const result = json(await call('exec_task_start', {
    title,
    acceptance_criteria: [GOOD],
    allowed_paths: ['packages/core/src/exec/**'],
  }));
  expect(result.task_id).toEqual(expect.any(String));
  return result;
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe8-scope-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
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

describe('PE-8 measured scope and baseline provenance', () => {
  it('captures a hash-only start manifest and scope_check ignores report claims', async () => {
    const start = makeScopeManifest([
      { path: 'packages/core/src/exec/allowed.ts', sha256: '1'.repeat(64) },
      { path: 'packages/core/src/exec/deleted.ts', sha256: '3'.repeat(64) },
    ]);
    let current = start;
    installManifestSource(() => current);

    const task = await createTask('manifest-measured task');
    expect(task.start_ref).toBeNull();
    const event = await db
      .selectFrom('exec_events')
      .select(['actor_type', 'actor_id', 'tool', 'payload'])
      .where('task_id', '=', task.task_id as string)
      .where('action', '=', 'scope.manifest_captured')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({ actor_type: 'system', actor_id: 'exec-scope-manifest', tool: 'exec_task_start' });
    expect((event.payload as { hash: string }).hash).toBe(start.hash);
    expect(JSON.stringify(event.payload)).not.toContain('export const');

    current = makeScopeManifest([
      { path: 'packages/core/src/exec/allowed.ts', sha256: '1'.repeat(64) },
      { path: 'docs/outside.md', sha256: '2'.repeat(64) },
    ]);
    const checked = json(await call('scope_check', { task_ref: task.code as string }));
    expect(checked).toMatchObject({
      measurable: true,
      basis: 'manifest',
      touched: 2,
      outside_count: 1,
      deleted_count: 1,
      report_changed_files_used: false,
    });
    expect(checked.outside).toEqual([{ path: 'docs/outside.md', change: 'A' }]);
    expect(checked.deleted).toEqual([{ path: 'packages/core/src/exec/deleted.ts', change: 'D' }]);
    expect(checked.manifest_hash).toBe(current.hash);

    const human: LedgerActor = {
      organizationId: orgId,
      projectId,
      actorType: 'human',
      actorId: userId,
      tool: 'test:scope-expansion',
    };
    await expandTaskScope(db, human, task.code as string, ['docs/**'], 'Human explicitly approved docs changes for this task');
    const expanded = json(await call('scope_check', { task_ref: task.task_id as string }));
    expect(expanded).toMatchObject({ measurable: true, basis: 'manifest', outside_count: 0 });
    expect((expanded.files as { path: string; in_allowed_paths: boolean }[]).find((file) => file.path === 'docs/outside.md')?.in_allowed_paths).toBe(true);
    const loaded = await loadGateContext(db, task.task_id as string);
    const judged = evaluateGate({
      ...loaded.ctx,
      report: { tests_executed: [], tests_not_run: [], changed_files: [] },
    });
    expect(judged.blocked_by.some((item) => item.rule === 11 && item.ref === 'packages/core/src/exec/deleted.ts')).toBe(true);
    await expect(
      waiveScopeMeasurement(db, human, task.code as string, 'cannot waive a currently measurable scope'),
    ).rejects.toMatchObject({ code: 'LEDGER_STATE_INVALID' });
  });

  it('captures only exact-SHA CI results and measured test weakening, never report claims', async () => {
    const startSha = 'c'.repeat(40);
    let currentSha = startSha;
    setExecReviewSource({
      snapshot: async () => ({ files: [], tree_hash: 'e'.repeat(64) }),
      treeHash: async () => 'e'.repeat(64),
      headSha: async () => currentSha,
      isWorktreeClean: async () => true,
      changedFiles: async () => [{ path: 'packages/core/src/auth.test.ts', status: 'M' }],
      readFilePair: async () => ({
        before: 'it("auth", () => { expect(1).toBe(1); });',
        after: 'it.skip("auth", () => { expect(1).toBe(1); });',
      }),
    });
    const cipher = createCipher(Buffer.alloc(32, 23));
    setActiveCipher(cipher);
    await putSecret(db, cipher, orgId, 'ci-readonly', 'read-only-ci-token');
    await upsertSetting(db, 'project', projectId, 'exec.ci_log_endpoint', 'https://8.8.8.8/logs/{sha}');
    await upsertSetting(db, 'project', projectId, 'exec.ci_log_secret_name', 'ci-readonly');
    await upsertSetting(db, 'project', projectId, 'exec.protected_test_globs', ['**/*.test.ts']);
    const task = await createTask('CI-backed baseline task');
    expect(task.start_ref).toBe(startSha);
    currentSha = 'd'.repeat(40);

    const passingLog = '✓ auth > logs in (1ms)\nTests 1 passed (1)';
    const skippedLog = '↓ auth > logs in (1ms)\nTests 1 skipped (1)';
    let startCaptureCount = 0;
    let currentCaptureCount = 0;
    const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      const sha = url.pathname.split('/').at(-1) ?? '';
      expect(init?.headers).toMatchObject({ authorization: 'Bearer read-only-ci-token' });
      const runId = sha === startSha ? `start-run-${++startCaptureCount}` : `current-run-${++currentCaptureCount}`;
      return new Response(JSON.stringify({
        sha,
        run_id: runId,
        job: 'unit',
        provider: 'local-fixture',
        log: sha === startSha ? passingLog : skippedLog,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchStub);
    let captured: Record<string, unknown>;
    try {
      captured = json(await call('baseline_capture', { task_ref: task.task_id as string }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.stringify(captured)).not.toContain('read-only-ci-token');
    expect(captured).toMatchObject({
      ok: true,
      start_sha: startSha,
      current_sha: currentSha,
      start_test_count: 1,
      current_test_count: 1,
      weakening_count: 1,
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(captured.provenance).toMatchObject({ start: { run_id: 'start-run-1' }, current: { run_id: 'current-run-1' } });

    vi.stubGlobal('fetch', fetchStub);
    let repeated: Record<string, unknown>;
    try {
      repeated = json(await call('baseline_capture', { task_ref: task.code as string }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(repeated).toMatchObject({ ok: true, start_captured: false });
    expect(repeated.provenance).toMatchObject({ start: { run_id: 'start-run-1' }, current: { run_id: 'current-run-2' } });
    expect(fetchStub).toHaveBeenCalledTimes(4);

    const row = await db
      .selectFrom('exec_baseline_tests')
      .select(['test_name', 'result_at_start', 'source', 'provenance'])
      .where('task_id', '=', task.task_id as string)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci' });
    expect(row.provenance).toMatchObject({ run_id: 'start-run-1', sha: startSha });
    const events = await db
      .selectFrom('exec_events')
      .select('payload')
      .where('task_id', '=', task.task_id as string)
      .where('action', 'in', ['baseline.start_captured', 'baseline.captured'])
      .execute();
    const serializedEvents = JSON.stringify(events.map((event) => event.payload));
    expect(serializedEvents).not.toContain(passingLog);
    expect(serializedEvents).not.toContain(skippedLog);
    expect(serializedEvents).not.toContain('read-only-ci-token');
    const loaded = await loadGateContext(db, task.task_id as string);
    expect(loaded.ctx.baseline).toMatchObject({
      ran: true,
      start_sha: startSha,
      current_sha: currentSha,
      after: { sha: currentSha, results: { 'auth > logs in': 'skip' } },
      weakening: [{ path: 'packages/core/src/auth.test.ts', modifiers: ['.skip'] }],
    });
    const judged = evaluateGate({
      ...loaded.ctx,
      report: {
        tests_executed: [{ name: 'auth > logs in', result: 'pass', evidence_ref: 'test:agent-claim' }],
        tests_not_run: [],
        changed_files: [],
      },
    });
    expect(judged.blocked_by.some((item) => item.rule === 12 && item.title.includes('weakened'))).toBe(true);
    expect(judged.blocked_by.some((item) => item.rule === 12 && item.title.includes('no longer green'))).toBe(true);
  });

  it('only a human can waive unavailable scope and CI evidence, with approval-bound gate context', async () => {
    installManifestSource(() => null);
    const task = await createTask('human waiver task');
    const human: LedgerActor = {
      organizationId: orgId,
      projectId,
      actorType: 'human',
      actorId: userId,
      tool: 'test:human',
    };
    const agent: LedgerActor = { ...human, actorType: 'agent', actorId: 'agent-1', tool: 'exec_task_complete' };

    await expect(waiveScopeMeasurement(db, agent, task.code as string, 'scope waiver reason')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(waiveBaseline(db, agent, task.code as string, 'baseline waiver reason')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await waiveScopeMeasurement(db, human, task.code as string, 'human reviewed the unmeasurable workspace');
    await waiveBaseline(db, human, task.code as string, 'CI log provider is unavailable for this task');
    const loaded = await loadGateContext(db, task.task_id as string);
    expect(loaded.ctx.scope).toMatchObject({ available: false, human_waived: true });
    expect(loaded.ctx.baseline.human_waived).toBe(true);
    expect(loaded.ctx.task.human_waivers).toEqual(
      expect.arrayContaining([`scope:${task.code}`, `baseline:${task.code}`]),
    );
    const waivedGate = evaluateGate({
      ...loaded.ctx,
      report: { tests_executed: [], tests_not_run: [], changed_files: [] },
    });
    expect(waivedGate.blocked_by.some((item) => item.rule === 11)).toBe(false);
    expect(waivedGate.blocked_by.some((item) => item.rule === 12)).toBe(false);

    const approvals = await db
      .selectFrom('approval_requests')
      .select(['action', 'status', 'decided_by'])
      .where('organization_id', '=', orgId)
      .where('action', 'in', ['exec.scope_waive', 'exec.baseline_waive'])
      .execute();
    expect(approvals).toHaveLength(2);
    expect(approvals.every((approval) => approval.status === 'approved' && approval.decided_by === userId)).toBe(true);
  });
});
