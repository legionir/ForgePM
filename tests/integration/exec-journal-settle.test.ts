import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';
import { newId } from '@forgepm/core';

describe('R-06 exec_action_journal settle (started→unknown→done)', () => {
  let h: Harness;
  let db: Harness['db'];
  let orgId: string;
  let projectId: string;
  let taskId: string;
  let taskCode: string;

  beforeAll(async () => { h = await createHarness(); db = h.db; });
  afterAll(async () => { await h.cleanup(); });

  beforeEach(async () => {
    await h.reset();
    const seed = await seedOrg(db, { email: `r06-${Date.now()}@example.invalid`, password: 'sup3r-s3cret-pass' });
    orgId = seed.organizationId;
    projectId = seed.projectId;
    const state = await db.insertInto('workflow_states').values({ id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' }).returning('id').executeTakeFirstOrThrow();
    const workItemId = newId();
    await db.insertInto('work_items').values({ id: workItemId, organization_id: orgId, project_id: projectId, number: 1, type: 'task', title: 'r06 scaffold', state_id: state.id }).execute();
    const { allocateLedgerCode, ensureCodeCounters } = await import('@forgepm/core');
    await ensureCodeCounters(db, projectId);
    taskCode = await allocateLedgerCode(db, projectId, 'T');
    taskId = newId();
    await sql`INSERT INTO exec_tasks (id, organization_id, project_id, work_item_id, code, title, status, start_ref, tree_hash_start) VALUES (${taskId}, ${orgId}, ${projectId}, ${workItemId}, ${taskCode}, 'r06 scaffold', 'in_progress', 'abc1234', ${'t'.repeat(40)})`.execute(db);
  });

  it('allows started→unknown→done in two UPDATEs (no deadlock)', async () => {
    const code = `J-${Date.now().toString(36)}`;
    const inserted = await sql<{ id: string; code: string; status: string }>`
      INSERT INTO exec_action_journal (id, organization_id, task_id, code, action, status, target, idempotent, expected_effect, pre_state_ref, started_at)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${taskId}::uuid, ${code}, 'test.action', 'started', 'target', false, 'effect', 'pre', now())
      RETURNING id::text as id, code, status
    `.execute(db as never);
    const row = inserted.rows[0];
    expect(row.status).toBe('started');
    const toUnknown = await sql<{ status: string }>`UPDATE exec_action_journal SET status='unknown', finished_at=now() WHERE id=${row.id}::uuid RETURNING status`.execute(db as never);
    expect(toUnknown.rows[0].status).toBe('unknown');
    const toDone = await sql<{ status: string }>`UPDATE exec_action_journal SET status='done', finished_at=now() WHERE id=${row.id}::uuid RETURNING status`.execute(db as never);
    expect(toDone.rows[0].status).toBe('done');
    await expect(sql`UPDATE exec_action_journal SET status='failed' WHERE id=${row.id}::uuid`.execute(db as never)).rejects.toThrow(/already settled/);
    await expect(sql`DELETE FROM exec_action_journal WHERE id=${row.id}::uuid`.execute(db as never)).rejects.toThrow(/may not be deleted/);
    const code2 = `J-${(Date.now()+1).toString(36)}`;
    const ins2 = await sql<{ id: string }>`INSERT INTO exec_action_journal (id, organization_id, task_id, code, action, status, target, idempotent, expected_effect, pre_state_ref, started_at) VALUES (gen_random_uuid(), ${orgId}::uuid, ${taskId}::uuid, ${code2}, 'test.action', 'started', 'target', false, 'effect', 'pre', now()) RETURNING id::text as id`.execute(db as never);
    const id2 = ins2.rows[0].id;
    await sql`UPDATE exec_action_journal SET status='unknown' WHERE id=${id2}::uuid`.execute(db as never);
    await expect(sql`UPDATE exec_action_journal SET status='unknown' WHERE id=${id2}::uuid`.execute(db as never)).rejects.toThrow(/re-opened|restarted/);
  });
});
