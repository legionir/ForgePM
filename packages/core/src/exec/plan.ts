import { sql } from 'kysely';
import { AppError, taskBlockInputSchema } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { appendEvent } from './events';
import { findTaskByRef, type LedgerActor } from './open-items-service';
import { assertAcyclic, pendingDependencies } from './dependencies';

export interface ExecTaskStateResult {
  task_id: string;
  task_code: string;
  status: string;
  pending_deps?: string[];
  already_started?: boolean;
}

export async function startExecTask(db: DbLike, actor: LedgerActor, taskRef: string): Promise<ExecTaskStateResult> {
  const task = await taskByRef(db, actor, taskRef);
  if (task.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`);
  if (task.status === 'in_progress') return { task_id: task.id, task_code: task.code, status: task.status, already_started: true };
  if (task.status !== 'not_started') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} cannot start while '${task.status}'`, {
      needed_action: 'resolve its current blocker or answer the pending human question first',
    });
  }
  const pending = await pendingDependencies(db, task.id);
  if (pending.length) {
    const pendingCodes = pending.map((dependency) => dependency.code);
    throw new AppError('CONFLICT', `task ${task.code} has pending dependencies: ${pendingCodes.join(', ')}`, {
      pending_deps: pendingCodes,
      needed_action: 'finish every dependency before moving this task to in progress',
    });
  }
  await sql`UPDATE exec_tasks SET status = 'in_progress', updated_at = now() WHERE id = ${task.id}::uuid`.execute(db as never);
  await moveWorkItem(db, task.work_item_id, actor.projectId, 'started');
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: 'task.started',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { before: { status: task.status }, after: { status: 'in_progress' } },
  });
  return { task_id: task.id, task_code: task.code, status: 'in_progress' };
}

export async function blockExecTask(db: DbLike, actor: LedgerActor, raw: unknown): Promise<ExecTaskStateResult & { blocked_on_kind: string }> {
  const parsed = taskBlockInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION_ERROR', `${issue?.path.join('.') || 'payload'}: ${issue?.message ?? 'invalid blocker'}`, {
      needed_action: 'send task_ref, reason, blocked_on_kind, unblock_condition, and a blocking ref when the blocker is a task/question/decision',
    });
  }
  const input = parsed.data;
  const task = await taskByRef(db, actor, input.task_ref);
  if (task.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`);
  const blocker = await resolveBlocker(db, actor, input.blocked_on_kind, input.blocked_on_ref);
  if (input.blocked_on_kind === 'task' && blocker?.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `blocking task ${blocker.code} is already done`);
  }
  if (input.blocked_on_kind === 'task' && blocker) {
    await assertAcyclic(db, actor, task.id, blocker.id, task.code, blocker.code);
    await sql`
      INSERT INTO exec_task_deps (task_id, depends_on_task_id)
      VALUES (${task.id}::uuid, ${blocker.id}::uuid)
      ON CONFLICT (task_id, depends_on_task_id) DO NOTHING
    `.execute(db as never);
  }
  await sql`
    UPDATE exec_tasks SET status = 'blocked', blocked_on_kind = ${input.blocked_on_kind},
      blocked_on_ref = ${blocker?.id ?? null}::uuid, blocked_reason = ${input.reason},
      unblock_condition = ${input.unblock_condition}, closed_at = NULL, updated_at = now()
    WHERE id = ${task.id}::uuid
  `.execute(db as never);
  await moveWorkItem(db, task.work_item_id, actor.projectId, 'unstarted');
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: 'task.blocked',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: task.status },
      after: {
        status: 'blocked',
        reason: input.reason,
        blocked_on_kind: input.blocked_on_kind,
        blocked_on_ref: blocker?.id ?? null,
        blocked_on_code: blocker?.code ?? input.blocked_on_ref ?? null,
        unblock_condition: input.unblock_condition,
      },
    },
  });
  return { task_id: task.id, task_code: task.code, status: 'blocked', blocked_on_kind: input.blocked_on_kind };
}

export async function resumeBlockedTask(
  db: DbLike,
  taskId: string,
  blockerKind: 'task' | 'question' | 'decision',
  blockerRef: string,
  reason: string,
): Promise<string | null> {
  const task = await sql<{
    id: string;
    code: string;
    organization_id: string;
    project_id: string;
    work_item_id: string;
    status: string;
    blocked_on_kind: string | null;
    blocked_on_ref: string | null;
  }>`
    SELECT id::text AS id, code, organization_id::text AS organization_id, project_id::text AS project_id,
      work_item_id::text AS work_item_id, status, blocked_on_kind, blocked_on_ref::text AS blocked_on_ref
    FROM exec_tasks WHERE id = ${taskId}::uuid
  `.execute(db as never);
  const row = task.rows[0];
  if (!row || row.status === 'done') return row?.status ?? null;
  const matchesBlocker = row.blocked_on_kind === blockerKind && (blockerKind === 'task' || row.blocked_on_ref === blockerRef);
  if (!matchesBlocker) return row.status;
  const pending = await pendingDependencies(db, row.id);
  if (pending.length) {
    const next = pending[0];
    await sql`
      UPDATE exec_tasks SET status = 'blocked', blocked_on_kind = 'task', blocked_on_ref = ${next.id}::uuid,
        blocked_reason = ${`dependency ${next.code} is not done`},
        unblock_condition = ${`task ${next.code} must be done before this task can continue`}, updated_at = now()
      WHERE id = ${row.id}::uuid
    `.execute(db as never);
    await moveWorkItem(db, row.work_item_id, row.project_id, 'unstarted');
    return 'blocked';
  }
  await sql`
    UPDATE exec_tasks SET status = 'in_progress', blocked_on_kind = NULL, blocked_on_ref = NULL,
      blocked_reason = NULL, unblock_condition = NULL, updated_at = now()
    WHERE id = ${row.id}::uuid
  `.execute(db as never);
  await moveWorkItem(db, row.work_item_id, row.project_id, 'started');
  await appendEvent(db, {
    organization_id: row.organization_id,
    task_id: row.id,
    entity: 'task',
    entity_id: row.id,
    entity_code: row.code,
    action: 'task.unblocked',
    actor_type: 'system',
    actor_id: 'exec-plan-unblock',
    tool: 'task_start',
    payload: { reason, blocker_kind: blockerKind, blocker_ref: blockerRef, status: 'in_progress' },
  });
  return 'in_progress';
}

export async function unblockDependencyTasks(db: DbLike, completedTaskId: string): Promise<string[]> {
  const dependents = await sql<{ id: string; code: string }>`
    SELECT DISTINCT t.id::text AS id, t.code
    FROM exec_task_deps d JOIN exec_tasks t ON t.id = d.task_id
    WHERE d.depends_on_task_id = ${completedTaskId}::uuid AND t.status = 'blocked' AND t.blocked_on_kind = 'task'
    ORDER BY t.code
  `.execute(db as never);
  const unblocked: string[] = [];
  for (const task of dependents.rows) {
    const next = await resumeBlockedTask(db, task.id, 'task', completedTaskId, 'dependency_completed');
    if (next === 'in_progress') unblocked.push(task.code);
  }
  return unblocked;
}

async function taskByRef(db: DbLike, actor: LedgerActor, ref: string) {
  const task = await findTaskByRef(db, actor, ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${ref}' in this project`);
  const row = await sql<{ work_item_id: string }>`
    SELECT work_item_id::text AS work_item_id FROM exec_tasks WHERE id = ${task.id}::uuid
  `.execute(db as never);
  return { ...task, work_item_id: row.rows[0]?.work_item_id ?? '' };
}

async function resolveBlocker(
  db: DbLike,
  actor: LedgerActor,
  kind: 'task' | 'question' | 'decision' | 'external',
  ref?: string,
): Promise<{ id: string; code: string; status: string } | null> {
  if (kind === 'external') return null;
  if (!ref) throw new AppError('VALIDATION_ERROR', `blocked_on_ref is required for ${kind}`);
  if (kind === 'task') {
    const task = await findTaskByRef(db, actor, ref);
    if (!task) throw new AppError('NOT_FOUND', `no blocking task '${ref}' in this project`);
    return { id: task.id, code: task.code, status: task.status };
  }
  const table = kind === 'question' ? 'exec_questions' : 'exec_decisions';
  const statusColumn = kind === 'question' ? 'status' : 'approval_state';
  const rows = await sql<{ id: string; code: string; status: string }>`
    SELECT x.id::text AS id, x.code, x.${sql.raw(statusColumn)}::text AS status
    FROM ${sql.raw(table)} x JOIN exec_tasks t ON t.id = x.task_id
    WHERE x.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
      AND (x.code = ${ref} OR x.id::text = ${ref})
    LIMIT 1
  `.execute(db as never);
  const row = rows.rows[0];
  if (!row) throw new AppError('NOT_FOUND', `no blocking ${kind} '${ref}' in this project`);
  if (kind === 'question' && row.status !== 'open') throw new AppError('LEDGER_STATE_INVALID', `${kind} ${row.code} is ${row.status}`);
  if (kind === 'decision' && row.status !== 'pending') throw new AppError('LEDGER_STATE_INVALID', `${kind} ${row.code} is ${row.status}`);
  return { id: row.id, code: row.code, status: row.status };
}

async function moveWorkItem(db: DbLike, workItemId: string, projectId: string, target: 'started' | 'unstarted'): Promise<void> {
  const preferStarted = target === 'started';
  await sql`
    WITH target_state AS (
      SELECT id FROM workflow_states
      WHERE project_id = ${projectId}::uuid
        AND ((${preferStarted} AND category = 'started')
          OR (NOT ${preferStarted} AND category IN ('unstarted','backlog')))
      ORDER BY CASE WHEN category = 'unstarted' THEN 0 ELSE 1 END, position LIMIT 1
    )
    UPDATE work_items SET state_id = (SELECT id FROM target_state), updated_at = now()
    WHERE id = ${workItemId}::uuid AND EXISTS (SELECT 1 FROM target_state)
  `.execute(db as never);
}
