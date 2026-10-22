import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleRegistry, newId, upsertSetting, type Db } from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * Requirement codes are unique per organisation but used to be numbered per project: the first
 * requirement of a second project got REQ-001 again and the INSERT failed, which an agent saw only
 * as "internal error". These tests pin the numbering through the real req_add dispatch path.
 */

let h: Harness;
let db: Db;
let orgA: string;
let userA: string;
let projectA: string;
let projectB: string;
let deps: McpDeps;
let seq = 0;

const actorFor = (organizationId: string, userId: string, projectId: string): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['ledger:read', 'ledger:write'],
    projectIds: [projectId],
    requestId: `req-codes-${(seq += 1)}`,
  }) as unknown as Actor;

const addReq = (who: Actor, n: number) =>
  callTool(
    deps,
    who,
    'req_add',
    { text: `Requirement number ${n} must return 201 and persist one row; test:exec-req-codes.test.ts`, quote: `Requirement number ${n}`, source: 'user_message', kind: 'functional', priority: 'medium' },
    who.requestId,
  );
const code = (r: Awaited<ReturnType<typeof addReq>>): string => (JSON.parse(r.content[0]?.text ?? '{}') as { code?: string }).code ?? `ERROR: ${r.content[0]?.text}`;

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const a = await seedOrg(db, { email: `rc-a-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass', projectKey: 'AAA' });
  orgA = a.organizationId;
  userA = a.userId;
  projectA = a.projectId;
  projectB = newId();
  await db.insertInto('projects').values({ id: projectB, organization_id: orgA, key: 'BBB', name: 'Second' } as never).execute();
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

describe('requirement code numbering', () => {
  it('second project gets a fresh code: its first requirement no longer collides with REQ-001', async () => {
    const first = await addReq(actorFor(orgA, userA, projectA), 1);
    expect(first.isError, JSON.stringify(first.content)).toBe(false);
    expect(code(first)).toBe('REQ-001');
    const second = await addReq(actorFor(orgA, userA, projectB), 2);
    expect(second.isError, JSON.stringify(second.content)).toBe(false);
    expect(code(second)).toBe('REQ-002');
    const third = await addReq(actorFor(orgA, userA, projectA), 3);
    expect(code(third)).toBe('REQ-003');
  });

  it('concurrent adds are distinct: parallel req_add calls in one organisation all succeed with distinct codes', async () => {
    const results = await Promise.all(
      [10, 11, 12, 13, 14, 15].map((n) => addReq(actorFor(orgA, userA, n % 2 ? projectA : projectB), n)),
    );
    for (const r of results) expect(r.isError, JSON.stringify(r.content)).toBe(false);
    const codes = results.map(code);
    expect(new Set(codes).size).toBe(codes.length);
    const all = await db.selectFrom('exec_requirements' as never).select('code' as never).where('organization_id' as never, '=', orgA as never).execute();
    const numbers = (all as unknown as { code: string }[]).map((r) => Number(r.code.slice(4))).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1)); // no gaps, no repeats
  });

  it('organisations are independent: another organisation starts again at REQ-001', async () => {
    const b = await seedOrg(db, { email: `rc-b-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass', projectKey: 'CCC' });
    const first = await addReq(actorFor(b.organizationId, b.userId, b.projectId), 20);
    expect(first.isError, JSON.stringify(first.content)).toBe(false);
    expect(code(first)).toBe('REQ-001');
  });
});
