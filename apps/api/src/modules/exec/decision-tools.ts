import { decisionObjectSchema, decisionRefinement, questionObjectSchema, questionRefinement } from '@forgepm/shared';
import {
  askHuman,
  classify,
  EXEC_POLICY_DEFAULT,
  getEffective,
  journalWriteLock,
  recordDecision,
  throwIfJournalLocked,
  unitOfWork,
  unresolvedJournalRows,
  type Db,
} from '@forgepm/core';
import type { ExecPolicy } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectForTask, projectRefSchema } from './context';

/**
 * PE-4's two "the agent must involve a human" tools (plan §9.2, §9.3).
 *
 * `ledger_record_decision` writes down a choice AND the risk the policy
 * assigns to it; `ledger_ask_human` writes down a question whose options
 * each have a stated consequence. Both end in the same place: a row the gate
 * can read, so "why was this done" and "what is still waiting" are facts
 * rather than prose.
 */

export const decisionToolSchema = decisionObjectSchema
  .extend({
    project_ref: projectRefSchema.optional(),
  })
  .superRefine(decisionRefinement);

export const questionToolSchema = questionObjectSchema
  .extend({
    project_ref: projectRefSchema.optional(),
  })
  .superRefine(questionRefinement);

export async function recordDecisionTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    decisionToolSchema,
    raw,
    'send { task_ref, title, context, options, selected, rationale, reversible, touches } — the risk level is computed, never sent',
  );
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  const policy = await effectivePolicy(db, actor.organizationId, projectId);
  const payload = decisionPayload(tool);
  const ledger = ledgerActor(actor, projectId, 'ledger_record_decision');
  const approvalDecision =
    classify(policy, { touches: tool.touches as string[], reversible: tool.reversible as boolean }).level === 'approval';
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const open = await unresolvedJournalRows(tx, actor.organizationId, projectId);
    throwIfJournalLocked(
      journalWriteLock({
        tool: 'ledger_record_decision',
        actorType: ledger.actorType,
        openRows: open,
        approvalDecision,
      }),
    );
    const row = await recordDecision(tx, ledger, payload, policy);
    await auditIn(tx, actor, 'exec.decision.record', 'exec_decision', row.id, {
      task: row.task_code,
      code: row.code,
      risk_level: row.risk_level,
      approval_state: row.approval_state,
    });
    out = row;
  });
  return out;
}

export async function askHumanTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    questionToolSchema,
    raw,
    'send { task_ref, question, options, recommendation, why_it_matters, impact_per_option } — one impact per option',
  );
  const projectId = await projectForTask(db, actor, String(tool.task_ref), tool.project_ref as string | undefined);
  const payload = questionPayload(tool);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await askHuman(tx, ledgerActor(actor, projectId, 'ledger_ask_human'), payload);
    await auditIn(tx, actor, 'exec.question.ask', 'exec_question', row.id, {
      task: row.task_code,
      code: row.code,
      blocking: row.blocking,
    });
    out = row;
  });
  return out;
}

/** The policy the operator configured, or the plan's default table. */
async function effectivePolicy(db: Db, orgId: string, projectId: string): Promise<ExecPolicy> {
  const eff = await getEffective(db, 'exec.policy', orgId, projectId);
  return (eff?.value as ExecPolicy | undefined) ?? EXEC_POLICY_DEFAULT;
}

/** The ledger payload is strict: rebuild it from the known keys. */
function decisionPayload(tool: Record<string, unknown>): Record<string, unknown> {
  return {
    task_ref: tool.task_ref,
    title: tool.title,
    context: tool.context,
    options: tool.options,
    selected: tool.selected,
    rationale: tool.rationale,
    reversible: tool.reversible,
    touches: tool.touches,
    review_trigger: tool.review_trigger,
  };
}

function questionPayload(tool: Record<string, unknown>): Record<string, unknown> {
  return {
    task_ref: tool.task_ref,
    question: tool.question,
    options: tool.options,
    recommendation: tool.recommendation,
    impact_per_option: tool.impact_per_option,
    why_it_matters: tool.why_it_matters,
    blocking: tool.blocking,
    kind: tool.kind,
  };
}
