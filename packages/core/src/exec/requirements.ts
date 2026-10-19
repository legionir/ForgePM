import { sql } from 'kysely';
import { AppError, assessCheckable, requirementInputSchema, type RequirementInput } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { createOpenItem, findTaskByRef, type LedgerActor } from './open-items-service';

export interface RequirementRow {
  id: string;
  code: string;
  project_id: string | null;
  text: string;
  quote: string;
  source: string;
  source_ref: string | null;
  kind: string;
  priority: string;
  status: string;
}

export interface RequirementTaskRef {
  id: string;
  code: string;
  status: string;
  work_item_id: string;
}

export interface RequirementChangeResult {
  id: string;
  code: string;
  status: 'changed';
  revisited_criteria: string[];
  stale_evidence: string[];
  revisited_decisions: string[];
  reopened_tasks: string[];
  blocker_items: string[];
}

function parseRequirement(raw: unknown): RequirementInput {
  const parsed = requirementInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('UNPROCESSABLE', `${issue?.path.join('.') || 'requirement'}: ${issue?.message ?? 'invalid requirement'}`, {
      needed_action: 'quote an exact excerpt and send a measurable requirement with a readable reference',
    });
  }
  const check = assessCheckable(parsed.data.text);
  if (!check.ok) {
    throw new AppError('UNPROCESSABLE', `requirement is not checkable: ${check.errors.join(', ')}`, {
      needed_action: check.needed_action ?? 'rewrite as an observable outcome and include a test, file, or other readable reference',
      examples: check.examples,
    });
  }
  return parsed.data;
}

function assertSourceActor(actor: LedgerActor, source: RequirementInput['source']): void {
  if (source === 'human' && actor.actorType !== 'human') {
    throw new AppError('FORBIDDEN', "an agent may not record a requirement as source='human'", {
      needed_action: 'use source=user_message, doc, or agent_derived with the evidence that supports it',
    });
  }
}

async function resolveContradictions(db: DbLike, actor: LedgerActor, refs: string[]): Promise<{ id: string; code: string }[]> {
  if (!refs.length) return [];
  const rows = await sql<{ id: string; code: string }>`
    SELECT id::text AS id, code FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}::uuid
      AND (project_id = ${actor.projectId}::uuid OR project_id IS NULL)
      AND (code = ANY(${refs}::text[]) OR id::text = ANY(${refs}::text[]))
  `.execute(db as never);
  const found = new Map(rows.rows.flatMap((row) => [[row.code, row], [row.id, row]] as const));
  const missing = refs.filter((ref) => !found.has(ref));
  if (missing.length) throw new AppError('NOT_FOUND', `no requirement '${missing[0]}' to contradict`, { missing });
  return [...new Map(refs.map((ref) => found.get(ref)!).map((row) => [row.id, row])).values()];
}

export async function addRequirement(db: DbLike, actor: LedgerActor, raw: unknown): Promise<RequirementRow & { contradicts: string[] }> {
  const value = parseRequirement(raw);
  assertSourceActor(actor, value.source);
  const contradicts = await resolveContradictions(db, actor, value.contradicts);
  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'REQ', actor.organizationId);
  await sql`
    INSERT INTO exec_requirements
      (id, organization_id, project_id, code, text, quote, source, source_ref, kind, priority)
    VALUES (${id}::uuid, ${actor.organizationId}::uuid, ${actor.projectId}::uuid, ${code},
      ${value.text}, ${value.quote}, ${value.source}, ${value.source_ref ?? null}, ${value.kind}, ${value.priority})
  `.execute(db as never);
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: null,
    entity: 'requirement',
    entity_id: id,
    entity_code: code,
    action: 'requirement.added',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { before: null, after: { ...value, contradicts: contradicts.map((row) => row.code) } },
  });
  return {
    id,
    code,
    project_id: actor.projectId,
    text: value.text,
    quote: value.quote,
    source: value.source,
    source_ref: value.source_ref ?? null,
    kind: value.kind,
    priority: value.priority,
    status: 'active',
    contradicts: contradicts.map((row) => row.code),
  };
}

/** Assigned means declared at task creation or linked by a criterion; only the latter is gate coverage. */
export async function listUnassignedRequirements(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
): Promise<{ id: string; code: string; text: string; status: string }[]> {
  const rows = await sql<{ id: string; code: string; text: string; status: string }>`
    SELECT r.id::text AS id, r.code, r.text, r.status
    FROM exec_requirements r
    WHERE r.organization_id = ${actor.organizationId}::uuid
      AND (r.project_id = ${actor.projectId}::uuid OR r.project_id IS NULL)
      AND r.status <> 'dropped'
      AND NOT EXISTS (
        SELECT 1 FROM exec_tasks t
        WHERE t.organization_id = r.organization_id AND t.project_id = ${actor.projectId}::uuid
          AND (
            EXISTS (
              SELECT 1 FROM exec_events e
              WHERE e.task_id = t.id AND e.action = 'task.created'
                AND (COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? r.code
                  OR COALESCE(e.payload #> '{after,req_ids}', '[]'::jsonb) ? r.id::text)
            )
            OR EXISTS (SELECT 1 FROM exec_criteria c WHERE c.task_id = t.id AND c.req_id = r.id)
          )
      )
    ORDER BY r.code
  `.execute(db as never);
  return rows.rows;
}

export async function assertRequirementsAssigned(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  refs: string[],
): Promise<void> {
  const assignedByStart = new Set(refs);
  const unassigned = await listUnassignedRequirements(db, actor);
  const missing = unassigned.filter((row) => !assignedByStart.has(row.id) && !assignedByStart.has(row.code));
  if (missing.length) {
    throw new AppError('REQUIREMENT_UNCOVERED', `active requirement ${missing[0].code} has no task`, {
      uncovered: missing.map((row) => row.code),
      needed_action: 'include every unassigned REQ code in req_ids when creating a task, then use req_link_task to link its acceptance criterion; declarations do not satisfy gate coverage',
    });
  }
}

export async function linkRequirement(
  db: DbLike,
  actor: LedgerActor,
  requirementRef: string,
  taskRef: string,
  criterionRefs: string[],
): Promise<{ requirement_id: string; requirement: string; task: string; criteria: string[]; already_linked: string[] }> {
  const requirement = await sql<{ id: string; code: string; status: string }>`
    SELECT id::text AS id, code, status FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}::uuid
      AND (project_id = ${actor.projectId}::uuid OR project_id IS NULL)
      AND (code = ${requirementRef} OR id::text = ${requirementRef})
    LIMIT 1
  `.execute(db as never);
  const req = requirement.rows[0];
  if (!req) throw new AppError('NOT_FOUND', `no requirement '${requirementRef}' in this project`);
  if (req.status === 'dropped') throw new AppError('LEDGER_STATE_INVALID', `requirement ${req.code} is dropped`);
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`);
  if (task.status === 'done') throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`);
  if (!criterionRefs.length) throw new AppError('VALIDATION_ERROR', 'at least one criterion_ref is required');
  const found = await sql<{ id: string; code: string; req_id: string | null }>`
    SELECT id::text AS id, code, req_id::text AS req_id FROM exec_criteria
    WHERE task_id = ${task.id}::uuid
      AND (code = ANY(${criterionRefs}::text[]) OR id::text = ANY(${criterionRefs}::text[]))
    ORDER BY code
  `.execute(db as never);
  const known = new Set(found.rows.flatMap((row) => [row.code, row.id]));
  const missing = criterionRefs.filter((ref) => !known.has(ref));
  if (missing.length) throw new AppError('NOT_FOUND', `no criterion '${missing[0]}' on task ${task.code}`, { missing });
  const conflict = found.rows.find((row) => row.req_id && row.req_id !== req.id);
  if (conflict) throw new AppError('CONFLICT', `criterion ${conflict.code} is already linked to another requirement`);
  const toLink = found.rows.filter((row) => !row.req_id);
  for (const criterion of toLink) {
    await sql`UPDATE exec_criteria SET req_id = ${req.id}::uuid WHERE id = ${criterion.id}::uuid`.execute(db as never);
  }
  if (toLink.length) {
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: task.id,
      entity: 'requirement',
      entity_id: req.id,
      entity_code: req.code,
      action: 'requirement.linked',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? null,
      payload: {
        task_id: task.id,
        task_code: task.code,
        criterion_ids: toLink.map((row) => row.id),
        criterion_codes: toLink.map((row) => row.code),
      },
    });
  }
  return {
    requirement_id: req.id,
    requirement: req.code,
    task: task.code,
    criteria: found.rows.map((row) => row.code),
    already_linked: found.rows.filter((row) => row.req_id === req.id).map((row) => row.code),
  };
}


interface RequirementChangeContext {
  before: RequirementRow;
  linked: RequirementTaskRef[];
  criteria: { id: string; code: string }[];
  evidence: { id: string }[];
  decisions: { id: string; code: string }[];
}

export async function changeRequirement(
  db: DbLike,
  actor: LedgerActor,
  requirementRef: string,
  raw: unknown,
): Promise<RequirementChangeResult> {
  const value = parseRequirement(raw);
  assertSourceActor(actor, value.source);
  const contradicts = await resolveContradictions(db, actor, value.contradicts);
  const context = await loadChangeContext(db, actor, requirementRef);
  await persistRequirementChange(db, context, value);
  const doneTasks = context.linked.filter((task) => task.status === 'done');
  if (doneTasks.length) await reopenTasks(db, actor.projectId, doneTasks);
  const blockerItems = await createRevisitBlockers(db, actor, context.before, value, doneTasks);
  await appendChangeEvent(db, actor, context, value, contradicts.map((row) => row.code), doneTasks, blockerItems);
  return {
    id: context.before.id,
    code: context.before.code,
    status: 'changed',
    revisited_criteria: context.criteria.map((row) => row.code),
    stale_evidence: context.evidence.map((row) => row.id),
    revisited_decisions: context.decisions.map((row) => row.code),
    reopened_tasks: doneTasks.map((task) => task.code),
    blocker_items: blockerItems,
  };
}

async function loadChangeContext(db: DbLike, actor: LedgerActor, ref: string): Promise<RequirementChangeContext> {
  const result = await sql<RequirementRow>`
    SELECT id::text AS id, code, project_id::text AS project_id, text, quote, source, source_ref, kind, priority, status
    FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}::uuid
      AND (project_id = ${actor.projectId}::uuid OR project_id IS NULL)
      AND (code = ${ref} OR id::text = ${ref})
    LIMIT 1
  `.execute(db as never);
  const before = result.rows[0];
  if (!before) throw new AppError('NOT_FOUND', `no requirement '${ref}' in this project`);
  if (before.status === 'dropped') throw new AppError('LEDGER_STATE_INVALID', `requirement ${before.code} is dropped`);
  const [linked, criteria, evidence, decisions] = await Promise.all([
    sql<RequirementTaskRef>`
      SELECT DISTINCT t.id::text AS id, t.code, t.status, w.id::text AS work_item_id
      FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id JOIN work_items w ON w.id = t.work_item_id
      WHERE c.req_id = ${before.id}::uuid AND t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${actor.projectId}::uuid ORDER BY t.code
    `.execute(db as never),
    sql<{ id: string; code: string }>`
      SELECT c.id::text AS id, c.code FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id
      WHERE c.req_id = ${before.id}::uuid AND t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${actor.projectId}::uuid ORDER BY c.code
    `.execute(db as never),
    sql<{ id: string }>`
      SELECT e.id::text AS id FROM exec_evidence e JOIN exec_criteria c ON c.id = e.criterion_id
        JOIN exec_tasks t ON t.id = c.task_id
      WHERE c.req_id = ${before.id}::uuid AND t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${actor.projectId}::uuid ORDER BY e.id
    `.execute(db as never),
    sql<{ id: string; code: string }>`
      SELECT d.id::text AS id, d.code FROM exec_decisions d JOIN exec_tasks t ON t.id = d.task_id
      WHERE d.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
        AND COALESCE(d.review_trigger->'req_codes', '[]'::jsonb) ? ${before.code}
      ORDER BY d.code
    `.execute(db as never),
  ]);
  return { before, linked: linked.rows, criteria: criteria.rows, evidence: evidence.rows, decisions: decisions.rows };
}

async function persistRequirementChange(db: DbLike, context: RequirementChangeContext, value: RequirementInput): Promise<void> {
  await sql`
    UPDATE exec_requirements
    SET text = ${value.text}, quote = ${value.quote}, source = ${value.source},
        source_ref = ${value.source_ref ?? null}, kind = ${value.kind}, priority = ${value.priority},
        status = 'changed', updated_at = now()
    WHERE id = ${context.before.id}::uuid
  `.execute(db as never);
  await sql`
    UPDATE exec_criteria SET status = 'pending', verified_at = NULL, waiver_approval_id = NULL
    WHERE req_id = ${context.before.id}::uuid
  `.execute(db as never);
  const decisionIds = context.decisions.map((decision) => decision.id);
  if (decisionIds.length) {
    await sql`UPDATE exec_decisions SET status = 'needs_revisit', updated_at = now() WHERE id = ANY(${decisionIds}::uuid[])`
      .execute(db as never);
  }
}

async function createRevisitBlockers(
  db: DbLike,
  actor: LedgerActor,
  before: RequirementRow,
  value: RequirementInput,
  tasks: RequirementTaskRef[],
): Promise<string[]> {
  const items: string[] = [];
  for (const task of tasks) {
    const item = await createOpenItem(db, actor, task.code, {
      title: `requirement ${before.code} changed; revisit ${task.code}`,
      detail: `Requirement text changed. Previous: ${before.text}\nCurrent: ${value.text}`,
      type: 'incomplete_requirement',
      blocks_completion: true,
      related_ref: `requirement-change:${before.code}:${newId()}`,
    });
    items.push(item.code);
  }
  return items;
}

async function appendChangeEvent(
  db: DbLike,
  actor: LedgerActor,
  context: RequirementChangeContext,
  value: RequirementInput,
  contradicts: string[],
  tasks: RequirementTaskRef[],
  blockerItems: string[],
): Promise<void> {
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: null,
    entity: 'requirement',
    entity_id: context.before.id,
    entity_code: context.before.code,
    action: 'requirement.changed',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { text: context.before.text, status: context.before.status },
      after: { ...value, status: 'changed', contradicts },
      affected: {
        criteria: context.criteria,
        evidence_ids: context.evidence.map((row) => row.id),
        decisions: context.decisions,
        reopened_tasks: tasks.map((task) => task.code),
        blocker_items: blockerItems,
      },
    },
  });
}

async function reopenTasks(db: DbLike, projectId: string, tasks: RequirementTaskRef[]): Promise<void> {
  const ids = tasks.map((task) => task.id);
  await sql`
    UPDATE exec_tasks SET status = 'in_progress', closed_at = NULL, gate_stamp_id = NULL,
      blocked_on_kind = NULL, blocked_on_ref = NULL, blocked_reason = NULL, unblock_condition = NULL, updated_at = now()
    WHERE id = ANY(${ids}::uuid[])
  `.execute(db as never);
  const workItemIds = tasks.map((task) => task.work_item_id);
  await sql`
    UPDATE work_items w SET state_id = s.id, updated_at = now()
    FROM workflow_states s
    WHERE w.id = ANY(${workItemIds}::uuid[]) AND s.project_id = ${projectId}::uuid AND s.category = 'started'
  `.execute(db as never);
}
