import { sql } from 'kysely';
import { AppError, execLedgerReconcileInputSchema, journalDoneInputSchema, journalFailInputSchema, journalStartInputSchema } from '@forgepm/shared';
import {
  appendEvent,
  reconcileLedger,
  resolveExecReviewSource,
  settleJournalAction,
  startJournalAction,
  unitOfWork,
  type Db,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectForTask, projectRefSchema, resolveProject } from './context';

export const journalStartToolSchema = journalStartInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const journalDoneToolSchema = journalDoneInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const journalFailToolSchema = journalFailInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const execLedgerReconcileToolSchema = execLedgerReconcileInputSchema.extend({ project_ref: projectRefSchema.optional() });

export async function journalStartTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    journalStartToolSchema,
    raw,
    'send { task_ref, action, target?, idempotent, expected_effect } before performing the external action',
  );
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  const source = resolveExecReviewSource();
  if (!source?.captureJournalPreState) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: the server cannot capture the Git pre-state for this journal action', {
      needed_action: 'restore the configured read-only Git source before starting the action; do not provide a caller-authored pre_state_ref',
    });
  }
  const preStateRef = await source.captureJournalPreState();
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'journal_start');
    const row = await startJournalAction(tx, ledger, {
      task_ref: String(tool.task_ref),
      action: String(tool.action),
      target: typeof tool.target === 'string' ? tool.target : undefined,
      idempotent: Boolean(tool.idempotent),
      expected_effect: String(tool.expected_effect),
    }, preStateRef);
    await auditIn(tx, actor, 'exec.journal.start', 'exec_action_journal', row.id, {
      task: row.task_code,
      code: row.code,
      action: row.action,
      idempotent: row.idempotent,
      retry_of: row.retry_of ?? [],
    });
    out = row;
  });
  return out;
}

export async function journalDoneTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(journalDoneToolSchema, raw, 'send { journal_ref, result_ref?, note?, project_ref? } after verifying the action completed');
  const projectId = await projectForJournal(db, actor, String(tool.journal_ref), tool.project_ref as string | undefined);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'journal_done');
    const row = await settleJournalAction(tx, ledger, {
      journal_ref: String(tool.journal_ref),
      result_ref: typeof tool.result_ref === 'string' ? tool.result_ref : undefined,
      note: typeof tool.note === 'string' ? tool.note : undefined,
    }, 'done');
    await auditIn(tx, actor, 'exec.journal.done', 'exec_action_journal', row.id, {
      task: row.task_code,
      code: row.code,
      result_ref: row.result_ref ?? null,
    });
    out = row;
  });
  return out;
}

export async function journalFailTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(journalFailToolSchema, raw, 'send { journal_ref, note, result_ref?, project_ref? } to record the verified failure');
  const projectId = await projectForJournal(db, actor, String(tool.journal_ref), tool.project_ref as string | undefined);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'journal_fail');
    const row = await settleJournalAction(tx, ledger, {
      journal_ref: String(tool.journal_ref),
      result_ref: typeof tool.result_ref === 'string' ? tool.result_ref : undefined,
      note: String(tool.note),
    }, 'failed');
    await auditIn(tx, actor, 'exec.journal.fail', 'exec_action_journal', row.id, {
      task: row.task_code,
      code: row.code,
      result_ref: row.result_ref ?? null,
      note: row.note,
    });
    out = row;
  });
  return out;
}

export async function execLedgerReconcileTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(execLedgerReconcileToolSchema, raw, 'send {} or { project_ref }');
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:read');
  const ledger = ledgerActor(actor, projectId, 'exec_ledger_reconcile');
  const result = await reconcileLedger(db, ledger);
  await unitOfWork(db, async ({ tx }) => {
    await appendEvent(tx, {
      organization_id: actor.organizationId,
      task_id: null,
      entity: 'project',
      entity_id: projectId,
      action: 'ledger.reconciled',
      actor_type: ledger.actorType,
      actor_id: ledger.actorId,
      tool: 'exec_ledger_reconcile',
      payload: { counts: result.counts, truncated: result.truncated },
    });
    await auditIn(tx, actor, 'exec.ledger.reconcile', 'project', projectId, {
      counts: result.counts,
      truncated: result.truncated,
    });
  });
  return result;
}

async function projectForJournal(db: Db, actor: Actor, journalRef: string, explicit?: string): Promise<string> {
  if (explicit) return resolveProject(db, actor, explicit, 'project:write');
  const rows = await sql<{ project_id: string }>`
    SELECT DISTINCT t.project_id::text AS project_id
    FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid
      AND (j.code = ${journalRef} OR j.id::text = ${journalRef})
      ${actor.projectIds ? sql`AND t.project_id = ANY(${actor.projectIds}::uuid[])` : sql``}
  `.execute(db as never);
  const projects = [...new Set(rows.rows.map((row) => row.project_id))];
  if (!projects.length) throw new AppError('NOT_FOUND', `no journal action '${journalRef}' you may access`, { ref: journalRef });
  if (projects.length > 1) {
    throw new AppError('VALIDATION_ERROR', `'${journalRef}' names journal actions in ${projects.length} projects`, {
      needed_action: 'pass project_ref to select one project',
    });
  }
  return projects[0]!;
}
