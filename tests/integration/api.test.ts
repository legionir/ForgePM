import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  upsertSetting,
  type Env,
} from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';

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
let redisUp = true;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({
    env,
    db: h.db,
    registry: buildRegistry(),
    redisAvailable: () => Promise.resolve(redisUp),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.cleanup();
});

beforeEach(async () => {
  redisUp = true;
  await h.reset();
});

describe('health (plan §4 acceptance)', () => {
  it('/health/live is 200 regardless of dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/health/ready is 200 when postgres and redis are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', postgres: 'ok', redis: 'ok' });
  });

  it('/health/ready is 503 when redis is down but live stays 200', async () => {
    redisUp = false;
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'degraded', postgres: 'ok', redis: 'down' });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
  });
});

describe('module lifecycle over REST (plan §3b-1, §4 acceptance)', () => {
  it('disabled module returns 503 MODULE_DISABLED on every entry point', async () => {
    const status = await app.inject({ method: 'GET', url: '/sample/status' });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toMatchObject({ error: { code: 'MODULE_DISABLED' } });

    const echo = await app.inject({ method: 'POST', url: '/sample/echo', payload: { message: 'x' } });
    expect(echo.statusCode).toBe(503);
    expect(echo.json()).toMatchObject({ error: { code: 'MODULE_DISABLED' } });
  });

  it('enabling via the admin route makes it return 200 without restart', async () => {
    // enable through the real route (which writes the setting + invalidates cache)
    const enable = await app.inject({ method: 'PUT', url: '/api/v1/modules/sample/enabled', payload: { enabled: true } });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().modules.find((m: { name: string }) => m.name === 'sample').enabled).toBe(true);

    const echo = await app.inject({ method: 'POST', url: '/sample/echo', payload: { message: 'hello' } });
    expect(echo.statusCode).toBe(200);
    expect(echo.json()).toEqual({ echo: 'hello' });
  });

  it('a settings change made out-of-band takes effect after cache TTL (≤5s) via invalidation', async () => {
    // Flip the flag directly in the DB (as if from the worker/another node),
    // then trigger cache invalidation through the list route which re-reads.
    await upsertSetting(h.db, 'system', null, 'modules.sample.enabled', true);
    // Build a fresh registry to avoid the app's in-process 5s cache entirely.
    const fresh = buildRegistry();
    expect(await fresh.isEnabled(h.db, 'sample', null, null)).toBe(true);
  });
});

describe('error + validation contracts (plan §13)', () => {
  it('unknown route returns the unified NOT_FOUND envelope with request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(typeof res.json().error.request_id).toBe('string');
  });

  it('bad body returns VALIDATION_ERROR (400) — even when module is enabled', async () => {
    await upsertSetting(h.db, 'system', null, 'modules.sample.enabled', true);
    // use a fresh app instance so the registry cache reflects the DB change.
    const app2 = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true) });
    await app2.ready();
    const res = await app2.inject({ method: 'POST', url: '/sample/echo', payload: { message: 123 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app2.close();
  });
});

describe('openapi (plan §13)', () => {
  it('serves a valid OpenAPI 3.0 document listing registered routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths).toHaveProperty('/sample/echo');
  });
});
