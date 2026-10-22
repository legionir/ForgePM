import { sql } from 'kysely';
import { AppError, assessCheckable, taskStartInputSchema, type TaskStartInput } from '@forgepm/shared';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import type { DbLike } from '../db/unitOfWork';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { makeScopeManifest, type ScopeFileManifest } from './scope';
import type { LedgerActor, ParseResult } from './open-items-service';

/**
 * `exec_task_start`'s ledger half (plan §7 B.2/B.4): the task row, its acceptance
 * criteria, and the one `exec_events` row that records the creation.
 *
 * Split like the open-item service — a shape answer and a law answer are different
 * questions. `parseTaskStart` only asks whether the payload is a well-formed object;
 * `checkCriteria` asks whether each criterion is *verifiable*, which is a rule
 * (`assessCheckable` in @forgepm/shared) and not something a string can satisfy by
 * length alone. The caller owns the transaction, so work item + task + criteria +
 * audit + this event commit or roll back together (B.4).
 */

export interface TaskStartValue {
  title: string;
  description: string | null;
  criteria: string[];
  reqIds: string[];
  allowedPaths: string[];
  idempotencyKey?: string;
  projectRef?: string;
  /** Work item fields; the API resolves the refs and applies them to the work item. */
  type?: TaskStartInput['type'];
  priority?: TaskStartInput['priority'];
  milestoneRef?: string;
  featureRef?: string;
}

export interface TaskCreatedRow {
  task_id: string;
  code: string;
  title: string;
  status: string;
  work_item_id: string;
  allowed_paths: string[];
  criterion_ids: string[];
  criterion_codes: string[];
  /** Declared, not covered: rule 8 needs a verified criterion linked to the requirement. */
  req_ids: string[];
  /** Captured by the API's read-only repository adapter, never supplied by the task author. */
  start_ref: string | null;
}

export type CriteriaCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'CRITERION_NOT_CHECKABLE';
      message: string;
      needed_action: string;
      examples: string[];
      bad: { index: number; text: string; errors: string[] }[];
    };

function shapeFailure(err: { issues: { path: (string | number)[]; message: string }[] }): {
  message: string;
  needed_action: string;
} {
  const issue = err.issues[0] ?? { path: [], message: 'payload did not parse' };
  return {
    message: issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    needed_action: 'send { title, acceptance_criteria[], allowed_paths[] }; every criterion must name a check',
  };
}

/** Shape-check a task-start payload. Unknown keys are refused, not ignored. */
export function parseTaskStart(raw: unknown): ParseResult<TaskStartValue> {
  const parsed = taskStartInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const why = shapeFailure(parsed.error as never);
    return { ok: false, code: 'VALIDATION_ERROR', ...why };
  }
  const v = parsed.data as TaskStartInput;
  return {
    ok: true,
    value: {
      title: v.title,
      description: v.description ?? null,
      criteria: [...v.acceptance_criteria],
      reqIds: [...v.req_ids],
      allowedPaths: [...v.allowed_paths],
      ...(v.idempotency_key ? { idempotencyKey: v.idempotency_key } : {}),
      ...(v.project_ref ? { projectRef: v.project_ref } : {}),
      ...(v.type ? { type: v.type } : {}),
      ...(v.priority ? { priority: v.priority } : {}),
      ...(v.milestone_ref ? { milestoneRef: v.milestone_ref } : {}),
      ...(v.feature_ref ? { featureRef: v.feature_ref } : {}),
    },
  };
}

/**
 * Map `assessCheckable` onto the tool's error shape, reporting **every** bad criterion
 * at once: an agent that gets one index per round-trip fixes a 20-row list in 20
 * round-trips, which is how a rule becomes a formality.
 */
export function checkCriteria(texts: string[]): CriteriaCheck {
  const bad: { index: number; text: string; errors: string[] }[] = [];
  let action: string | null = null; // first refusal wins: one instruction, not five variants
  let examples: string[] = [];
  texts.forEach((text, index) => {
    const r = assessCheckable(text);
    if (r.ok) return;
    bad.push({ index, text, errors: r.errors });
    action ??= r.needed_action ?? 'rewrite the criterion as an observable outcome with a reference';
    examples = r.examples;
  });
  if (!bad.length) return { ok: true };
  return {
    ok: false,
    code: 'CRITERION_NOT_CHECKABLE',
    message: `${bad.length} of ${texts.length} criteria are not checkable: ${bad
      .map((b) => `#${b.index} — ${b.errors.join(', ')}`)
      .join(' | ')}`,
    needed_action: action ?? 'rewrite the criterion as an observable outcome with a reference',
    examples,
    bad,
  };
}

/** Requirements the caller claims must exist here — a typo is not a link. */
async function assertRequirementsExist(db: DbLike, actor: LedgerActor, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const found = await sql<{ id: string; code: string }>`
    SELECT id::text AS id, code FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}
      AND (project_id = ${actor.projectId} OR project_id IS NULL)
      AND (id::text = ANY(${refs}::text[]) OR code = ANY(${refs}::text[]))
  `.execute(db as never);
  const known = new Set<string>();
  for (const row of found.rows) {
    known.add(row.id);
    known.add(row.code);
  }
  const missing = refs.filter((r) => !known.has(r));
  if (missing.length) {
    throw new AppError('NOT_FOUND', `no requirement '${missing[0]}' in this project`, {
      missing,
      needed_action: 'record it with req_add first; a task may not claim a requirement that was never written down',
    });
  }
}

async function taskRow(db: DbLike, id: string): Promise<TaskCreatedRow> {
  const r = await sql<{
    id: string;
    code: string;
    title: string;
    status: string;
    work_item_id: string;
    allowed_paths: unknown;
    start_ref: string | null;
  }>`
    SELECT id, code, title, status, work_item_id::text AS work_item_id, allowed_paths, start_ref
    FROM exec_tasks WHERE id = ${id}::uuid
  `.execute(db as never);
  const row = r.rows[0];
  if (!row) throw new AppError('INTERNAL', 'task row vanished after insert');
  return {
    task_id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    work_item_id: row.work_item_id,
    allowed_paths: Array.isArray(row.allowed_paths) ? (row.allowed_paths as string[]) : [],
    start_ref: row.start_ref,
    criterion_ids: [],
    criterion_codes: [],
    req_ids: [],
  };
}

/**
 * Write the task and its criteria. `workItemId` is required by the schema
 * (`exec_tasks.work_item_id NOT NULL`), which is what keeps the ledger and the
 * board from drifting apart: a ledger task always has a work item behind it.
 */
export interface CreateTaskOptions {
  /** Server-measured commit SHA from the configured read-only Git source. */
  startRef?: string | null;
  /** Hash-only snapshot for a Git-less workspace; never accepted from task input. */
  startManifest?: ScopeFileManifest | null;
  /** Parent ledger task when this row is created by task_split. */
  parentTaskId?: string | null;
}

export async function createTask(
  db: DbLike,
  actor: LedgerActor,
  workItemId: string,
  raw: unknown,
  options: CreateTaskOptions = {},
): Promise<TaskCreatedRow> {
  const parsed = parseTaskStart(raw);
  if (!parsed.ok) throw new AppError('VALIDATION_ERROR', parsed.message, { needed_action: parsed.needed_action });
  const laws = checkCriteria(parsed.value.criteria);
  if (!laws.ok) {
    throw new AppError('CRITERION_NOT_CHECKABLE', laws.message, {
      needed_action: laws.needed_action,
      examples: laws.examples,
      criteria: laws.bad,
    });
  }
  await assertRequirementsExist(db, actor, parsed.value.reqIds);

  let startManifest: ScopeFileManifest | null = null;
  if (!options.startRef && options.startManifest) {
    try {
      startManifest = makeScopeManifest(options.startManifest.files);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'server-measured scope manifest is invalid', {
        needed_action: 'retry task creation with a stable read-only workspace snapshot',
      });
    }
    if (startManifest.hash !== options.startManifest.hash) {
      throw new AppError('VALIDATION_ERROR', 'server-measured scope manifest hash is inconsistent', {
        needed_action: 'retry task creation with a stable read-only workspace snapshot',
      });
    }
  }

  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'T');
  await sql`
    INSERT INTO exec_tasks
      (id, organization_id, project_id, work_item_id, parent_id, code, title, description, status, start_ref, allowed_paths)
    VALUES (${id}, ${actor.organizationId}, ${actor.projectId}, ${workItemId}::uuid, ${options.parentTaskId ?? null}::uuid, ${code},
            ${parsed.value.title}, ${parsed.value.description}, 'not_started', ${options.startRef ?? null},
            ${toJsonb(parsed.value.allowedPaths)}::jsonb)
  `.execute(db as never);

  const criterionIds: string[] = [];
  const criterionCodes: string[] = [];
  for (const text of parsed.value.criteria) {
    const cId = newId();
    const cCode = await allocateLedgerCode(db, actor.projectId, 'C');
    await sql`
      INSERT INTO exec_criteria (id, task_id, code, text, status)
      VALUES (${cId}, ${id}::uuid, ${cCode}, ${text}, 'pending')
    `.execute(db as never);
    criterionIds.push(cId);
    criterionCodes.push(cCode);
  }

  const row = await taskRow(db, id);
  row.criterion_ids = criterionIds;
  row.criterion_codes = criterionCodes;
  row.req_ids = parsed.value.reqIds;
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: id,
    entity: 'task',
    entity_id: id,
    entity_code: code,
    action: 'task.created',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { before: null, after: row },
  });
  if (startManifest) {
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: id,
      entity: 'task',
      entity_id: id,
      entity_code: code,
      action: 'scope.manifest_captured',
      actor_type: 'system',
      actor_id: 'exec-scope-manifest',
      tool: 'exec_task_start',
      payload: { version: 1, hash: startManifest.hash, files: startManifest.files },
    });
  }
  return row;
}
