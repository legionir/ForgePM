import { AppError, type ApprovalPolicy, type WorkItemType, type Priority } from '@forgepm/shared';
import {
  applyExecApprovalDecision,
  getEffective,
  type DbLike,
  type Db,
  newId,
  recordAudit,
  unitOfWork,
} from '@forgepm/core';

/**
 * Approval policy engine (plan §7). `auto_low_risk` permits an agent to apply
 * specific operations immediately; everything else becomes an
 * approval_request. Sensitivity is by OPERATION, not only item type.
 */
export const LOW_RISK_OPERATIONS = new Set([
  'work_item.create',
  'work_item.update_content',
  'work_item.comment',
  'work_item.link',
]);
const LOW_RISK_TRANSITIONS = new Set(['unstarted', 'started', 'in_review']);
const LOW_RISK_TYPES = new Set<WorkItemType>(['task', 'chore', 'research', 'improvement']);

export interface OperationDesc {
  operation: string;
  item_type?: WorkItemType;
  priority?: Priority;
  transition_category?: string;
  count?: number; // number of items in a bulk op
}

export async function policyFor(db: DbLike, orgId: string, projectId: string | null): Promise<ApprovalPolicy> {
  const eff = await getEffective(db as Db, 'approval_policy', orgId, projectId);
  return (eff?.value as ApprovalPolicy) ?? 'manual';
}

/**
 * Classify an operation under the current policy. `auto` when low-risk and the
 * policy is auto_low_risk; `approval` when a human decision is needed.
 */
export async function classify(
  db: DbLike,
  orgId: string,
  projectId: string | null,
  op: OperationDesc,
  opts: { actorType: 'user' | 'agent'; autoOpsAllowed: Set<string>; rateOk: boolean },
): Promise<'auto' | 'approval'> {
  if (opts.actorType !== 'agent') return 'auto'; // humans are the approvers
  const policy = await policyFor(db, orgId, projectId);
  if (policy !== 'auto_low_risk') return 'approval';
  if (!opts.rateOk) return 'approval';
  if (!opts.autoOpsAllowed.has(op.operation)) return 'approval';

  if (op.operation === 'work_item.transition') {
    return op.transition_category && LOW_RISK_TRANSITIONS.has(op.transition_category) ? 'auto' : 'approval';
  }
  if (op.operation === 'work_item.create') {
    const typeOk = op.item_type && LOW_RISK_TYPES.has(op.item_type);
    const prioOk = !op.priority || op.priority === 'none' || op.priority === 'low' || op.priority === 'medium';
    const bulkOk = (op.count ?? 1) <= 25;
    return typeOk && prioOk && bulkOk ? 'auto' : 'approval';
  }
  return 'auto';
}

export interface ApprovalRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  requested_by: string;
  action: string;
  payload: unknown;
  risk: 'low' | 'sensitive';
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  decided_by: string | null;
  reason: string | null;
  created_at: Date;
}

const COLS = [
  'id',
  'organization_id',
  'project_id',
  'requested_by',
  'action',
  'payload',
  'risk',
  'status',
  'decided_by',
  'reason',
  'created_at',
] as const;

export async function createApproval(
  db: DbLike,
  orgId: string,
  projectId: string | null,
  requestedBy: string,
  action: string,
  payload: unknown,
  risk: 'low' | 'sensitive',
): Promise<string> {
  const id = newId();
  await db
    .insertInto('approval_requests')
    .values({
      id,
      organization_id: orgId,
      project_id: projectId,
      requested_by: requestedBy,
      action,
      payload: JSON.parse(JSON.stringify(payload ?? null)),
      risk,
      status: 'pending',
    })
    .execute();
  return id;
}

export async function listPending(db: DbLike, orgId: string): Promise<ApprovalRow[]> {
  const rows = await db
    .selectFrom('approval_requests')
    .select(COLS)
    .where('organization_id', '=', orgId)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'desc')
    .execute();
  return rows as unknown as ApprovalRow[];
}

/**
 * Decide an approval. Only a human with plan:approve-or-admin may decide;
 * an agent may never approve its own request (FORBIDDEN_SELF_APPROVAL).
 */
export async function decide(
  db: Db,
  actor: { id: string; organizationId: string; type: 'user' | 'agent'; orgRole: string | null; requestId: string },
  id: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<ApprovalRow> {
  if (actor.type === 'agent') throw new AppError('FORBIDDEN_SELF_APPROVAL', 'agents cannot decide approval requests');
  const existing = await db
    .selectFrom('approval_requests')
    .select(COLS)
    .where('id', '=', id)
    .where('organization_id', '=', actor.organizationId)
    .executeTakeFirst();
  if (!existing) throw new AppError('NOT_FOUND', 'approval request not found');
  const row = existing as unknown as ApprovalRow;
  if (row.status !== 'pending') throw new AppError('CONFLICT', `already ${row.status}`);
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .updateTable('approval_requests')
      .set({ status: decision, decided_by: actor.id, decided_at: new Date(), reason: reason ?? null })
      .where('id', '=', id)
      .execute();
    // The ledger's own reading of "the human approved" (a decision's
    // approval_state, and the event that says so) happens in the SAME
    // transaction: an approval that was decided but did not reach the ledger
    // would keep the gate refusing with nothing left to fix.
    await applyExecApprovalDecision(tx, {
      action: row.action,
      payload: row.payload,
      decision,
      reason,
      actorId: actor.id,
      organizationId: actor.organizationId,
      tool: 'approvals.decide',
    });
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: 'user',
      actor_id: actor.id,
      action: `approval.${decision}`,
      resource_type: 'approval_request',
      resource_id: id,
      summary: { reason: reason ?? null },
      request_id: actor.requestId,
    });
  });
  const after = await db.selectFrom('approval_requests').select(COLS).where('id', '=', id).executeTakeFirstOrThrow();
  return after as unknown as ApprovalRow;
}

/** Auto-operation hourly rate limit per API key/agent (plan §7 auto_rate_limit). */
export async function autoRateOk(db: DbLike, actorId: string, limitPerHour = 100): Promise<boolean> {
  const r = await db
    .selectFrom('approval_requests')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('requested_by', '=', actorId)
    .where('created_at', '>=', new Date(Date.now() - 60 * 60 * 1000))
    .executeTakeFirst();
  return Number(r?.n ?? 0) < limitPerHour;
}
