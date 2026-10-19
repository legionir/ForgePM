import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { throwIfJournalLocked, journalWriteLock, type JournalRetryIntent, type JournalRow } from './journal';
import { findTaskByRef, type LedgerActor } from './open-items-service';

export interface JournalStartValue {
  task_ref: string;
  action: string;
  target?: string;
  idempotent: boolean;
  expected_effect: string;
}

export interface JournalSettleValue {
  journal_ref: string;
  result_ref?: string;
  note?: string;
}

export interface JournalEntryResult {
  id: string;
  code: string;
  task_id: string;
  task_code: string;
  action: string;
  target: string | null;
  idempotent: boolean;
  status: 'started' | 'done' | 'failed';
  started_at?: Date | string;
  finished_at?: Date | string;
  result_ref?: string | null;
  note?: string | null;
  retry_of?: string[];
}

/**
 * Write the journal row before an external action starts. `preStateRef` is
 * captured by the API's fixed, read-only Git adapter, never accepted from the
 * agent. The caller owns the transaction so the row, event and audit commit
 * together.
 */
export async function startJournalAction(
  db: DbLike,
  actor: LedgerActor,
  input: JournalStartValue,
  preStateRef: string,
): Promise<JournalEntryResult> {
  const task = await findTaskByRef(db, actor, input.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${input.task_ref}' in this project`, { ref: input.task_ref });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is closed; start a new task before journaling an action`);
  }
  if (!preStateRef || preStateRef.length > 2_100_000) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'the server could not capture a bounded pre-action Git state', {
      needed_action: 'restore read-only Git access to the configured worktree before starting this action',
    });
  }

  const unresolved = await sql<JournalRow & { target: string | null }>`
    SELECT j.code, j.task_id::text AS task_id, j.action, j.target, j.expected_effect, j.idempotent, j.status
    FROM exec_action_journal j
    JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid
      AND t.project_id = ${actor.projectId}::uuid
      AND j.status IN ('started','unknown')
    ORDER BY j.started_at, j.code
  `.execute(db as never);
  const retryIntent: JournalRetryIntent = {
    task_id: task.id,
    action: input.action,
    target: input.target ?? null,
    expected_effect: input.expected_effect,
    idempotent: input.idempotent,
  };
  const lock = journalWriteLock({
    tool: 'journal_start',
    actorType: actor.actorType,
    openRows: unresolved.rows,
    retryIntent,
  });
  throwIfJournalLocked(lock);

  const code = await allocateLedgerCode(db, actor.projectId, 'AJ', actor.organizationId);
  const id = newId();
  const inserted = await sql<{
    id: string;
    started_at: Date;
  }>`
    INSERT INTO exec_action_journal (
      id, organization_id, task_id, code, action, target, idempotent,
      expected_effect, pre_state_ref, status
    ) VALUES (
      ${id}::uuid, ${actor.organizationId}::uuid, ${task.id}::uuid, ${code}, ${input.action},
      ${input.target ?? null}, ${input.idempotent}, ${input.expected_effect}, ${preStateRef}, 'started'
    )
    RETURNING id::text AS id, started_at
  `.execute(db as never);

  const retryOf = lock.retry_of ?? [];
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'journal',
    entity_id: id,
    entity_code: code,
    action: retryOf.length ? 'journal.retry_started' : 'journal.started',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? 'journal_start',
    payload: {
      action: input.action,
      target: input.target ?? null,
      idempotent: input.idempotent,
      expected_effect: input.expected_effect,
      ...(retryOf.length ? { retry_of: retryOf, idempotent_retry: true } : {}),
    },
  });

  return {
    id: inserted.rows[0]?.id ?? id,
    code,
    task_id: task.id,
    task_code: task.code,
    action: input.action,
    target: input.target ?? null,
    idempotent: input.idempotent,
    status: 'started',
    started_at: inserted.rows[0]?.started_at,
    ...(retryOf.length ? { retry_of: retryOf } : {}),
  };
}

export async function settleJournalAction(
  db: DbLike,
  actor: LedgerActor,
  input: JournalSettleValue,
  status: 'done' | 'failed',
): Promise<JournalEntryResult> {
  const found = await sql<{
    id: string;
    code: string;
    task_id: string;
    task_code: string;
    status: string;
    action: string;
    target: string | null;
    idempotent: boolean;
  }>`
    SELECT j.id::text AS id, j.code, j.task_id::text AS task_id, t.code AS task_code,
      j.status, j.action, j.target, j.idempotent
    FROM exec_action_journal j
    JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid
      AND t.project_id = ${actor.projectId}::uuid
      AND (j.code = ${input.journal_ref} OR j.id::text = ${input.journal_ref})
  `.execute(db as never);
  const row = found.rows[0];
  if (!row) throw new AppError('NOT_FOUND', `no journal action '${input.journal_ref}' in this project`, { ref: input.journal_ref });
  if (row.status !== 'started' && row.status !== 'unknown') {
    throw new AppError('LEDGER_STATE_INVALID', `journal action ${row.code} is already settled (${row.status})`, {
      needed_action: 'journal rows settle once; inspect the existing result rather than rewriting it',
    });
  }

  const updated = await sql<{ finished_at: Date }>`
    UPDATE exec_action_journal
    SET status = ${status}, finished_at = now(), result_ref = ${input.result_ref ?? null},
        note = ${input.note ?? null}
    WHERE id = ${row.id}::uuid AND status IN ('started','unknown')
    RETURNING finished_at
  `.execute(db as never);
  if (!updated.rows[0]) {
    throw new AppError('LEDGER_STATE_INVALID', `journal action ${row.code} changed while it was being settled`);
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: row.task_id,
    entity: 'journal',
    entity_id: row.id,
    entity_code: row.code,
    action: status === 'done' ? 'journal.done' : 'journal.failed',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? (status === 'done' ? 'journal_done' : 'journal_fail'),
    payload: {
      previous_status: row.status,
      status,
      result_ref: input.result_ref ?? null,
      note: input.note ?? null,
    },
  });
  return {
    id: row.id,
    code: row.code,
    task_id: row.task_id,
    task_code: row.task_code,
    action: row.action,
    target: row.target,
    idempotent: row.idempotent,
    status,
    finished_at: updated.rows[0].finished_at,
    result_ref: input.result_ref ?? null,
    note: input.note ?? null,
  };
}

/** Read unresolved rows for transaction-level recovery-exception checks. */
export async function unresolvedJournalRows(
  db: DbLike,
  organizationId: string,
  projectId: string,
): Promise<JournalRow[]> {
  const rows = await sql<JournalRow>`
    SELECT j.code, j.task_id::text AS task_id, j.action, j.target, j.expected_effect, j.idempotent, j.status
    FROM exec_action_journal j
    JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${organizationId}::uuid
      AND t.project_id = ${projectId}::uuid
      AND j.status IN ('started','unknown')
    ORDER BY j.started_at, j.code
  `.execute(db as never);
  return rows.rows;
}
