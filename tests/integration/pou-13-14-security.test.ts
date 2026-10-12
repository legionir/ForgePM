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

async function patchUser(headers: Hdrs, userId: string, body: Record<string, unknown>): Promise<number> {
  const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${userId}`, payload: body, headers });
  return res.statusCode;
}

async function displayName(id: string): Promise<string | undefined> {
  return (await h.db.selectFrom('users').select('display_name').where('id', '=', id).executeTakeFirst())?.display_name;
}

describe('POU-13: org-scoped user mutation', () => {
  it('owner can update users in their own org', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'owner@example.com', password: 'password123' });
    const memberId = await seedMember(h.db, organizationId, { email: 'm@example.com', password: 'password123' });
    const headers = await loginHeaders('owner@example.com', 'password123');
    expect(await patchUser(headers, userId, { display_name: 'Updated' })).toBe(200);
    expect(await patchUser(headers, memberId, { display_name: 'Member Updated' })).toBe(200);
    expect(await displayName(memberId)).toBe('Member Updated');
  });

  it('a plain member cannot update another user in the same org', async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'owner@example.com', password: 'password123' });
    await seedMember(h.db, organizationId, { email: 'm@example.com', password: 'password123' });
    const status = await patchUser(await loginHeaders('m@example.com', 'password123'), userId, { display_name: 'Hacked' });
    expect(status).toBe(403);
    expect(await displayName(userId)).not.toBe('Hacked');
  });

  it('an owner cannot touch a user in a different org (isolation)', async () => {
    await seedOrg(h.db, { email: 'org1@example.com', password: 'password123' });
    const { userId: otherUserId } = await seedOrg(h.db, { email: 'org2@example.com', password: 'password123' });
    const status = await patchUser(await loginHeaders('org1@example.com', 'password123'), otherUserId, { display_name: 'Hacked' });
    expect(status).toBe(404);
    expect(await displayName(otherUserId)).not.toBe('Hacked');
  });

  it('a soft-deleted user is invisible to mutation', async () => {
    const { organizationId } = await seedOrg(h.db, { email: 'owner@example.com', password: 'password123' });
    const memberId = await seedMember(h.db, organizationId, { email: 'm@example.com', password: 'password123' });
    await h.db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', memberId).execute();
    const status = await patchUser(await loginHeaders('owner@example.com', 'password123'), memberId, { display_name: 'Hacked' });
    expect(status).toBe(404);
  });
});

describe('POU-14: key authorization after user disabled/deleted', () => {
  it("a disabled owner's key returns 401 immediately", async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const raw = await seedApiKey(h.db, organizationId, userId, ['admin']);
    await h.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(raw) });
    expect(res.statusCode).toBe(401);
  });

  it("a deleted owner's key returns 401 immediately", async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const raw = await seedApiKey(h.db, organizationId, userId, ['admin']);
    await h.db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(raw) });
    expect(res.statusCode).toBe(401);
  });

  it("a disabled user's existing session also returns 401", async () => {
    const { userId } = await seedOrg(h.db, { email: 'u@example.com', password: 'password123' });
    const headers = await loginHeaders('u@example.com', 'password123');
    await h.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers });
    expect(res.statusCode).toBe(401);
  });

  it("active users' keys still work after another user is disabled", async () => {
    const { organizationId, userId } = await seedOrg(h.db, { email: 'u1@example.com', password: 'password123' });
    const otherId = await seedMember(h.db, organizationId, { email: 'u2@example.com', password: 'password123' });
    const raw = await seedApiKey(h.db, organizationId, userId, ['admin']);
    await h.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', otherId).execute();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(raw) });
    expect(res.statusCode).toBe(200);
  });
});
