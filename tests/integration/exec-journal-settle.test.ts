import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, type Harness } from './harness';
import { sql } from 'kysely';

/**
 * R-06 guarantee: exec_journal_settle_only must allow exactly one
 * started→unknown and one unknown→done/failed, and forbid
 * deletes, restarts, and re-opens. This test is the red→green witness
 * that 0011 fixed the deadlock (started→unknown→done must succeed).
 */
describe('R-06 exec_action_journal settle (started→unknown→done)', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h?.close(); });

  it('allows started→unknown→done in two UPDATEs (no deadlock)', async () => {
    const task = await h.createExecTask({ title: 'R-06 journal deadlock witness' });
    // The harness seeds a journal row via exec_journal_start; find one or create via direct insert
    // For isolation, insert a fresh journal row as started
    const code = `J-${Date.now().toString(36)}`;
    const inserted = await sql<{ id: string; code: string; status: string }>`
      INSERT INTO exec_action_journal (id, organization_id, task_id, code, action, status, target, idempotent, expected_effect, pre_state_ref, started_at)
      VALUES (gen_random_uuid(), ${h.organizationId}::uuid, ${task.id}::uuid, ${code}, 'test.action', 'started', 'target', false, 'effect', 'pre', now())
      RETURNING id::text as id, code, status
    `.execute(h.db as never);
    const row = inserted.rows[0];
    expect(row.status).toBe('started');

    // First settle: started → unknown (crash)
    const toUnknown = await sql<{ status: string }>`
      UPDATE exec_action_journal SET status='unknown', finished_at=now() WHERE id=${row.id}::uuid RETURNING status
    `.execute(h.db as never);
    expect(toUnknown.rows[0].status).toBe('unknown');

    // Second settle: unknown → done (reconcile)
    const toDone = await sql<{ status: string }>`
      UPDATE exec_action_journal SET status='done', finished_at=now() WHERE id=${row.id}::uuid RETURNING status
    `.execute(h.db as never);
    expect(toDone.rows[0].status).toBe('done');

    // Already settled → any further UPDATE must fail
    await expect(
      sql`UPDATE exec_action_journal SET status='failed' WHERE id=${row.id}::uuid`.execute(h.db as never)
    ).rejects.toThrow(/already settled/);

    // DELETE must fail
    await expect(
      sql`DELETE FROM exec_action_journal WHERE id=${row.id}::uuid`.execute(h.db as never)
    ).rejects.toThrow(/may not be deleted/);

    // unknown → unknown must fail (re-open)
    const code2 = `J-${(Date.now()+1).toString(36)}`;
    const ins2 = await sql<{ id: string }>`
      INSERT INTO exec_action_journal (id, organization_id, task_id, code, action, status, target, idempotent, expected_effect, pre_state_ref, started_at)
      VALUES (gen_random_uuid(), ${h.organizationId}::uuid, ${task.id}::uuid, ${code2}, 'test.action', 'started', 'target', false, 'effect', 'pre', now())
      RETURNING id::text as id
    `.execute(h.db as never);
    const id2 = ins2.rows[0].id;
    await sql`UPDATE exec_action_journal SET status='unknown' WHERE id=${id2}::uuid`.execute(h.db as never);
    await expect(
      sql`UPDATE exec_action_journal SET status='unknown' WHERE id=${id2}::uuid`.execute(h.db as never)
    ).rejects.toThrow(/re-opened|restarted/);
  });
});
