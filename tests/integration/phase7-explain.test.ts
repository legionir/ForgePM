import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createHarness, type Harness } from './harness';

/**
 * Plan §14 / PERFORMANCE_BUDGET P-04 — hot-path queries must be index-backed.
 * On a small test DB the planner would legitimately seq-scan, so the guard
 * asserts *index capability*: with enable_seqscan=off, any remaining
 * "Seq Scan on <guarded table>" means no usable index path exists — a product
 * bug. Query shapes mirror the real repository hot paths (cursor list, board
 * filter, full-text search, audit, outbox claim, sweeper, MCP log, FK joins).
 */
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.cleanup();
});

const ANY = "'00000000-0000-7000-8000-000000000000'";

async function planFor(query: string): Promise<string> {
  return h.db.transaction().execute(async (tx) => {
    await sql`SET LOCAL enable_seqscan = off`.execute(tx);
    const r = await sql.raw(`EXPLAIN ${query}`).execute(tx);
    // pg returns one row per plan line in a "QUERY PLAN" column
    const rows = r.rows as Record<string, string>[];
    return rows.map((row) => Object.values(row).join(' ')).join('\n');
  });
}

async function expectIndexed(label: string, query: string, tables: string[]): Promise<void> {
  const plan = await planFor(query);
  for (const t of tables) {
    expect(plan, `${label}: expected an index path for ${t}\n${plan}`).not.toContain(`Seq Scan on ${t}`);
  }
}

describe('EXPLAIN index guard for hot queries (P-04, plan §14)', () => {
  it('work-item cursor list (workitems_org_created_idx)', async () => {
    await expectIndexed(
      'wi list',
      `SELECT id FROM work_items WHERE deleted_at IS NULL AND organization_id = ${ANY}
       ORDER BY created_at DESC, id DESC LIMIT 50`,
      ['work_items'],
    );
  });

  it('board filter by project + state (workitems_state_idx)', async () => {
    await expectIndexed(
      'wi board',
      `SELECT id FROM work_items WHERE deleted_at IS NULL AND project_id = ${ANY} AND state_id = ${ANY}
       ORDER BY priority LIMIT 50`,
      ['work_items'],
    );
  });

  it('full-text search via GIN (workitems_search_idx)', async () => {
    await expectIndexed(
      'wi search',
      `SELECT id FROM work_items WHERE deleted_at IS NULL AND organization_id = ${ANY}
       AND search_vector @@ plainto_tsquery('simple', 'login') LIMIT 20`,
      ['work_items'],
    );
  });

  it('work item by assignee (workitems_assignee_user_idx)', async () => {
    await expectIndexed(
      'wi assignee',
      `SELECT id FROM work_items WHERE assignee_user_id = ${ANY} AND deleted_at IS NULL`,
      ['work_items'],
    );
  });

  it('audit list by org (audit_org_created_idx)', async () => {
    await expectIndexed(
      'audit list',
      `SELECT id FROM audit_events WHERE organization_id = ${ANY} ORDER BY created_at DESC, id DESC LIMIT 50`,
      ['audit_events'],
    );
  });

  it('audit by resource (audit_resource_idx)', async () => {
    await expectIndexed(
      'audit resource',
      `SELECT id FROM audit_events WHERE resource_type = 'work_item' AND resource_id = ${ANY}`,
      ['audit_events'],
    );
  });

  it('outbox claim (outbox_pending_idx)', async () => {
    await expectIndexed(
      'outbox claim',
      `SELECT id FROM outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50`,
      ['outbox'],
    );
  });

  it('jobs sweeper scan (jobs_status_queue_idx)', async () => {
    await expectIndexed(
      'jobs stale',
      `SELECT id FROM jobs WHERE status = 'queued' AND created_at < now() - interval '10 minutes' LIMIT 100`,
      ['jobs'],
    );
  });

  it('MCP call log by key (mcp_calls_key_created_idx)', async () => {
    await expectIndexed(
      'mcp by key',
      `SELECT id FROM mcp_tool_calls WHERE api_key_id = ${ANY} ORDER BY created_at DESC LIMIT 50`,
      ['mcp_tool_calls'],
    );
  });

  it('organization by slug (organizations_slug_uniq)', async () => {
    await expectIndexed(
      'org slug',
      `SELECT id FROM organizations WHERE slug = 'x' AND deleted_at IS NULL`,
      ['organizations'],
    );
  });

  it('project cursor list (projects_org_created_idx)', async () => {
    await expectIndexed(
      'project list',
      `SELECT id FROM projects WHERE deleted_at IS NULL AND organization_id = ${ANY}
       ORDER BY created_at DESC, id DESC LIMIT 50`,
      ['projects'],
    );
  });
});
