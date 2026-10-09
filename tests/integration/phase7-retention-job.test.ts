import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { newId, upsertSetting, SYSTEM_ACTOR_ID, type Db } from '@forgepm/core';
import { RetentionJob } from '../../apps/worker/src/retention-job';
import { createHarness, type Harness } from './harness';

/**
 * Phase 7 / plan §14 — the nightly retention job wired into the worker.
 * tick() prunes per runRetention and emits ONE system.retention audit event
 * only when something was actually deleted.
 */
let h: Harness;
let orgId: string;

beforeAll(async () => {
  h = await createHarness();
  orgId = newId();
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'RJ Org', ${'rj-' + orgId.slice(0, 8)})`.execute(h.db);
});

function silentLogger() {
  const noop = () => undefined;
  return Object.assign(noop, {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => silentLogger(),
  }) as never;
}

async function auditCount(db: Db): Promise<number> {
  const r = await sql<{ c: string }>`SELECT count(*)::text AS c FROM audit_events WHERE action = 'system.retention'`.execute(db);
  return Number(r.rows[0].c);
}

describe('RetentionJob.tick (plan §14)', () => {
  it('prunes old audit rows and records a system.retention audit event', async () => {
    await upsertSetting(h.db, 'system', null, 'retention.audit_days', 5);
    await sql`
      INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, resource_type, resource_id, created_at)
      VALUES (${newId()}, ${orgId}, 'system', ${orgId}, 'x', 'x', ${orgId}, now() - interval '9 days')
    `.execute(h.db);

    const job = new RetentionJob(h.db, silentLogger());
    const res = await job.tick();
    expect(res.audit_events).toBe(1);
    // the pruning event itself is recorded (audit trail for every mutation)
    expect(await auditCount(h.db)).toBe(1);
  });

  it('records nothing when a pass deletes zero rows', async () => {
    const job = new RetentionJob(h.db, silentLogger());
    const res = await job.tick();
    expect(Object.values(res).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await auditCount(h.db)).toBe(0);
  });

  it('start/stop manages the interval without leaking', () => {
    const job = new RetentionJob(h.db, silentLogger(), 60_000);
    job.start();
    expect(job.running).toBe(true);
    job.stop();
    expect(job.running).toBe(false);
  });

  it('uses SYSTEM actor id for its audit event', async () => {
    await upsertSetting(h.db, 'system', null, 'retention.audit_days', 1);
    await sql`
      INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, resource_type, resource_id, created_at)
      VALUES (${newId()}, ${orgId}, 'system', ${orgId}, 'x', 'x', ${orgId}, now() - interval '3 days')
    `.execute(h.db);
    await new RetentionJob(h.db, silentLogger()).tick();
    const r = await sql`SELECT actor_id FROM audit_events WHERE action = 'system.retention'`.execute(h.db);
    expect(r.rows[0].actor_id).toBe(SYSTEM_ACTOR_ID);
  });
});
