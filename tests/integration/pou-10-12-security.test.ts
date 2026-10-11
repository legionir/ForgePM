import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg, seedApiKey } from './seed';

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

async function login(email: string, password: string): Promise<{ token: string; userId: string; orgId: string }> {
  const seed = await seedOrg(h.db, { email, password });
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { access_token: string; user: { id: string; organization_id: string } };
  return { token: body.access_token, userId: seed.userId, orgId: seed.organizationId };
}

describe('POU-10: module toggle auth', () => {
  it('unauthenticated request returns 401', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/v1/modules/sample/enabled', payload: { enabled: true } });
    expect(res.statusCode).toBe(401);
  });

  it('non-owner member returns 403', async () => {
    const { token } = await login('member@example.com', 'password123');
    const res = await app.inject({ method: 'PUT', url: '/api/v1/modules/sample/enabled', payload: { enabled: true }, headers: { Authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('admin can toggle module and audit records actor + request_id', async () => {
    const { token } = await login('admin@example.com', 'password123');
    const res = await app.inject({ method: 'PUT', url: '/api/v1/modules/sample/enabled', payload: { enabled: true }, headers: { Authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.find((m: { name: string }) => m.name === 'sample').enabled).toBe(true);

    // Check audit log
    const audits = await h.db.selectFrom('audit_logs').selectAll().execute();
    expect(audits.length).toBeGreaterThan(0);
    const lastAudit = audits[audits.length - 1];
    expect(lastAudit.action).toBe('setting.update');
    expect(typeof lastAudit.actor_id).toBe('string');
    expect(typeof lastAudit.request_id).toBe('string');
  });
});

describe('POU-12: API key escalation guard', () => {
  it('read-only key can mint another read key', async () => {
    const { token, orgId, userId } = await login('user@example.com', 'password123');
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'child-key', scopes: ['read'] }, headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(201);
    expect(res.json().api_key.scopes).toEqual(['read']);
  });

  it('read-only key cannot mint write key', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'evil', scopes: ['write'] }, headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(403);
    // No key was created
    const count = await h.db.selectFrom('api_keys').count('* as cnt').where('prefix', 'like', 'evil%').executeTakeFirst();
    expect(Number(count?.cnt)).toBe(0);
  });

  it('read-only key cannot mint admin key', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'evil', scopes: ['admin'] }, headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(403);
  });

  it('admin key can mint write key', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['admin']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'write-key', scopes: ['write'] }, headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(201);
    expect(res.json().api_key.scopes).toContain('write');
  });

  it('escalated key cannot expand its own scope', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    // Try to use read key to mint a write key for itself (same user)
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'mine', scopes: ['read', 'write'] }, headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(403);
  });
});
