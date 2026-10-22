import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { newId, upsertSetting, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';
import { setActiveCipher, createCipher } from '@forgepm/core';

let h: Harness;
let app: FastifyInstance;
let AUTH: { cookies: string; csrf: string };
let projectId = '';
let backlogId = '';

const env: Env = {
  NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200', API_DOCS_ENABLED: false, METRICS_ENABLED: false, LOG_LEVEL: 'fatal',
};

beforeAll(async () => {
  setActiveCipher(createCipher(Buffer.from(env.FORGEPM_SECRET_KEY, 'base64')));
  h = await createHarness();
  app = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true) });
  await app.ready();
});
afterAll(async () => { await app.close(); await h.cleanup(); });

async function session(): Promise<void> {
  const seed = await seedOrg(h.db, { email: 'gh@x.io', password: 'hunter22x', projectKey: 'FPM' });
  projectId = seed.projectId;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'gh@x.io', password: 'hunter22x' } });
  const cookies = r.headers['set-cookie'] as unknown as string[];
  const s = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  AUTH = { cookies: `${s}; fpm_csrf=${csrf}`, csrf };
  const st = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/states`, headers: { cookie: AUTH.cookies } });
  backlogId = st.json().items.find((x: { name: string }) => x.name === 'Backlog').id as string;
}

beforeEach(async () => {
  await h.reset();
  // webhook secret is read from env (bootstrap); keep it fixed for tests.
  process.env.GITHUB_WEBHOOK_SECRET = 'whsec_test';
  // enabling the module now requires all three secrets (POU-36)
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
  await session();
});

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function enableGithub(): Promise<void> {
  // toggle via the route so the running app's module cache is invalidated too.
  const r = await app.inject({ method: 'PUT', url: '/api/v1/modules/github/enabled', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { enabled: true } });
  expect(r.statusCode).toBeLessThan(300);
}

async function createItem(title: string): Promise<{ id: string; key: string }> {
  const r = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/work-items`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { type: 'task', title, state_id: backlogId } });
  return { id: r.json().id, key: r.json().key };
}

describe('github module lifecycle (plan §9 acceptance)', () => {
  it('server boots with no github config; webhook => 503 MODULE_DISABLED; core tests unaffected', async () => {
    const res = await app.inject({ method: 'POST', url: '/integrations/github/webhook', payload: { action: 'opened' }, headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-none' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
    // core still healthy: project list works
    const projects = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: AUTH.cookies } });
    expect(projects.statusCode).toBe(200);
  });

  it('invalid signature => 401 + no delivery row; valid => 202; resend idempotent', async () => {
    await enableGithub();
    const body = JSON.stringify({ action: 'opened', pull_request: { id: 1, number: 1, title: 't', state: 'open', draft: false }, repository: { id: 10, full_name: 'a/b' } });
    const bad = await app.inject({ method: 'POST', url: '/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-bad', 'x-hub-signature-256': 'sha256=deadbeef' }, payload: JSON.parse(body) as object });
    expect(bad.statusCode).toBe(401);
    const still = await h.db.selectFrom('webhook_deliveries').select('id').where('delivery_id', '=', 'd-bad').executeTakeFirst();
    expect(still).toBeUndefined();

    const sig = sign(process.env.GITHUB_WEBHOOK_SECRET!, body);
    const ok = await app.inject({ method: 'POST', url: '/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-ok', 'x-hub-signature-256': sig }, payload: JSON.parse(body) as object });
    expect(ok.statusCode).toBe(202);
    const resend = await app.inject({ method: 'POST', url: '/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-ok', 'x-hub-signature-256': sig }, payload: JSON.parse(body) as object });
    expect(resend.statusCode).toBe(202);
    const rows = await h.db.selectFrom('webhook_deliveries').selectAll().where('delivery_id', '=', 'd-ok').execute();
    expect(rows.length).toBe(1);
    const outbox = await sql`SELECT * FROM outbox WHERE payload->>'delivery_id' = 'd-ok'`.execute(h.db);
    expect(outbox.rows.length).toBe(1);
  });

  it('manual PR link extracts FPM keys from branch + title; auto_transition_on_merge moves only the closing key', async () => {
    await enableGithub();
    const branchItem = await createItem('login form'); // referenced only by branch
    const closingItem = await createItem('dashboard'); // referenced by 'fixes'
    const title = `fixes ${closingItem.key} and mentions ${branchItem.key}`;
    const headRef = `feat/${branchItem.key}-login`;
    await upsertSetting(h.db, 'system', null, 'github.auto_transition_on_merge', true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/pull-requests`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'r1', repository_full_name: 'org/repo', pr_external_id: 'pr1', number: 7, title, state: 'open', draft: false, head_ref: headRef },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().links).toBe(2); // both keys linked (branch + title)

    const devB = await app.inject({ method: 'GET', url: `/api/v1/work-items/${branchItem.key}/development`, headers: { cookie: AUTH.cookies } });
    expect(devB.json().items.length).toBe(1);
    const devC = await app.inject({ method: 'GET', url: `/api/v1/work-items/${closingItem.key}/development`, headers: { cookie: AUTH.cookies } });
    expect(devC.json().items.length).toBe(1);
    // 'opened' is not a merge: states unchanged.
    const openState = await app.inject({ method: 'GET', url: `/api/v1/work-items/${closingItem.key}`, headers: { cookie: AUTH.cookies } });
    expect(openState.json().state_category).toBe('backlog');

    // merged close moves only the closing-referenced key to completed.
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/pull-requests`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'r1', repository_full_name: 'org/repo', pr_external_id: 'pr1', number: 7, title, state: 'closed', draft: false, head_ref: headRef, action: 'closed', merged: true, merged_at: new Date().toISOString() },
    });
    expect(res2.statusCode).toBe(201);
    const closed = await app.inject({ method: 'GET', url: `/api/v1/work-items/${closingItem.key}`, headers: { cookie: AUTH.cookies } });
    expect(closed.json().state_category).toBe('completed');
    const branch = await app.inject({ method: 'GET', url: `/api/v1/work-items/${branchItem.key}`, headers: { cookie: AUTH.cookies } });
    expect(branch.json().state_category).toBe('backlog');
  });

  it('no source code / secret values in DB; only encrypted secrets', async () => {
    await enableGithub();
    const save = await app.inject({ method: 'POST', url: '/api/v1/integrations/github/config', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { app_id: '12345', app_private_key: 'PRIVATE KEY MATERIAL zzz', webhook_secret: 'whsec_top_secret' } });
    expect(save.statusCode).toBe(200);
    const dump = JSON.stringify(await h.db.selectFrom('secrets').selectAll().execute());
    expect(dump).not.toContain('PRIVATE KEY MATERIAL');
    expect(dump).not.toContain('whsec_top_secret');
    const audit = JSON.stringify(await h.db.selectFrom('audit_events').selectAll().execute());
    expect(audit).not.toContain('whsec_top_secret');
  });

  it('project with two repositories sees PRs from both; no repo project works', async () => {
    await enableGithub();
    const p1 = await createItem('a');
    const pr1 = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/pull-requests`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { repository_external_id: 'rA', repository_full_name: 'a/b', pr_external_id: 'prA', number: 1, title: `ref ${p1.key}`, state: 'open', draft: false, head_ref: `feat/${p1.key}-a` } });
    const pr2 = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/pull-requests`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { repository_external_id: 'rB', repository_full_name: 'c/d', pr_external_id: 'prB', number: 2, title: `ref ${p1.key}`, state: 'open', draft: false, head_ref: `fix/${p1.key}-b` } });
    expect(pr1.statusCode).toBe(201);
    expect(pr2.statusCode).toBe(201);
    const dev = await app.inject({ method: 'GET', url: `/api/v1/work-items/${p1.key}/development`, headers: { cookie: AUTH.cookies } });
    expect(dev.json().items.length).toBe(2);
    const repos = await app.inject({ method: 'GET', url: '/api/v1/repositories', headers: { cookie: AUTH.cookies } });
    expect(repos.json().items.length).toBe(2);
  });
});

describe('issue import + release (plan §9.5, §9.6)', () => {
  it('mode=off: no work item created', async () => {
    await enableGithub();
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/' + projectId + '/issues/import',
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'rI', repository_full_name: 'o/i', issue_number: 101, title: 'bug one', body: null, state: 'open', labels: [] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().action).toBe('skipped');
  });

  it('mode=import: creates then idempotent update; conflict path records sync_conflict', async () => {
    await enableGithub();
    // set project-scoped import mode
    await app.inject({
      method: 'PUT',
      url: `/api/v1/settings/project/${projectId}/github.issue_sync_mode`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { value: 'import' },
    });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/issues/import`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'rI', repository_full_name: 'o/i', issue_number: 500, title: 'bug A', body: 'desc', state: 'open', labels: ['triage'], remote_version: 'v1' },
    });
    expect(first.statusCode).toBe(201, first.body);
    expect(first.json().action).toBe('created');
    // repeat => updated (not created)
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/issues/import`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'rI', repository_full_name: 'o/i', issue_number: 500, title: 'bug A updated', body: 'new body', state: 'closed', labels: ['triage'], remote_version: 'v2' },
    });
    expect(second.json().action).toBe('updated');
    const items = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/work-items?limit=100`, headers: { cookie: AUTH.cookies } });
    const found = items.json().items.filter((i: { title: string }) => i.title.startsWith('bug A'));
    expect(found.length).toBe(1); // no duplicate created
    // simulate local edit: bump local_modified_at on the link, then re-import => conflict
    const linkRow = await h.db.selectFrom('external_issue_links').select('id').where('repository_id', '=', first.json().repository_id).executeTakeFirstOrThrow();
    await h.db.updateTable('external_issue_links').set({ local_modified_at: new Date(Date.now() + 10_000), last_synced_at: new Date(0) } as never).where('id', '=', linkRow.id).execute();
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/issues/import`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'rI', repository_full_name: 'o/i', issue_number: 500, title: 'gh wins', body: 'body', state: 'open', labels: [], remote_version: 'v3' },
    });
    expect(conflict.json().action).toBe('conflict');
    const audits = await h.db.selectFrom('audit_events').select('action').where('action', '=', 'github.sync_conflict').execute();
    expect(audits.length).toBe(1);
  });

  it('github.issue_sync_mode=export/two_way rejected with 422 (plan §9.5)', async () => {
    for (const bad of ['export', 'two_way']) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/v1/settings/project/${projectId}/github.issue_sync_mode`,
        headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
        payload: { value: bad },
      });
      expect(r.statusCode, `${bad}: ${r.body}`).toBe(422);
    }
    const off = await app.inject({
      method: 'PUT',
      url: `/api/v1/settings/project/${projectId}/github.issue_sync_mode`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { value: 'off' },
    });
    expect(off.statusCode).toBe(200);
  });

  it('release event persists a row', async () => {
    await enableGithub();
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/releases`,
      headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf },
      payload: { repository_external_id: 'rR', repository_full_name: 'o/r', tag: 'v1.0.0', published_at: new Date().toISOString(), notes: 'first' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().created).toBe(true);
    const releases = await h.db.selectFrom('releases').selectAll().where('tag', '=', 'v1.0.0').execute();
    expect(releases.length).toBe(1);
  });
});

describe('project repository links (list + disconnect)', () => {
  const H = () => ({ cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf });
  const link = (id: string, name: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/pull-requests`,
      headers: H(),
      payload: { repository_external_id: id, repository_full_name: name, pr_external_id: `pr-${id}`, number: 1, title: 't', state: 'open', draft: false, head_ref: 'x' },
    });

  it('project repositories list: only the repositories linked to that project', async () => {
    await enableGithub();
    expect((await link('rA', 'a/b')).statusCode).toBe(201);
    expect((await link('rB', 'c/d')).statusCode).toBe(201);
    const orgId = (await h.db.selectFrom('projects').select('organization_id').where('id', '=', projectId).executeTakeFirstOrThrow()).organization_id;
    await h.db.insertInto('repositories').values({ id: newId(), organization_id: orgId, provider: 'github', external_id: 'rC', full_name: 'e/f' }).execute();

    const mine = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/repositories`, headers: { cookie: AUTH.cookies } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.map((r: { full_name: string }) => r.full_name)).toEqual(['a/b', 'c/d']);
    const all = await app.inject({ method: 'GET', url: '/api/v1/repositories', headers: { cookie: AUTH.cookies } });
    expect(all.json().items.length).toBe(3);
  });

  it('disconnect repository: removes only the link row, audits once and is idempotent', async () => {
    await enableGithub();
    await link('rA', 'a/b');
    const repoId = (await h.db.selectFrom('repositories').select('id').where('external_id', '=', 'rA').executeTakeFirstOrThrow()).id;
    const url = `/api/v1/projects/${projectId}/repositories/${repoId}`;

    const first = await app.inject({ method: 'DELETE', url, headers: H() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'ok', removed: true });
    expect((await h.db.selectFrom('repositories').select('id').where('id', '=', repoId).execute()).length).toBe(1);
    expect((await h.db.selectFrom('project_repositories').select('repository_id').where('repository_id', '=', repoId).execute()).length).toBe(0);

    const again = await app.inject({ method: 'DELETE', url, headers: H() });
    expect(again.json()).toEqual({ status: 'ok', removed: false });
    const audits = await h.db.selectFrom('audit_events').select('id').where('action', '=', 'github.disconnect_repository').execute();
    expect(audits.length).toBe(1);

    const relist = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/repositories`, headers: { cookie: AUTH.cookies } });
    expect(relist.json().items).toEqual([]);
    // reconnecting restores the link (the pull request path upserts and connects again)
    await link('rA', 'a/b');
    const back = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/repositories`, headers: { cookie: AUTH.cookies } });
    expect(back.json().items.length).toBe(1);
  });

  it('repository link access: anonymous callers and unknown projects are refused', async () => {
    await enableGithub();
    const anon = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/repositories` });
    expect(anon.statusCode).toBe(401);
    const anonDel = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/repositories/${newId()}` });
    expect(anonDel.statusCode).toBe(401);
    const ghost = await app.inject({ method: 'GET', url: `/api/v1/projects/${newId()}/repositories`, headers: { cookie: AUTH.cookies } });
    expect(ghost.statusCode).toBeGreaterThanOrEqual(400);
    expect(ghost.statusCode).toBeLessThan(500);
  });
});
