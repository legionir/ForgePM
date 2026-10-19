import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import { findCycle } from '../graph';
import type { DbLike } from '../db/unitOfWork';
import { findTaskByRef, type LedgerActor } from './open-items-service';
import { requirementCoverage } from './requirement-coverage';

export interface PlanTaskNode {
  id: string;
  code: string;
  title: string;
  status: string;
  display_status: string;
  parent_id: string | null;
  blocked_on: { kind: string; ref: string | null; reason: string | null; unblock_condition: string | null } | null;
  depends_on: { id: string; code: string; status: string }[];
  declared_req_ids: string[];
  criteria: { code: string; req_code: string | null; status: string }[];
  canceled_by_human: boolean;
  children: PlanTaskNode[];
}

interface TaskRow {
  id: string;
  code: string;
  title: string;
  status: string;
  parent_id: string | null;
  blocked_on_kind: string | null;
  blocked_on_ref: string | null;
  blocked_reason: string | null;
  unblock_condition: string | null;
}

interface PlanFacts {
  tasks: TaskRow[];
  dependencies: { task_id: string; id: string; code: string; status: string }[];
  declarations: { task_id: string; req_ids: unknown }[];
  criteria: { task_id: string; code: string; req_code: string | null; status: string }[];
  cancellations: { child_id: string; waiver: string | null }[];
}

export async function execPlanView(
  db: DbLike,
  actor: LedgerActor,
  taskRef?: string,
): Promise<{ project_id: string; roots: PlanTaskNode[]; task_count: number; requirements: Awaited<ReturnType<typeof requirementCoverage>> }> {
  if (taskRef && !(await findTaskByRef(db, actor, taskRef))) {
    throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`);
  }
  const facts = await loadPlanFacts(db, actor);
  const requirements = await requirementCoverage(db, actor);
  const roots = buildPlanTree(facts);
  return { project_id: actor.projectId, roots, task_count: facts.tasks.length, requirements };
}

async function loadPlanFacts(db: DbLike, actor: LedgerActor): Promise<PlanFacts> {
  const tasks = await sql<TaskRow>`
    SELECT id::text AS id, code, title, status, parent_id::text AS parent_id,
      blocked_on_kind, blocked_on_ref::text AS blocked_on_ref, blocked_reason, unblock_condition
    FROM exec_tasks
    WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
    ORDER BY code
  `.execute(db as never);
  const ids = tasks.rows.map((task) => task.id);
  if (!ids.length) return { tasks: [], dependencies: [], declarations: [], criteria: [], cancellations: [] };
  const [dependencies, declarations, criteria, cancellations] = await Promise.all([
    sql<{ task_id: string; id: string; code: string; status: string }>`
      SELECT d.task_id::text AS task_id, dependency.id::text AS id, dependency.code, dependency.status
      FROM exec_task_deps d JOIN exec_tasks dependency ON dependency.id = d.depends_on_task_id
      WHERE d.task_id = ANY(${ids}::uuid[]) ORDER BY d.task_id, dependency.code
    `.execute(db as never),
    sql<{ task_id: string; req_ids: unknown }>`
      SELECT e.task_id::text AS task_id, e.payload #> '{after,req_ids}' AS req_ids
      FROM exec_events e WHERE e.task_id = ANY(${ids}::uuid[]) AND e.action = 'task.created'
      ORDER BY e.created_at, e.id
    `.execute(db as never),
    sql<{ task_id: string; code: string; req_code: string | null; status: string }>`
      SELECT c.task_id::text AS task_id, c.code, r.code AS req_code, c.status
      FROM exec_criteria c LEFT JOIN exec_requirements r ON r.id = c.req_id
      WHERE c.task_id = ANY(${ids}::uuid[]) ORDER BY c.task_id, c.code
    `.execute(db as never),
    sql<{ child_id: string; waiver: string | null }>`
      SELECT e.entity_id::text AS child_id, e.payload->>'waiver' AS waiver
      FROM exec_events e JOIN exec_tasks parent ON parent.id = e.task_id
      WHERE parent.organization_id = ${actor.organizationId}::uuid AND parent.project_id = ${actor.projectId}::uuid
        AND e.action = 'task.waived' AND e.actor_type = 'human'
      ORDER BY e.created_at, e.id
    `.execute(db as never),
  ]);
  return {
    tasks: tasks.rows,
    dependencies: dependencies.rows,
    declarations: declarations.rows,
    criteria: criteria.rows,
    cancellations: cancellations.rows,
  };
}

export function buildPlanTree(facts: PlanFacts): PlanTaskNode[] {
  const parentEdges = facts.tasks.flatMap((task): [string, string][] => task.parent_id ? [[task.id, task.parent_id]] : []);
  for (const task of facts.tasks) {
    const cycle = findCycle(parentEdges, task.id);
    if (cycle) throw new AppError('DEPENDENCY_CYCLE', `task parent cycle: ${cycle.join(' -> ')}`, { cycle });
  }
  const byId = new Map(facts.tasks.map((task) => [task.id, createNode(task, facts)]));
  const roots: PlanTaskNode[] = [];
  for (const task of facts.tasks) {
    const node = byId.get(task.id)!;
    const parent = task.parent_id ? byId.get(task.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  sortTree(roots);
  return roots;
}

function createNode(task: TaskRow, facts: PlanFacts): PlanTaskNode {
  const canceled = facts.cancellations.some((event) => event.child_id === task.id && event.waiver === `cancel:${task.code}`);
  const taskDependencies = facts.dependencies
    .filter((dependency) => dependency.task_id === task.id)
    .map(({ id, code, status }) => ({ id, code, status }));
  const declarations = facts.declarations
    .filter((event) => event.task_id === task.id)
    .flatMap((event) => readStringArray(event.req_ids));
  const criteria = facts.criteria
    .filter((criterion) => criterion.task_id === task.id)
    .map(({ code, req_code, status }) => ({ code, req_code, status }));
  return {
    id: task.id,
    code: task.code,
    title: task.title,
    status: task.status,
    display_status: displayStatus(task.status, canceled),
    parent_id: task.parent_id,
    blocked_on: task.blocked_on_kind
      ? {
          kind: task.blocked_on_kind,
          ref: task.blocked_on_ref,
          reason: task.blocked_reason,
          unblock_condition: task.unblock_condition,
        }
      : null,
    depends_on: taskDependencies,
    declared_req_ids: [...new Set(declarations)].sort(),
    criteria,
    canceled_by_human: canceled,
    children: [],
  };
}

function displayStatus(status: string, canceled: boolean): string {
  if (canceled) return 'canceled';
  if (status === 'awaiting_review') return 'awaiting_human';
  return status;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function sortTree(nodes: PlanTaskNode[]): void {
  nodes.sort((left, right) => left.code.localeCompare(right.code));
  for (const node of nodes) sortTree(node.children);
}
