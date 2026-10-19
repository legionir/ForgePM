import { sql } from 'kysely';
import { AppError, questionInputSchema } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { resumeBlockedTask } from './plan';
import { findTaskByRef, type LedgerActor } from './open-items-service';

/**
 * `ledger_ask_human` (plan §9.3, acceptance B.11).
 *
 * A question is the one way the agent can stop and wait. Three things make it
 * a real question rather than a note:
 *
 *   • the options are written down, with the impact of EACH one (a question
 *     whose options have no consequences is a question nobody can answer),
 *   • a blocking question moves the task to `awaiting_review` and says what
 *     would unblock it — the ledger's own CHECK demands exactly that,
 *   • and there is NO timeout. Silence is not approval: an unanswered
 *     question keeps the gate refusing, tomorrow and next week.
 *
 * The caller owns the transaction.
 */

export interface QuestionAskValue {
  task_ref: string;
  question: string;
  options: string[];
  recommendation: string;
  impact_per_option?: string[];
  why_it_matters: string;
  blocking: boolean;
  kind: 'generic' | 'scope_expansion' | 'drop_requirement' | 'waive_requirement' | 'baseline_change';
}

export interface QuestionAskResult {
  id: string;
  code: string;
  task_code: string;
  status: 'open';
  blocking: boolean;
  kind: string;
  approval_id: string | null;
  /** The task now waits; this is what would unblock it. */
  task_status: string;
  needed_action: string;
}

export interface QuestionParseOk {
  ok: true;
  value: QuestionAskValue;
}
export interface QuestionParseFail {
  ok: false;
  code: 'UNPROCESSABLE';
  message: string;
  needed_action: string;
}
export type QuestionParse = QuestionParseOk | QuestionParseFail;

export function parseQuestion(raw: unknown): QuestionParse {
  const parsed = questionInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join('.') : 'payload';
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: `${path}: ${issue?.message ?? 'the question did not parse'}`,
      needed_action:
        'send { task_ref, question, options, recommendation, why_it_matters, impact_per_option } — one impact per option, and the recommendation must be one of the options',
    };
  }
  return { ok: true, value: parsed.data as QuestionAskValue };
}

export async function askHuman(db: DbLike, actor: LedgerActor, raw: unknown): Promise<QuestionAskResult> {
  const parsed = parseQuestion(raw);
  if (!parsed.ok) {
    throw new AppError(parsed.code, parsed.message, { needed_action: parsed.needed_action });
  }
  const input = parsed.value;

  const task = await findTaskByRef(db, actor, input.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${input.task_ref}' in this project`, { ref: input.task_ref });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the question it was closed with; open a new task for new work',
    });
  }

  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'Q', actor.organizationId);
  const impact = input.impact_per_option ?? [];
  const approvalId = input.blocking ? await requestApproval(db, actor, id, code, input) : null;

  await sql`
    INSERT INTO exec_questions (id, organization_id, task_id, code, question, options, recommendation,
                                why_it_matters, impact, blocking, status, approval_id)
    VALUES (${id}, ${actor.organizationId}, ${task.id}::uuid, ${code}, ${input.question},
            ${toJsonb(input.options) as never}::jsonb, ${input.recommendation}, ${input.why_it_matters},
            ${toJsonb(impact) as never}::jsonb, ${input.blocking}, 'open', ${approvalId}::uuid)
  `.execute(db as never);

  let taskStatus = task.status;
  if (input.blocking) {
    // The ledger's own CHECK: a task in `awaiting_review` must say what would
    // unblock it. The question is the answer to "what would unblock it".
    const unblock = `a human answers question ${code} (one of: ${input.options.join(' | ')})`;
    await sql`
      UPDATE exec_tasks
      SET status = 'awaiting_review', updated_at = now(),
          blocked_on_kind = 'question', blocked_on_ref = ${id}::uuid,
          unblock_condition = ${unblock}
      WHERE id = ${task.id}::uuid
    `.execute(db as never);
    taskStatus = 'awaiting_review';
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'question',
    entity_id: id,
    entity_code: code,
    action: 'question.asked',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: null,
      after: {
        code,
        blocking: input.blocking,
        kind: input.kind,
        options: input.options.length,
        task_status: taskStatus,
      },
    },
  });

  return {
    id,
    code,
    task_code: task.code,
    status: 'open',
    blocking: input.blocking,
    kind: input.kind,
    approval_id: approvalId,
    task_status: taskStatus,
    needed_action: input.blocking
      ? 'wait for a human answer — silence is not approval, and the gate keeps refusing until the question is answered'
      : 'continue; the question is on the record and the human may answer it later',
  };
}

/** A blocking question is decided by a human, through the ordinary approval queue. */
async function requestApproval(
  db: DbLike,
  actor: LedgerActor,
  questionId: string,
  code: string,
  input: QuestionAskValue,
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO approval_requests (id, organization_id, project_id, requested_by, action, payload, risk, status)
    VALUES (${id}, ${actor.organizationId}, ${actor.projectId}::uuid, ${actor.actorId}, 'exec.question',
            ${toJsonb({ question_id: questionId, code, question: input.question, options: input.options }) as never}::jsonb,
            'sensitive', 'pending')
  `.execute(db as never);
  return id;
}

/**
 * `POST /api/v1/exec/questions/:code/answer` (plan §9.5) — the human's answer.
 *
 * Answering a question is what unblocks the task: the question becomes
 * `answered`, the task leaves `awaiting_review` (and stops claiming to be
 * blocked by a question that no longer exists), and the request that asked for
 * an answer is closed by the very person who gave it.
 */
export interface QuestionAnswerResult {
  id: string;
  code: string;
  task_code: string;
  status: 'answered';
  answer: string;
  answered_by: string;
  task_status: string;
}

export async function answerQuestion(
  db: DbLike,
  actor: LedgerActor,
  code: string,
  answer: string,
): Promise<QuestionAnswerResult> {
  const text = (answer ?? '').trim();
  if (text.length < 1) {
    throw new AppError('VALIDATION_ERROR', 'the answer is empty', {
      needed_action: 'write the answer the human gave — a blank answer is not an answer',
    });
  }
  const rows = await sql<{
    id: string;
    code: string;
    task_id: string;
    status: string;
    task_code: string;
    task_status: string;
  }>`
    SELECT q.id::text AS id, q.code, q.task_id::text AS task_id, q.status, t.code AS task_code, t.status AS task_status
    FROM exec_questions q JOIN exec_tasks t ON t.id = q.task_id
    WHERE q.organization_id = ${actor.organizationId}::uuid
      AND (q.code = ${code} OR q.id::text = ${code})
  `.execute(db as never);
  const question = rows.rows[0];
  if (!question) {
    throw new AppError('NOT_FOUND', `no question '${code}' in this organisation`, { ref: code });
  }
  if (question.status !== 'open') {
    throw new AppError('LEDGER_STATE_INVALID', `question ${question.code} is already ${question.status}`, {
      needed_action: 'a question that was answered or canceled keeps its answer; ask a new one',
    });
  }

  await sql`
    UPDATE exec_questions
    SET status = 'answered', answer = ${text}, answered_by = ${actor.actorId}, answered_at = now()
    WHERE id = ${question.id}::uuid
  `.execute(db as never);

  // An answer clears only the matching question blocker; unfinished dependencies still block.
  const taskStatus = (await resumeBlockedTask(db, question.task_id, 'question', question.id, 'question_answered'))
    ?? question.task_status;

  // The approval that asked for an answer is closed by the person who answered.
  await sql`
    UPDATE approval_requests
    SET status = 'approved', decided_by = ${actor.actorId}, decided_at = now(), reason = ${text.slice(0, 1000)}
    WHERE action = 'exec.question' AND status = 'pending'
      AND payload->>'question_id' = ${question.id}
  `.execute(db as never);

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: question.task_id,
    entity: 'question',
    entity_id: question.id,
    entity_code: question.code,
    action: 'question.answered',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { status: 'open' },
      after: { status: 'answered', answer: text.slice(0, 500), task_status: taskStatus },
    },
  });

  return {
    id: question.id,
    code: question.code,
    task_code: question.task_code,
    status: 'answered',
    answer: text,
    answered_by: actor.actorId,
    task_status: taskStatus,
  };
}
