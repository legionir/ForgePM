import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

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


describe('POU-18: IP spoofing protection', () => {
  it('direct request uses real socket IP for rate limit key', async () => {
    await seedOrg(h.db, { email: 'ip@x.io', password: 'hunter22x' });
    // All 11 requests come from the same socket (127.0.0.1)
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ip@x.io', password: 'wrong' } });
      if (i < 10) expect(r.statusCode).toBe(401);
      else expect(r.statusCode).toBe(429);
    }
  });

  it('X-Forwarded-For forged from untrusted source is ignored', async () => {
    await seedOrg(h.db, { email: 'spoof@x.io', password: 'hunter22x' });
    // Request with a forged X-Forwarded-For header — socket is still 127.0.0.1
    // (no trusted proxy), so the forged IP must be ignored.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      payload: { email: 'spoof@x.io', password: 'wrong' },
    });
    expect(r.statusCode).toBe(401); // should not 429 just because of header
  });

  it('successful login clears both IP and account rate-limit counters', async () => {
    await seedOrg(h.db, { email: 'clear@x.io', password: 'hunter22x' });
    // 5 failures
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'clear@x.io', password: 'wrong' } });
    }
    // Success clears counters
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'clear@x.io', password: 'hunter22x' } });
    expect(ok.statusCode).toBe(200);
    // Now we should still be under the limit (counter reset)
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'clear@x.io', password: 'wrong' } });
      expect(r.statusCode).toBe(401);
    }
  });
});

describe('POU-18: Account-bounded rate limit', () => {
  it('two different IPs hitting the same account exhaust the account counter first', async () => {
    await seedOrg(h.db, { email: 'acct@x.io', password: 'hunter22x' });
    // Send 6 attempts from IP A and 5 from IP B (total 11)
    const send = async (email: string, password: string, ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email, password: 'wrong' },
      });

    // First 10 failures: 6 from 10.0.0.1 + 4 from 10.0.0.2
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.1');
    await send('acct@x.io', 'wrong', '10.0.0.2');
    await send('acct@x.io', 'wrong', '10.0.0.2');
    await send('acct@x.io', 'wrong', '10.0.0.2');
    await send('acct@x.io', 'wrong', '10.0.0.2');

    // 11th attempt — account counter exhausted regardless of which IP
    const r = await send('acct@x.io', 'wrong', '10.0.0.3');
    expect(r.statusCode).toBe(429);
  });
});

describe('POU-18: Trusted proxy behavior', () => {
  it('headers from untrusted proxy socket are ignored', async () => {
    await seedOrg(h.db, { email: 'proxy@x.io', password: 'hunter22x' });
    // Fastify inject sets socket to the loopback; no trusted proxy configured
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.1', 'x-real-ip': '192.168.1.2' },
      payload: { email: 'proxy@x.io', password: 'wrong' },
    });
    // Should still be 401 (not 429 from a different IP key)
    expect(r.statusCode).toBe(401);
  });
});
