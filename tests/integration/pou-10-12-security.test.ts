import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg, seedMember, seedApiKey } from './seed';

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
};

let h: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
});

type Hdrs = { cookie: string; 'x-csrf-token': string };

/** Real panel login (session cookie + CSRF double-submit), as the SPA does. */
async function loginHeaders(email: string, password: string): Promise<Hdrs> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  return { cookie: `${session}; fpm_csrf=${csrf}`, 'x-csrf-token': csrf };
}

const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

describe('POU-10: module toggle auth', () => {
  const url = '/api/v1/modules/sample/enabled';

  it('unauthenticated request returns 401', async () => {
    const res = await app.inject({ method: 'PUT', url, payload: { enabled: true } });
    expect(res.statusCode).toBe(401);
  });

  it('non-owner member returns 403', async () => {
    const { organizationId } = await seedOrg(h.db, { email: 'owner@example.com', password: 'password123' });
    await seedMember(h.db, organizationId, { email: 'member@example.com', password: 'password123' });
    const res = await app.inject({ method: 'PUT', url, payload: { enabled: true }, headers: await loginHeaders('member@example.com', 'password123') });
    expect(res.statusCode).toBe(403);
  });

  it('owner can toggle module and the audit trail records the actor', async () => {
    const { userId } = await seedOrg(h.db, { email: 'owner@example.com', password: 'password123' });
    const res = await app.inject({ method: 'PUT', url, payload: { enabled: true }, headers: await loginHeaders('owner@example.com', 'password123') });
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.find((m: { name: string }) => m.name === 'sample').enabled).toBe(true);
    const audit = await h.db.selectFrom('audit_events').selectAll().where('actor_id', '=', userId).execute();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => typeof a.request_id === 'string')).toBe(true);
  });
});

describe('POU-12: API key escalation guard', () => {
  const mint = (raw: string, scopes: string[]) =>
    app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'child-key', scopes }, headers: bearer(raw) });

  it('read-only key can mint another read key', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const res = await mint(await seedApiKey(h.db, organizationId, userId, ['read']), ['read']);
    expect(res.statusCode).toBe(201);
    expect(res.json().api_key.scopes).toEqual(['read']);
  });

  it('read-only key cannot mint a write key', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const res = await mint(await seedApiKey(h.db, organizationId, userId, ['read']), ['write']);
    expect(res.statusCode).toBe(403);
    const created = await h.db.selectFrom('api_keys').select('id').where('name', '=', 'child-key').execute();
    expect(created).toHaveLength(0);
  });

  it('read-only key cannot mint an admin key', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const res = await mint(await seedApiKey(h.db, organizationId, userId, ['read']), ['admin']);
    expect(res.statusCode).toBe(403);
  });

  it('admin key can mint a write key', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const res = await mint(await seedApiKey(h.db, organizationId, userId, ['admin']), ['write']);
    expect(res.statusCode).toBe(201);
    expect(res.json().api_key.scopes).toContain('write');
  });

  it('a read key cannot widen its own scope set', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const res = await mint(await seedApiKey(h.db, organizationId, userId, ['read']), ['read', 'write']);
    expect(res.statusCode).toBe(403);
  });
});
