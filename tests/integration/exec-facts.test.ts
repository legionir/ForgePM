import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  ModuleRegistry,
  makeScopeManifest,
  setExecReviewSource,
  upsertSetting,
  type Db,
  type ExecFactFileSource,
  type ExecReviewSource,
  type ScopeFileManifest,
} from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { FactVerificationJob } from '../../apps/worker/src/fact-verification-job';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const ROOTS = ['packages/core/src/exec'];
const FILE = 'packages/core/src/exec/facts.ts';
const GOOD_CRITERION = 'The fact source hash MUST become stale at next session_start; test:exec-facts';
const liveHashes = new Map<string, string>();
let h: Harness;
let db: Db;
let deps: McpDeps;
let sequence = 0;

function manifest(paths: string[] = [...liveHashes.keys()]): ScopeFileManifest {
  return makeScopeManifest(paths.flatMap((path) => {
    const sha256 = liveHashes.get(path);
    return sha256 ? [{ path, sha256 }] : [];
  }));
}

const fileSource: ExecReviewSource & ExecFactFileSource = {
  snapshot: async () => ({ files: [], tree_hash: manifest().hash }),
  treeHash: async () => manifest().hash,
  fileSnapshot: async () => manifest(),
  hashFiles: async ({ roots, files, allowMissing }) => {
    const outside = files.filter((path) => !roots.some((root) => path === root || path.startsWith(`${root}/`)));
    if (outside.length) throw new Error(`outside roots: ${outside.join(',')}`);
    const missing = files.filter((path) => !liveHashes.has(path));
    if (missing.length && !allowMissing) throw new Error(`missing: ${missing.join(',')}`);
    return manifest(files);
  },
  resolveCommit: async (ref) => {
    if (!/^[0-9a-f]{7,64}$/i.test(ref)) throw new Error('bad commit');
    return ref.padEnd(40, '0').toLowerCase();
  },
  headSha: async () => 'b'.repeat(40),
  isWorktreeClean: async () => true,
  changedFiles: async () => [],
  captureJournalPreState: async () => `tree\n${'c'.repeat(40)}\nstatus\n`,
};

async function context(): Promise<{
  actor: Actor;
  human: Actor;
  projectId: string;
  call: (name: string, args: Record<string, unknown>) => ReturnType<typeof callTool>;
  callHuman: (name: string, args: Record<string, unknown>) => ReturnType<typeof callTool>;
}> {
  const seeded = await seedOrg(db, {
    email: `pe11-facts-${process.pid}-${Date.now()}-${(sequence += 1)}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  await upsertSetting(db, 'project', seeded.projectId, 'exec.allowed_repo_roots', ROOTS);
  const base = {
    id: seeded.userId,
    organizationId: seeded.organizationId,
    orgRole: 'owner',
    projectRole: () => 'lead',
    scopes: ['read', 'write', 'ledger:read', 'ledger:write', 'ledger:decide'],
    projectIds: [seeded.projectId],
    requestId: `pe11-${sequence}`,
  };
  const actor = { ...base, type: 'agent' } as Actor;
  const human = { ...base, type: 'user', requestId: `pe11-human-${sequence}` } as Actor;
  return {
    actor,
    human,
    projectId: seeded.projectId,
    call: (name, args) => callTool(deps, actor, name, args, `${actor.requestId}-${(sequence += 1)}`),
    callHuman: (name, args) => callTool(deps, human, name, args, `${human.requestId}-${(sequence += 1)}`),
  };
}

async function json(result: ReturnType<typeof callTool>): Promise<Record<string, unknown>> {
  const response = await result;
  if (response.isError) throw new Error(response.content[0]?.text ?? 'MCP call failed');
  return JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function createTask(ctx: Awaited<ReturnType<typeof context>>): Promise<Record<string, unknown>> {
  return json(callTool(deps, ctx.human, 'exec_task_start', {
    title: `PE-11 fact-dependent task ${sequence}`,
    acceptance_criteria: [GOOD_CRITERION],
    allowed_paths: ['packages/core/src/exec/**'],
  }, `${ctx.human.requestId}-task-${sequence}`));
}

async function recordCodeFact(ctx: Awaited<ReturnType<typeof context>>, key: string): Promise<Record<string, unknown>> {
  liveHashes.set(FILE, 'a'.repeat(64));
  return json(ctx.call('fact_record', {
    key,
    value: 'The fact is grounded in a hashed source file.',
    kind: 'fact',
    source: 'code',
    source_ref: `file:${FILE}`,
    files: [FILE],
  }));
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  setExecReviewSource(fileSource);
  const registry = new ModuleRegistry();
  registry.register({ name: 'exec' });
  registry.invalidate();
  deps = { db, registry, tools: buildToolRegistry(db), rateLimitPerMinute: 100_000 };
  resetRateBuckets();
});

beforeEach(async () => {
  await h.reset();
  liveHashes.clear();
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
});

afterAll(async () => {
  setExecReviewSource(null);
  await h?.cleanup();
});

describe('PE-11 facts, inspectability, and stale recovery (appendix I)', () => {
  it('I.1 rejects a guessed fact and accepts the same claim as an assumption', async () => {
    const ctx = await context();
    const rejected = await ctx.call('fact_record', {
      key: 'runtime.guess',
      value: 'The runtime probably caches project settings.',
      kind: 'fact',
      source: 'agent_guess',
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("use kind='assumption'");

    const assumption = await json(ctx.call('fact_record', {
      key: 'runtime.guess',
      value: 'The runtime probably caches project settings.',
      kind: 'assumption',
      source: 'agent_guess',
    }));
    expect(assumption).toMatchObject({ kind: 'assumption', source: 'agent_guess', status: 'active' });
  });

  it('I.2/I.3/I.6 changes a referenced hash stale at session_start, revisits decisions, blocks Gate, and warns in fact_query', async () => {
    const ctx = await context();
    const task = await createTask(ctx);
    const fact = await recordCodeFact(ctx, `runtime.source_${sequence}`);
    const decision = await json(ctx.call('ledger_record_decision', {
      task_ref: task.code,
      title: 'Use the documented runtime contract',
      context: 'The selected project behavior depends on the referenced source file.',
      options: ['Use the current contract', 'Defer the change'],
      selected: 'Use the current contract',
      rationale: 'The code establishes this contract and the decision is reversible if the source changes.',
      reversible: true,
      touches: ['none'],
      review_trigger: { fact_codes: [String(fact.code)] },
    }));
    await db.updateTable('exec_decisions').set({ status: 'active' }).where('code', '=', String(decision.code)).execute();

    liveHashes.set(FILE, 'b'.repeat(64));
    await json(ctx.call('session_start', {}));

    const stored = await sql<{ status: string }>`SELECT status FROM exec_facts WHERE id = ${String(fact.id)}::uuid`.execute(db as never);
    expect(stored.rows[0]?.status).toBe('stale');
    const revisited = await sql<{ status: string }>`SELECT status FROM exec_decisions WHERE id = ${String(decision.id)}::uuid`.execute(db as never);
    expect(revisited.rows[0]?.status).toBe('needs_revisit');
    const blockers = await sql<{ code: string; title: string }>`
      SELECT code, title FROM exec_open_items
      WHERE task_id = (SELECT id FROM exec_tasks WHERE code = ${String(task.code)})
        AND source = 'hook' AND blocks_completion = true AND status = 'open'
    `.execute(db as never);
    expect(blockers.rows).toHaveLength(1);
    expect(blockers.rows[0]?.title).toContain(String(fact.code));

    const gate = await import('@forgepm/core').then(({ dryRunGate }) => dryRunGate(db, String(task.task_id)));
    expect(gate.ok).toBe(false);
    expect(gate.blocked_by).toContainEqual(expect.objectContaining({ rule: 2, ref: blockers.rows[0]?.code }));

    const query = await json(ctx.call('fact_query', { query: String(fact.key) }));
    const results = query.facts as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ code: fact.code, status: 'stale' });
    expect(String(results[0]?.warning)).toContain('STALE');
    expect(query.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: fact.code })]));
  });

  it('I.4 supersedes duplicate keys without deleting either version', async () => {
    const ctx = await context();
    const key = `runtime.duplicate_${sequence}`;
    const first = await json(ctx.call('fact_record', {
      key,
      value: 'First recorded description of a stable project behavior.',
      kind: 'fact',
      source: 'human',
    }));
    const second = await json(ctx.call('fact_record', {
      key,
      value: 'Second recorded description correcting the earlier behavior.',
      kind: 'fact',
      source: 'human',
    }));
    const rows = await sql<{ code: string; status: string; superseded_by: string | null }>`
      SELECT code, status, superseded_by::text AS superseded_by FROM exec_facts WHERE key = ${key} ORDER BY created_at
    `.execute(db as never);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ code: first.code, status: 'superseded', superseded_by: second.id });
    expect(rows.rows[1]).toMatchObject({ code: second.code, status: 'active', superseded_by: null });
  });

  it('I.5 requires a human reason to promote and leaves an approval plus audit trail', async () => {
    const ctx = await context();
    const guess = await json(ctx.call('fact_record', {
      key: `runtime.promote_${sequence}`,
      value: 'This assumption may be promoted after a human verifies it.',
      kind: 'assumption',
      source: 'agent_guess',
    }));
    const withoutReason = await ctx.callHuman('fact_promote', { fact_ref: guess.code });
    expect(withoutReason.isError).toBe(true);
    expect(withoutReason.content[0]?.text).toContain('reason');

    const promoted = await json(ctx.callHuman('fact_promote', {
      fact_ref: guess.code,
      source: 'human',
      reason: 'The human checked the statement and confirms it is correct.',
    }));
    expect(promoted).toMatchObject({ code: guess.code, kind: 'fact', source: 'human' });
    const approvals = await sql<{ status: string; action: string }>`
      SELECT status, action FROM approval_requests
      WHERE action = 'exec.fact_promotion' AND payload->>'fact_id' = ${String(guess.id)}
    `.execute(db as never);
    expect(approvals.rows).toEqual([{ status: 'approved', action: 'exec.fact_promotion' }]);
    const audit = await sql<{ action: string }>`
      SELECT action FROM audit_events WHERE resource_type = 'exec_fact' AND resource_id = ${String(guess.id)}
        AND action = 'exec.fact.promote'
    `.execute(db as never);
    expect(audit.rows).toHaveLength(1);
  });

  it('I.7 rejects missing file and malformed commit refs; valid refs are inspectable', async () => {
    const ctx = await context();
    const missingFile = await ctx.call('fact_record', {
      key: `runtime.missing_${sequence}`,
      value: 'A claim with a missing source file must not be stored.',
      kind: 'fact',
      source: 'docs',
      source_ref: 'file:packages/core/src/exec/not-here.ts',
    });
    expect(missingFile.isError).toBe(true);
    expect(missingFile.content[0]?.text).toContain('EVIDENCE_UNAVAILABLE');

    const malformedCommit = await ctx.call('fact_record', {
      key: `runtime.bad_commit_${sequence}`,
      value: 'A claim with a malformed commit reference is rejected.',
      kind: 'fact',
      source: 'code',
      source_ref: 'commit:not-a-sha',
      files: [FILE],
    });
    expect(malformedCommit.isError).toBe(true);
    expect(malformedCommit.content[0]?.text).toContain('parseable');

    liveHashes.set(FILE, 'c'.repeat(64));
    const validFile = await json(ctx.call('fact_record', {
      key: `runtime.valid_file_${sequence}`,
      value: 'The server inspected and hashed this referenced source file.',
      kind: 'fact',
      source: 'code',
      source_ref: `file:${FILE}`,
      files: [FILE],
    }));
    expect(validFile.files).toContain(FILE);

    const validCommit = await json(ctx.call('fact_record', {
      key: `runtime.valid_commit_${sequence}`,
      value: 'The source commit resolves and the file is hash tracked.',
      kind: 'fact',
      source: 'code',
      source_ref: `commit:${'d'.repeat(40)}`,
      files: [FILE],
    }));
    expect(validCommit.status).toBe('active');
  });

  it('honors stale_check_on_start=false but verifies hashes before task completion', async () => {
    const ctx = await context();
    const task = await createTask(ctx);
    const fact = await recordCodeFact(ctx, `runtime.precomplete_${sequence}`);
    await upsertSetting(db, 'project', ctx.projectId, 'exec.stale_check_on_start', false);
    liveHashes.set(FILE, 'b'.repeat(64));

    await json(ctx.call('session_start', {}));
    let stored = await sql<{ status: string }>`SELECT status FROM exec_facts WHERE id = ${String(fact.id)}::uuid`.execute(db as never);
    expect(stored.rows[0]?.status).toBe('active');

    await ctx.call('exec_task_complete', { task_ref: task.code });
    stored = await sql<{ status: string }>`SELECT status FROM exec_facts WHERE id = ${String(fact.id)}::uuid`.execute(db as never);
    expect(stored.rows[0]?.status).toBe('stale');
  });

  it('runs the periodic verifier and fails stale sources closed', async () => {
    const ctx = await context();
    liveHashes.set(FILE, 'e'.repeat(64));
    const fact = await json(ctx.call('fact_record', {
      key: `runtime.periodic_${sequence}`,
      value: 'The periodic fact verifier compares current source hashes.',
      kind: 'fact',
      source: 'code',
      source_ref: `file:${FILE}`,
      files: [FILE],
    }));
    liveHashes.set(FILE, 'f'.repeat(64));

    const job = new FactVerificationJob(db, silentLogger(), fileSource, 60_000);
    const result = await job.tick();
    expect(result).toMatchObject({ projects_checked: 1, facts_checked: 1, facts_stale: 1 });
    const stored = await sql<{ status: string }>`SELECT status FROM exec_facts WHERE id = ${String(fact.id)}::uuid`.execute(db as never);
    expect(stored.rows[0]?.status).toBe('stale');
  });
});

function silentLogger() {
  const noop = () => undefined;
  return Object.assign(noop, {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => silentLogger(),
  }) as never;
}
