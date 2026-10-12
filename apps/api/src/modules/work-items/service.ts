import { AppError, type WorkItemDto, type CreateWorkItemInput, type WorkItemFilter } from '@forgepm/shared';
import {
  findCycle,
  newId,
  recordAudit,
  unitOfWork,
  beginIdempotency,
  storeIdempotencyResult,
  abandonIdempotency,
  getEffective,
  type Db,
  type Tx,
  type DbLike,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';
import { classify, createApproval, autoRateOk, type OperationDesc } from '../approvals/service';
import {
  getWorkItemById,
  getWorkItemByKey,
  insertWorkItem,
  listWorkItems,
  loadLabels,
  rowToDto,
  searchWorkItems,
  setWorkItemLabels,
  softDeleteWorkItem,
  updateWorkItemFields,
  type NewWorkItemValues,
  type RawRow,
} from './items-repository';
import {
  allocateNumber,
  ensureWorkflow,
  listStates,
} from './states';

/**
 * Create a work item. Enforces the parent-depth CHECK (plan §6.1 max 3),
 * assigns `PRJ-N` number atomically, writes audit in the same tx.
 */
export type CreateResult = WorkItemDto | { pending: true; approval_request_id: string };

export async function createWorkItem(db: Db, actor: Actor, projectId: string, input: CreateWorkItemInput): Promise<CreateResult> {
  await assertProjectAccess(db, actor, projectId, 'project:write');
  if (input.assignee_user_id && input.assignee_agent_id) {
    throw new AppError('VALIDATION_ERROR', 'an item can have at most one assignee (user or agent)');
  }
  await ensureWorkflow(db as never, projectId, actor.organizationId);
  const gateResult = await gateAgentOperation(db, actor, 'work_item.create', { item_type: input.type, priority: input.priority ?? 'none' });
  if (gateResult) return gateResult;
  // depth check: parent -> grandparent -> great-grandparent (max 3 hops)
  if (input.parent_id) {
    await assertDepth(db as never, actor.organizationId, input.parent_id);
  }

  let id = '';
  let row: RawRow | undefined;
  await unitOfWork(db, async ({ tx }) => {
    const number = await allocateOnTx(tx, projectId);
    id = await insertWorkItem(tx as never, { ...buildValues(actor, projectId, input), number } as never);
    if (input.labels?.length) await setWorkItemLabels(tx as never, id, input.labels, actor.organizationId, projectId);
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'work_item.create',
      resource_type: 'work_item',
      resource_id: id,
      summary: { project_id: projectId, title: input.title, type: input.type, priority: input.priority ?? 'none' },
      request_id: actor.requestId,
    });
    row = await getWorkItemById(tx as never, id);
  });
  if (!row) throw new AppError('INTERNAL', 'work item vanished');
  const labels = await loadLabels(db, [id]);
  return rowToDto(row, labels.get(id) ?? []);
}

function buildValues(actor: Actor, projectId: string, input: CreateWorkItemInput): Omit<NewWorkItemValues, 'number'> & { number?: number } {
  return {
    organization_id: actor.organizationId,
    project_id: projectId,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    state_id: input.state_id,
    priority: input.priority,
    assignee_user_id: input.assignee_user_id ?? null,
    assignee_agent_id: input.assignee_agent_id ?? null,
    reporter_id: actor.type === 'user' ? actor.id : null,
    estimate: input.estimate ?? null,
    due_date: input.due_date ?? null,
    parent_id: input.parent_id ?? null,
    feature_id: input.feature_id ?? null,
    milestone_id: input.milestone_id ?? null,
    acceptance_criteria: input.acceptance_criteria ?? [],
    source: input.source ?? 'manual',
    plan_id: input.plan_id ?? null,
  } as never;
}

async function allocateOnTx(tx: Tx, projectId: string): Promise<number> {
  return allocateNumber(tx as never, projectId);
}

async function assertDepth(db: DbLike, orgId: string, parentId: string): Promise<void> {
  let cur: RawRow | undefined = await getWorkItemById(db, parentId);
  let depth = 0;
  while (cur && cur.parent_id) {
    depth += 1;
    if (depth >= 3) throw new AppError('VALIDATION_ERROR', 'work item nesting exceeds max depth 3');
    cur = await getWorkItemById(db, cur.parent_id as string);
  }
  if (cur && cur.organization_id !== orgId) throw new AppError('NOT_FOUND', 'parent not found');
}

export async function patchWorkItem(db: Db, actor: Actor, key: string, patch: Partial<CreateWorkItemInput>): Promise<WorkItemDto> {
  const existing = await getWorkItemByKey(db, actor.organizationId, key);
  if (!existing) throw new AppError('NOT_FOUND', 'work item not found');
  await assertProjectAccess(db, actor, existing.project_id as string, 'project:write');
  const gateResult = await gateAgentOperation(db, actor, 'work_item.update_content', { item_type: existing.type as any, priority: existing.priority });
  if (gateResult) throw new AppError('APPROVAL_REQUIRED', 'agent action requires approval', { approval_request_id: gateResult.approval_request_id });

  await unitOfWork(db, async ({ tx }) => {
    await updateWorkItemFields(tx as never, existing.id as string, patch as never);
    if (patch.labels !== undefined) {
      await setWorkItemLabels(tx as never, existing.id as string, patch.labels, actor.organizationId, existing.project_id as string);
    }
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'work_item.update',
      resource_type: 'work_item',
      resource_id: existing.id as string,
      summary: { patch: summarizePatch(patch) },
      request_id: actor.requestId,
    });
  });
  return reload(db, existing.id as string);
}

function summarizePatch(p: Partial<CreateWorkItemInput>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (p.title !== undefined) s.title = p.title;
  if (p.description !== undefined) s.description = p.description;
  if (p.priority !== undefined) s.priority = p.priority;
  if (p.assignee_user_id !== undefined) s.assignee_user_id = p.assignee_user_id;
  if (p.assignee_agent_id !== undefined) s.assignee_agent_id = p.assignee_agent_id;
  if (p.acceptance_criteria !== undefined) s.acceptance_criteria = 'AC updated';
  if (p.labels !== undefined) s.labels = p.labels;
  if (p.due_date !== undefined) s.due_date = p.due_date;
  if (p.estimate !== undefined) s.estimate = p.estimate;
  return s;
}

export async function reload(db: Db, id: string): Promise<WorkItemDto> {
  const row = await getWorkItemById(db, id);
  if (!row) throw new AppError('NOT_FOUND', 'work item not found');
  const labels = await loadLabels(db, [id]);
  return rowToDto(row, labels.get(id) ?? []);
}

/**
 * Transition via workflow state (plan §6.2). Refuses moving to `completed`
 * when the item still has an open blocker (`blocks` relation with a source
 * whose category is not `completed`/`canceled`).
 */
export async function transitionWorkItem(db: Db, actor: Actor, key: string, toStateId: string): Promise<WorkItemDto> {
  const item = await getWorkItemByKey(db, actor.organizationId, key);
  if (!item) throw new AppError('NOT_FOUND', 'work item not found');
  await assertProjectAccess(db, actor, item.project_id as string, 'project:write');
  const toState = (await listStates(db, item.project_id as string)).find((s) => s.id === toStateId);
  if (!toState) throw new AppError('VALIDATION_ERROR', 'unknown state for this project');
  const gateResult = await gateAgentOperation(db, actor, 'work_item.transition', { item_type: item.type as any, priority: item.priority, transition_category: toState.category });
  if (gateResult) throw new AppError('APPROVAL_REQUIRED', 'agent action requires approval', { approval_request_id: gateResult.approval_request_id });
  if (toState.category === 'completed') {
    const open = await openBlockers(db, item.id as string);
    if (open.length > 0) {
      throw new AppError('BLOCKED_BY_OPEN_ITEMS', `blocked by: ${open.join(', ')}`);
    }
  }
  await unitOfWork(db, async ({ tx }) => {
    await updateWorkItemFields(tx as never, item.id as string, { state_id: toStateId });
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'work_item.transition',
      resource_type: 'work_item',
      resource_id: item.id as string,
      summary: { from: item.state_id, to: toStateId, category: toState.category },
      request_id: actor.requestId,
    });
  });
  return reload(db, item.id as string);
}

/** Item ids of blockers (source items whose type='blocks' target=this) not yet terminal. */
async function openBlockers(db: DbLike, itemId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('work_item_relations as r')
    .innerJoin('work_items as wi', 'wi.id', 'r.from_id')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .innerJoin('projects as p', 'p.id', 'wi.project_id')
    .select(['r.from_id as from_id', 'ws.category as category', 'p.key as project_key', 'wi.number as number'])
    .where('r.to_id', '=', itemId)
    .where('r.type', '=', 'blocks')
    .where('wi.deleted_at', 'is', null)
    .execute();
  return rows
    .filter((r) => r.category !== 'completed' && r.category !== 'canceled')
    .map((r) => `${r.project_key}-${r.number}`);
}

export async function softDelete(db: Db, actor: Actor, key: string): Promise<void> {
  const item = await getWorkItemByKey(db, actor.organizationId, key);
  if (!item) throw new AppError('NOT_FOUND', 'work item not found');
  await assertProjectAccess(db, actor, item.project_id as string, 'project:write');
  const gateResult = await gateAgentOperation(db, actor, 'work_item.delete', { item_type: item.type as any, priority: item.priority });
  if (gateResult) throw new AppError('APPROVAL_REQUIRED', 'agent action requires approval', { approval_request_id: gateResult.approval_request_id });
  await unitOfWork(db, async ({ tx }) => {
    await softDeleteWorkItem(tx as never, item.id as string);
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'work_item.soft_delete',
      resource_type: 'work_item',
      resource_id: item.id as string,
      summary: null,
      request_id: actor.requestId,
    });
  });
}

/**
 * Add a relation. `blocks` relations are cycle-checked against the current
 * blocking graph (plan §6.3): A blocks B then B blocks A => 409.
 */
export async function addRelation(db: Db, actor: Actor, key: string, toKey: string, type: 'blocks' | 'relates_to' | 'duplicates'): Promise<void> {
  const from = await getWorkItemByKey(db, actor.organizationId, key);
  if (!from) throw new AppError('NOT_FOUND', 'work item not found');
  await assertProjectAccess(db, actor, from.project_id as string, 'project:write');
  const to = await getWorkItemByKey(db, actor.organizationId, toKey);
  if (!to) throw new AppError('NOT_FOUND', 'target work item not found');
  const gateResult = await gateAgentOperation(db, actor, 'work_item.relation_add', { item_type: from.type as any, priority: from.priority });
  if (gateResult) throw new AppError('APPROVAL_REQUIRED', 'agent action requires approval', { approval_request_id: gateResult.approval_request_id });

  if (type === 'blocks') {
    // Build edges and check for a cycle after the proposed insertion.
    const edges = await blockingEdges(db, from.organization_id as string);
    edges.push([from.id as string, to.id as string]);
    const cycle = findCycle(edges, from.id as string);
    if (cycle) {
      const path = await keysForIds(db, cycle);
      throw new AppError('DEPENDENCY_CYCLE', `cycle: ${path.join(' -> ')}`, { cycle: path });
    }
  }

  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('work_item_relations')
      .values({ id: newId(), from_id: from.id as string, to_id: to.id as string, type })
      .onConflict((oc) => oc.columns(['from_id', 'to_id', 'type']).doNothing())
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'work_item.relation_add',
      resource_type: 'work_item',
      resource_id: from.id as string,
      summary: { to: to.id, type },
      request_id: actor.requestId,
    });
  });
}

async function blockingEdges(db: DbLike, orgId: string): Promise<[string, string][]> {
  const rows = await db
    .selectFrom('work_item_relations as r')
    .innerJoin('work_items as wi', 'wi.id', 'r.from_id')
    .select(['r.from_id as from_id', 'r.to_id as to_id'])
    .where('r.type', '=', 'blocks')
    .where('wi.organization_id', '=', orgId)
    .execute();
  return rows.map((r) => [r.from_id, r.to_id]);
}

async function keysForIds(db: DbLike, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const r = await getWorkItemById(db, id);
    if (r) out.push(`${r.project_key}-${r.number}`);
  }
  return out;
}

/** Bulk create up to 100 items in ONE tx, idempotent by key (plan §6.9). */
export async function bulkCreate(db: Db, actor: Actor, projectId: string, items: CreateWorkItemInput[], idempotencyKey: string) {
  await assertProjectAccess(db, actor, projectId, 'project:write');
  const gateResult = await gateAgentOperation(db, actor, 'work_item.create', { item_type: items[0]?.type, priority: items[0]?.priority, count: items.length });
  if (gateResult) throw new AppError('APPROVAL_REQUIRED', 'agent bulk action requires approval', { approval_request_id: gateResult.approval_request_id, payload: { project_id: projectId, items } });
  const outcome = await beginIdempotency(db, actor.id, 'work_item.bulk_create', idempotencyKey, { project_id: projectId, items });
  if (outcome.kind === 'replay') {
    return { replay: true as const, response: outcome.response, status: outcome.status };
  }
  const created: WorkItemDto[] = [];
  const skipped: { index: number; reason: string }[] = [];
  const response = await runOrAbandon(db, async (tx) => {
    await ensureWorkflow(tx as never, projectId, actor.organizationId);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        if (it.parent_id) await assertDepth(tx as never, actor.organizationId, it.parent_id);
        const number = await allocateOnTx(tx, projectId);
        const id = await insertWorkItem(tx as never, { ...buildValues(actor, projectId, it), number } as never);
        if (it.labels?.length) await setWorkItemLabels(tx as never, id, it.labels, actor.organizationId, projectId);
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'work_item.create',
          resource_type: 'work_item',
          resource_id: id,
          summary: { project_id: projectId, title: it.title, type: it.type, bulk: true, index: i },
          request_id: actor.requestId,
        });
        const labels = await loadLabels(tx as never, [id]);
        const row = await getWorkItemById(tx as never, id);
        if (row) created.push(rowToDto(row, labels.get(id) ?? []));
      } catch (e) {
        skipped.push({ index: i, reason: (e as Error).message });
      }
    }
    const result = { created: created.length, skipped, items: created };
    await storeIdempotencyResult(tx as never, actor.id, 'work_item.bulk_create', idempotencyKey, result, 201);
    return result;
  }, actor, idempotencyKey);
  return { replay: false as const, response, status: 201 };
}

/** Gate agent mutations under the approval policy; returns { pending } if approval is needed. */
async function gateAgentOperation(db: DbLike, actor: Actor, operation: string, desc: OperationDesc): Promise<{ pending: true; approval_request_id: string } | null> {
  if (actor.type !== 'agent') return null;
  const allowed = new Set(((await getEffective(db as Db, 'approval.auto_operations', actor.organizationId, null))?.value as string[]) ?? ['work_item.create', 'work_item.update_content', 'work_item.comment', 'work_item.link']);
  const rateOk = await autoRateOk(db, actor.id);
  const verdict = await classify(db, actor.organizationId, null, { operation, ...desc }, { actorType: 'agent', autoOpsAllowed: allowed, rateOk });
  if (verdict !== 'approval') return null;
  const approvalId = await createApproval(db, actor.organizationId, null, actor.id, operation, desc, 'sensitive');
  return { pending: true, approval_request_id: approvalId };
}

async function runOrAbandon<T>(db: Db, fn: (tx: Tx) => Promise<T>, actor: Actor, key: string): Promise<T> {
  try {
    return await db.transaction().execute((tx) => fn(tx));
  } catch (err) {
    await abandonIdempotency(db, actor.id, 'work_item.bulk_create', key);
    throw err;
  }
}

export async function listFor(db: Db, actor: Actor, projectId: string, args: Omit<WorkItemFilter, never> & { limit: number; cursor?: string | null }) {
  await assertProjectAccess(db, actor, projectId, 'project:read');
  const { rows, hasMore } = await listWorkItems(db, { ...args, organizationId: actor.organizationId, projectId });
  const slice = hasMore ? rows.slice(0, args.limit) : rows;
  const labels = await loadLabels(db, slice.map((r) => r.id as string));
  const items = slice.map((r) => rowToDto(r, labels.get(r.id as string) ?? []));
  const next = hasMore
    ? encode(slice[slice.length - 1])
    : null;
  return { items, next_cursor: next };
}

function encode(r: RawRow): string {
  const raw = `${(r.created_at as Date).toISOString()}|${r.id}`;
  return Buffer.from(raw, 'utf8').toString('hex');
}

export async function search(db: Db, actor: Actor, q: string, limit: number) {
  const rows = await searchWorkItems(db, actor.organizationId, q, limit, actor.projectIds);
  const labels = await loadLabels(db, rows.map((r) => r.id as string));
  return { items: rows.map((r) => rowToDto(r, labels.get(r.id as string) ?? [])) };
}

export { allocateNumber };
