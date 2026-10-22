import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleRegistry, newId, upsertSetting, type Db } from '@forgepm/core';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { callTool, resetRateBuckets, type McpDeps } from '../../apps/api/src/modules/mcp/dispatch';
import type { Actor } from '../../apps/api/src/app/auth-context';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * An agent with a ledger-only key used to guess `project_ref` from a project name and got a bare
 * NOT_FOUND. These tests pin the helpful behaviour end to end through the real dispatch path:
 * what resolves, what is refused and what the refusal tells the agent.
 */

let h: Harness;
let db: Db;
let orgId: string;
let userId: string;
let seededProjectId: string;
let zenithId: string;
let otherId: string;
let deps: McpDeps;
let seq = 0;

const actor = (over: Partial<Actor> = {}): Actor =>
  ({
    type: 'user',
    id: userId,
    organizationId: orgId,
    orgRole: 'owner',
    projectRole: () => 'admin',
    scopes: ['ledger:read', 'ledger:write'],
    projectIds: null,
    requestId: `req-pref-${(seq += 1)}`,
    ...over,
  }) as unknown as Actor;

const call = (name: string, args: Record<string, unknown>, who = actor()) => callTool(deps, who, name, args, who.requestId);
const body = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> => JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
const errorText = (r: Awaited<ReturnType<typeof call>>): string => r.content.map((c) => c.text).join('\n');

async function addProject(key: string, name: string, status = 'active'): Promise<string> {
  const id = newId();
  await db.insertInto('projects').values({ id, organization_id: orgId, key, name, status } as never).execute();
  return id;
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
  const seeded = await seedOrg(db, { email: `pref-${process.pid}-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass', projectKey: 'SSS' });
  orgId = seeded.organizationId;
  userId = seeded.userId;
  seededProjectId = seeded.projectId;
  zenithId = await addProject('ZNITH', 'Zenith');
  otherId = await addProject('OTHER', 'Other Thing');
  await addProject('DUPA', 'Twin');
  await addProject('DUPB', 'Twin');
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

describe('project_ref resolution', () => {
  it('resolves id key and unique name: id, key in any letter case and an exact unique name reach the same project', async () => {
    for (const ref of [zenithId, 'ZNITH', 'znith', 'ZnItH', 'Zenith', 'zenith']) {
      const r = await call('session_start', { project_ref: ref });
      expect(r.isError, `${ref}: ${errorText(r)}`).toBe(false);
      expect(body(r).project_id).toBe(zenithId);
    }
  });

  it('two projects with the same name must fail with a VALIDATION_ERROR listing both keys', async () => {
    const r = await call('session_start', { project_ref: 'twin' });
    expect(r.isError).toBe(true);
    const text = errorText(r);
    expect(text).toContain('VALIDATION_ERROR');
    expect(text).toContain('DUPA');
    expect(text).toContain('DUPB');
  });

  it('not found lists projects: the message names the visible projects and a did-you-mean candidate', async () => {
    const r = await call('session_start', { project_ref: 'zenit' });
    expect(r.isError).toBe(true);
    const text = errorText(r);
    expect(text).toContain('NOT_FOUND');
    expect(text).toContain("did you mean ZNITH");
    expect(text).toContain('Projects you can use:');
    expect(text).toContain('SSS (Seed Project)');
    expect(text).toContain('OTHER (Other Thing)');
  });

  it('a missing project_ref on an unbound key tells the agent which projects exist', async () => {
    const r = await call('session_start', {});
    expect(r.isError).toBe(true);
    const text = errorText(r);
    expect(text).toContain('needs one project');
    expect(text).toContain('ZNITH (Zenith)');
  });

  it('restricted key sees only its projects: neither the error nor ledger_projects leaks the others', async () => {
    const bound = actor({ projectIds: [zenithId] });
    const ok = await call('session_start', {}, bound);
    expect(ok.isError, errorText(ok)).toBe(false);
    expect(body(ok).project_id).toBe(zenithId);

    const miss = await call('session_start', { project_ref: 'nothing-like-it' }, bound);
    const text = errorText(miss);
    expect(text).toContain('ZNITH');
    expect(text).not.toContain('OTHER');
    expect(text).not.toContain('Seed Project');

    const list = body(await call('ledger_projects', { include_archived: true }, bound));
    expect((list.items as { key: string }[]).map((p) => p.key)).toEqual(['ZNITH']);
    expect(list.bound_to_project_ids).toEqual([zenithId]);
  });
});

describe('ledger_projects and session_start', () => {
  it('ledger_projects tool: listed and callable with ledger:read only, returns id, key, name and status', async () => {
    const readOnly = actor({ scopes: ['ledger:read'] });
    const listed = await deps.tools.visible(['ledger:read'], async () => true);
    expect(listed.map((t) => t.name)).toContain('ledger_projects');

    const r = await call('ledger_projects', {}, readOnly);
    expect(r.isError, errorText(r)).toBe(false);
    const out = body(r);
    const items = out.items as { id: string; key: string; name: string; status: string }[];
    expect(items.find((p) => p.key === 'ZNITH')).toEqual({ id: zenithId, key: 'ZNITH', name: 'Zenith', status: 'active' });
    expect(items.map((p) => p.key)).toEqual(expect.arrayContaining(['SSS', 'OTHER', 'DUPA', 'DUPB']));
    expect(typeof out.hint).toBe('string');
  });

  it('ledger_projects hides archived projects unless asked', async () => {
    await addProject('OLDY', 'Old One', 'archived');
    const plain = body(await call('ledger_projects', {}));
    expect((plain.items as { key: string }[]).map((p) => p.key)).not.toContain('OLDY');
    const all = body(await call('ledger_projects', { include_archived: true }));
    expect((all.items as { key: string; status: string }[]).find((p) => p.key === 'OLDY')?.status).toBe('archived');
  });

  it('session_start project: the result names the project it resolved', async () => {
    const out = body(await call('session_start', { project_ref: 'ZNITH' }));
    expect(out.project).toEqual({ id: zenithId, key: 'ZNITH', name: 'Zenith' });
    const seeded = body(await call('session_start', { project_ref: seededProjectId }));
    expect((seeded.project as { key: string }).key).toBe('SSS');
    expect(otherId).toBeTruthy();
  });
});
