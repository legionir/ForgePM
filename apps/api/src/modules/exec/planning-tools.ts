import { sql } from 'kysely';
import {
  AppError,
  linkDependencyInputSchema,
  planViewInputSchema,
  taskBlockObjectSchema,
  taskBlockRefinement,
  taskSplitInputSchema,
  taskStartCommandInputSchema,
} from '@forgepm/shared';
import {
  appendEvent,
  assertRequirementsAssigned,
  blockExecTask,
  checkCriteria,
  createTask,
  execPlanView,
  linkTaskDependency,
  parseTaskSplit,
  resolveExecReviewSource,
  startExecTask,
  unitOfWork,
  type Db,
  type ScopeFileManifest,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { allocateNumber, ensureWorkflow } from '../work-items/states';
import { insertWorkItem } from '../work-items/items-repository';
import { gateAgentOperation } from '../work-items/service';
import { auditIn, ledgerActor, parseTool, projectForTask, projectRefSchema, resolveProject } from './context';
import { resolveWorkItemLinks } from './catalog-tools';

export const taskSplitToolSchema = taskSplitInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const taskStartCommandToolSchema = taskStartCommandInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const taskBlockToolSchema = taskBlockObjectSchema
  .extend({ project_ref: projectRefSchema.optional() })
  .superRefine(taskBlockRefinement);
export const dependencyToolSchema = linkDependencyInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const planViewToolSchema = planViewInputSchema.extend({ project_ref: projectRefSchema.optional() });

export async function taskSplitTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    taskSplitToolSchema,
    raw,
    'send { parent_ref, children:[{ key, title, acceptance_criteria, allowed_paths, req_ids, depends_on }] }',
  );
  const { project_ref: projectRef, ...splitInput } = tool;
  const split = parseTaskSplit(splitInput);
  const projectId = await projectForTask(db, actor, split.parent_ref, projectRef as string | undefined);
  const parent = await taskWithWorkItem(db, actor, projectId, split.parent_ref);
  if (parent.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `parent task ${parent.code} is already closed`);
  for (const child of split.children) {
    const check = checkCriteria(child.acceptance_criteria);
    if (!check.ok) {
      throw new AppError('CRITERION_NOT_CHECKABLE', check.message, {
        needed_action: check.needed_action,
        examples: check.examples,
        criteria: check.bad,
      });
    }
  }
  const declaredReqs = split.children.flatMap((child) => child.req_ids);
  await assertRequirementsAssigned(db, { organizationId: actor.organizationId, projectId }, declaredReqs);
  const childLinks = new Map<string, { feature_id: string | null; milestone_id: string | null }>();
  for (const child of split.children) {
    childLinks.set(child.key, await resolveWorkItemLinks(db, projectId, { featureRef: child.feature_ref, milestoneRef: child.milestone_ref }));
  }
  // The gate sees the riskiest child: the highest priority and the first non-task type.
  const rank = ['none', 'low', 'medium', 'high', 'urgent'];
  const gatePriority = split.children.map((c) => c.priority ?? 'none').sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0] ?? 'none';
  const gateType = split.children.map((c) => c.type ?? 'task').find((t) => t !== 'task') ?? 'task';
  const gate = await gateAgentOperation(db, actor, projectId, 'work_item.create', { item_type: gateType, priority: gatePriority });
  if (gate) return { ...gate };
  const baseline = await captureStart();
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    await assertRequirementsAssigned(tx, { organizationId: actor.organizationId, projectId }, declaredReqs);
    const states = await ensureWorkflow(tx as never, projectId, actor.organizationId);
    const initial = states.slice().sort((a, b) => Number(a.position) - Number(b.position))[0];
    if (!initial) throw new AppError('INTERNAL', 'project has no workflow states after ensureWorkflow');
    const ledger = ledgerActor(actor, projectId, 'task_split');
    const children = [] as { key: string; task: Record<string, unknown> }[];
    for (const child of split.children) {
      const number = await allocateNumber(tx as never, projectId);
      const workItemId = await insertWorkItem(tx as never, {
        organization_id: actor.organizationId,
        project_id: projectId,
        number,
        type: child.type ?? 'task',
        priority: child.priority ?? 'none',
        feature_id: childLinks.get(child.key)?.feature_id ?? null,
        milestone_id: childLinks.get(child.key)?.milestone_id ?? null,
        title: child.title,
        description: child.description ?? null,
        state_id: initial.id,
        acceptance_criteria: child.acceptance_criteria as never,
        parent_id: parent.work_item_id,
        source: 'manual',
      });
      const task = await createTask(
        tx,
        ledger,
        workItemId,
        {
          title: child.title,
          description: child.description,
          acceptance_criteria: child.acceptance_criteria,
          req_ids: child.req_ids,
          allowed_paths: child.allowed_paths,
        },
        { ...baseline, parentTaskId: parent.id },
      );
      children.push({ key: child.key, task: task as unknown as Record<string, unknown> });
    }
    const taskCodeByKey = new Map(children.map(({ key, task }) => [key, String(task.code)]));
    const dependencyLinks: { task: string; depends_on: string; already_linked: boolean }[] = [];
    for (const child of split.children) {
      const taskCode = taskCodeByKey.get(child.key)!;
      for (const dependencyRef of child.depends_on) {
        dependencyLinks.push(
          await linkTaskDependency(tx, ledger, taskCode, taskCodeByKey.get(dependencyRef) ?? dependencyRef),
        );
      }
    }
    await appendEvent(tx, {
      organization_id: actor.organizationId,
      task_id: parent.id,
      entity: 'task',
      entity_id: parent.id,
      entity_code: parent.code,
      action: 'task.split',
      actor_type: ledger.actorType,
      actor_id: ledger.actorId,
      tool: 'task_split',
      payload: { children: children.map(({ key, task }) => ({ key, code: task.code })), dependencies: dependencyLinks },
    });
    await auditIn(tx, actor, 'exec.task.split', 'exec_task', parent.id, {
      parent: parent.code,
      children: children.map(({ key, task }) => ({ key, code: task.code })),
      dependencies: dependencyLinks,
    });
    out = { parent: parent.code, children: children.map(({ key, task }) => ({ key, ...task })), dependencies: dependencyLinks };
  });
  return out;
}

export async function taskStartCommandTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(taskStartCommandToolSchema, raw, 'send { task_ref }');
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await startExecTask(tx, ledgerActor(actor, projectId, 'task_start'), String(tool.task_ref));
    await auditIn(tx, actor, 'exec.task.start', 'exec_task', row.task_id, {
      task: row.task_code,
      status: row.status,
      pending_deps: row.pending_deps ?? [],
    });
    out = row;
  });
  return out;
}

export async function taskBlockTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(taskBlockToolSchema, raw, 'send { task_ref, reason, blocked_on_kind, blocked_on_ref, unblock_condition }');
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  const { project_ref: _projectRef, ...payload } = tool;
  void _projectRef;
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await blockExecTask(tx, ledgerActor(actor, projectId, 'task_block'), payload);
    await auditIn(tx, actor, 'exec.task.block', 'exec_task', row.task_id, {
      task: row.task_code,
      status: row.status,
      blocked_on_kind: row.blocked_on_kind,
    });
    out = row;
  });
  return out;
}

export async function taskDependencyTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(dependencyToolSchema, raw, 'send { task_ref, depends_on_ref }');
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  const task = await taskWithWorkItem(db, actor, projectId, String(tool.task_ref));
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await linkTaskDependency(
      tx,
      ledgerActor(actor, projectId, 'task_link_dependency'),
      String(tool.task_ref),
      String(tool.depends_on_ref),
    );
    await auditIn(tx, actor, 'exec.task.dependency_link', 'exec_task', task.id, row);
    out = row;
  });
  return out;
}

export async function execPlanViewTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(planViewToolSchema, raw, 'send {} or { task_ref, project_ref }');
  const projectId = tool.task_ref
    ? await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined)
    : await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:read');
  return execPlanView(db, ledgerActor(actor, projectId, 'exec_plan_view'), tool.task_ref as string | undefined);
}

async function taskWithWorkItem(db: Db, actor: Actor, projectId: string, ref: string) {
  const task = await sql<{ id: string; code: string; status: string; work_item_id: string }>`
    SELECT id::text AS id, code, status, work_item_id::text AS work_item_id FROM exec_tasks
    WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${projectId}::uuid
      AND (code = ${ref} OR id::text = ${ref}) LIMIT 1
  `.execute(db as never);
  const row = task.rows[0];
  if (!row) throw new AppError('NOT_FOUND', `no task '${ref}' in this project`);
  return row;
}

async function captureStart(): Promise<{ startRef: string | null; startManifest: ScopeFileManifest | null }> {
  const source = resolveExecReviewSource();
  let startRef: string | null = null;
  let startManifest: ScopeFileManifest | null = null;
  try {
    const sha = await source?.headSha?.();
    startRef = typeof sha === 'string' && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    startRef = null;
  }
  if (!startRef && source?.fileManifest) {
    try {
      startManifest = await source.fileManifest();
    } catch {
      startManifest = null;
    }
  }
  return { startRef, startManifest };
}
