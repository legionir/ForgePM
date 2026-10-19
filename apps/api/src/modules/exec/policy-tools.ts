import { policyCheckInputSchema } from '@forgepm/shared';
import { EXEC_POLICY_DEFAULT, appendEvent, classify, getEffective, type Db } from '@forgepm/core';
import type { ExecPolicy } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { parseTool, projectRefSchema } from './context';

/**
 * `exec_policy_check` (plan §9.4, acceptance B.12).
 *
 * "What would the policy say about this?" — answered by the SAME table that
 * decides, so the answer cannot drift from the decision. It creates no
 * decision and approves nothing. When the policy denies an action, it appends
 * only a `policy.denied` event to the ledger (plan §10, acceptance F.7), so a
 * blocked attempt remains auditable. Other outcomes make no ledger write.
 *
 * The agent is meant to ask BEFORE it acts, and the answer is deliberately
 * blunt: the level, the rule that produced it, and the next tool to call.
 */

export const policyCheckToolSchema = policyCheckInputSchema.extend({
  project_ref: projectRefSchema.optional(),
});

export interface PolicyCheckAnswer {
  level: 'auto' | 'review' | 'approval' | 'deny';
  matched_rules: { category: string; level: string; source: string; note?: string }[];
  required: { approval_id: string | null; tool_to_call: string | null };
  explanation: string;
  /** Present when the action is serious enough to be journalled. */
  warning?: string;
}

export async function policyCheckTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<{
    action_kind: string;
    command?: string;
    target: string;
    reversible?: boolean;
    details?: Record<string, unknown>;
    project_ref?: string;
  }>(
    policyCheckToolSchema,
    raw,
    'send { action_kind, target, reversible } — action_kind is one of the policy categories, and the command text when the action is a command',
  );
  const policy = await effectivePolicy(db, actor.organizationId);
  const classified = classify(policy, {
    touches: [tool.action_kind],
    reversible: tool.reversible ?? true,
    command: tool.command,
  });
  if (classified.level === 'deny') {
    // F.7: the denial is recorded, in the ledger's own stream.
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: null,
      entity: 'policy',
      entity_id: null,
      entity_code: null,
      action: 'policy.denied',
      actor_type: actor.type === 'agent' ? 'agent' : 'human',
      actor_id: actor.id,
      tool: 'exec_policy_check',
      payload: {
        outcome: 'blocked',
        level: 'deny',
        category: tool.action_kind,
        target: tool.target,
        command: tool.command ?? null,
        matched: classified.matched.map((m) => m.category),
      },
    });
  }
  return buildAnswer(classified, tool.target, tool.action_kind);
}

/** The answer shape (plan §9.4) — pure, so it can be unit-tested. */
export function buildAnswer(
  classified: ReturnType<typeof classify>,
  target: string,
  actionKind: string,
): PolicyCheckAnswer {
  const answer: PolicyCheckAnswer = {
    level: classified.level,
    matched_rules: classified.matched.map((m) => ({
      category: m.category,
      level: m.level,
      source: m.source,
    })),
    required: {
      approval_id: null,
      tool_to_call:
        classified.level === 'deny'
          ? null
          : classified.level === 'approval'
            ? 'ledger_record_decision'
            : classified.level === 'review'
              ? 'ledger_record_decision'
              : null,
    },
    explanation: `${actionKind} on ${target} is ${classified.level} — ${classified.explanation}`,
  };
  if (classified.level === 'approval' || classified.level === 'deny') {
    answer.warning =
      classified.level === 'deny'
        ? 'do not apply this action at all: the policy denies it, and no approval makes it allowed'
        : 'journal this action before you do it (journal_start), record the decision with ledger_record_decision, and do not apply it until a human approves';
  }
  return answer;
}

async function effectivePolicy(db: Db, orgId: string): Promise<ExecPolicy> {
  const eff = await getEffective(db, 'exec.policy', orgId, null);
  return (eff?.value as ExecPolicy | undefined) ?? EXEC_POLICY_DEFAULT;
}
