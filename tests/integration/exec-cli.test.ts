import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { EXEC_POLICY_DEFAULT, newId, toJsonb, upsertSetting, type Db, type Env } from '@forgepm/core';
import type { ExecPolicy } from '@forgepm/shared';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { ensureWorkflow } from '../../apps/api/src/modules/work-items/states';
import { createHarness, type Harness } from './harness';
import { seedAgent, seedApiKey, seedOrg } from './seed';

/**
 * The human's CLI (plan §9.5, acceptance B.14/B.15).
 *
 * The CLI is a thin client over the same REST routes the panel uses, and the
 * test proves exactly that: the command line reaches the ledger, the item is
 * closed with the human's name on it, and an AGENT's key is refused with
 * FORBIDDEN_SCOPE — because the deciding path is the human's (D-040).
 */

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

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
let baseUrl: string;

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, {
    email: `pe4-cli-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seeded.organizationId;
  projectId = seeded.projectId;
  userId = seeded.userId;
  humanKey = await seedApiKey(db, orgId, userId, ['read', 'write', 'ledger:decide'], [projectId]);
  // A real AGENT key (no owner user): the plan's B.15 says an agent's key
  // gets FORBIDDEN_SCOPE, because `ledger:decide` is human-only (D-040) and
  // an agent key can never carry it.
  const agentId = await seedAgent(db, orgId, `pe4-cli-agent-${process.pid}`);
  agentKey = await seedApiKey(db, orgId, userId, ['read', 'write', 'ledger:read', 'ledger:write'], [projectId], {
    agentId,
  });
  const registry = buildRegistry();
  await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
  registry.invalidate();
  app = await buildApp({
    env,
    db: h.db,
    registry,
    redisAvailable: () => Promise.resolve(true),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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
      title: 'a task with an open item the human closes',
      state_id: states[0]?.id as string,
    })
    .execute();
  taskId = newId();
  await db
    .insertInto('exec_tasks')
    .values({
      id: taskId,
      organization_id: orgId,
      project_id: projectId,
      work_item_id: workItemId,
      code: 'T-001',
      title: 'a task with an open item the human closes',
      status: 'in_progress',
      allowed_paths: toJsonb(['packages/core/src/exec/**']) as never,
    })
    .execute();
  await db
    .insertInto('exec_open_items')
    .values({
      id: newId(),
      organization_id: orgId,
      task_id: taskId,
      code: 'OI-001',
      title: 'the migration is still missing',
      type: 'commitment',
      blocks_completion: true,
      source: 'agent',
      status: 'open',
    })
    .execute();
});

afterAll(async () => {
  await app?.close();
  await h?.cleanup();
});

async function cli(args: string[], key: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await run(TSX, [join(ROOT, 'scripts', 'ledger-cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, FORGEPM_URL: baseUrl, FORGEPM_API_KEY: key },
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function policyCheck(): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${humanKey}` },
    payload: {
      jsonrpc: '2.0',
      id: 'policy-check',
      method: 'tools/call',
      params: {
        name: 'exec_policy_check',
        arguments: { action_kind: 'deps_add', target: 'package.json', reversible: true },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const envelope = response.json() as { result?: { content?: { text?: string }[] } };
  return JSON.parse(envelope.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('the CLI is the human path (B.14/B.15)', () => {
  it('B.14 a human closes an item from the command line, and the ledger says who', async () => {
    const res = await cli(
      ['resolve', 'OI-001', '--status', 'deferred', '--note', 'the migration moves to the next release, by decision'],
      humanKey,
    );
    expect(res.code, res.stderr).toBe(0);

    const row = await sql<{ status: string; resolved_by: string | null; resolution_note: string }>`
      SELECT status, resolved_by, resolution_note FROM exec_open_items WHERE code = 'OI-001'
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('deferred');
    expect(row.rows[0]?.resolved_by).toBe('human');
    expect(row.rows[0]?.resolution_note).toContain('next release');

    const audits = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM audit_events
      WHERE action = 'exec.open_item.resolve' AND resource_id = (
        SELECT id FROM exec_open_items WHERE code = 'OI-001'
      )
    `.execute(db as never);
    expect(Number(audits.rows[0]?.n)).toBe(1);
  });

  it('B.15 the same command with an AGENT key is refused', async () => {
    const res = await cli(
      ['resolve', 'OI-001', '--status', 'resolved', '--note', 'the agent closed it on its own, why not'],
      agentKey,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/FORBIDDEN_SCOPE/);
  });

  it('F.2 policy:set changes deps_add from review to approval without a code change', async () => {
    expect(await policyCheck()).toMatchObject({ level: 'review' });

    const customPolicy = JSON.parse(JSON.stringify(EXEC_POLICY_DEFAULT)) as ExecPolicy;
    customPolicy.rules = customPolicy.rules.map((rule) =>
      rule.category === 'deps_add' ? { ...rule, level: 'approval' } : rule,
    );
    const directory = await mkdtemp(join(tmpdir(), 'forgepm-policy-'));
    const file = join(directory, 'policy.json');
    try {
      await writeFile(file, JSON.stringify(customPolicy, null, 2));
      const set = await cli(
        ['policy', 'set', '--from', file, '--scope', 'organization', '--scope-id', 'me'],
        humanKey,
      );
      expect(set.code, set.stderr).toBe(0);

      // getEffective is a direct settings read (there is no stale policy cache).
      expect(await policyCheck()).toMatchObject({ level: 'approval', required: { tool_to_call: 'ledger_record_decision' } });
      const printed = await cli(['policy', 'print', '--scope', 'organization', '--scope-id', 'me', '--json'], humanKey);
      expect(printed.code, printed.stderr).toBe(0);
      expect(JSON.parse(printed.stdout)).toMatchObject({ source: 'organization', value: { rules: expect.arrayContaining([
        expect.objectContaining({ category: 'deps_add', level: 'approval' }),
      ]) } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('the CLI reaches the other human verbs too', async () => {
    // A criterion to waive, a fact to promote: the same REST routes the
    // panel uses, reached from the terminal.
    const criterionId = newId();
    await db
      .insertInto('exec_criteria')
      .values({
        id: criterionId,
        task_id: taskId,
        code: 'C-001',
        text: 'the human may waive a criterion it does not want to keep',
        status: 'pending',
      })
      .execute();
    const waived = await cli(
      ['waive', 'C-001', '--reason', 'the requirement behind it moved to the next release'],
      humanKey,
    );
    expect(waived.code, waived.stderr).toBe(0);
    const row = await sql<{ status: string; waiver_approval_id: string | null }>`
      SELECT status, waiver_approval_id::text AS waiver_approval_id FROM exec_criteria WHERE code = 'C-001'
    `.execute(db as never);
    expect(row.rows[0]?.status).toBe('waived');
    expect(row.rows[0]?.waiver_approval_id).toBeTruthy();

    await db
      .insertInto('exec_facts')
      .values({
        id: newId(),
        organization_id: orgId,
        project_id: projectId,
        code: 'F-001',
        key: 'cli.fact_promotion',
        value: 'the command line can promote a guess into a fact',
        kind: 'assumption',
        source: 'agent_guess',
      })
      .execute();
    const promoted = await cli(
      ['fact', 'promote', 'F-001', '--source', 'human', '--reason', 'the human checked it and says it is true'],
      humanKey,
    );
    expect(promoted.code, promoted.stderr).toBe(0);
    const fact = await sql<{ kind: string; source: string }>`
      SELECT kind, source FROM exec_facts WHERE code = 'F-001'
    `.execute(db as never);
    expect(fact.rows[0]?.kind).toBe('fact');
    expect(fact.rows[0]?.source).toBe('human');
  });

  it('the CLI refuses a waiver with no reason', async () => {
    const res = await cli(['waive', 'C-001', '--reason', 'because'], humanKey);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/--reason/);
  });

  it('the CLI refuses a closure without a note', async () => {
    const res = await cli(['resolve', 'OI-001', '--status', 'resolved'], humanKey);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/--note/);
  });
});
