import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultRegistry, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';

/**
 * Plan §14 — /metrics behind METRICS_ENABLED, dependency-free Prometheus text.
 */
function envWith(metrics: boolean): Env {
  return {
    NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
    WEB_ORIGIN: 'http://localhost:4200',
    API_DOCS_ENABLED: false, METRICS_ENABLED: metrics, LOG_LEVEL: 'fatal',
  } satisfies Env;
}

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  defaultRegistry.reset();
  await h.reset();
});

describe('/metrics (plan §14)', () => {
  it('returns 404 when METRICS_ENABLED is false', async () => {
    const app: FastifyInstance = await buildApp({
      env: envWith(false), db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true),
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('exposes counters and latency after requests', async () => {
    const app: FastifyInstance = await buildApp({
      env: envWith(true), db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true),
    });
    await app.ready();
    await app.inject({ method: 'GET', url: '/health/live' });
    await app.inject({ method: 'GET', url: '/health/live' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('http_requests_total');
    expect(body).toContain('GET');
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('# TYPE forgepm_queue_length gauge');
    await app.close();
  });
});
