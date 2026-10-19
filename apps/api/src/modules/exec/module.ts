import { sql } from 'kysely';
import { AppError, execHarnessSchema, execPolicySchema } from '@forgepm/shared';
import {
  getEffective,
  validateSettingValue,
  registerCompletionGuard,
  type CompletionGuard,
  type Db,
  type DbLike,
  type ModuleDefinition,
} from '@forgepm/core';

/**
 * Execution-control module (docs/EXECUTION_CONTROL_PLAN.md §5 PE-0 item 3, §8.3 I-1).
 *
 * Always REGISTERED (registration means "exists", plan §3b-1.1) and OFF by
 * default: while `modules.exec.enabled` is false the agent's `tools/list`
 * contains no exec tool, and the REST routes answer MODULE_DISABLED. That is how
 * this feature ships without changing anyone's current behaviour.
 *
 * `validateConfig` runs on ENABLE (plan §3b-1.4): the module refuses to switch on
 * while the policy/harness settings do not parse, so the Finalization Gate can
 * never evaluate against a half-written JSON document. Enabling also registers
 * the completion guard, so a work item that belongs to the ledger can only be
 * completed through the gate.
 */

/**
 * The completion guard (plan §8.3, I-1).
 *
 * A work item that has a ledger task behind it may not be moved to
 * `category='completed'` unless the gate has passed for that task. The guard
 * reads the newest gate stamp; without one, the task was closed by hand and the
 * move is refused with GATE_FAILED.
 */
export const completionGuard: CompletionGuard = {
  name: 'exec-completion-guard',
  async assert(input, db: DbLike): Promise<void> {
    if (input.target_category !== 'completed') return;
    // The link exists in both directions and the code only fills one of them
    // today (`exec_tasks.work_item_id`); the plan's wording is the other way
    // round (`work_items.exec_task_id`), so the guard asks for both.
    const found = await sql<{ id: string; code: string; status: string }>`
      SELECT t.id::text AS id, t.code, t.status
      FROM exec_tasks t
      LEFT JOIN work_items w ON w.exec_task_id = t.id
      WHERE t.organization_id = ${input.organization_id}::uuid
        AND (t.work_item_id = ${input.work_item_id}::uuid OR w.id = ${input.work_item_id}::uuid)
      LIMIT 1
    `.execute(db as never);
    const task = found.rows[0];
    if (!task) return; // not a ledger task — not the gate's business
    const stamp = await db
      .selectFrom('exec_gate_checks')
      .select(['id', 'ok'])
      .where('task_id', '=', task.id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (task.status === 'done' && stamp?.ok) return;
    throw new AppError(
      'GATE_FAILED',
      `work item ${input.work_item_id} belongs to ledger task ${task.code}, which the finalization gate has not passed`,
      {
        task_code: task.code,
        task_status: task.status,
        gate_stamp: stamp ? (stamp.ok ? 'ok' : 'not passing') : 'missing',
        needed_action:
          'call exec_task_complete for this task (the exec module must be enabled) — the gate writes the stamp, and only a stamped task may be completed',
      },
    );
  },
};

const CHECKED_ON_ENABLE = [
  ['exec.policy', execPolicySchema],
  ['exec.test_result_parser', execHarnessSchema.shape.result_parser],
  ['exec.protected_test_globs', execHarnessSchema.shape.protected_test_globs],
] as const;

export const execControlModule: ModuleDefinition = {
  name: 'exec',
  validateConfig: async (db: Db) => {
    const problems: string[] = [];
    for (const [key, schema] of CHECKED_ON_ENABLE) {
      const eff = await getEffective(db, key, null, null);
      // Absent = the settings-registry default applies, which is valid by construction.
      if (!eff) continue;
      if (key === 'exec.policy') {
        const checked = validateSettingValue(key, eff.value);
        if (!checked.ok) problems.push(`${key}: ${checked.message}`);
        continue;
      }
      const parsed = schema.safeParse(eff.value);
      if (!parsed.success) {
        problems.push(
          `${key}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        );
      }
    }
    if (problems.length) {
      throw new AppError('VALIDATION_ERROR', `exec module config is invalid: ${problems.join(' | ')}`, { problems });
    }
    // Enabling the module installs the guard that keeps the board and the
    // ledger in agreement (plan §8.3). Registration is idempotent.
    registerCompletionGuard(completionGuard);
  },
};

/** The guard, registered at import time as well: the module may be enabled by a
 *  direct settings write, and a guard that only exists on one enable path is
 *  a guard with a hole in it. The guard itself is inert without a ledger task. */
registerCompletionGuard(completionGuard);

/** Used by the tests and by the CLI: is there a ledger task behind this item? */
export async function execTaskForWorkItem(db: DbLike, workItemId: string): Promise<string | null> {
  const r = await sql<{ code: string }>`
    SELECT code FROM exec_tasks WHERE work_item_id = ${workItemId}::uuid LIMIT 1
  `.execute(db as never);
  return r.rows[0]?.code ?? null;
}
