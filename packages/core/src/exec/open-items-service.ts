import { sql } from 'kysely';
import {
  AppError,
  BLOCKING_BY_DEFAULT,
  openItemInputSchema,
  resolveItemInputSchema,
  type ExecOpenItemStatus,
} from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { dedupKey, validateNewOpenItem, validateResolution, type ResolveOutcome } from './open-items';

/**
 * Open-item write path (docs/EXECUTION_CONTROL_PLAN.md §6, acceptance A.3–A.8).
 *
 * The laws themselves live in `open-items.ts` (pure) and in 0010's CHECK
 * constraints (non-bypassable); this file is the *only* supported way to write an
 * open item, and it exists so that those laws cannot be re-implemented slightly
 * differently by each caller. Every mutation appends exactly one `exec_events`
 * row inside the same transaction (A.4) and never deletes anything (A.2):
 * a closed item is history, not trash.
 *
 * Callers own the transaction: pass a `unitOfWork` tx so ledger row + event +
 * `audit_event` commit or roll back together.
 */

export interface LedgerActor {
  organizationId: string;
  projectId: string;
  actorType: 'agent' | 'human' | 'system';
  actorId: string;
  /** The tool that asked for this, recorded verbatim in exec_events. */
  tool?: string;
}

export interface OpenItemRow {
  id: string;
  task_id: string;
  code: string;
  title: string;
  detail: string | null;
  type: string;
  blocks_completion: boolean;
  why_not_blocking: string | null;
  source: string;
  status: ExecOpenItemStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  related_ref: string | null;
}

export interface ParseOk<T> {
  ok: true;
  value: T;
}
export interface ParseFail {
  ok: false;
  code: 'VALIDATION_ERROR';
  message: string;
  needed_action: string;
}
/** Structured, never thrown: a malformed payload is an answer, not a crash (A.5). */
export type ParseResult<T> = ParseOk<T> | ParseFail;

export interface OpenItemCreateValue {
  title: string;
  detail?: string;
  type: string;
  blocks_completion?: boolean;
  why_not_blocking?: string;
  related_ref?: string;
}

export interface OpenItemResolveValue {
  item_ref: string;
  status: ExecOpenItemStatus;
  note: string;
}

const SELECT_COLS = `id, task_id, code, title, detail, type, blocks_completion, why_not_blocking,
       source, status, resolution_note, resolved_by, related_ref`;

/** Shape-check a create payload. Unknown keys are refused, not ignored. */
export function parseOpenItemCreate(raw: unknown): ParseResult<OpenItemCreateValue> {
  const parsed = openItemInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return zodFailure(parsed.error.issues[0]);
  // task_ref routes the write to a task; it is not part of the row, and the caller
  // passes it separately — so the parsed value loses it here rather than at the INSERT.
  const rest = { ...parsed.data };
  delete rest.task_ref;
  return { ok: true, value: rest };
}

/** Shape-check a resolve payload (`{ item_ref, status, note }`). */
export function parseOpenItemResolve(raw: unknown): ParseResult<OpenItemResolveValue> {
  const parsed = resolveItemInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return zodFailure(parsed.error.issues[0]);
  return { ok: true, value: parsed.data };
}

/**
 * Which `source` an actor may file an item under. 0010's CHECK allows five
 * sources; only agent and human follow from who is acting, so a system caller has
 * to say which of the three remaining roles it is writing as.
 */
export function sourceForActor(
  actorType: LedgerActor['actorType'],
  requested?: string,
): { ok: true; source: string } | { ok: false; message: string; needed_action: string } {
  if (requested) {
    const allowed = ['agent', 'exit_report', 'reviewer', 'human', 'hook'];
    if (!allowed.includes(requested)) {
      return {
        ok: false,
        message: `unknown open-item source '${requested}'`,
        needed_action: `use one of: ${allowed.join(', ')}`,
      };
    }
    if (actorType === 'agent' && requested !== 'agent' && requested !== 'exit_report' && requested !== 'reviewer') {
      return {
        ok: false,
        message: `an agent may not file an item as '${requested}'`,
        needed_action: 'file it as agent (or exit_report/reviewer when promoting a report)',
      };
    }
    return { ok: true, source: requested };
  }
  if (actorType === 'agent') return { ok: true, source: 'agent' };
  if (actorType === 'human') return { ok: true, source: 'human' };
  return {
    ok: false,
    message: 'a system actor must name the source it writes as',
    needed_action: "pass source: 'exit_report' | 'reviewer' | 'hook'",
  };
}

/** Task lookup by id or ledger code, scoped to the caller's organisation. */
export async function findTaskByRef(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  ref: string,
): Promise<{ id: string; code: string; status: string } | null> {
  const r = await sql<{ id: string; code: string; status: string }>`
    SELECT id, code, status FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND project_id = ${actor.projectId}
      AND (id::text = ${ref} OR code = ${ref})
  `.execute(db as never);
  return r.rows[0] ?? null;
}

/**
 * File an open item. Refused before any write when the rules say so: a blocking
 * item filed as non-blocking needs a reason, and an already-open item with the
 * same normalised title is a duplicate rather than a second record.
 */
export async function createOpenItem(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  raw: unknown,
  source?: string,
): Promise<OpenItemRow> {
  const parsed = parseOpenItemCreate(raw);
  if (!parsed.ok) throw validationError(parsed);
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });

  const blocks =
    parsed.value.blocks_completion ?? (BLOCKING_BY_DEFAULT as readonly string[]).includes(parsed.value.type);
  const check = validateNewOpenItem({
    type: parsed.value.type,
    title: parsed.value.title,
    blocks_completion: blocks,
    why_not_blocking: parsed.value.why_not_blocking,
    actorType: actor.actorType,
  });
  if (!check.ok) throw ruleError(check);
  const who = sourceForActor(actor.actorType, source);
  if (!who.ok) throw new AppError('VALIDATION_ERROR', who.message, { needed_action: who.needed_action });

  const key = dedupKey(parsed.value.type, parsed.value.title);
  const twin = await findByDedupKey(db, task.id, parsed.value.type, parsed.value.title);
  if (twin) {
    throw new AppError('CONFLICT', `open item '${twin.code}' already covers this`, {
      existing: twin.code,
      dedup_key: key,
      needed_action: `update or resolve ${twin.code} instead of filing it twice`,
    });
  }

  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'OI');
  await sql`
    INSERT INTO exec_open_items
      (id, organization_id, task_id, code, title, detail, type, blocks_completion, why_not_blocking, source, status, related_ref)
    VALUES
      (${id}, ${actor.organizationId}, ${task.id}, ${code}, ${parsed.value.title}, ${parsed.value.detail ?? null},
       ${parsed.value.type}, ${blocks}, ${parsed.value.why_not_blocking ?? null}, ${who.source}, 'open',
       ${parsed.value.related_ref ?? null})
  `.execute(db as never);
  const row = await readItem(db, id);
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'open_item',
    entity_id: id,
    entity_code: code,
    action: 'open_item.created',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { before: null, after: row },
  });
  return row;
}

/**
 * Move an open item to another status. The pure state machine answers first, so
 * an agent asking to `defer` a blocking item gets `LEDGER_TRANSITION_NOT_ALLOWED`
 * with the action it must take instead — and 0010's CHECK is still what makes the
 * same rule true for any other writer (A.3).
 */
export async function resolveOpenItem(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  raw: unknown,
): Promise<OpenItemRow> {
  const parsed = parseOpenItemResolve(raw);
  if (!parsed.ok) throw validationError(parsed);
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });

  const before = await findItemByRef(db, task.id, parsed.value.item_ref);
  if (!before) {
    throw new AppError('NOT_FOUND', `no open item '${parsed.value.item_ref}' on task ${task.code}`, {
      item_ref: parsed.value.item_ref,
      needed_action: 'ledger_list_open shows the codes this task has',
    });
  }
  const subject = {
    code: before.code,
    type: before.type,
    blocks_completion: before.blocks_completion,
    status: before.status,
  };
  const check = validateResolution(subject, {
    requested: parsed.value.status,
    note: parsed.value.note,
    actorType: actor.actorType,
  });
  if (!check.ok) throw ruleError(check);

  const closing = parsed.value.status !== 'open' && !ACTIVE_STATUSES.has(parsed.value.status);
  await sql`
    UPDATE exec_open_items
    SET status = ${parsed.value.status}, resolution_note = ${parsed.value.note},
        resolved_by = ${closing ? (actor.actorType === 'agent' ? 'agent' : 'human') : null},
        updated_at = now()
    WHERE id = ${before.id}
  `.execute(db as never);
  const after = await readItem(db, before.id);
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'open_item',
    entity_id: before.id,
    entity_code: before.code,
    action: closing ? 'open_item.closed' : 'open_item.reopened',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: before.status, resolution_note: before.resolution_note, resolved_by: before.resolved_by },
      after: { status: after.status, resolution_note: after.resolution_note, resolved_by: after.resolved_by },
    },
  });
  return after;
}

/** Every item of a task, active first — the order the panel and the tools show. */
export async function listTaskItems(
  db: DbLike,
  taskId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<OpenItemRow[]> {
  const active = opts.activeOnly ? sql`AND status IN ('open','blocked','awaiting_human')` : sql``;
  const r = await sql<OpenItemRow>`
    SELECT ${sql.raw(SELECT_COLS)} FROM exec_open_items
    WHERE task_id = ${taskId} ${active}
    ORDER BY (status IN ('open','blocked','awaiting_human')) DESC, code
  `.execute(db as never);
  return r.rows.map(normaliseRow);
}

async function findByDedupKey(db: DbLike, taskId: string, type: string, title: string): Promise<OpenItemRow | null> {
  const active = await listTaskItems(db, taskId, { activeOnly: true });
  const key = dedupKey(type, title);
  return active.find((row) => dedupKey(row.type, row.title) === key) ?? null;
}

async function findItemByRef(db: DbLike, taskId: string, ref: string): Promise<OpenItemRow | null> {
  const r = await sql<OpenItemRow>`
    SELECT ${sql.raw(SELECT_COLS)} FROM exec_open_items
    WHERE task_id = ${taskId} AND (id::text = ${ref} OR code = ${ref})
  `.execute(db as never);
  return r.rows[0] ? normaliseRow(r.rows[0]) : null;
}

async function readItem(db: DbLike, id: string): Promise<OpenItemRow> {
  const r = await sql<OpenItemRow>`
    SELECT ${sql.raw(SELECT_COLS)} FROM exec_open_items WHERE id = ${id}
  `.execute(db as never);
  const row = r.rows[0];
  if (!row) throw new AppError('INTERNAL', `open item ${id} vanished inside its own transaction`);
  return normaliseRow(row);
}

/** `blocks_completion` arrives as a boolean but the driver types everything as string. */
function normaliseRow(row: OpenItemRow): OpenItemRow {
  return {
    ...row,
    blocks_completion:
      row.blocks_completion === true ||
      (row.blocks_completion as unknown) === 'true' ||
      (row.blocks_completion as unknown) === 1,
  };
}

/** Statuses an item can still move out of; anything else has been closed. */
const ACTIVE_STATUSES = new Set(['open', 'blocked', 'awaiting_human']);

function validationError(fail: ParseFail): AppError {
  return new AppError('VALIDATION_ERROR', fail.message, { needed_action: fail.needed_action });
}

function ruleError(check: Extract<ResolveOutcome, { ok: false }>): AppError {
  return new AppError(check.code, check.message, { needed_action: check.needed_action });
}

function zodFailure(issue: { path: (string | number)[]; message: string } | undefined): ParseFail {
  const path = issue?.path?.filter((p) => p !== 'task_ref').join('.') ?? '';
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    message: issue ? `open-item input: ${path || '(root)'} ${issue.message}` : 'open-item input is not an object',
    needed_action: path
      ? `fix '${path}' (see docs/EXECUTION_CONTROL_PLAN.md §6 for the shape)`
      : 'send only the documented fields, with task_ref, title (>= 5 chars), type and blocks_completion',
  };
}
