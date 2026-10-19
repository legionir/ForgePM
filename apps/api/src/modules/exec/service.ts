import { sql } from 'kysely';
import { z } from 'zod';
import { AppError, idOrCodeSchema, openItemInputSchema, resolveItemInputSchema } from '@forgepm/shared';
import {
  abandonIdempotency,
  beginIdempotency,
  checkCriteria,
  createOpenItem,
  createTask,
  listTaskItems,
  loadLedgerStatus,
  parseTaskStart,
  recordAudit,
  resolveOpenItem,
  storeIdempotencyResult,
  unitOfWork,
  type Db,
  type DbLike,
  type LedgerActor,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';
import { allocateNumber, ensureWorkflow } from '../work-items/states';
import { insertWorkItem } from '../work-items/items-repository';
import { gateAgentOperation } from '../work-items/service';

/**
 * The service behind PE-2's five ledger tools (plan §7). Thin on purpose: every ledger
 * rule lives in `@forgepm/core/src/exec`, so the tool, a future REST route and
 * `scripts/ledger-cli.ts` cannot drift apart. What this file owns is the specifically
 * *api* part — which project the caller means, whether an agent write needs the
 * approval gate first, the audit row, and the idempotency claim.
 */

const projectRefSchema = z.string().min(1).max(64);

// ---- tool input shapes (B.1) — strict, and the ledger laws are NOT restated here ----

export const openItemToolSchema = openItemInputSchema.extend({
  task_ref: idOrCodeSchema,
  project_ref: projectRefSchema.optional(),
});
export const resolveToolSchema = resolveItemInputSchema.extend({
  task_ref: idOrCodeSchema,
  project_ref: projectRefSchema.optional(),
});
export const listToolSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  active_only: z.boolean().default(true),
  project_ref: projectRefSchema.optional(),
});
export const statusToolSchema = z.strictObject({
  task_ref: idOrCodeSchema.optional(),
  project_ref: projectRefSchema.optional(),
});

/** A malformed call is an answer, not a crash: same shape as the ledger parsers (A.5). */
function parseTool<T extends object>(schema: z.ZodTypeAny, raw: unknown, neededAction: string): T {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data as T;
  const issue = parsed.error.issues[0] ?? { path: [], message: 'payload did not parse' };
  const path = (issue.path as (string | number)[]).join('.');
  throw new AppError('VALIDATION_ERROR', path ? `${path}: ${issue.message}` : issue.message, {
    needed_action: neededAction,
  });
}

/** `{project_ref}` is optional everywhere; the rule for filling it in lives here. */
async function resolveProject(
  db: DbLike,
  actor: Actor,
  ref: string | undefined,
  action: 'project:read' | 'project:write',
): Promise<string> {
  if (ref) {
    // `id::text` because a caller may pass the PRJ-key; comparing a text key to a uuid
    // column is a postgres type error, which would surface as INTERNAL rather than
    // "no such project".
    const found = await sql<{ id: string }>`
      SELECT id::text AS id FROM projects
      WHERE organization_id = ${actor.organizationId} AND (id::text = ${ref} OR key = ${ref})
    `.execute(db as never);
    const row = found.rows[0];
    if (!row) {
      throw new AppError('NOT_FOUND', `no project '${ref}' in this organisation`, {
        ref,
        needed_action: 'the key may only touch the projects it is bound to',
      });
    }
    await assertProjectAccess(db as Db, actor, row.id, action);
    return row.id;
  }
  if (actor.projectIds && actor.projectIds.length === 1) {
    await assertProjectAccess(db as Db, actor, actor.projectIds[0], action);
    return actor.projectIds[0];
  }
  throw new AppError('VALIDATION_ERROR', 'the ledger needs one project to write into', {
    needed_action: 'pass project_ref (id or PRJ-key), or bind the API key to a single project',
  });
}

/**
 * A task code is unique per project, not per org, so `T-004` alone can name several
 * tasks. Resolving it by project is fine; guessing between two projects is not.
 */
async function projectForTask(db: DbLike, actor: Actor, taskRef: string, explicit?: string): Promise<string> {
  if (explicit) return resolveProject(db, actor, explicit, 'project:read');
  const rows = await sql<{ project_id: string }>`
    SELECT project_id::text AS project_id FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND (code = ${taskRef} OR id::text = ${taskRef})
  `.execute(db as never);
  const found = [...new Set(rows.rows.map((r) => r.project_id))];
  const narrowed = actor.projectIds ? found.filter((p) => actor.projectIds?.includes(p)) : found;
  if (narrowed.length === 1) return narrowed[0];
  if (!narrowed.length) {
    throw new AppError('NOT_FOUND', `no ledger task '${taskRef}' you may write to`, {
      ref: taskRef,
      needed_action: 'exec_task_start creates the task; ledger_status without task_ref lists what exists',
    });
  }
  throw new AppError('VALIDATION_ERROR', `'${taskRef}' names a task in ${narrowed.length} projects`, {
    needed_action: 'pass project_ref to pick one',
  });
}

function ledgerActor(actor: Actor, projectId: string, tool: string): LedgerActor {
  return {
    organizationId: actor.organizationId,
    projectId,
    actorType: actor.type === 'agent' ? 'agent' : 'human',
    actorId: actor.id,
    tool,
  };
}

function auditIn(
  tx: DbLike,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  summary: unknown,
): Promise<string> {
  return recordAudit(tx, {
    organization_id: actor.organizationId,
    actor_type: actor.type === 'agent' ? 'agent' : 'user',
    actor_id: actor.id,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    summary,
    request_id: actor.requestId,
  });
}

export interface TaskStartOutcome {
  pending?: true;
  approval_request_id?: string;
  task_id?: string;
  code?: string;
  replayed?: boolean;
  [key: string]: unknown;
}

/**
 * `exec_task_start` — work item + ledger task + criteria + audit + event in ONE
 * transaction (B.4). When the approval policy says an agent may not create this work
 * item unsupervised, **nothing** is written: the ledger must not record work that has
 * not been allowed, so the gate is consulted before the transaction opens.
 */
export async function startTask(db: Db, actor: Actor, raw: unknown): Promise<TaskStartOutcome> {
  const parsed = parseTaskStart(raw ?? {});
  if (!parsed.ok) {
    throw new AppError('VALIDATION_ERROR', parsed.message, { needed_action: parsed.needed_action });
  }
  // Law before gate: a payload that cannot be executed must not cost a human an
  // approval request. `createTask` checks again — defence in depth, not a second rule.
  const laws = checkCriteria(parsed.value.criteria);
  if (!laws.ok) {
    throw new AppError('CRITERION_NOT_CHECKABLE', laws.message, {
      needed_action: laws.needed_action,
      examples: laws.examples,
      criteria: laws.bad,
    });
  }
  const projectId = await resolveProject(db, actor, parsed.value.projectRef, 'project:write');
  const gate = await gateAgentOperation(db, actor, projectId, 'work_item.create', {
    item_type: 'task',
    priority: 'none',
  });
  if (gate) return { ...gate };

  const key = parsed.value.idempotencyKey;
  if (key) {
    const begin = await beginIdempotency(db, actor.id, 'exec_task_start', key, raw);
    if (begin.kind === 'replay') return { ...(begin.response as object), replayed: true };
  }

  let created: TaskStartOutcome = {};
  try {
    await unitOfWork(db, async ({ tx }) => {
      const states = await ensureWorkflow(tx as never, projectId, actor.organizationId);
      const first = states.slice().sort((a, b) => Number(a.position) - Number(b.position))[0];
      if (!first) throw new AppError('INTERNAL', 'project has no workflow states after ensureWorkflow');
      const number = await allocateNumber(tx as never, projectId);
      const workItemId = await insertWorkItem(
        tx as never,
        {
          organization_id: actor.organizationId,
          project_id: projectId,
          type: 'task',
          title: parsed.value.title,
          description: parsed.value.description,
          state_id: first.id,
          acceptance_criteria: parsed.value.criteria,
          // `work_items.source` is a closed CHECK list ('manual','planner','…'):
          // 'exec_ledger' would need a migration, and provenance is not what PE-2 was
          // asked to add. The ledger side of the same task carries the real story.
          source: 'manual',
          number,
        } as never,
      );
      const row = await createTask(tx, ledgerActor(actor, projectId, 'exec_task_start'), workItemId, raw);
      await auditIn(tx, actor, 'exec.task_start', 'exec_task', row.task_id, {
        code: row.code,
        work_item_id: row.work_item_id,
        criteria: row.criterion_codes,
        req_ids: row.req_ids,
        allowed_paths: row.allowed_paths,
      });
      created = { ...row };
      if (key) await storeIdempotencyResult(tx, actor.id, 'exec_task_start', key, created, 200);
    });
  } catch (err) {
    if (key) await abandonIdempotency(db, actor.id, 'exec_task_start', key);
    throw err;
  }
  return created;
}

/** `ledger_add_open_item` — the filing law (defaults, dedup, blocking reason) is the service's. */
export async function addOpenItem(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<z.infer<typeof openItemToolSchema>>(
    openItemToolSchema,
    raw,
    'send { task_ref, title, type } — title ≥ 5 chars, type from the ledger enum',
  );
  const projectId = await projectForTask(db, actor, tool.task_ref, tool.project_ref);
  const { task_ref: _taskRef, project_ref: _projectRef, ...item } = tool;
  void _taskRef;
  void _projectRef;
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await createOpenItem(tx, ledgerActor(actor, projectId, 'ledger_add_open_item'), tool.task_ref, item);
    await auditIn(tx, actor, 'exec.open_item.add', 'exec_open_item', row.id, {
      code: row.code,
      task: row.task_id,
      type: row.type,
      blocks_completion: row.blocks_completion,
    });
    out = row;
  });
  return out;
}

/** `ledger_resolve_item` — an agent may not soft-close a blocking item (A.3, tool shape). */
export async function resolveItem(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<z.infer<typeof resolveToolSchema>>(
    resolveToolSchema,
    raw,
    'send { task_ref, item_ref, status, note } — note ≥ 20 chars',
  );
  const projectId = await projectForTask(db, actor, tool.task_ref, tool.project_ref);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await resolveOpenItem(tx, ledgerActor(actor, projectId, 'ledger_resolve_item'), tool.task_ref, {
      item_ref: tool.item_ref,
      status: tool.status,
      note: tool.note,
    });
    await auditIn(tx, actor, 'exec.open_item.resolve', 'exec_open_item', row.id, {
      code: row.code,
      status: row.status,
      by: row.resolved_by,
    });
    out = row;
  });
  return out;
}

/** `ledger_list_open` — active first, then history (the order the panel will reuse). */
export async function listOpen(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<z.infer<typeof listToolSchema>>(
    listToolSchema,
    raw,
    'send { task_ref } (T-NNN or the task id)',
  );
  const projectId = await projectForTask(db, actor, tool.task_ref, tool.project_ref);
  const found = await sql<{ id: string; code: string }>`
    SELECT id::text AS id, code FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId}
      AND (code = ${tool.task_ref} OR id::text = ${tool.task_ref})
  `.execute(db as never);
  const task = found.rows[0];
  if (!task) throw new AppError('NOT_FOUND', `no ledger task '${tool.task_ref}' in this project`);
  const items = await listTaskItems(db, task.id, { activeOnly: tool.active_only });
  return { task_ref: task.code, count: items.length, items };
}

/** `exec_ledger_status` (B.5, and the tool half of A.1) — the shared projection over real rows. */
export async function ledgerStatus(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<z.infer<typeof statusToolSchema>>(
    statusToolSchema,
    raw,
    'send {} , { project_ref } or { task_ref }',
  );
  const projectId = tool.task_ref
    ? await projectForTask(db, actor, tool.task_ref, tool.project_ref)
    : await resolveProject(db, actor, tool.project_ref, 'project:read');
  return loadLedgerStatus(db, { organizationId: actor.organizationId, projectId }, tool.task_ref);
}
