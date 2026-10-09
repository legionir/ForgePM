import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { newId, upsertSetting, runRetention, RETENTION_KEYS } from '@forgepm/core';
import { createHarness, type Harness } from './harness';

/**
 * Phase 7 / plan §14 — retention job:
 * rows older than retention.*_days are deleted, newer rows untouched, and the
 * organization-level override wins over the registry default.
 */
let h: Harness;
let orgId: string;
const otherOrg = /* deterministically reused per file */ newId();

beforeAll(async () => {
  h = await createHarness();
  orgId = newId();
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Ret Org', ${'ret-' + orgId.slice(0, 8)})`.execute(h.db);
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${otherOrg}, 'Other Org', ${'ret2-' + otherOrg.slice(0, 8)})`.execute(h.db);
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Ret Org', ${'ret-' + orgId.slice(0, 8)})`.execute(h.db);
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${otherOrg}, 'Other Org', ${'ret2-' + otherOrg.slice(0, 8)})`.execute(h.db);
});

async function insertAudit(org: string, ageDays: number): Promise<void> {
  await sql`
    INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, resource_type, resource_id, created_at)
    VALUES (${newId()}, ${org}, 'system', ${org}, 'test', 'test', ${org},
            now() - (${ageDays}::double precision * interval '1 day'))
  `.execute(h.db);
}

async function countRows(table: string, org: string): Promise<number> {
  const r = await sql<{ c: string }>`SELECT count(*)::text AS c FROM ${sql.table(table)} WHERE organization_id = ${org}`.execute(h.db);
  return Number(r.rows[0].c);
}

describe('runRetention (plan §14)', () => {
  it('deletes audit_events older than retention.audit_days and keeps newer ones', async () => {
    // default retention.audit_days = 365
    await insertAudit(orgId, 400);
    await insertAudit(orgId, 300);
    const res = await runRetention(h.db);
    expect(res.audit_events).toBe(1);
    expect(await countRows('audit_events', orgId)).toBe(1);
  });

  it('honors an organization override (retention.audit_days=7)', async () => {
    await upsertSetting(h.db, 'organization', orgId, 'retention.audit_days', 7);
    await insertAudit(orgId, 10); // older than override
    await insertAudit(orgId, 3); // newer
    const res = await runRetention(h.db);
    expect(res.audit_events).toBe(1);
    expect(await countRows('audit_events', orgId)).toBe(1);
  });

  it('is tenancy-scoped: rows of another org are not touched by this org override', async () => {
    await upsertSetting(h.db, 'organization', orgId, 'retention.audit_days', 7);
    await insertAudit(orgId, 10);
    await insertAudit(otherOrg, 10); // other org keeps the 365-day default
    const res = await runRetention(h.db);
    expect(res.audit_events).toBe(1);
    expect(await countRows('audit_events', otherOrg)).toBe(1);
  });

  it('prunes ai_calls, mcp_tool_calls and webhook_deliveries with their own keys', async () => {
    await upsertSetting(h.db, 'system', null, 'retention.ai_call_days', 30);
    await upsertSetting(h.db, 'system', null, 'retention.mcp_call_days', 30);
    await upsertSetting(h.db, 'system', null, 'retention.webhook_days', 10);

    // provider row is required by ai_calls FK
    const prov = newId();
    await sql`
      INSERT INTO ai_providers (id, organization_id, name, kind, base_url, default_model, created_at, updated_at)
      VALUES (${prov}, ${orgId}, 'fake', 'openai', 'https://example.invalid/v1', 'm', now(), now())
    `.execute(h.db);
    await sql`
      INSERT INTO ai_calls (id, organization_id, provider_id, model, purpose, status, created_at)
      VALUES (${newId()}, ${orgId}, ${prov}, 'm', 'plan', 'ok', now() - interval '40 days')
    `.execute(h.db);
    await sql`
      INSERT INTO mcp_tool_calls (id, organization_id, tool, outcome, created_at)
      VALUES (${newId()}, ${orgId}, 'ping', 'ok', now() - interval '40 days')
    `.execute(h.db);
    await sql`
      INSERT INTO webhook_deliveries (id, organization_id, delivery_id, event, payload, received_at)
      VALUES (${newId()}, ${orgId}, 'd-1', 'ping', '{}'::jsonb, now() - interval '11 days')
    `.execute(h.db);

    const res = await runRetention(h.db);
    expect(res.ai_calls).toBe(1);
    expect(res.mcp_tool_calls).toBe(1);
    expect(res.webhook_deliveries).toBe(1);
  });

  it('exports exactly the four documented retention keys', () => {
    expect([...RETENTION_KEYS].sort()).toEqual(
      ['retention.ai_call_days', 'retention.audit_days', 'retention.mcp_call_days', 'retention.webhook_days'].sort(),
    );
  });
});
