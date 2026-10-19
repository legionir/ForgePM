import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { appendEvent } from './events';
import { resumeBlockedTask } from './plan';

/**
 * What a human's approval MEANS for the execution ledger (plan §9.5).
 *
 * The generic approval queue decides a row in `approval_requests`; the ledger
 * needs more than that — a decision whose approval_state stays `pending` after
 * the human said yes would keep the gate refusing forever. This is the one
 * place that translates "the human approved" into the ledger's own language.
 *
 * The translation is deliberately narrow: an `exec.decision` approval flips the
 * decision's `approval_state`, and nothing else. A question is not approved,
 * it is ANSWERED (a different route, a different verb) — and this function
 * says so rather than pretending.
 */

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalEffectInput {
  action: string;
  payload: unknown;
  decision: ApprovalDecision;
  reason?: string;
  actorId: string;
  organizationId: string;
  tool?: string;
}

export interface ApprovalEffect {
  kind: 'decision' | 'none';
  code?: string;
  task_code?: string;
}

/**
 * Record a decision the human has ALREADY made.
 *
 * The human's path is not a request and a wait: the person in front of the
 * terminal has decided, and the ledger needs a row that says so — who, when,
 * what, and why. The row is written already decided (status `approved`), and
 * the ledger's own tables point at it (a waiver's `waiver_approval_id`), so
 * an auditor can walk from the decision back to the human who made it.
 */
export async function recordHumanDecision(
  db: DbLike,
  input: {
    organizationId: string;
    projectId: string;
    actorId: string;
    action: string;
    payload: Record<string, unknown>;
    reason: string;
    risk?: 'low' | 'sensitive';
  },
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO approval_requests (id, organization_id, project_id, requested_by, action, payload, risk,
                                   status, decided_by, decided_at, reason)
    VALUES (${id}, ${input.organizationId}::uuid, ${input.projectId}::uuid, ${input.actorId}, ${input.action},
            ${toJsonb(input.payload) as never}::jsonb, ${input.risk ?? 'sensitive'}, 'approved',
            ${input.actorId}, now(), ${input.reason})
  `.execute(db as never);
  return id;
}

/**
 * The exec rows of the approvals queue, with the ledger's own names.
 *
 * The generic queue knows an approval as `{action, payload}` — for the panel
 * that is not enough: "exec.decision" says nothing about WHICH decision, and
 * a human about to approve something needs the code and the task it belongs
 * to. So this list joins the ledger's own tables and answers with the codes
 * the rest of the ledger speaks in.
 */
export interface ExecApprovalRow {
  id: string;
  action: string;
  status: string;
  risk: string;
  reason: string | null;
  decided_by: string | null;
  created_at: string;
  /** The ledger code: D-001, Q-001, C-001, REQ-001 … */
  ledger_code: string | null;
  /** The task the row belongs to (a dropped requirement belongs to none). */
  task_code: string | null;
  title: string | null;
}

export async function listExecApprovals(
  db: DbLike,
  organizationId: string,
  limit = 50,
): Promise<ExecApprovalRow[]> {
  const rows = await sql<{
    id: string;
    action: string;
    status: string;
    risk: string;
    reason: string | null;
    decided_by: string | null;
    created_at: string;
    payload: Record<string, unknown> | null;
  }>`
    SELECT id::text AS id, action, status, risk, reason, decided_by, created_at::text AS created_at, payload
    FROM approval_requests
    WHERE organization_id = ${organizationId}::uuid AND action LIKE 'exec.%'
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `.execute(db as never);

  const ids = (key: string): string[] =>
    rows.rows.map((r) => String((r.payload ?? {})[key] ?? '')).filter((v) => v.length > 0);
  const [decisions, questions, criteria, requirements, facts] = await Promise.all([
    lookup(db, 'exec_decisions', ids('decision_id')),
    lookup(db, 'exec_questions', ids('question_id')),
    lookup(db, 'exec_criteria', ids('criterion_id')),
    lookup(db, 'exec_requirements', ids('requirement_id')),
    lookup(db, 'exec_facts', ids('fact_id')),
  ]);
  // The task each row belongs to: a decision, a question and a criterion live
  // on a task; a dropped requirement and a promoted fact belong to none.
  const owners = await taskOfRows(db, ids('decision_id').concat(ids('question_id')).concat(ids('criterion_id')));
  const tasks = await taskById(db, ids('task_id'));

  return rows.rows.map((row) => {
    const payload = row.payload ?? {};
    const decision = decisions.get(String(payload.decision_id ?? ''));
    const question = questions.get(String(payload.question_id ?? ''));
    const criterion = criteria.get(String(payload.criterion_id ?? ''));
    const requirement = requirements.get(String(payload.requirement_id ?? ''));
    const fact = facts.get(String(payload.fact_id ?? ''));
    const ledger = decision ?? question ?? criterion ?? requirement ?? fact ?? null;
    const owner = String(payload.decision_id ?? payload.question_id ?? payload.criterion_id ?? '');
    const scopeTask = String(payload.task_id ?? '');
    return {
      id: row.id,
      action: row.action,
      status: row.status,
      risk: row.risk,
      reason: row.reason,
      decided_by: row.decided_by,
      created_at: row.created_at,
      ledger_code: ledger?.code ?? (scopeTask ? (tasks.get(scopeTask)?.code ?? null) : null),
      task_code: scopeTask
        ? (tasks.get(scopeTask)?.code ?? null)
        : owner
          ? (owners.get(owner) ?? null)
          : null,
      title: ledger?.title ?? null,
    };
  });
}

interface LedgerNamed {
  id: string;
  code: string;
  title: string | null;
}

/** The rows of one ledger table, by id — the tables differ only in their title. */
async function lookup(db: DbLike, table: string, ids: string[]): Promise<Map<string, LedgerNamed>> {
  const out = new Map<string, LedgerNamed>();
  if (!ids.length) return out;
  const titleColumn =
    table === 'exec_decisions' || table === 'exec_questions' ? 'title' : table === 'exec_facts' ? 'key' : 'text';
  const rows = await sql<{ id: string; code: string; title: string | null }>`
    SELECT id::text AS id, code, ${sql.raw(titleColumn)}::text AS title
    FROM ${sql.raw(table)}
    WHERE id = ANY(${ids}::uuid[])
  `.execute(db as never);
  for (const row of rows.rows) out.set(row.id, row);
  return out;
}

/** The task code of every ledger row that belongs to one. */
async function taskOfRows(db: DbLike, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await sql<{ id: string; task_code: string }>`
    SELECT d.id::text AS id, t.code AS task_code
    FROM (
      SELECT id, task_id FROM exec_decisions WHERE id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT id, task_id FROM exec_questions WHERE id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT id, task_id FROM exec_criteria WHERE id = ANY(${ids}::uuid[])
    ) d JOIN exec_tasks t ON t.id = d.task_id
  `.execute(db as never);
  for (const row of rows.rows) out.set(row.id, row.task_code);
  return out;
}

/** The tasks themselves, by id (a scope expansion names its task). */
async function taskById(db: DbLike, ids: string[]): Promise<Map<string, { code: string }>> {
  const out = new Map<string, { code: string }>();
  if (!ids.length) return out;
  const rows = await sql<{ id: string; code: string }>`
    SELECT id::text AS id, code FROM exec_tasks WHERE id = ANY(${ids}::uuid[])
  `.execute(db as never);
  for (const row of rows.rows) out.set(row.id, row);
  return out;
}

export async function applyExecApprovalDecision(db: DbLike, input: ApprovalEffectInput): Promise<ApprovalEffect> {
  if (input.action === 'exec.question') {
    throw new AppError('VALIDATION_ERROR', 'a question is answered, not approved', {
      needed_action:
        'answer the question (POST /api/v1/exec/questions/:code/answer) — approving the request leaves the question open',
    });
  }
  if (input.action !== 'exec.decision') return { kind: 'none' };

  const payload = (input.payload ?? {}) as { decision_id?: string; code?: string };
  if (!payload.decision_id) return { kind: 'none' };

  const rows = await sql<{ id: string; code: string; task_id: string; task_code: string; approval_state: string }>`
    SELECT d.id::text AS id, d.code, t.id::text AS task_id, t.code AS task_code, d.approval_state
    FROM exec_decisions d JOIN exec_tasks t ON t.id = d.task_id
    WHERE d.id = ${payload.decision_id}::uuid AND d.organization_id = ${input.organizationId}::uuid
  `.execute(db as never);
  const decision = rows.rows[0];
  if (!decision) {
    throw new AppError('NOT_FOUND', `the decision behind this approval (${payload.code ?? 'unknown'}) is gone`, {
      needed_action: 'the ledger row the approval referred to is missing; record the decision again',
    });
  }
  if (decision.approval_state !== 'pending') {
    throw new AppError('CONFLICT', `decision ${decision.code} is already ${decision.approval_state}`);
  }

  const state: ApprovalDecision = input.decision;
  await sql`
    UPDATE exec_decisions
    SET approval_state = ${state}, updated_at = now()
    WHERE id = ${decision.id}::uuid
  `.execute(db as never);
  if (state === 'approved') {
    await resumeBlockedTask(db, decision.task_id, 'decision', decision.id, 'decision_approved');
  }

  await appendEvent(db, {
    organization_id: input.organizationId,
    task_id: null,
    entity: 'decision',
    entity_id: decision.id,
    entity_code: decision.code,
    action: state === 'approved' ? 'decision.approved' : 'decision.rejected',
    actor_type: 'human',
    actor_id: input.actorId,
    tool: input.tool ?? null,
    payload: {
      before: { approval_state: 'pending' },
      after: { approval_state: state, reason: input.reason ?? null, task: decision.task_code },
    },
  });

  return { kind: 'decision', code: decision.code, task_code: decision.task_code };
}
