import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { recordHumanDecision } from './approvals';
import { appendEvent } from './events';
import { findTaskByRef, type LedgerActor } from './open-items-service';

export interface CancelSubtaskResult {
  parent: string;
  task_id: string;
  task: string;
  status: 'canceled';
  approval_id: string;
  linked_requirements: string[];
  reason: string;
}

/** Cancellation is a human decision, recorded against the parent gate's waiver history. */
export async function cancelSubtask(
  db: DbLike,
  actor: LedgerActor,
  parentRef: string,
  childRef: string,
  rawReason: string,
): Promise<CancelSubtaskResult> {
  if (actor.actorType !== 'human') {
    throw new AppError('FORBIDDEN', 'only a human may cancel a linked subtask', {
      needed_action: 'ask the human to cancel this child with an audited reason',
    });
  }
  const reason = (rawReason ?? '').trim();
  if (reason.length < 10) throw new AppError('VALIDATION_ERROR', 'cancellation reason must be at least 10 characters');
  const parent = await findTaskByRef(db, actor, parentRef);
  const child = await findTaskByRef(db, actor, childRef);
  if (!parent) throw new AppError('NOT_FOUND', `no parent task '${parentRef}' in this project`);
  if (!child) throw new AppError('NOT_FOUND', `no child task '${childRef}' in this project`);
  if (parent.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `parent task ${parent.code} is already closed`);
  const relation = await sql<{ parent_id: string | null; work_item_id: string }>`
    SELECT parent_id::text AS parent_id, work_item_id::text AS work_item_id FROM exec_tasks WHERE id = ${child.id}::uuid
  `.execute(db as never);
  if (relation.rows[0]?.parent_id !== parent.id) {
    throw new AppError('VALIDATION_ERROR', `task ${child.code} is not a direct child of ${parent.code}`);
  }
  if (child.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `subtask ${child.code} is already done`);
  if (await wasCanceled(db, parent.id, child.code)) {
    throw new AppError('CONFLICT', `subtask ${child.code} was already canceled by a human`);
  }
  const linked = await sql<{ code: string }>`
    SELECT DISTINCT r.code FROM exec_criteria c JOIN exec_requirements r ON r.id = c.req_id
    WHERE c.task_id = ${child.id}::uuid AND r.status <> 'dropped' ORDER BY r.code
  `.execute(db as never);
  const requirementCodes = linked.rows.map((row) => row.code);
  const approvalId = await recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action: 'exec.cancel_subtask',
    payload: {
      parent_task_id: parent.id,
      parent_code: parent.code,
      task_id: child.id,
      task_code: child.code,
      linked_requirements: requirementCodes,
      reason,
    },
    reason,
  });
  await moveWorkItemToCanceled(db, relation.rows[0].work_item_id, actor.projectId);
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: parent.id,
    entity: 'task',
    entity_id: child.id,
    entity_code: child.code,
    action: 'task.waived',
    actor_type: 'human',
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      waiver: `cancel:${child.code}`,
      approval_id: approvalId,
      reason,
      linked_requirements: requirementCodes,
      before: { status: child.status },
      after: { work_item_status: 'canceled' },
    },
  });
  return {
    parent: parent.code,
    task_id: child.id,
    task: child.code,
    status: 'canceled',
    approval_id: approvalId,
    linked_requirements: requirementCodes,
    reason,
  };
}

async function wasCanceled(db: DbLike, parentId: string, childCode: string): Promise<boolean> {
  const event = await sql<{ id: string }>`
    SELECT id::text AS id FROM exec_events
    WHERE task_id = ${parentId}::uuid AND action = 'task.waived' AND payload->>'waiver' = ${`cancel:${childCode}`}
    LIMIT 1
  `.execute(db as never);
  return Boolean(event.rows[0]);
}

async function moveWorkItemToCanceled(db: DbLike, workItemId: string, projectId: string): Promise<void> {
  await sql`
    UPDATE work_items w SET state_id = s.id, updated_at = now()
    FROM workflow_states s
    WHERE w.id = ${workItemId}::uuid AND s.project_id = ${projectId}::uuid AND s.category = 'canceled'
  `.execute(db as never);
}
