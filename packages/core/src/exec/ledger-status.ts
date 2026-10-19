import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import {
  buildLedgerStatus,
  type LedgerCriterionLite,
  type LedgerDecisionLite,
  type LedgerEvidenceLite,
  type LedgerItemLite,
  type LedgerQuestionLite,
  type LedgerRequirementCoverageLite,
  type LedgerStatusView,
  type LedgerTaskLite,
} from './ledger-view';
import type { LedgerActor } from './open-items-service';

/**
 * The loader behind `exec_ledger_status` (plan §6 A.1, §7 B.5): read the ledger
 * rows for a project — or for one task — and hand them to `buildLedgerStatus`.
 *
 * Kept separate from the projection on purpose. The projection is pure and byte
 * stable, so it can be reasoned about (and unit-tested) without a database; this
 * file is the part that must be proven against real rows. Nothing here decides
 * whether a task is ready to submit — if it did, the panel and the tool could
 * disagree, which is the failure this whole phase exists to remove.
 */

export interface LedgerStatusResult {
  /** True when the project has no ledger task yet (B.5): say so, and point at `exec_task_start`. */
  empty: boolean;
  tasks: LedgerStatusView[];
  needed_action?: string;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** One row per task, in code order, so two runs of the same project print alike. */
async function readTasks(db: DbLike, actor: Pick<LedgerActor, 'organizationId' | 'projectId'>, taskRef?: string) {
  const r = await sql<{
    id: string;
    code: string;
    title: string;
    status: string;
    closed_at: string | null;
    start_ref: string | null;
    tree_hash_start: string | null;
    allowed_paths: unknown;
  }>`
    SELECT id::text AS id, code, title, status, closed_at::text AS closed_at,
           start_ref, tree_hash_start, allowed_paths
    FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND project_id = ${actor.projectId}
      ${taskRef ? sql`AND (id::text = ${taskRef} OR code = ${taskRef})` : sql``}
    ORDER BY code
  `.execute(db as never);
  return r.rows;
}

/** Children are read for the whole task set at once: six queries, not six per task. */
async function readChildren(db: DbLike, actor: Pick<LedgerActor, 'organizationId' | 'projectId'>, ids: string[]) {
  const [criteria, evidence, items, questions, decisions, requirements, stamps] = await Promise.all([
    sql<{ task_id: string; code: string; text: string }>`
      SELECT task_id::text AS task_id, code, text FROM exec_criteria
      WHERE task_id = ANY(${ids}::uuid[]) ORDER BY code
    `.execute(db as never),
    sql<{ task_id: string; criterion_code: string; kind: string; ref: string; summary: string }>`
      SELECT e.task_id::text AS task_id, c.code AS criterion_code, e.kind, e.ref, e.summary
      FROM exec_evidence e JOIN exec_criteria c ON c.id = e.criterion_id
      WHERE e.task_id = ANY(${ids}::uuid[]) ORDER BY c.code, e.ref
    `.execute(db as never),
    sql<{ task_id: string; code: string; title: string; type: string; status: string; blocks_completion: boolean }>`
      SELECT task_id::text AS task_id, code, title, type, status, blocks_completion FROM exec_open_items
      WHERE task_id = ANY(${ids}::uuid[]) ORDER BY code
    `.execute(db as never),
    sql<{ task_id: string; code: string; question: string; answered_at: string | null; blocking: boolean }>`
      SELECT task_id::text AS task_id, code, question, answered_at::text AS answered_at, blocking
      FROM exec_questions WHERE task_id = ANY(${ids}::uuid[]) ORDER BY code
    `.execute(db as never),
    sql<{ task_id: string; code: string; title: string; approved: boolean; needs_approval: boolean }>`
      SELECT task_id::text AS task_id, code, title,
             (approval_state = 'approved') AS approved,
             (risk_level = 'approval')     AS needs_approval
      FROM exec_decisions WHERE task_id = ANY(${ids}::uuid[]) ORDER BY code
    `.execute(db as never),
    sql<{ code: string; status: string; covered_by_tasks: unknown }>`
      SELECT r.code, r.status,
             COALESCE(array_agg(DISTINCT t.code) FILTER (WHERE t.code IS NOT NULL), '{}') AS covered_by_tasks
      FROM exec_requirements r
      LEFT JOIN exec_criteria c ON c.req_id = r.id
      LEFT JOIN exec_tasks t ON t.id = c.task_id
      WHERE r.organization_id = ${actor.organizationId}
        AND (r.project_id = ${actor.projectId} OR r.project_id IS NULL)
      GROUP BY r.code, r.status
      ORDER BY r.code
    `.execute(db as never),
    // The newest gate stamp per task: C.9b needs to know whether a task that
    // says "done" was ever stamped by the gate.
    sql<{ task_id: string; id: string; ok: boolean; created_at: string }>`
      SELECT DISTINCT ON (task_id) task_id::text AS task_id, id::text AS id, ok, created_at::text AS created_at
      FROM exec_gate_checks
      WHERE task_id = ANY(${ids}::uuid[])
      ORDER BY task_id, created_at DESC, id DESC
    `.execute(db as never),
  ]);
  return {
    criteria: criteria.rows,
    evidence: evidence.rows,
    items: items.rows,
    questions: questions.rows,
    decisions: decisions.rows,
    requirements: requirements.rows,
    stamps: stamps.rows,
  };
}

function group<T extends { task_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.task_id) ?? [];
    list.push(row);
    out.set(row.task_id, list);
  }
  return out;
}

/**
 * One read of the ledger for a project (or a single task when `task_ref` is given).
 * An unknown ref is `NOT_FOUND` rather than "empty": an empty answer to a typo would
 * tell the agent its work is unwritten (A.8).
 */
export async function loadLedgerStatus(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  taskRef?: string,
): Promise<LedgerStatusResult> {
  const rows = await readTasks(db, actor, taskRef);
  if (taskRef && !rows.length) {
    throw new AppError('NOT_FOUND', `no ledger task '${taskRef}' in this project`, {
      ref: taskRef,
      needed_action: 'exec_task_start creates one; ledger_status without task_ref lists every task in the project',
    });
  }
  if (!rows.length) {
    return {
      empty: true,
      tasks: [],
      needed_action: 'exec_task_start is the entry point: no task means no ledger, and the gate has nothing to check',
    };
  }

  const ids = rows.map((r) => r.id);
  const kids = await readChildren(db, actor, ids);
  const byTask = {
    criteria: group(kids.criteria),
    evidence: group(kids.evidence),
    items: group(kids.items),
    questions: group(kids.questions),
    decisions: group(kids.decisions),
  };
  const stampByTask = new Map(kids.stamps.map((s) => [s.task_id, { ok: s.ok, stamp_id: s.id }]));

  const views: LedgerStatusView[] = rows.map((row) => {
    const task: LedgerTaskLite = {
      code: row.code,
      title: row.title,
      status: row.status,
      closed_at: row.closed_at,
      start_ref: row.start_ref,
      tree_hash_start: row.tree_hash_start,
      allowed_paths: textArray(row.allowed_paths),
    };
    const criteria: LedgerCriterionLite[] = (byTask.criteria.get(row.id) ?? []).map((c) => ({
      code: c.code,
      text: c.text,
      // §7: a criterion without evidence is never satisfied — there is no "trust me"
      // state in this ledger, so the flag is a rule, not a column.
      requires_evidence: true,
    }));
    const evidence: LedgerEvidenceLite[] = (byTask.evidence.get(row.id) ?? []).map((e) => ({
      criterion_code: e.criterion_code,
      kind: e.kind,
      ref: e.ref,
      summary: e.summary,
    }));
    const items: LedgerItemLite[] = (byTask.items.get(row.id) ?? []).map((i) => ({
      code: i.code,
      title: i.title,
      type: i.type,
      status: i.status as LedgerItemLite['status'],
      blocks_completion: i.blocks_completion,
    }));
    const questions: LedgerQuestionLite[] = (byTask.questions.get(row.id) ?? []).map((q) => ({
      code: q.code,
      question: q.question,
      answered_at: q.answered_at,
      blocking: q.blocking,
    }));
    const decisions: LedgerDecisionLite[] = (byTask.decisions.get(row.id) ?? []).map((d) => ({
      code: d.code,
      title: d.title,
      approved: d.approved,
      needs_approval: d.needs_approval,
    }));
    // Coverage here means "a criterion is linked to the requirement". Verified-ness is
    // the gate's rule 8, and keeping the two apart is what lets the status tool answer
    // "what is still open" without pretending to be the approval authority.
    const requirements: LedgerRequirementCoverageLite[] = kids.requirements.map((r) => ({
      code: r.code,
      status: r.status,
      covered_by_tasks: textArray(r.covered_by_tasks),
    }));
    return buildLedgerStatus({
      task,
      criteria,
      evidence,
      items,
      questions,
      decisions,
      requirements,
      gate_stamp: stampByTask.get(row.id) ?? null,
    });
  });

  return { empty: false, tasks: views };
}
