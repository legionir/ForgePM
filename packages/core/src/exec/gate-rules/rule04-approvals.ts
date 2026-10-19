import { classify } from '../policy';
import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 4 — no pending or rejected approval whose change was already applied.
 *
 * The level comes from the policy engine, never from the agent: a decision
 * that policy denies may not be applied at all, and one that policy demands
 * approval for stays shut until a human approved it.
 */
const rule04: Rule = (ctx: GateContext): BlockedRef[] => {
  const out: BlockedRef[] = [];
  for (const d of ctx.decisions) {
    const level = classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level;
    // The journal is the record of what actually ran. A `done` action whose
    // target is this decision is applied even if an older caller did not set
    // exec_decisions.applied_at; a rejected change must still be reverted.
    const applied = d.applied || ctx.journal.some((j) => j.status === 'done' && j.target === d.code);
    if (level === 'deny' && applied) {
      out.push({
        rule: 4,
        ref: d.code,
        title: d.title,
        needed: 'the change is denied by policy — revert it and ask the human',
        tool_to_call: 'ledger_ask_human',
      });
      continue;
    }
    if (level !== 'approval' && level !== 'deny') continue;
    if (d.approval_state === 'pending') {
      out.push({
        rule: 4,
        ref: d.code,
        title: d.title,
        needed: 'await human approval before closing',
        tool_to_call: 'ledger_ask_human',
      });
    } else if (d.approval_state === 'rejected' && applied) {
      out.push({
        rule: 4,
        ref: d.code,
        title: d.title,
        needed: 'decision was rejected but the change is applied — revert it',
        tool_to_call: 'ledger_record_decision',
      });
    }
  }
  return out;
};

export default rule04;
