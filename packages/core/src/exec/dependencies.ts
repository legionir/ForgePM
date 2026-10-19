import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import { findCycle } from '../graph';
import type { DbLike } from '../db/unitOfWork';
import { appendEvent } from './events';
import { findTaskByRef, type LedgerActor } from './open-items-service';

export interface DependencyRow {
  id: string;
  code: string;
  status: string;
}

export async function pendingDependencies(db: DbLike, taskId: string): Promise<DependencyRow[]> {
  const rows = await sql<DependencyRow>`
    SELECT dependency.id::text AS id, dependency.code, dependency.status
    FROM exec_task_deps d JOIN exec_tasks dependency ON dependency.id = d.depends_on_task_id
    WHERE d.task_id = ${taskId}::uuid AND dependency.status <> 'done'
    ORDER BY dependency.code
  `.execute(db as never);
  return rows.rows;
}

export async function linkTaskDependency(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  dependsOnRef: string,
): Promise<{ task: string; depends_on: string; already_linked: boolean }> {
  const task = await findTaskByRef(db, actor, taskRef);
  const dependency = await findTaskByRef(db, actor, dependsOnRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`);
  if (!dependency) throw new AppError('NOT_FOUND', `no dependency task '${dependsOnRef}' in this project`);
  if (task.id === dependency.id) {
    throw new AppError('DEPENDENCY_CYCLE', `task ${task.code} cannot depend on itself`, { cycle: [task.code, task.code] });
  }
  await assertAcyclic(db, actor, task.id, dependency.id, task.code, dependency.code);
  const inserted = await sql<{ task_id: string }>`
    INSERT INTO exec_task_deps (task_id, depends_on_task_id)
    VALUES (${task.id}::uuid, ${dependency.id}::uuid)
    ON CONFLICT (task_id, depends_on_task_id) DO NOTHING
    RETURNING task_id::text AS task_id
  `.execute(db as never);
  const alreadyLinked = inserted.rows.length === 0;
  if (!alreadyLinked) {
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: task.id,
      entity: 'dependency',
      entity_id: dependency.id,
      entity_code: dependency.code,
      action: 'task.dependency_linked',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? null,
      payload: { task: task.code, depends_on: dependency.code },
    });
  }
  if (task.status === 'in_progress' && dependency.status !== 'done') {
    await blockOnDependency(db, actor, task.id, task.code, dependency.id, dependency.code);
  }
  return { task: task.code, depends_on: dependency.code, already_linked: alreadyLinked };
}

export async function assertAcyclic(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  taskId: string,
  dependencyId: string,
  taskCode: string,
  dependencyCode: string,
): Promise<void> {
  const rows = await sql<{
    task_id: string;
    task_code: string;
    depends_on_task_id: string;
    dependency_code: string;
  }>`
    SELECT d.task_id::text AS task_id, task.code AS task_code,
      d.depends_on_task_id::text AS depends_on_task_id, dependency.code AS dependency_code
    FROM exec_task_deps d JOIN exec_tasks task ON task.id = d.task_id
      JOIN exec_tasks dependency ON dependency.id = d.depends_on_task_id
    WHERE task.organization_id = ${actor.organizationId}::uuid AND task.project_id = ${actor.projectId}::uuid
  `.execute(db as never);
  const edges: [string, string][] = rows.rows.map((row) => [row.task_id, row.depends_on_task_id]);
  const labels = new Map<string, string>([[taskId, taskCode], [dependencyId, dependencyCode]]);
  for (const row of rows.rows) {
    labels.set(row.task_id, row.task_code);
    labels.set(row.depends_on_task_id, row.dependency_code);
  }
  edges.push([taskId, dependencyId]);
  const cycle = findCycle(edges, taskId);
  if (cycle) {
    throw new AppError('DEPENDENCY_CYCLE', `dependency cycle: ${cycle.map((id) => labels.get(id) ?? id).join(' -> ')}`, {
      cycle,
      needed_action: 'remove a dependency edge so tasks do not depend on each other in a loop',
    });
  }
}

async function blockOnDependency(
  db: DbLike,
  actor: LedgerActor,
  taskId: string,
  taskCode: string,
  dependencyId: string,
  dependencyCode: string,
): Promise<void> {
  const condition = `task ${dependencyCode} must be done before ${taskCode} can continue`;
  await sql`
    UPDATE exec_tasks SET status = 'blocked', blocked_on_kind = 'task', blocked_on_ref = ${dependencyId}::uuid,
      blocked_reason = ${condition}, unblock_condition = ${condition}, updated_at = now()
    WHERE id = ${taskId}::uuid AND status = 'in_progress'
  `.execute(db as never);
  await sql`
    WITH target_state AS (
      SELECT s.id FROM workflow_states s JOIN exec_tasks t ON t.project_id = s.project_id
      WHERE t.id = ${taskId}::uuid AND s.category IN ('unstarted','backlog')
      ORDER BY CASE WHEN s.category = 'unstarted' THEN 0 ELSE 1 END LIMIT 1
    )
    UPDATE work_items w SET state_id = (SELECT id FROM target_state), updated_at = now()
    FROM exec_tasks t WHERE t.id = ${taskId}::uuid AND w.id = t.work_item_id
      AND EXISTS (SELECT 1 FROM target_state)
  `.execute(db as never);
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: taskId,
    entity: 'task',
    entity_id: taskId,
    entity_code: taskCode,
    action: 'task.blocked',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { blocked_on_kind: 'task', blocked_on_ref: dependencyId, blocked_on_code: dependencyCode, unblock_condition: condition },
  });
}
