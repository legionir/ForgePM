import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { appendEvent } from './events';
import { recordHumanDecision } from './approvals';
import type { LedgerActor } from './open-items-service';

/**
 * The human's two "this demand will not happen" verbs (plan §9.5):
 * waive a criterion, drop a requirement.
 *
 * Both are the same kind of act, so they are written the same way:
 *
 *   • the ledger's own CHECK demands a justification (`drop_reason` ≥ 10
 *     characters; a waiver without a reason is a deletion with extra steps),
 *   • and the schema demands a BACKING APPROVAL — a waived criterion points
 *     at the approval that waived it (`waiver_approval_id`), because "the
 *     human waived it" must be something an auditor can read, not a status.
 *     So each of these writes an approval row that is already decided, and
 *     the ledger points at it.
 *
 * The agent has no way to do any of this: the plan's tool table (§4.0) has no
 * `criterion_waive` and no `req_drop` on purpose, and the service refuses a
 * non-human actor even if a caller forgets that.
 */

const MIN_REASON = 10;

export interface WaiveResult {
  kind: 'criterion';
  id: string;
  code: string;
  task_code: string;
  status: 'waived';
  approval_id: string;
  reason: string;
}

export interface DropResult {
  kind: 'requirement';
  id: string;
  code: string;
  status: 'dropped';
  approval_id: string;
  reason: string;
  waived_criteria: string[];
}

/** Only a human may remove a demand; the agent may ask, never decide. */
function assertHuman(actor: LedgerActor): void {
  if (actor.actorType === 'agent') {
    throw new AppError('FORBIDDEN', 'only a human may waive a criterion or drop a requirement', {
      needed_action: 'ask the human (ledger_ask_human) — the ledger records who decided, and that is not the agent',
    });
  }
}

function checkReason(reason: string): string {
  const text = (reason ?? '').trim();
  if (text.length < MIN_REASON) {
    throw new AppError('VALIDATION_ERROR', `the reason is too short (${text.length} characters)`, {
      needed_action: 'write what changed and why — a waiver without a reason is a deletion with extra steps',
    });
  }
  return text;
}

/**
 * The approval row behind a human's decision: already decided, by the human.
 * (`recordHumanDecision` writes it; the ledger points at it afterwards.)
 */
async function decidedApproval(
  db: DbLike,
  actor: LedgerActor,
  action: string,
  payload: Record<string, unknown>,
  reason: string,
): Promise<string> {
  return recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action,
    payload,
    reason,
  });
}

/**
 * Waive one acceptance criterion of a task.
 *
 * A verified criterion is NOT waived: it is already proven, and turning a
 * proof into a waiver would erase the very evidence the human is relying on.
 */
export async function waiveCriterion(
  db: DbLike,
  actor: LedgerActor,
  code: string,
  reason: string,
): Promise<WaiveResult> {
  assertHuman(actor);
  const text = checkReason(reason);

  const rows = await sql<{
    id: string;
    code: string;
    status: string;
    task_id: string;
    task_code: string;
    task_status: string;
  }>`
    SELECT c.id::text AS id, c.code, c.status, t.id::text AS task_id, t.code AS task_code, t.status AS task_status
    FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid
      AND (c.code = ${code} OR c.id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const criterion = rows.rows[0];
  if (!criterion) {
    throw new AppError('NOT_FOUND', `no criterion '${code}' in this organisation`, { ref: code });
  }
  if (criterion.task_status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${criterion.task_code} is already closed`, {
      needed_action: 'a closed task keeps the criteria it was closed with; open a new task for new work',
    });
  }
  if (criterion.status === 'verified') {
    throw new AppError('LEDGER_STATE_INVALID', `criterion ${criterion.code} is already verified`, {
      needed_action: 'a proven criterion does not need a waiver — the evidence stands',
    });
  }
  if (criterion.status === 'waived') {
    throw new AppError('LEDGER_STATE_INVALID', `criterion ${criterion.code} is already waived`);
  }

  const approvalId = await decidedApproval(
    db,
    actor,
    'exec.waive_criterion',
    { criterion_id: criterion.id, code: criterion.code, task_code: criterion.task_code, reason: text },
    text,
  );

  await sql`
    UPDATE exec_criteria
    SET status = 'waived', waiver_approval_id = ${approvalId}::uuid
    WHERE id = ${criterion.id}::uuid
  `.execute(db as never);

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: criterion.task_id,
    entity: 'criterion',
    entity_id: criterion.id,
    entity_code: criterion.code,
    action: 'task.waived',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: criterion.status },
      after: { status: 'waived', waiver: `criterion:${criterion.code}`, approval_id: approvalId, reason: text },
    },
  });

  return {
    kind: 'criterion',
    id: criterion.id,
    code: criterion.code,
    task_code: criterion.task_code,
    status: 'waived',
    approval_id: approvalId,
    reason: text,
  };
}

/**
 * Drop a requirement of the organisation.
 *
 * Dropping a requirement removes a promise the project made, so the ledger
 * keeps the promise with a `drop_reason` and a `dropped_by` — a dropped
 * requirement is not deleted, it is *dropped*, by a named human. The criteria
 * that were linked to it cannot be verified any more (nobody has to implement
 * a dropped requirement), so they are waived against the same approval.
 */
export async function dropRequirement(
  db: DbLike,
  actor: LedgerActor,
  code: string,
  reason: string,
): Promise<DropResult> {
  assertHuman(actor);
  const text = checkReason(reason);

  const rows = await sql<{ id: string; code: string; status: string; project_id: string }>`
    SELECT id::text AS id, code, status, project_id::text AS project_id
    FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}::uuid
      AND (code = ${code} OR id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const requirement = rows.rows[0];
  if (!requirement) {
    throw new AppError('NOT_FOUND', `no requirement '${code}' in this organisation`, { ref: code });
  }
  if (requirement.status === 'dropped') {
    throw new AppError('LEDGER_STATE_INVALID', `requirement ${requirement.code} is already dropped`);
  }

  const approvalId = await decidedApproval(
    db,
    actor,
    'exec.drop_requirement',
    { requirement_id: requirement.id, code: requirement.code, reason: text },
    text,
  );

  await sql`
    UPDATE exec_requirements
    SET status = 'dropped', drop_reason = ${text}, dropped_by = 'human', updated_at = now()
    WHERE id = ${requirement.id}::uuid
  `.execute(db as never);

  const linked = await sql<{ id: string; code: string; status: string; task_id: string }>`
    SELECT id::text AS id, code, status, task_id::text AS task_id
    FROM exec_criteria
    WHERE req_id = ${requirement.id}::uuid AND status = 'pending'
  `.execute(db as never);

  const waived: string[] = [];
  for (const criterion of linked.rows) {
    await sql`
      UPDATE exec_criteria
      SET status = 'waived', waiver_approval_id = ${approvalId}::uuid
      WHERE id = ${criterion.id}::uuid
    `.execute(db as never);
    waived.push(criterion.code);
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: criterion.task_id,
      entity: 'criterion',
      entity_id: criterion.id,
      entity_code: criterion.code,
      action: 'task.waived',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? null,
      payload: {
        before: { status: criterion.status },
        after: {
          status: 'waived',
          waiver: `criterion:${criterion.code}`,
          approval_id: approvalId,
          reason: `requirement ${requirement.code} was dropped`,
        },
      },
    });
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: null,
    entity: 'requirement',
    entity_id: requirement.id,
    entity_code: requirement.code,
    action: 'requirement.dropped',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: requirement.status },
      after: { status: 'dropped', reason: text, waived_criteria: waived },
    },
  });

  return {
    kind: 'requirement',
    id: requirement.id,
    code: requirement.code,
    status: 'dropped',
    approval_id: approvalId,
    reason: text,
    waived_criteria: waived,
  };
}
