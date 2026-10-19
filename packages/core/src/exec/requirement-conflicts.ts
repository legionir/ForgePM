import { sql } from 'kysely';
import { askHuman } from './question-service';
import { createOpenItem, type LedgerActor } from './open-items-service';
import { appendEvent } from './events';
import type { DbLike } from '../db/unitOfWork';

interface ConflictPair {
  left_id: string;
  left_code: string;
  left_kind: string;
  left_priority: string;
  right_id: string;
  right_code: string;
  right_kind: string;
  right_priority: string;
}

interface TaskRow {
  id: string;
  code: string;
  status: string;
  work_item_id: string;
}

/** Explicit contradictions are stored in append-only requirement events, not inferred from agent prose. */
export async function materializeRequirementConflicts(
  db: DbLike,
  actor: LedgerActor,
): Promise<{ conflict: string; task: string; item: string; question: string }[]> {
  const pairs = await loadConflictPairs(db, actor);
  const created: { conflict: string; task: string; item: string; question: string }[] = [];
  for (const pair of pairs) {
    if (pair.left_kind !== pair.right_kind || pair.left_priority !== pair.right_priority) continue;
    const conflictRef = [pair.left_code, pair.right_code].sort().join(':');
    const tasks = await tasksForPair(db, actor, pair);
    for (const task of tasks) {
      if (await wasReported(db, task.id, conflictRef)) continue;
      if (task.status === 'done') await reopenTask(db, actor, task);
      const item = await createOpenItem(db, actor, task.code, {
        title: `requirements ${pair.left_code} and ${pair.right_code} conflict`,
        detail: `A human must resolve the explicit contradiction before completion. ${pair.left_code} conflicts with ${pair.right_code}.`,
        type: 'design_gap',
        blocks_completion: true,
        related_ref: `requirement-conflict:${conflictRef}`,
      });
      const blocking = task.status !== 'blocked' && task.status !== 'awaiting_review';
      const question = await askHuman(db, { ...actor, tool: 'req_link_task' }, {
        task_ref: task.code,
        question: `Which requirement should govern this conflict: ${pair.left_code} or ${pair.right_code}?`,
        options: [`Keep ${pair.left_code}`, `Keep ${pair.right_code}`, 'Revise both requirements'],
        recommendation: 'Revise both requirements',
        impact_per_option: [
          `The implementation follows ${pair.left_code}; ${pair.right_code} must be changed or dropped by a human.`,
          `The implementation follows ${pair.right_code}; ${pair.left_code} must be changed or dropped by a human.`,
          'Neither requirement is treated as settled until a human records revised wording for both.',
        ],
        why_it_matters: `These requirements conflict, so implementing either without a human decision could violate the other requirement.`,
        blocking,
        kind: 'generic',
      });
      await appendEvent(db, {
        organization_id: actor.organizationId,
        task_id: task.id,
        entity: 'requirement',
        entity_id: pair.left_id,
        entity_code: pair.left_code,
        action: 'requirement.conflict_reported',
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        tool: actor.tool ?? 'req_link_task',
        payload: {
          conflict_ref: conflictRef,
          requirements: [pair.left_code, pair.right_code],
          item_code: item.code,
          question_code: question.code,
        },
      });
      created.push({ conflict: conflictRef, task: task.code, item: item.code, question: question.code });
    }
  }
  return created;
}

async function loadConflictPairs(db: DbLike, actor: LedgerActor): Promise<ConflictPair[]> {
  const rows = await sql<{
    id: string;
    code: string;
    contradictions: unknown;
  }>`
    SELECT e.entity_id::text AS id, e.entity_code AS code, e.payload->'after'->'contradicts' AS contradictions
    FROM exec_events e JOIN exec_requirements r ON r.id = e.entity_id
    WHERE e.organization_id = ${actor.organizationId}::uuid
      AND (r.project_id = ${actor.projectId}::uuid OR r.project_id IS NULL) AND r.status <> 'dropped'
      AND e.action IN ('requirement.added','requirement.changed')
      AND e.entity = 'requirement'
    ORDER BY e.created_at, e.id
  `.execute(db as never);
  const latest = new Map<string, { id: string; code: string; contradictions: string[] }>();
  for (const event of rows.rows) {
    latest.set(event.code, { id: event.id, code: event.code, contradictions: stringArray(event.contradictions) });
  }
  const refs = new Map<string, { id: string; code: string }>();
  for (const source of latest.values()) {
    for (const ref of source.contradictions) {
      const [left, right] = [source.code, ref].sort();
      if (left !== right) refs.set(`${left}:${right}`, { id: source.id, code: source.code });
    }
  }
  const pairs: ConflictPair[] = [];
  for (const [key, source] of refs) {
    const [leftCode, rightCode] = key.split(':');
    const found = await sql<ConflictPair>`
      SELECT l.id::text AS left_id, l.code AS left_code, l.kind AS left_kind, l.priority AS left_priority,
             r.id::text AS right_id, r.code AS right_code, r.kind AS right_kind, r.priority AS right_priority
      FROM exec_requirements l, exec_requirements r
      WHERE l.organization_id = ${actor.organizationId}::uuid AND r.organization_id = l.organization_id
        AND l.code = ${leftCode} AND r.code = ${rightCode}
        AND (l.project_id = ${actor.projectId}::uuid OR l.project_id IS NULL)
        AND (r.project_id = ${actor.projectId}::uuid OR r.project_id IS NULL)
    `.execute(db as never);
    const pair = found.rows[0];
    if (pair && pair.left_id !== pair.right_id && source.id) pairs.push(pair);
  }
  return pairs;
}

async function tasksForPair(db: DbLike, actor: LedgerActor, pair: ConflictPair): Promise<TaskRow[]> {
  const rows = await sql<TaskRow>`
    SELECT DISTINCT t.id::text AS id, t.code, t.status, t.work_item_id::text AS work_item_id
    FROM exec_tasks t
    WHERE t.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
      AND (
        EXISTS (
          SELECT 1 FROM exec_criteria c
          WHERE c.task_id = t.id AND c.req_id IN (${pair.left_id}::uuid, ${pair.right_id}::uuid)
        )
        OR EXISTS (
          SELECT 1 FROM exec_events e
          WHERE e.task_id = t.id AND e.action = 'task.created'
            AND (COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? ${pair.left_id}
              OR COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? ${pair.left_code}
              OR COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? ${pair.right_id}
              OR COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? ${pair.right_code})
        )
      )
    ORDER BY t.code
  `.execute(db as never);
  return rows.rows;
}

async function wasReported(db: DbLike, taskId: string, conflictRef: string): Promise<boolean> {
  const row = await sql<{ id: string }>`
    SELECT id::text AS id FROM exec_events
    WHERE task_id = ${taskId}::uuid AND action = 'requirement.conflict_reported'
      AND payload->>'conflict_ref' = ${conflictRef}
    LIMIT 1
  `.execute(db as never);
  return Boolean(row.rows[0]);
}

async function reopenTask(db: DbLike, actor: LedgerActor, task: TaskRow): Promise<void> {
  await sql`
    UPDATE exec_tasks SET status = 'in_progress', closed_at = NULL, gate_stamp_id = NULL, updated_at = now()
    WHERE id = ${task.id}::uuid AND status = 'done'
  `.execute(db as never);
  await sql`
    UPDATE work_items w SET state_id = s.id, updated_at = now()
    FROM workflow_states s
    WHERE w.id = ${task.work_item_id}::uuid AND s.project_id = ${actor.projectId}::uuid AND s.category = 'started'
  `.execute(db as never);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
