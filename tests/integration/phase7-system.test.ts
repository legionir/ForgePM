import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newId, toJsonb, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * Phase 7 / plan §5+§11 — the System panel surface promised by
 * docs/API_CONTRACTS.md ("System | GET /audit, GET /jobs, POST /jobs/:id/retry,
 * GET /system/health, POST /system/backup") that earlier phases left unbuilt:
 * jobs registry (cursor-paginated, org-scoped), manual retry re-enqueue,
 * effective-settings system health, and an admin-only backup trigger.
 * Also the §8 panel requirement "لاگ mcp_tool_calls با فیلتر".
 */
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
let app: FastifyInstance;
let auth: { cookies: string; csrf: string };

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({
    env,
    db: h.db,
    registry: buildRegistry(),
    redisAvailable: () => Promise.resolve(true),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.cleanup();
});

async function login(email: string, password: string): Promise<{ cookies: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200, `login ${email}: ${res.body}`);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('fpm_session='))!;
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  return { cookies: `${session.split(';')[0]}; fpm_csrf=${csrf}`, csrf };
}

beforeEach(async () => {
  await h.reset();
  await seedOrg(h.db, { email: 'sys@x.io', password: 'sup3r-pass-x' });
  auth = await login('sys@x.io', 'sup3r-pass-x');
});

async function insertJob(orgId: string | null, status: string, type = 'system.ping'): Promise<string> {
  const id = newId();
  await h.db
    .insertInto('jobs')
    .values({
      id,
      organization_id: orgId,
      queue: h.queueName,
      type,
      status: status as never,
      payload: toJsonb({ a: 1 }) as never,
    })
    .execute();
  return id;
}

describe('GET /api/v1/jobs (plan §5.11 System Health & Jobs page)', () => {
  it('lists org jobs newest-first with cursor pagination; limit>200 => 400', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: cookieHeaders(auth) });
    const orgId = me.json().actor.organization_id as string;
    for (let i = 0; i < 3; i++) await insertJob(orgId, 'succeeded');
    await insertJob('11111111-1111-7111-8111-111111111111', 'succeeded'); // other org (FK: null org is allowed for system jobs)

    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs?limit=2', headers: cookieHeaders(auth) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    expect(typeof body.next_cursor).toBe('string');
    expect(body.items.every((j: { status: string }) => j.status === 'succeeded')).toBe(true);

    const page2 = await app.inject({ method: 'GET', url: `/api/v1/jobs?limit=2&cursor=${body.next_cursor}`, headers: cookieHeaders(auth) });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items.length).toBe(1);
    // never returns the other org's row: total visible = 3
    const all = await app.inject({ method: 'GET', url: '/api/v1/jobs?limit=50', headers: cookieHeaders(auth) });
    expect(all.json().items.length).toBe(3);

    const bad = await app.inject({ method: 'GET', url: '/api/v1/jobs?limit=201', headers: cookieHeaders(auth) });
    expect(bad.statusCode).toBe(400);
  });

  it('viewer role gets 403 jobs:read (matrix)', async () => {
    await seedOrg(h.db, { email: 'v@x.io', password: 'view-pass-x', role: 'viewer', createProject: false });
    const v = await login('v@x.io', 'view-pass-x');
    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs', headers: cookieHeaders(v) });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/v1/jobs/:id/retry', () => {
  it('re-queues a failed/dead job: status back to queued; the sweeper re-enqueues it (plan §3b-3)', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: cookieHeaders(auth) });
    const orgId = me.json().actor.organization_id as string;
    const jobId = await insertJob(orgId, 'failed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: { cookie: auth.cookies, 'x-csrf-token': auth.csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe('queued');

    const row = await h.db.selectFrom('jobs').select(['status', 'error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row.status).toBe('queued');
    // error cleared so a fresh run starts clean
    expect(row.error ?? null).toBeNull();

    // retrying a now-queued (non-failed) job => 409
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: { cookie: auth.cookies, 'x-csrf-token': auth.csrf },
    });
    expect(again.statusCode).toBe(409);
  });

  it('cross-org job id => 404 (no existence leak)', async () => {
    const jobId = await insertJob('22222222-2222-7222-8222-222222222222', 'failed');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: { cookie: auth.cookies, 'x-csrf-token': auth.csrf },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v1/system/health', () => {
  it('returns db/redis status plus per-module enabled flags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/health', headers: cookieHeaders(auth) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.database).toBe('ok');
    expect(body.redis).toBe('ok');
    expect(Array.isArray(body.modules)).toBe(true);
    const github = body.modules.find((m: { name: string }) => m.name === 'github');
    expect(github).toBeTruthy();
    expect(github.enabled).toBe(false); // default off
  });
});

describe('POST /api/v1/system/backup', () => {
  it('admin owner triggers pg_dump into BACKUP_DIR and records a system.backup audit event', async () => {
    process.env.BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/forgepm-e2e-backups';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/backup',
      headers: { cookie: auth.cookies, 'x-csrf-token': auth.csrf },
    });
    expect(res.statusCode).toBe(202);
    const file = res.json().file as string;
    expect(file).toMatch(/forgepm-.*\.dump$/);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?resource_type=system',
      headers: cookieHeaders(auth),
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json().items.some((e: { action: string }) => e.action === 'system.backup'),
    ).toBe(true);
  });
});

describe('GET /api/v1/mcp/calls (plan §8.11 panel log)', () => {
  it('lists masked mcp_tool_calls for the org with cursor pagination', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: cookieHeaders(auth) });
    const orgId = me.json().actor.organization_id as string;
    await h.db
      .insertInto('mcp_tool_calls')
      .values({
        id: newId(),
        organization_id: orgId,
        api_key_id: null,
        tool: 'work_item_create',
        input_summary: toJsonb({ masked: true }) as never,
        outcome: 'ok',
        duration_ms: 12,
      })
      .execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/mcp/calls', headers: cookieHeaders(auth) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].tool).toBe('work_item_create');
    expect(body.items[0].outcome).toBe('ok');
    expect('next_cursor' in body).toBe(true);
  });
});

function cookieHeaders(a: { cookies: string }): Record<string, string> {
  return { cookie: a.cookies };
}
