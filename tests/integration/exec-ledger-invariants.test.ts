import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  ModuleRegistry,
  allocateLedgerCode,
  appendEvent,
  countEvents,
  ensureCodeCounters,
  migrations,
  newId,
  runMigrations,
  upsertSetting,
  type Db,
} from '@forgepm/core';
import { execPolicySchema } from '@forgepm/shared';
import { buildToolRegistry } from '../../apps/api/src/modules/mcp/tools';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

/**
 * PE-0 acceptance (docs/EXECUTION_CONTROL_PLAN.md §5): the ledger scaffold must
 * hold at the DATABASE level — the agent cannot edit history, cannot delete a
 * record, and cannot claim a code twice — plus the module must be dark until it
 * is switched on. Everything here is deliberately raw SQL: it proves the
 * constraints, not the service layer.
 */

let h: Harness;
let db: Db;
let orgId: string;
let projectId: string;
let workItemId: string;
let taskId: string;
let taskCode: string;

async function seedTask(): Promise<void> {
  const seed = await seedOrg(db, {
    email: `exec-${process.pid}-${Date.now()}@example.invalid`,
    password: 'sup3r-s3cret-pass',
  });
  orgId = seed.organizationId;
  projectId = seed.projectId;
  const state = await db
    .insertInto('workflow_states')
    .values({ id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' })
    .returning('id')
    .executeTakeFirstOrThrow();
  workItemId = newId();
  await db
    .insertInto('work_items')
    .values({
      id: workItemId,
      organization_id: orgId,
      project_id: projectId,
      number: 1,
      type: 'task',
      title: 'ledger scaffold',
      state_id: state.id,
    })
    .execute();
  await ensureCodeCounters(db, projectId);
  taskCode = await allocateLedgerCode(db, projectId, 'T');
  taskId = newId();
  await sql`
    INSERT INTO exec_tasks (id, organization_id, project_id, work_item_id, code, title, status, start_ref, tree_hash_start)
    VALUES (${taskId}, ${orgId}, ${projectId}, ${workItemId}, ${taskCode}, ${'ledger scaffold task'}, 'in_progress', 'abc1234', ${'t'.repeat(40)})
  `.execute(db);
}

beforeAll(async () => {
  h = await createHarness();
  db = h.db;
});
afterAll(async () => {
  await h.cleanup();
});
beforeEach(async () => {
  await h.reset();
  await seedTask();
});

describe('PE-0.1/0.2 migration + shape', () => {
  it('re-running the migration set is idempotent (no error, no duplicate object)', async () => {
    await expect(runMigrations(db, migrations)).resolves.toBeUndefined();
    const dup = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM (
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'exec_%'
        GROUP BY tablename HAVING count(*) > 1
      ) d
    `.execute(db);
    expect(Number((dup.rows as { n: string }[])[0].n)).toBe(0);
  });

  it('all 17 ledger tables exist', async () => {
    const { rows } = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'exec_%'
    `.execute(db);
    const names = (rows as { tablename: string }[]).map((r) => r.tablename).sort();
    expect(names).toHaveLength(17);
    for (const must of [
      'exec_code_seq',
      'exec_tasks',
      'exec_criteria',
      'exec_evidence',
      'exec_open_items',
      'exec_decisions',
      'exec_questions',
      'exec_reviews',
      'exec_reports',
      'exec_gate_checks',
      'exec_facts',
      'exec_baseline_tests',
      'exec_action_journal',
      'exec_events',
      'exec_requirements',
    ]) {
      expect(names, must).toContain(must);
    }
    // the work-item link the plan promises (D-03)
    const col = await sql<{
      c: string;
    }>`SELECT count(*)::text AS c FROM information_schema.columns WHERE table_name = 'work_items' AND column_name = 'exec_task_id'`.execute(
      db,
    );
    expect(Number((col.rows as { c: string }[])[0].c)).toBe(1);
  });

  it('the counter table only accepts the eight documented prefixes', async () => {
    await expect(
      sql`INSERT INTO exec_code_seq (project_id, prefix, seq) VALUES (${projectId}, 'XX', 0)`.execute(db),
    ).rejects.toThrowError(/check|violates/i);
  });
});

describe('PE-0.3 append-only enforcement (invariant I-2)', () => {
  it('exec_events cannot be updated or deleted, even by the table owner', async () => {
    const id = await appendEvent(db, {
      organization_id: orgId,
      task_id: taskId,
      entity: 'exec_task',
      entity_code: taskCode,
      action: 'task_start',
      actor_type: 'agent',
      actor_id: 'agent-1',
      tool: 'exec_task_start',
    });
    expect(await countEvents(db, taskId)).toBe(1);
    await expect(sql`UPDATE exec_events SET action = 'rewritten' WHERE id = ${id}`.execute(db)).rejects.toThrowError(
      /append-only/,
    );
    await expect(sql`DELETE FROM exec_events WHERE id = ${id}`.execute(db)).rejects.toThrowError(/append-only/);
    expect(await countEvents(db, taskId)).toBe(1);
  });

  it('exec_evidence and exec_gate_checks are append-only too', async () => {
    const crit = await sql`
      INSERT INTO exec_criteria (id, task_id, code, text, status)
      VALUES (${newId()}, ${taskId}, 'C-1', ${'the scaffold boots and the gate can read it'}, 'pending')
      RETURNING id
    `.execute(db);
    const criterionId = (crit.rows as { id: string }[])[0].id;
    const ev = await sql`
      INSERT INTO exec_evidence (id, organization_id, task_id, criterion_id, kind, ref, summary, recorded_by)
      VALUES (${newId()}, ${orgId}, ${taskId}, ${criterionId}, 'command_output', 'cmd:npm run verify', ${'verify ran and printed the summary line'}, 'agent-1')
      RETURNING id
    `.execute(db);
    const evidenceId = (ev.rows as { id: string }[])[0].id;
    await expect(
      sql`UPDATE exec_evidence SET summary = 'tiny' WHERE id = ${evidenceId}`.execute(db),
    ).rejects.toThrowError(/append-only/);
    await expect(sql`DELETE FROM exec_evidence WHERE id = ${evidenceId}`.execute(db)).rejects.toThrowError(
      /append-only/,
    );

    const reportId = newId();
    await sql`
      INSERT INTO exec_reports (id, organization_id, task_id, payload)
      VALUES (${reportId}, ${orgId}, ${taskId}, '{}'::jsonb)
    `.execute(db);
    const gate = await sql`
      INSERT INTO exec_gate_checks (id, organization_id, task_id, report_id, ok, blocked_by, gate_version, tree_hash, run_source)
      VALUES (${newId()}, ${orgId}, ${taskId}, ${reportId}, false, '[]'::jsonb, 1, ${'t'.repeat(40)}, 'none')
      RETURNING id
    `.execute(db);
    const gateId = (gate.rows as { id: string }[])[0].id;
    await expect(sql`UPDATE exec_gate_checks SET ok = true WHERE id = ${gateId}`.execute(db)).rejects.toThrowError(
      /append-only/,
    );
    await expect(sql`DELETE FROM exec_gate_checks WHERE id = ${gateId}`.execute(db)).rejects.toThrowError(
      /append-only/,
    );
  });

  it('a journal row may be settled once and only its outcome columns change', async () => {
    const j = await sql`
      INSERT INTO exec_action_journal (id, organization_id, task_id, code, action, idempotent, expected_effect, status)
      VALUES (${newId()}, ${orgId}, ${taskId}, 'AJ-001', 'exec_run_command', false, ${'writes one file under packages/core'}, 'started')
      RETURNING id
    `.execute(db);
    const jid = (j.rows as { id: string }[])[0].id;

    // rewriting the claim itself is impossible
    await expect(
      sql`UPDATE exec_action_journal SET expected_effect = 'nothing happened' WHERE id = ${jid}`.execute(db),
    ).rejects.toThrowError(/only status\/finished_at\/result_ref\/note/);
    // settling is allowed, and only once
    await expect(
      sql`UPDATE exec_action_journal SET status = 'done', finished_at = now(), result_ref = 'cmd:1' WHERE id = ${jid}`.execute(
        db,
      ),
    ).resolves.toBeDefined();
    await expect(
      sql`UPDATE exec_action_journal SET status = 'failed', finished_at = now() WHERE id = ${jid}`.execute(db),
    ).rejects.toThrowError(/already settled/);
    await expect(sql`DELETE FROM exec_action_journal WHERE id = ${jid}`.execute(db)).rejects.toThrowError(
      /may not be deleted/,
    );
  });

  it('the REVOKE half of I-2 bites when a dedicated app role exists', async () => {
    // CI/test DBs connect as the owner, so the migration's REVOKE block is a
    // no-op there. Provision the role the RUNBOOK describes, re-apply the
    // revoke, and prove the app role cannot rewrite the audit surfaces even
    // while it holds full table grants.
    await sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forgepm_app') THEN CREATE ROLE forgepm_app LOGIN; END IF; END $$;`.execute(
      db,
    );
    await sql`GRANT USAGE ON SCHEMA public TO forgepm_app`.execute(db);
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forgepm_app`.execute(db);
    await sql`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('forgepm_app','forgepm') LOOP
          EXECUTE format('REVOKE UPDATE, DELETE ON exec_events, exec_gate_checks, exec_evidence FROM %I', r.rolname);
          EXECUTE format('REVOKE DELETE ON exec_action_journal FROM %I', r.rolname);
        END LOOP;
      END $$;
    `.execute(db);

    const id = await appendEvent(db, {
      organization_id: orgId,
      task_id: taskId,
      entity: 'exec_task',
      entity_code: taskCode,
      action: 'task_start',
      actor_type: 'agent',
      actor_id: 'agent-1',
    });

    // Every statement runs in ONE pooled connection with RESET ROLE in a
    // finally — a leaked SET ROLE would poison the next test.
    const asApp = (statement: string) =>
      db.connection().execute(async (trx) => {
        await sql`SET ROLE forgepm_app`.execute(trx as never);
        try {
          await sql.raw(statement).execute(trx as never);
        } finally {
          await sql`RESET ROLE`.execute(trx as never);
        }
        return 'executed';
      });

    await expect(asApp(`UPDATE exec_events SET action = 'rewritten' WHERE id = '${id}'`)).rejects.toThrowError(
      /permission denied/,
    );
    await expect(asApp(`DELETE FROM exec_evidence WHERE id = '${newId()}'`)).rejects.toThrowError(/permission denied/);
    await expect(asApp(`DELETE FROM exec_action_journal WHERE task_id = '${taskId}'`)).rejects.toThrowError(
      /permission denied/,
    );
    // INSERT stays allowed: the ledger is append-only, not read-only.
    await expect(
      asApp(
        `INSERT INTO exec_events (id, organization_id, entity, action, actor_type, actor_id) VALUES ('${newId()}', '${orgId}', 'probe', 'probe', 'agent', 'agent-1')`,
      ),
    ).resolves.toBeDefined();

    // The role may own nothing, but it does hold grants/default privileges, so
    // DROP OWNED has to come first.
    await sql`DROP OWNED BY forgepm_app CASCADE`.execute(db);
    await sql`DROP ROLE IF EXISTS forgepm_app`.execute(db);
  });

  it('the tamper CHECKs refuse the forbidden status moves (I-3)', async () => {
    const soft = sql`
      INSERT INTO exec_open_items (id, organization_id, task_id, code, title, type, blocks_completion, status, resolution_note, resolved_by, source)
      VALUES (${newId()}, ${orgId}, ${taskId}, 'OI-001', ${'the requirement is not met at all'}, 'incomplete_requirement', true, 'accepted',
              ${'the agent decided this was fine and closed it'}, 'agent', 'agent')
    `;
    await expect(soft.execute(db)).rejects.toThrowError(/check|violates/i); // a blocking item is human-only
    await expect(
      sql`
        INSERT INTO exec_open_items (id, organization_id, task_id, code, title, type, blocks_completion, status, source)
        VALUES (${newId()}, ${orgId}, ${taskId}, 'OI-002', ${'an item without any note'}, 'bug', false, 'resolved', 'agent')
      `.execute(db),
    ).rejects.toThrowError(/check|violates/i); // closing needs a >= 20 char note
    // a human closure with a note is the legal path
    await expect(
      sql`
        INSERT INTO exec_open_items (id, organization_id, task_id, code, title, type, blocks_completion, status, resolution_note, resolved_by, source)
        VALUES (${newId()}, ${orgId}, ${taskId}, 'OI-003', ${'an item a human accepted'}, 'risk', true, 'accepted',
                ${'accepted by the owner after review of the risk register'}, 'human', 'human')
      `.execute(db),
    ).resolves.toBeDefined();
  });
});

describe('PE-0.5 code allocation', () => {
  it('20 concurrent allocations give 20 unique contiguous codes', async () => {
    const codes = await Promise.all(Array.from({ length: 20 }, () => allocateLedgerCode(db, projectId, 'T')));
    const seqs = codes.map((c) => Number(c.split('-')[1])).sort((a, b) => a - b);
    expect(new Set(codes).size).toBe(20);
    expect(seqs[0]).toBe(2); // 1 was taken while seeding
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(19); // contiguous
  });

  it('counters are per project and per prefix', async () => {
    const other = await seedOrg(db, {
      email: `exec2-${process.pid}-${Date.now()}@example.invalid`,
      password: 'sup3r-s3cret-pass',
    });
    await ensureCodeCounters(db, other.projectId);
    expect(await allocateLedgerCode(db, other.projectId, 'T')).toBe('T-001');
    expect(await allocateLedgerCode(db, projectId, 'OI')).toBe('OI-001');
    expect(await allocateLedgerCode(db, projectId, 'C')).toBe('C-1');
  });
});

describe('PE-0.4/0.6 module + tool surface', () => {
  it('the exec module is registered and OFF by default; enabling it is a setting', async () => {
    const reg = new ModuleRegistry();
    reg.register({ name: 'exec' });
    expect(reg.isRegistered('exec')).toBe(true);
    expect(await reg.isEnabled(db, 'exec', orgId, null)).toBe(false);
    await upsertSetting(db, 'system', null, 'modules.exec.enabled', true);
    reg.invalidate();
    expect(await reg.isEnabled(db, 'exec', orgId, null)).toBe(true);
  });

  it('no tool in the whole registry is a ledger delete path', async () => {
    const names = buildToolRegistry(db)
      .all()
      .map((t) => t.name);
    expect(names.filter((n) => /_delete$|^delete_/.test(n))).toEqual([]);
    // PE-0 adds no tools yet: the exec surface is dark until PE-2 registers it.
    expect(names.filter((n) => /^exec_/.test(n))).toEqual([]);
  });

  it('exec.policy must parse before the module may be enabled', async () => {
    await upsertSetting(db, 'system', null, 'exec.policy', { version: 1, rules: [] } as never);
    const parsed = execPolicySchema.safeParse({ version: 1, rules: [] });
    expect(parsed.success).toBe(false); // an empty rule table is not a policy
  });
});
