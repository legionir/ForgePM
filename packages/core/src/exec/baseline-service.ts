import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { appendEvent } from './events';
import { recordHumanDecision } from './approvals';
import { findTaskByRef, type LedgerActor } from './open-items-service';

export interface BaselineWaiverResult {
  task_id: string;
  task_code: string;
  approval_id: string;
  reason: string;
}

/** Only an explicit human may waive a missing CI baseline. */
export async function waiveBaseline(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  reason: string,
): Promise<BaselineWaiverResult> {
  if (actor.actorType !== 'human') {
    throw new AppError('FORBIDDEN', 'only a human may waive an unavailable CI baseline', {
      needed_action: 'ask a human to record an explicit baseline waiver',
    });
  }
  const text = (reason ?? '').trim();
  if (text.length < 10) {
    throw new AppError('VALIDATION_ERROR', 'a baseline waiver needs a reason of at least 10 characters', {
      needed_action: 'state why the CI log is unavailable and why the human accepts the risk',
    });
  }
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the baseline decision it was closed with; open a new task for new work',
    });
  }

  const approvalId = await recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action: 'exec.baseline_waive',
    payload: { task_id: task.id, task_code: task.code, reason: text },
    reason: text,
    risk: 'sensitive',
  });
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: 'baseline.waived',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { waiver: `baseline:${task.code}`, task_id: task.id, approval_id: approvalId, reason: text },
  });
  return { task_id: task.id, task_code: task.code, approval_id: approvalId, reason: text };
}
