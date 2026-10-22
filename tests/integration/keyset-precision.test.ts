// Keyset pagination must not skip rows whose created_at differ only in microseconds (same JS millisecond).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { encodeCursor } from '@forgepm/shared';
import { newId, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const env = {
  NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200', API_DOCS_ENABLED: false, METRICS_ENABLED: false, LOG_LEVEL: 'fatal',
} satisfies Env;

let h: Harness;
let app: FastifyInstance;
let headers: Record<string, string>;
let orgId = '';

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
  const seed = await seedOrg(h.db, { email: 'ks@x.io', password: 'hunter22x', projectKey: 'KSP' });
  orgId = seed.organizationId;
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ks@x.io', password: 'hunter22x' } });
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const s = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  headers = { cookie: `${s}; fpm_csrf=${csrf}`, 'x-csrf-token': csrf };
});

/** Five timestamps inside one millisecond: .123100 .. .123500 (JS Dates can only hold .123). */
const MICROS = ['2026-01-01T00:00:00.123100Z', '2026-01-01T00:00:00.123200Z', '2026-01-01T00:00:00.123300Z', '2026-01-01T00:00:00.123400Z', '2026-01-01T00:00:00.123500Z'];

async function page(url: string): Promise<{ ids: string[]; next: string | null }> {
  const res = await app.inject({ method: 'GET', url, headers });
  expect(res.statusCode, res.body).toBe(200);
  return { ids: res.json().items.map((i: { id: string }) => i.id), next: res.json().next_cursor };
}

async function walk(base: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const { ids, next }: { ids: string[]; next: string | null } = await page(`${base}${base.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...ids);
    if (!next) return seen;
    cursor = next;
  }
  throw new Error('pagination did not terminate');
}

describe('keyset pagination precision', () => {
  it('microsecond rows are not skipped: jobs', async () => {
    const ids: string[] = [];
    for (const ts of MICROS) {
      const id = newId();
      ids.push(id);
      await sql`INSERT INTO jobs (id, organization_id, queue, type, status, payload, created_at)
                VALUES (${id}::uuid, ${orgId}::uuid, ${h.queueName}, 'system.ping', 'succeeded', '{}'::jsonb, ${ts}::timestamptz)`.execute(h.db);
    }
    const seen = await walk('/api/v1/jobs', 2);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    for (const id of ids) expect(seen.filter((s) => s === id).length, `job ${id}`).toBe(1);
    // newest first: the microsecond order is preserved across page borders
    expect(seen.filter((s) => ids.includes(s))).toEqual([...ids].reverse());
  });

  it('microsecond rows are not skipped: audit', async () => {
    const ids: string[] = [];
    for (const ts of MICROS) {
      const id = newId();
      ids.push(id);
      await sql`INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, resource_type, resource_id, summary, request_id, created_at)
                VALUES (${id}::uuid, ${orgId}::uuid, 'system', ${newId()}, 'keyset.test', 'probe', ${id}, '{}'::jsonb, NULL, ${ts}::timestamptz)`.execute(h.db);
    }
    const seen = await walk('/api/v1/audit?resource_type=probe', 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((s) => ids.includes(s))).toEqual([...ids].reverse());
    expect(seen.length).toBe(ids.length);
  });

  it('legacy cursor: an ISO millisecond cursor from before this change is still accepted', async () => {
    const id = newId();
    await sql`INSERT INTO jobs (id, organization_id, queue, type, status, payload, created_at)
              VALUES (${id}::uuid, ${orgId}::uuid, ${h.queueName}, 'system.ping', 'succeeded', '{}'::jsonb, '2026-01-01T00:00:00.123100Z'::timestamptz)`.execute(h.db);
    const legacy = encodeCursor('2026-01-01T00:00:00.124Z', newId());
    const { ids } = await page(`/api/v1/jobs?limit=10&cursor=${legacy}`);
    expect(ids).toContain(id); // 00:00:00.1231 is older than the cursor .124 so it is on the next page
  });
});
