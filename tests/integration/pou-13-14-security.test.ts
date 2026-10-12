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

async function patchUser(token: string, userId: string, body: Record<string, unknown>): Promise<number> {
  const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${userId}`, payload: body, headers: { Authorization: `Bearer ${token}` } });
  return res.statusCode;
}

describe('POU-13: org-scoped user mutation', () => {
  it('actor can update own user in their org', async () => {
    const { token, userId } = await login('admin@example.com', 'password123');
    const status = await patchUser(token, userId, { display_name: 'Updated' });
    expect(status).toBe(200);
    const u = await h.db.selectFrom('users').select(['display_name']).where('id', '=', userId).executeTakeFirst();
    expect(u?.display_name).toBe('Updated');
  });

  it('member cannot update another member in same org', async () => {
    const { token: memberToken } = await login('member@example.com', 'password123');
    const { userId: targetId } = await seedOrg(h.db, { email: 'target@example.com', password: 'p' });
    const status = await patchUser(memberToken, targetId, { display_name: 'Hacked' });
    expect(status).toBe(404);
    // data unchanged
    const u = await h.db.selectFrom('users').select(['display_name']).where('id', '=', targetId).executeTakeFirst();
    expect(u?.display_name).not.toBe('Hacked');
  });

  it('actor cannot touch user in different org (isolation)', async () => {
    const { token: adminToken } = await login('org1@example.com', 'password123');
    const { userId: otherOrgUserId } = await seedOrg(h.db, { email: 'otherorg@example.com', password: 'p' });
    const status = await patchUser(adminToken, otherOrgUserId, { display_name: 'Hacked' });
    expect(status).toBe(404);
    const u = await h.db.selectFrom('users').select(['display_name']).where('id', '=', otherOrgUserId).executeTakeFirst();
    expect(u?.display_name).not.toBe('Hacked');
  });

  it('deleted user is invisible to mutation', async () => {
    const { token, userId } = await login('admin@example.com', 'password123');
    await h.db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', userId).execute();
    const status = await patchUser(token, userId, { display_name: 'Hacked' });
    expect(status).toBe(404);
  });
});

describe('POU-14: key authorization after user disabled/deleted', () => {
  it('disabled user key returns 401 immediately', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    // disable the user
    await h.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(401);
  });

  it('deleted user key returns 401 immediately', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    await h.db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(401);
  });

  it('disabled user session also returns 401', async () => {
    const { token } = await login('u@ex.com', 'p');
    const { userId } = await seedOrg(h.db, { email: 'u@ex.com', password: 'p' });
    await h.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { Authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('active user keys still work after another user is disabled', async () => {
    const { orgId, userId } = await seedOrg(h.db, { email: 'u1@ex.com', password: 'p' });
    await seedOrg(h.db, { email: 'u2@ex.com', password: 'p' });
    const rawKey = await seedApiKey(h.db, orgId, userId, ['read']);
    // disable a different user
    await h.db.updateTable('users').set({ status: 'disabled' }).where('email', '=', 'u2@ex.com').execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(200);
  });
});
