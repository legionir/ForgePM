import { sql } from 'kysely';
import { AppError, decisionInputSchema, type ExecRiskLevel } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { appendEvent } from './events';
import { allocateLedgerCode } from './codes';
import { classify, type Classified } from './policy';
import { findTaskByRef, type LedgerActor } from './open-items-service';

/**
 * `ledger_record_decision` (plan §9.2, acceptance B.9).
 *
 * A decision is a choice with its reasons attached — and the RISK is not the
 * agent's to choose. The agent says what it touches and whether it can be
 * undone; the policy table says how serious that is, and the answer is stored
 * with the decision so nobody can re-label it later.
 *
 * Two rules that the plan states and this file keeps:
 *   • a decision whose level is `approval` may NOT be applied before a human
 *     says yes — the row is stored as `pending` and the answer says so in
 *     words (`do_not_apply_until_human_approval`),
 *   • a decision the policy DENIES is not recorded at all: there is no column
 *     for it, and a decision that may not exist may not be written down.
 *
 * The caller owns the transaction.
 */

export interface DecisionRecordValue {
  task_ref: string;
  title: string;
  context: string;
  options: string[];
  selected: string;
  rationale: string;
  reversible: boolean;
  touches: string[];
  review_trigger?: { fact_codes?: string[]; req_codes?: string[] };
}

export interface DecisionRecordResult {
  id: string;
  code: string;
  task_code: string;
  risk_level: ExecRiskLevel;
  approval_state: 'not_required' | 'pending';
  approval_id: string | null;
  /** The one sentence an agent must not skip. */
  do_not_apply_until_human_approval: boolean;
  matched: Classified['matched'];
  explanation: string;
}

export interface DecisionParseOk {
  ok: true;
  value: DecisionRecordValue;
}
export interface DecisionParseFail {
  ok: false;
  code: 'UNPROCESSABLE';
  message: string;
  needed_action: string;
}
export type DecisionParse = DecisionParseOk | DecisionParseFail;

/**
 * The shape check. `risk_level` is NOT accepted as input: the level is
 * computed (plan §9.2, acceptance B.9's I-4) — an agent that may name its own
 * risk may name it "auto".
 */
export function parseDecision(raw: unknown): DecisionParse {
  const parsed = decisionInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join('.') : 'payload';
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: `${path}: ${issue?.message ?? 'the decision did not parse'}`,
      needed_action:
        'send { task_ref, title, context, options, selected, rationale, reversible, touches } — the risk level is computed, never sent',
    };
  }
  return { ok: true, value: parsed.data as DecisionRecordValue };
}

export async function recordDecision(
  db: DbLike,
  actor: LedgerActor,
  raw: unknown,
  policy: Parameters<typeof classify>[0],
): Promise<DecisionRecordResult> {
  const parsed = parseDecision(raw);
  if (!parsed.ok) {
    throw new AppError(parsed.code, parsed.message, { needed_action: parsed.needed_action });
  }
  const input = parsed.value;

  const task = await findTaskByRef(db, actor, input.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${input.task_ref}' in this project`, { ref: input.task_ref });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the decision it was closed with; open a new task for new work',
    });
  }

  const classified = classify(policy, { touches: input.touches, reversible: input.reversible });
  if (classified.level === 'deny') {
    throw new AppError('FORBIDDEN', `the policy denies this decision (${input.touches.join(', ')})`, {
      needed_action:
        'do not apply this change: pick another option, or ask the human with ledger_ask_human — a denied decision is not recorded',
      matched: classified.matched,
    });
  }

  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'D', actor.organizationId);
  const needsApproval = classified.level === 'approval';
  const approvalId = needsApproval ? await requestApproval(db, actor, id, code, input) : null;
  const approvalState: 'not_required' | 'pending' = needsApproval ? 'pending' : 'not_required';

  await sql`
    INSERT INTO exec_decisions (id, organization_id, task_id, code, title, context, options, selected,
                                rationale, touches, reversible, risk_level, approval_state, approval_id,
                                status, review_trigger)
    VALUES (${id}, ${actor.organizationId}, ${task.id}::uuid, ${code}, ${input.title}, ${input.context},
            ${toJsonb(input.options) as never}::jsonb, ${input.selected}, ${input.rationale},
            ${input.touches}::text[], ${input.reversible}, ${classified.level}, ${approvalState},
            ${approvalId}::uuid, 'proposed', ${toJsonb(input.review_trigger ?? null) as never}::jsonb)
  `.execute(db as never);

  await linkReviewTrigger(db, actor, id, input.review_trigger);

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'decision',
    entity_id: id,
    entity_code: code,
    action: 'decision.recorded',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: null,
      after: {
        code,
        selected: input.selected,
        risk_level: classified.level,
        approval_state: approvalState,
        touches: input.touches,
      },
    },
  });

  return {
    id,
    code,
    task_code: task.code,
    risk_level: classified.level,
    approval_state: approvalState,
    approval_id: approvalId,
    do_not_apply_until_human_approval: needsApproval,
    matched: classified.matched,
    explanation: classified.explanation,
  };
}

/**
 * The approval request a decision waits for. It is an ordinary
 * `approval_requests` row: the human path (REST/CLI/panel, PE-4 §9.5) decides
 * it, and nothing else may.
 */
async function requestApproval(
  db: DbLike,
  actor: LedgerActor,
  decisionId: string,
  code: string,
  input: DecisionRecordValue,
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO approval_requests (id, organization_id, project_id, requested_by, action, payload, risk, status)
    VALUES (${id}, ${actor.organizationId}, ${actor.projectId}::uuid, ${actor.actorId}, 'exec.decision',
            ${toJsonb({ decision_id: decisionId, code, title: input.title, touches: input.touches, selected: input.selected }) as never}::jsonb,
            'sensitive', 'pending')
  `.execute(db as never);
  return id;
}

/** A decision that depends on a fact links to it, so the fact can be re-checked. */
async function linkReviewTrigger(
  db: DbLike,
  actor: LedgerActor,
  decisionId: string,
  trigger: DecisionRecordValue['review_trigger'],
): Promise<void> {
  const codes = trigger?.fact_codes ?? [];
  if (!codes.length) return;
  const rows = await sql<{ id: string; code: string }>`
    SELECT id, code FROM exec_facts
    WHERE organization_id = ${actor.organizationId} AND project_id = ${actor.projectId}::uuid AND code = ANY(${codes})
  `.execute(db as never);
  for (const fact of rows.rows) {
    await sql`
      INSERT INTO exec_fact_decisions (fact_id, decision_id) VALUES (${fact.id}::uuid, ${decisionId}::uuid)
      ON CONFLICT DO NOTHING
    `.execute(db as never);
  }
}
