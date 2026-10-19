import { sql } from 'kysely';
import { AppError, checkNoneConfirmed, exitReportSchema, type ExitReportInput } from '@forgepm/shared';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import type { DbLike } from '../db/unitOfWork';
import { evidenceIsVerifiable } from './evidence';
import { appendEvent } from './events';
import { createOpenItem, findTaskByRef, type LedgerActor } from './open-items-service';

/**
 * `exec_submit_exit_report` — the ledger half (plan §8.1).
 *
 * Two things happen here, and they are the point of the tool:
 *
 *  1. The report is *complete*. Eight "none" fields must each be present and
 *     either carry entries or be confirmed as intentionally empty. "I forgot
 *     to mention it" and "there was nothing to mention" are different
 *     statements, and only the second one may be made silently.
 *
 *  2. The report's findings become *ledger rows*. Every incomplete item,
 *     assumption, risk, unrun test and out-of-scope finding is filed as an
 *     open item with `source='exit_report'`, in code. An agent that says
 *     "I left the migration half done" has thereby created the item that will
 *     keep the task open — it cannot be a sentence in a chat message.
 */

export interface ExitReportValue {
  taskRef: string;
  summary: string;
  changedFiles: string[];
  completedItems: string[];
  incomplete: string[];
  assumptions: string[];
  decisionsMade: string[];
  risksFound: string[];
  testsExecuted: { name: string; result: 'pass' | 'fail'; evidenceId: string }[];
  testsNotRun: { name: string; reason: string; openItemRef?: string }[];
  outOfScopeFindings: string[];
  criteriaStatus: { criterion_ref: string; evidence_refs: string[] }[];
  reqIdsCovered: string[];
  scopeDeviations: string[];
  factsRecorded: string[];
}

export interface ExitReportResult {
  report_id: string;
  task_id: string;
  task_code: string;
  /** Open items created by this report, by code. */
  promoted: string[];
  /** Entries that named an existing item instead of filing a new one. */
  referenced: string[];
  /** Criteria the report declared met, by code — the ledger recorded them. */
  verified: string[];
}

export type ExitReportParse =
  | { ok: true; value: ExitReportValue }
  | {
      ok: false;
      code: 'UNPROCESSABLE';
      message: string;
      needed_action: string;
      details?: Record<string, unknown>;
    };

/**
 * The two spellings the plan and the codebase use for the same two fields.
 * `task_id`/`evidence_ref` are accepted as aliases so a caller that read the
 * plan does not have to guess; the canonical names are `task_ref` and
 * `evidence_id`.
 */
export function normalizeExitReportPayload(raw: unknown): Record<string, unknown> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (out.task_id !== undefined && out.task_ref === undefined) out.task_ref = out.task_id;
  delete out.task_id;
  if (Array.isArray(out.tests_executed)) {
    out.tests_executed = out.tests_executed.map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const y = { ...x };
      if (y.evidence_ref !== undefined && y.evidence_id === undefined) y.evidence_id = y.evidence_ref;
      delete y.evidence_ref;
      return y;
    });
  }
  return out;
}

/** Shape + cross-field check. Unknown keys are refused, not ignored. */
export function parseExitReport(raw: unknown): ExitReportParse {
  const normalized = normalizeExitReportPayload(raw);
  const parsed = exitReportSchema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join('.') : 'payload';
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: `${path}: ${issue?.message ?? 'the exit report did not parse'}`,
      needed_action:
        'the exit report is strict: send every field, use [] (plus none_confirmed.<field>=true) for the ones that are empty',
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    };
  }
  const none = checkNoneConfirmed(normalized);
  if (!none.ok) {
    const parts: string[] = [];
    if (none.missing_fields.length) parts.push(`missing field(s): ${none.missing_fields.join(', ')}`);
    if (none.missing_confirmation.length)
      parts.push(`empty without confirmation: ${none.missing_confirmation.join(', ')}`);
    if (none.contradictory.length) parts.push(`confirmed empty but not empty: ${none.contradictory.join(', ')}`);
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: `the exit report is not complete — ${parts.join(' | ')}`,
      needed_action: none.needed_action ?? 'complete the report',
      details: {
        missing_fields: none.missing_fields,
        missing_confirmation: none.missing_confirmation,
        contradictory: none.contradictory,
      },
    };
  }
  const v = parsed.data as ExitReportInput;
  return {
    ok: true,
    value: {
      taskRef: v.task_ref,
      summary: v.summary,
      changedFiles: [...v.changed_files],
      completedItems: [...v.completed_items],
      incomplete: [...v.incomplete],
      assumptions: [...v.assumptions],
      decisionsMade: [...v.decisions_made],
      risksFound: [...v.risks_found],
      testsExecuted: v.tests_executed.map((t) => ({
        name: t.name,
        result: t.result,
        evidenceId: t.evidence_id,
      })),
      testsNotRun: v.tests_not_run.map((t) => ({
        name: t.name,
        reason: t.reason,
        ...(t.open_item_ref ? { openItemRef: t.open_item_ref } : {}),
      })),
      outOfScopeFindings: [...v.out_of_scope_findings],
      criteriaStatus: v.criteria_status.map((c) => ({
        criterion_ref: c.criterion_ref,
        evidence_refs: [...c.evidence_refs],
      })),
      reqIdsCovered: [...v.req_ids_covered],
      scopeDeviations: [...v.scope_deviations],
      factsRecorded: [...v.facts_recorded],
    },
  };
}

/** Which report field becomes which kind of open item. */
const PROMOTION: {
  get: (r: ExitReportValue) => unknown[];
  type: string;
  prefix: string;
}[] = [
  { get: (r) => r.incomplete, type: 'incomplete_requirement', prefix: 'incomplete: ' },
  { get: (r) => r.assumptions, type: 'assumption', prefix: 'assumption: ' },
  { get: (r) => r.risksFound, type: 'risk', prefix: 'risk: ' },
  { get: (r) => r.testsNotRun, type: 'test_gap', prefix: 'test gap: ' },
  { get: (r) => r.outOfScopeFindings, type: 'out_of_scope', prefix: 'out of scope: ' },
  // A declared deviation is the agent telling the ledger "I went further than
  // the plan said". The report's `changed_files` are what rule 11 measures;
  // this is the part the agent volunteers, and it belongs in the ledger too —
  // as an `out_of_scope` item, so the completion report names it and PE-5's
  // real diff can check it against reality.
  { get: (r) => r.scopeDeviations, type: 'out_of_scope', prefix: 'scope deviation: ' },
];

/**
 * Every `tests_executed[].evidence_id` must point at a row that really exists.
 * A claim without a proof row is the one thing the gate exists to catch, and
 * it is caught here, at the door.
 */
async function assertEvidenceExists(db: DbLike, taskId: string, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const r = await sql<{ id: string }>`
    SELECT id::text AS id FROM exec_evidence
    WHERE task_id = ${taskId}::uuid AND id::text = ANY(${refs}::text[])
  `.execute(db as never);
  const known = new Set(r.rows.map((row) => row.id));
  const missing = refs.filter((ref) => !known.has(ref));
  if (missing.length) {
    throw new AppError('EVIDENCE_INVALID', `no evidence row '${missing[0]}' for this task`, {
      missing,
      needed_action:
        'record the proof first (ledger_add_evidence) and cite the evidence id it returns — a test result without evidence is a claim',
    });
  }
}

/**
 * Write the report and promote its findings. The caller owns the transaction,
 * so the report, the promoted items, the event and the audit row commit or
 * roll back together.
 */
export async function submitExitReport(db: DbLike, actor: LedgerActor, raw: unknown): Promise<ExitReportResult> {
  const parsed = parseExitReport(raw);
  if (!parsed.ok) {
    throw new AppError('UNPROCESSABLE', parsed.message, {
      needed_action: parsed.needed_action,
      ...(parsed.details ?? {}),
    });
  }
  const report = parsed.value;
  const task = await findTaskByRef(db, actor, report.taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${report.taskRef}' in this project`, { ref: report.taskRef });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the report it was closed with; open a new task for new work',
    });
  }

  await assertEvidenceExists(
    db,
    task.id,
    report.testsExecuted.map((t) => t.evidenceId),
  );

  const reportId = newId();
  // The payload is stored AS SENT (canonical field names), because the gate
  // reads the report back out of this column — a report that the gate cannot
  // read is a report the gate cannot judge.
  const stored = normalizeExitReportPayload(raw);
  await sql`
    INSERT INTO exec_reports (id, organization_id, task_id, payload, status)
    VALUES (${reportId}, ${actor.organizationId}, ${task.id}::uuid, ${toJsonb(stored) as never}::jsonb, 'submitted')
  `.execute(db as never);

  const promoted: string[] = [];
  const referenced: string[] = [];
  for (const spec of PROMOTION) {
    for (const entry of spec.get(report)) {
      const text = typeof entry === 'string' ? entry : String((entry as { name?: string })?.name ?? '');
      const detail = typeof entry === 'string' ? undefined : String((entry as { reason?: string })?.reason ?? '');
      const existingRef = typeof entry === 'string' ? undefined : (entry as { openItemRef?: string })?.openItemRef;
      if (existingRef) {
        referenced.push(existingRef);
        continue;
      }
      const code = await promote(db, actor, task.id, spec, text, detail, reportId);
      if (code) promoted.push(code);
    }
  }

  const verified = await applyCriteriaStatus(db, task.id, report.criteriaStatus);

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'report',
    entity_id: reportId,
    entity_code: task.code,
    action: 'report.submitted',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: null,
      after: {
        report_id: reportId,
        task_code: task.code,
        promoted,
        referenced,
        verified,
        tests_executed: report.testsExecuted.length,
        tests_not_run: report.testsNotRun.length,
      },
    },
  });

  return { report_id: reportId, task_id: task.id, task_code: task.code, promoted, referenced, verified };
}

/**
 * The report's `criteria_status` is the agent's declaration that a criterion is
 * met, with the proof it cites. The ledger records it — but only after the
 * code has checked that the proof exists and is verifiable, so the criterion
 * never becomes "verified" on a word alone. This is what makes the completion
 * report mean something: the criteria it lists as completed are the ones the
 * ledger recorded, not the ones the message praised.
 */
async function applyCriteriaStatus(
  db: DbLike,
  taskId: string,
  entries: { criterion_ref: string; evidence_refs: string[] }[],
): Promise<string[]> {
  if (!entries.length) return [];
  const [criteria, evidence] = await Promise.all([
    db.selectFrom('exec_criteria').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_evidence').selectAll().where('task_id', '=', taskId).execute(),
  ]);
  const marked: string[] = [];
  for (const entry of entries) {
    const criterion = criteria.find((c) => c.id === entry.criterion_ref || c.code === entry.criterion_ref);
    if (!criterion) {
      throw new AppError('VALIDATION_ERROR', `criterion '${entry.criterion_ref}' is not a criterion of this task`, {
        ref: entry.criterion_ref,
        needed_action: 'criteria_status may only list the criteria of this task (by code, e.g. C-001)',
      });
    }
    const cited = evidence.filter((e) => entry.evidence_refs.includes(e.id) && e.criterion_id === criterion.id);
    const verifiable = cited.filter(evidenceIsVerifiable);
    if (!verifiable.length) {
      throw new AppError('EVIDENCE_INVALID', `criterion '${criterion.code}' cites no verifiable evidence of its own`, {
        criterion: criterion.code,
        cited: entry.evidence_refs,
        needed_action: 'record the proof against the criterion first (ledger_add_evidence) and cite that evidence id',
      });
    }
    await db
      .updateTable('exec_criteria')
      .set({ status: 'verified', verified_at: new Date() })
      .where('id', '=', criterion.id)
      .execute();
    marked.push(criterion.code);
  }
  return marked;
}

/**
 * File one report entry as an open item. A duplicate (same type + same
 * normalised title) is not an error: the entry is already on the ledger, and
 * filing it twice would be the noise this promotion is supposed to avoid.
 */
async function promote(
  db: DbLike,
  actor: LedgerActor,
  taskId: string,
  spec: { type: string; prefix: string },
  text: string,
  detail: string | undefined,
  reportId: string,
): Promise<string | null> {
  const title = `${spec.prefix}${text}`.slice(0, 500);
  try {
    const item = await createOpenItem(
      db,
      actor,
      taskId,
      {
        title,
        type: spec.type,
        ...(detail ? { detail } : {}),
        related_ref: reportId,
      },
      'exit_report',
    );
    return item.code;
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFLICT') return null;
    throw err;
  }
}
