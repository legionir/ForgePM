import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 10 — no stale or rejected fact that an active decision depends on.
 *
 * A stale fact nobody decided anything from is harmless; one an active
 * decision still rests on means the decision must be revisited.
 */
const rule10: Rule = (ctx: GateContext): BlockedRef[] =>
  ctx.facts
    .filter((f) => f.status === 'stale' || f.status === 'rejected')
    .filter((f) => f.active_dependent_decisions.length > 0)
    .map((f) => ({
      rule: 10,
      ref: f.code,
      title: `fact ${f.code} is ${f.status}`,
      needed: `re-verify the fact or revisit decision(s) ${f.active_dependent_decisions.join(', ')}`,
      tool_to_call: 'fact_verify',
    }));

export default rule10;
