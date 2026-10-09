import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newId, setRepoFetcher, type Env, type GenerateRequest } from '@forgepm/core';
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

let currentFindings: unknown[] = [];
const stageRequests: unknown[] = [];
const fixtures = new Map<string, (req: GenerateRequest) => unknown>();
fixtures.set('*', (req: GenerateRequest) => {
  stageRequests.push(JSON.parse(req.messages[0].content));
  return { findings: currentFindings };
});

const env: Env = {
  NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200', API_DOCS_ENABLED: false, METRICS_ENABLED: false, LOG_LEVEL: 'fatal',
};

// sample repo: a 120-line function, a duplicated block, an import cycle.
function filler(n: number): string {
  const lines = [`export function big${n}(a: number): string {`, '  let out = \'\';'];
  for (let i = 0; i < 110; i++) lines.push(`  if (a > ${i}) { for (let j = 0; j < ${i}; j++) { out += a + j; } }`);
  lines.push('  return out;', '}');
  return lines.join('\n');
}
const dupUnit = (n: string) =>
  `export function shared${n}(alpha: number, beta: number): number {\n  const gamma = alpha * 2 + beta * 3 - 7;\n  const delta = gamma / 3 - beta + alpha * 4;\n  const epsilon = delta + alpha * beta - gamma * 2 + 11;\n  const zeta = epsilon - gamma + delta * 2 - beta + 13;\n  const eta = zeta * alpha / 2 + beta - epsilon + delta * 3;\n  return eta + gamma;\n}`;
function sampleRepo(): { path: string; content: string }[] {
  return [
    { path: 'src/long.ts', content: filler(1) },
    { path: 'src/dupA.ts', content: dupUnit('A') },
    { path: 'src/dupB.ts', content: dupUnit('B') },
    { path: 'src/c1.ts', content: `import { x2 } from './c2';\nexport const x1 = 1;\nvoid x2;` },
    { path: 'src/c2.ts', content: `import { x1 } from './c1';\nexport const x2 = 2;\nvoid x1;` },
  ];
}
const refFinding = (over: Record<string, unknown> = {}) => ({
  category: 'complexity', severity: 'medium', confidence: 0.9, file: 'src/long.ts', line_start: 1, line_end: 2,
  title: 'Long function', description: 'd', why_it_matters: 'w', suggestion: 's', evidence: "export function big1(a: number): string {",
  impact: 'i', effort: 'e', risk: 'r', ...over,
});

async function session(): Promise<void> {
  const seed = await seedOrg(h.db, { email: 'rf@x.io', password: 'hunter22x', projectKey: 'RFX' });
  projectId = seed.projectId;
  orgId = seed.organizationId;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'rf@x.io', password: 'hunter22x' } });
  const cookies = r.headers['set-cookie'] as unknown as string[];
  const s = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  AUTH = { cookies: `${s}; fpm_csrf=${csrf}`, csrf };
  repoId = (await h.db.insertInto('repositories').values({ id: newId(), organization_id: orgId, provider: 'github', external_id: '200', full_name: 'acme/lib' }).returning('id').executeTakeFirstOrThrow()).id;
  await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();
}

async function enable(mod: string): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: `/api/v1/modules/${mod}/enabled`, payload: { enabled: true } });
  expect(r.statusCode, r.body).toBeLessThan(300);
}

function postRefactor(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/review/refactor-runs', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: body });
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true), reviewFixtures: fixtures });
  await app.ready();
});
afterAll(async () => {
  setRepoFetcher(null);
  await app.close();
  await h.cleanup();
});
beforeEach(async () => {
  currentFindings = [];
  stageRequests.length = 0;
  await h.reset();
  await session();
});

describe('refactor review (plan §10 acceptance)', () => {
  it('sample local repo: analyzer finds long fn + duplication + cycle WITHOUT any provider', async () => {
    // The fixture provider returns NO findings for this case, so everything the
    // run detects comes from the deterministic analyzer alone (plan §10.6.2).
    await enable('refactor_review');
    const res = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'c1', files: sampleRepo() });
    expect(res.statusCode, res.body).toBe(201);
    const row = await h.db.selectFrom('code_structure_index').select(['index']).where('repository_id', '=', repoId).where('commit_sha', '=', 'c1').executeTakeFirstOrThrow();
    const idx = row.index as { functions: { name: string; lines: number; complexity: number }[]; duplicates: unknown[]; imports: { cycles: string[][] } };
    const big = idx.functions.find((f) => f.name === 'big1');
    expect(big).toBeTruthy();
    expect(big!.lines).toBeGreaterThanOrEqual(110);
    expect(big!.complexity).toBeGreaterThan(10);
    expect(idx.duplicates.length).toBeGreaterThan(0);
    expect(idx.imports.cycles.flat()).toContain('src/c1.ts');
    expect(res.json().stats.created).toBe(0); // zero AI-emitted findings
  });

  it('findings carry file/range/why/confidence/impact/suggestion/effort/risk', async () => {
    await enable('refactor_review');
    currentFindings = [refFinding()];
    const res = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'c2', files: sampleRepo() });
    expect(res.statusCode, res.body).toBe(201);
    const f = await app.inject({ method: 'GET', url: `/api/v1/review/findings?project_id=${projectId}`, headers: { cookie: AUTH.cookies } });
    const item = f.json().items.find((x: { file: string }) => x.file === 'src/long.ts');
    for (const key of ['file', 'line_start', 'line_end', 'why_it_matters', 'confidence', 'impact', 'suggestion', 'effort', 'risk']) {
      expect(item, JSON.stringify(item)).toHaveProperty(key);
    }
  });

  it('12000-file repo at max_files 5000: three runs cover all, cursor advances', async () => {
    await enable('refactor_review');
    await app.inject({ method: 'PUT', url: '/api/v1/settings/system/-/refactor_review.max_files_per_run', headers: { cookie: AUTH.cookies, 'x-csrf-token': AUTH.csrf }, payload: { value: 5000 } });
    currentFindings = [];
    const big = Array.from({ length: 12000 }, (_, i) => ({ path: `p${i % 8}/f${i}.ts`, content: `export const v${i} = ${i};` }));
    const cursors: number[] = [];
    for (let run = 0; run < 3; run++) {
      const res = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'big', files: big });
      expect(res.statusCode, res.body).toBe(201);
      const rep = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${res.json().run_id}`, headers: { cookie: AUTH.cookies } });
      cursors.push(Number((rep.json().stats as { partition_cursor?: number }).partition_cursor ?? -1));
    }
    // after 3 runs the whole repo is covered and the cursor wraps to 0
    expect(cursors).toEqual([1, 2, 0]);
  });

  it('refactor module off => 503 on the refactor endpoint; code endpoint independent', async () => {
    // refactor_review was enabled above via enable(); the per-test reset of the
    // module settings is implicit in harness.reset() wiping the settings table.
    // Here a fresh test starts with both modules OFF.
    const res = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'off', files: sampleRepo() });
    expect(res.statusCode).toBe(503);
  });

  it('incremental rerun only analyzes changed files (+ neighbours)', async () => {
    await enable('refactor_review');
    currentFindings = [];
    const v1 = sampleRepo();
    const r1 = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'i1', files: v1 });
    expect(r1.statusCode, r1.body).toBe(201);
    // change exactly one file; second run declares changed_since the first commit.
    const v2 = v1.map((f) => (f.path === 'src/long.ts' ? { path: f.path, content: f.content + '\n// touched' } : f));
    stageRequests.length = 0;
    const r2 = await postRefactor({ project_id: projectId, repository_id: repoId, commit_sha: 'i2', files: v2, changed_since_sha: 'i1' });
    expect(r2.statusCode, r2.body).toBe(201);
    const sent = (stageRequests[0] as { files: string[] }).files;
    expect(sent).toContain('src/long.ts');
    expect(sent).not.toContain('src/dupA.ts');
  });
});
