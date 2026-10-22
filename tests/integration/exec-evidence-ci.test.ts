import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ModuleRegistry, upsertSetting, type Db } from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * A bare ci:<run>:<job> evidence reference used to be accepted by the validator and then rejected by the
 * database (size_bytes 0 violates exec_evidence_size_bytes_check), so the agent only saw "internal error".
 */

let h: Harness;
let db: Db;
let deps: McpDeps;
let who: Actor;
let seq = 0;

const call = (name: string, args: Record<string, unknown>) => callTool(deps, who, name, args, `req-ci-${(seq += 1)}`);
const body = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> => JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const s = await seedOrg(db, { email: `ci-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass', projectKey: 'CIE' });
  who = {
    type: 'user',
    id: s.userId,
    organizationId: s.organizationId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['ledger:read', 'ledger:write'],
    projectIds: [s.projectId],
    requestId: 'req-ci',
  } as unknown as Actor;
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

async function startTask(): Promise<{ task: string; criterion: string }> {
  const r = await call('exec_task_start', {
    title: 'evidence probe task',
    acceptance_criteria: ['the evidence tool must accept the reference; test:exec-evidence-ci.test.ts'],
    allowed_paths: ['apps/**'],
  });
  expect(r.isError, JSON.stringify(r.content)).toBe(false);
  return { task: body(r).code as string, criterion: (body(r).criterion_codes as string[])[0] };
}

describe('ledger_add_evidence with a ci reference', () => {
  it('bare ci ref is stored unverified: the call succeeds, size_bytes is NULL and the criterion is not marked verified', async () => {
    const { task, criterion } = await startTask();
    const r = await call('ledger_add_evidence', {
      task_ref: task,
      criterion_ref: criterion,
      kind: 'test_output',
      ref: 'ci:39833987652:verify',
      summary: 'Remote CI run 39833987652 finished with verify success on the pull request.',
    });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    const out = body(r);
    expect(out.verified).toBe(false);
    expect(out.size_bytes).toBeNull();
    const row = await sql<{ size_bytes: number | null }>`SELECT size_bytes FROM exec_evidence WHERE ref = 'ci:39833987652:verify'`.execute(db as never);
    expect(row.rows).toEqual([{ size_bytes: null }]);
    const crit = await sql<{ status: string }>`SELECT c.status FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id WHERE t.code = ${task} AND c.code = ${criterion}`.execute(db as never);
    expect(crit.rows[0]?.status).not.toBe('verified');
  });

  it('payload evidence unchanged: real output still stores its size and verifies the criterion', async () => {
    const { task, criterion } = await startTask();
    const payload = ['✓ unit tests/unit/example.test.ts (12 tests)', ...Array.from({ length: 12 }, (_, i) => `   ✓ case ${i + 1} passes`), '      Tests  12 passed (12)'].join('\n');
    expect(payload.length).toBeGreaterThanOrEqual(200);
    const r = await call('ledger_add_evidence', {
      task_ref: task,
      criterion_ref: criterion,
      kind: 'test_output',
      ref: 'test:exec-evidence-ci.test.ts',
      summary: 'Unit test output with a result line, recorded with its payload.',
      payload,
    });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    const out = body(r);
    expect(out.verified).toBe(true);
    expect(out.size_bytes).toBe(Buffer.byteLength(payload));
  });
});
