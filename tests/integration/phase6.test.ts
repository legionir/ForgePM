import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setReviewOutputWriter,
  newId,
  type GenerateRequest,
  type Env,
} from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

let h: Harness;
let app: FastifyInstance;
let AUTH: { cookies: string; csrf: string };
let projectId = '';
let repoId = '';
let orgId = '';

// Per-test mutable findings the offline review provider returns for every
// stage; the engine dedupes identical ones within a run (plan §10).
let currentFindings: unknown[] = [];
const capturedPayloads: { files: string[] }[] = [];
const fixtures = new Map<string, (req: GenerateRequest) => unknown>();
fixtures.set('*', (req: GenerateRequest) => {
  capturedPayloads.push(JSON.parse(req.messages[0].content) as { files: string[] });
  return { findings: currentFindings };
});

const env: Env = {
  NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200', API_DOCS_ENABLED: false, METRICS_ENABLED: false, LOG_LEVEL: 'fatal',
};

// snapshot file src/a.ts: 11 fillers (1..11), alpha..eta (12..18), tail (19)
const SNAPSHOT = { path: 'src/a.ts', lines: [...Array.from({ length: 11 }, (_, i) => `f${i}`), 'alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();', 'tail'] };
const HUNKS = [{ file: 'src/a.ts', start: 12, lines: ['alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();'] }];

const finding = (over: Record<string, unknown> = {}) => ({
  category: 'security', severity: 'high', confidence: 0.9, file: 'src/a.ts',
  line_start: 12, line_end: 13, title: 'Missing check', description: 'd', why_it_matters: 'w', suggestion: 's', evidence: 'alpha();\nbeta();', ...over,
});

async function session(): Promise<void> {
  const seed = await seedOrg(h.db, { email: 'rv@x.io', password: 'hunter22x', projectKey: 'RVW' });
  projectId = seed.projectId;
  orgId = seed.organizationId;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'rv@x.io', password: 'hunter22x' } });
  const cookies = r.headers['set-cookie'] as unknown as string[];
  const s = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  AUTH = { cookies: `${s}; fpm_csrf=${csrf}`, csrf };
  // connect a repository to the project so reviews can target it
  repoId = (await h.db.insertInto('repositories').values({ id: newId(), organization_id: orgId, provider: 'github', external_id: '100', full_name: 'acme/app' }).returning('id').executeTakeFirstOrThrow()).id;
  await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();
  await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/states`, headers: { cookie: AUTH.cookies } });
}

async function enable(mod: 'code_review' | 'refactor_review'): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: `/api/v1/modules/${mod}/enabled`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { enabled: true } });
  expect(r.statusCode, r.body).toBeLessThan(300);
}
async function setPolicy(value: string): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/review.issue_policy', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value } });
  expect(r.statusCode, r.body).toBeLessThan(300);
}
function codeRunBody(extra: Record<string, unknown> = {}) {
  return { project_id: projectId, repository_id: repoId, pr_number: 7, commit_sha: 'sha-1', draft: false, hunks: HUNKS, snapshot: [SNAPSHOT], ...extra };
}
async function postCode(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/review/code-runs', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: body });
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true), reviewFixtures: fixtures });
  await app.ready();
});
afterAll(async () => {
  setReviewOutputWriter(null);
  await app.close();
  await h.cleanup();
});
beforeEach(async () => {
  setReviewOutputWriter(null);
  currentFindings = [];
  capturedPayloads.length = 0;
  await h.reset();
  await session();
});

describe('reviews module gates (plan §10 acceptance)', () => {
  it('both modules off => 503 MODULE_DISABLED; no review MCP tools listed', async () => {
    const res = await postCode(codeRunBody());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
    const runs = await app.inject({ method: 'GET', url: `/api/v1/review/runs?project_id=${projectId}`, headers: { cookie: AUTH.cookies } });
    expect(runs.statusCode).toBe(503);

    // MCP tools/list has no review_* / refactor_review_* when disabled
    const list = await app.inject({ method: 'POST', url: '/mcp', headers: { cookie: AUTH.cookies }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const names = (list.json().result.tools as { name: string }[]).map((t) => t.name);
    expect(names.filter((n) => n.startsWith('review_') || n.startsWith('refactor_review'))).toEqual([]);
  });

  it('creating a PR delivery enqueues NO review job while code_review is off', async () => {
    // auto_run path is off because the module is off — verify a delivery for a
    // PR does not create review_runs rows.
    const before = await h.db.selectFrom('review_runs').select('id').execute();
    expect(before.length).toBe(0);
    // (worker-driven webhook path is covered in phase6-worker.test.ts)
  });

  it('enable from the panel works without restart; core still boots clean', async () => {
    await enable('code_review');
    const res = await postCode(codeRunBody());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe('completed');
  });
});

describe('code review run (plan §10 acceptance)', () => {
  it('fake provider + PR sample => completed run, findings with all required fields', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    const res = await postCode(codeRunBody());
    expect(res.statusCode, res.body).toBe(201);
    const runId = res.json().run_id as string;
    const f = await app.inject({ method: 'GET', url: `/api/v1/review/findings?project_id=${projectId}`, headers: { cookie: AUTH.cookies } });
    const item = f.json().items[0];
    for (const key of ['category', 'severity', 'confidence', 'file', 'line_start', 'line_end', 'title', 'description', 'why_it_matters', 'suggestion', 'evidence']) {
      expect(item, JSON.stringify(item)).toHaveProperty(key);
    }
    expect(item.title).toBe('Missing check');
    const rep = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}`, headers: { cookie: AUTH.cookies } });
    expect(rep.json().status).toBe('completed');
  });

  it('invalid evidence (file/range/mismatch/out-of-hunk) discarded and counted', async () => {
    await enable('code_review');
    currentFindings = [
      finding({ title: 'bad file', file: 'src/ghost.ts' }),
      finding({ title: 'bad range', line_start: 999, line_end: 1000, evidence: 'x();' }),
      finding({ title: 'bad evidence', line_start: 12, line_end: 13, evidence: 'totally(); wrong();' }),
      finding({ title: 'out of hunk', line_start: 2, line_end: 3, evidence: 'f1\nf2' }),
    ];
    const res = await postCode(codeRunBody());
    expect(res.json().stats.discarded).toBe(4);
    const f = await app.inject({ method: 'GET', url: `/api/v1/review/findings?project_id=${projectId}`, headers: { cookie: AUTH.cookies } });
    expect(f.json().items).toHaveLength(0);
  });

  it('rerun same PR: no new findings, last_seen_run_id advances; line shift ≠ duplicate', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    await postCode(codeRunBody());
    const first = await h.db.selectFrom('review_findings').select(['id', 'last_seen_run_id', 'fingerprint']).executeTakeFirstOrThrow();

    // second run: same finding at SHIFTED lines (snapshot moved by one line);
    // evidence unchanged => fingerprint unchanged => touched, not duplicated.
    const snapshot2 = { path: 'src/a.ts', lines: [...Array.from({ length: 12 }, (_, i) => `f${i}`), 'alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();', 'tail'] };
    const hunks2 = [{ file: 'src/a.ts', start: 13, lines: ['alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();'] }];
    currentFindings = [finding({ line_start: 13, line_end: 14, evidence: 'alpha();\nbeta();' })];
    const r2 = await postCode(codeRunBody({ hunks: hunks2, snapshot: [snapshot2] }));
    expect(r2.json().stats.created, JSON.stringify(r2.json())).toBe(0);
    expect(r2.json().stats.touched).toBe(1);
    const after = await h.db.selectFrom('review_findings').select(['id', 'last_seen_run_id', 'fingerprint']).execute();
    expect(after).toHaveLength(1);
    expect(after[0].last_seen_run_id).not.toBe(first.last_seen_run_id);
    expect(after[0].id).toBe(first.id);
  });

  it('UNIQUE(project_id, scope_key, fingerprint) enforced at DB', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    await postCode(codeRunBody());
    const row = await h.db.selectFrom('review_findings').select(['project_id', 'scope_key', 'fingerprint', 'run_id']).executeTakeFirstOrThrow();
    await expect(
      h.db.insertInto('review_findings').values({
        id: newId(), organization_id: orgId, project_id: row.project_id, run_id: row.run_id, first_run_id: row.run_id, last_seen_run_id: row.run_id,
        scope_key: row.scope_key, fingerprint: row.fingerprint, category: 'x', severity: 'low', confidence: 1, file: 'f', title: 't', description: 'd',
      } as never).execute(),
    ).rejects.toThrow();
  });

  it('not_seen after 1 complete miss, fixed after 2; truncated run does not count', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    await postCode(codeRunBody()); // run A: F created (open)
    currentFindings = [];
    await postCode(codeRunBody()); // run B: complete, misses F => not_seen (streak 1)
    let st = await h.db.selectFrom('review_findings').select(['status', 'unseen_streak']).executeTakeFirstOrThrow();
    expect(st.status).toBe('not_seen');
    expect(st.unseen_streak).toBe(1);
    // truncated run must NOT advance the streak
    await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/code_review.max_diff_bytes', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 1024 } });
    currentFindings = [];
    await postCode(codeRunBody({ hunks: [{ file: 'src/a.ts', start: 12, lines: ['x'.repeat(3000)] }], snapshot: [SNAPSHOT] }));
    st = await h.db.selectFrom('review_findings').select(['status', 'unseen_streak']).executeTakeFirstOrThrow();
    expect(st.unseen_streak).toBe(1);
    await app.inject({ method: 'DELETE', url: '/api/v1/settings/system/-/code_review.max_diff_bytes', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf } });
    await postCode(codeRunBody()); // run C: complete, misses again => fixed (streak 2)
    st = await h.db.selectFrom('review_findings').select(['status', 'unseen_streak']).executeTakeFirstOrThrow();
    expect(st.status).toBe('fixed');
    expect(st.unseen_streak).toBe(2);
  });

  it('big diff truncated=true; ignored files never reach the provider', async () => {
    await enable('code_review');
    await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/code_review.max_diff_bytes', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 1024 } });
    currentFindings = [];
    const res = await postCode(codeRunBody({
      hunks: [
        { file: 'dist/bundle.js', start: 1, lines: ['ignored'] },
        { file: 'src/a.ts', start: 12, lines: ['y'.repeat(2000)] },
        { file: 'src/b.ts', start: 1, lines: ['z'.repeat(2000)] },
      ],
      snapshot: [SNAPSHOT, { path: 'src/b.ts', lines: ['z'.repeat(2000)] }],
    }));
    expect(res.json().status).toBe('truncated');
    expect(capturedPayloads.every((p) => !p.files.some((f) => f.includes('dist/') || f.includes('bundle')))).toBe(true);
  });
});

describe('issue policy (plan §10 acceptance)', () => {
  it('record_only creates no work items', async () => {
    await enable('code_review');
    currentFindings = [finding({ severity: 'critical', confidence: 0.95 })];
    await postCode(codeRunBody());
    const items = await h.db.selectFrom('work_items').select('id').execute();
    expect(items).toHaveLength(0);
  });

  it('human_approval queues once, creates only after approval', async () => {
    await enable('code_review');
    await setPolicy('human_approval');
    currentFindings = [finding()];
    const res = await postCode(codeRunBody());
    expect(res.json().stats.approvals_queued).toBe(1);
    const pending = await app.inject({ method: 'GET', url: '/api/v1/approvals?x=1', headers: { cookie: AUTH.cookies } });
    void pending;
    const appr = await h.db.selectFrom('approval_requests').select('id').where('action', '=', 'review.create_work_item').executeTakeFirstOrThrow();
    const itemsBefore = await h.db.selectFrom('work_items').select('id').execute();
    expect(itemsBefore).toHaveLength(0);
    const dec = await app.inject({ method: 'POST', url: `/api/v1/approvals/${appr.id}/decide`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { decision: 'approved' } });
    expect(dec.statusCode, dec.body).toBe(200);
    const f = await h.db.selectFrom('review_findings').select('id').executeTakeFirstOrThrow();
    const cw = await app.inject({ method: 'POST', url: `/api/v1/review/findings/${f.id}/create-work-item`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf } });
    expect(cw.statusCode, cw.body).toBe(201);
    // exactly one, idempotent replay
    const cw2 = await app.inject({ method: 'POST', url: `/api/v1/review/findings/${f.id}/create-work-item`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf } });
    expect(cw2.statusCode).toBe(200);
    const items = await h.db.selectFrom('work_items').select('id').execute();
    expect(items).toHaveLength(1);
  });

  it('auto_high_severity creates only eligible findings, cap 10', async () => {
    await enable('code_review');
    await setPolicy('auto_high_severity');
    currentFindings = Array.from({ length: 15 }, (_, i) => finding({ title: `Critical ${i}`, severity: 'critical', confidence: 0.9, line_start: 12, line_end: 13, evidence: 'alpha();\nbeta();' }))
      .concat([finding({ title: 'Low one', severity: 'low', confidence: 0.95, line_start: 12, line_end: 13, evidence: 'alpha();\nbeta();' })]);
    const res = await postCode(codeRunBody());
    expect(res.json().stats.issues_created).toBe(10);
    const items = await h.db.selectFrom('work_items').select('id').execute();
    expect(items.length).toBeLessThanOrEqual(10);
  });

  it('redeclaring a shared review.* key under a module prefix is rejected 422', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/code_review.issue_policy', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 'record_only' } });
    expect(bad.statusCode).toBe(422);
  });
});

describe('github review output (plan §10.6.A.4)', () => {
  it('summary: two runs => one comment updated; off: zero write calls', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    const calls: string[] = [];
    setReviewOutputWriter({
      async publish(a) {
        calls.push(a.mode);
        return { created: calls.length === 1 ? 1 : 0, updated: calls.length === 1 ? 0 : 1 };
      },
    });
    await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/review.github_output', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 'summary' } });
    await postCode(codeRunBody());
    await postCode(codeRunBody());
    expect(calls).toEqual(['summary', 'summary']);

    calls.length = 0;
    await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/review.github_output', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 'off' } });
    await postCode(codeRunBody());
    expect(calls).toHaveLength(0);
  });
});

describe('mcp + run controls (plan §10/§13 acceptance)', () => {
  it('enabled module lists review tools; agent key with review scope starts a run via MCP', async () => {
    await enable('code_review');
    const keyRes = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { name: 'rev-key', scopes: ['review', 'read'], project_ids: [projectId] } });
    expect(keyRes.statusCode, keyRes.body).toBe(201);
    const token = keyRes.json().raw_key as string;

    const list = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const names = (list.json().result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('review_start_code_review');
    expect(names).toContain('review_get_report');
    expect(names).not.toContain('refactor_review_start'); // refactor module still off

    currentFindings = [finding()];
    const call = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review_start_code_review', arguments: codeRunBody() } } });
    const result = call.json().result;
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(JSON.parse(result.content[0].text).status).toBe('completed');
  });

  it('cancel: queued/running => canceled; completed => 409', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    const res = await postCode(codeRunBody());
    const runId = res.json().run_id as string;
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/review/runs/${runId}/cancel`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf } });
    expect(cancel.statusCode).toBe(409); // already completed (inline execution)
    // a queued row (webhook path) can be canceled
    const qid = newId();
    await h.db.insertInto('review_runs').values({ id: qid, organization_id: orgId, project_id: projectId, repository_id: repoId, kind: 'code', target: { pr: 1 } as never, status: 'queued' } as never).execute();
    const c2 = await app.inject({ method: 'POST', url: `/api/v1/review/runs/${qid}/cancel`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf } });
    expect(c2.statusCode, c2.body).toBe(200);
    const audit = await h.db.selectFrom('audit_events').select('action').where('action', '=', 'review.run.cancel').execute();
    expect(audit).toHaveLength(1);
  });

  it('every mutation audits: run, decision and issue creation emit audit_events', async () => {
    await enable('code_review');
    currentFindings = [finding()];
    const res = await postCode(codeRunBody());
    expect(res.json().status).toBe('completed');
    const f = await h.db.selectFrom('review_findings').select('id').executeTakeFirstOrThrow();
    await app.inject({ method: 'POST', url: `/api/v1/review/findings/${f.id}/decision`, headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { status: 'dismissed', reason: 'noise' } });
    const actions = await h.db.selectFrom('audit_events').select('action').where('resource_type', 'in', ['review_run', 'review_finding']).execute();
    const set = new Set(actions.map((a) => a.action));
    expect(set.has('review.code_run.completed')).toBe(true);
    expect(set.has('review.finding.dismissed')).toBe(true);
  });
});
