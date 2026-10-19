import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { appendEvent } from './events';
import { buildFinalReport } from './final-report';
import { loadGateContext, loadStamp } from './gate-context';
import { runGate } from './gate';
import type { BlockedRef, FinalReport } from './gate-types';
import { createOpenItem, findTaskByRef, type LedgerActor } from './open-items-service';
import { scopeIssueRef } from './scope';
import { unblockDependencyTasks } from './plan';
import type { GateOpenItem } from './gate-types';

/**
 * `exec_task_complete` — the ONE door to `status='done'` (plan §8.2).
 *
 * The order matters and is not negotiable:
 *
 *   1. run the gate (which writes the stamp),
 *   2. move the task to the status the gate implies,
 *   3. only then answer.
 *
 * The stamp is written before the status moves, so there is never a moment in
 * which the task says "done" and the ledger cannot prove why. Open items are
 * NOT closed here: the gate may pass with items that a human accepted, and
 * closing them silently would be the very thing the ledger forbids.
 */
export interface CompleteTaskOptions {
  /** Close on a specific report; the newest one otherwise. */
  reportId?: string | null;
}

export interface CompleteTaskResult {
  ok: boolean;
  task_id: string;
  task_code: string;
  status: string;
  /** The gate stamp, or null when the task had no report to stamp (rule 1). */
  stamp_id: string | null;
  /** Which gate version decided — the caller may check it against its own. */
  gate_version: number;
  blocked_by: BlockedRef[];
  final_report?: FinalReport;
}

export async function completeTask(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  options: CompleteTaskOptions = {},
): Promise<CompleteTaskResult> {
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });

  // A task the gate already closed is closed. Calling the door again must not
  // be a way to re-open it — but a task that says `done` WITHOUT a passing
  // stamp is drift (C.9b), and the gate below is what puts it back to the
  // truth. The stamp is the difference between the two.
  if (task.status === 'done') {
    const stamp = await loadStamp(db, task.id, null);
    if (stamp?.ok) {
      throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
        needed_action: 'a closed task keeps the report it was closed with; open a new task for new work',
      });
    }
  }

  // Scope findings are measured by code and materialized before the gate reads
  // open items. This write happens only on the completion path; `scope_check`
  // remains ledger:read and has no side effects.
  const measured = await loadGateContext(db, task.id, { reportId: options.reportId ?? null });
  await materializeScopeFindings(db, measured);

  const gate = await runGate(db, task.id, {
    reportId: options.reportId ?? null,
    actorType: actor.actorType,
  });

  if (gate.ok) {
    // `ok` implies a report (rule 1 refuses without one), so there is a stamp.
    await sql`
      UPDATE exec_tasks
      SET status = 'done', closed_at = now(), gate_stamp_id = ${gate.stamp_id}::uuid, updated_at = now()
      WHERE id = ${task.id}::uuid
    `.execute(db as never);
  } else {
    // The ledger's own CHECK says a task may not sit in `awaiting_review` or
    // `blocked` without saying what would unblock it — so the gate writes the
    // condition down instead of leaving a status that the database would
    // refuse. The unblock condition is the gate's own words.
    const unblock = `the finalization gate must pass: ${
      gate.blocked_by.map((b) => b.needed).join('; ') || 'no rule was named'
    }`.slice(0, 400);
    const reason = `the gate refused to close this task: ${
      gate.blocked_by.map((b) => `rule ${b.rule} (${b.ref})`).join('; ') || 'unknown reason'
    }`.slice(0, 400);
    await sql`
      UPDATE exec_tasks
      SET status = ${gate.status}::text,
          updated_at = now(),
          closed_at = NULL,
          blocked_on_kind = CASE
            WHEN ${gate.status}::text IN ('awaiting_review','blocked') THEN COALESCE(blocked_on_kind, 'external')
            ELSE blocked_on_kind END,
          unblock_condition = CASE
            WHEN ${gate.status}::text IN ('awaiting_review','blocked') THEN COALESCE(unblock_condition, ${unblock})
            ELSE unblock_condition END,
          blocked_reason = CASE
            WHEN ${gate.status}::text = 'blocked' THEN COALESCE(blocked_reason, ${reason})
            ELSE blocked_reason END
      WHERE id = ${task.id}::uuid
    `.execute(db as never);
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: gate.ok ? 'task.completed' : 'gate.failed',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: task.status },
      after: {
        status: gate.ok ? 'done' : gate.status,
        stamp_id: gate.stamp_id,
        ok: gate.ok,
        blocked_by: gate.blocked_by,
      },
    },
  });

  if (!gate.ok) {
    return {
      ok: false,
      task_id: task.id,
      task_code: task.code,
      status: gate.status,
      stamp_id: gate.stamp_id,
      gate_version: gate.gate_version,
      blocked_by: gate.blocked_by,
    };
  }

  await unblockDependencyTasks(db, task.id);
  const finalReport = await buildFinalReport(db, task.id);
  return {
    ok: true,
    task_id: task.id,
    task_code: task.code,
    status: 'done',
    stamp_id: gate.stamp_id,
    gate_version: gate.gate_version,
    blocked_by: [],
    final_report: finalReport,
  };
}

async function materializeScopeFindings(
  db: DbLike,
  loaded: Awaited<ReturnType<typeof loadGateContext>>,
): Promise<void> {
  const { ctx } = loaded;
  if (!ctx.report || !ctx.scope.available) return;
  const active = new Set(['open', 'blocked', 'awaiting_human']);
  const systemActor: LedgerActor = {
    organizationId: loaded.organization_id,
    projectId: loaded.project_id,
    actorType: 'system',
    actorId: 'exec-scope-check',
    tool: 'scope_check',
  };

  for (const file of ctx.scope.files) {
    if (file.transient || (file.in_allowed_paths && !file.deleted)) continue;
    const relatedRef = scopeIssueRef(file.path, file.change);
    const existing = ctx.open_items.filter(
      (item) => item.source === 'hook' && item.type === 'out_of_scope' && item.related_ref === relatedRef,
    );
    if (
      existing.some((item) => active.has(item.status)) ||
      existing.some((item) => !active.has(item.status) && item.resolved_by === 'human')
    ) {
      continue;
    }

    const kind = file.deleted ? 'deleted' : 'changed outside allowed_paths';
    const hashSuffix = relatedRef.slice(-12);
    const title = `scope check requires human review: ${kind} ${file.path.slice(0, 400)} [${hashSuffix}]`;
    const detail = JSON.stringify({ path: file.path, change: file.change, basis: ctx.scope.basis });
    let row: Awaited<ReturnType<typeof createOpenItem>>;
    try {
      row = await createOpenItem(
        db,
        systemActor,
        ctx.task.code,
        { title, detail, type: 'out_of_scope', blocks_completion: true, related_ref: relatedRef },
        'hook',
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') continue;
      throw error;
    }
    const item: GateOpenItem = {
      code: row.code,
      title: row.title,
      type: row.type,
      status: row.status,
      blocks_completion: row.blocks_completion,
      source: row.source,
      related_ref: row.related_ref,
      resolved_by: row.resolved_by === 'human' || row.resolved_by === 'agent' ? row.resolved_by : null,
    };
    ctx.open_items.push(item);
  }
}
