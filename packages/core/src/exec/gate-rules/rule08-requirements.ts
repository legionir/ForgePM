import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 8 — every linked requirement is covered by a verified criterion.
 *
 * A dropped requirement is out of the gate's hands (dropping one needs human
 * approval); an active one without a verified criterion is the silent-drop
 * this rule exists to make impossible.
 */
const rule08: Rule = (ctx: GateContext): BlockedRef[] =>
  ctx.requirements
    .filter((rq) => rq.status !== 'dropped')
    .filter((rq) => rq.verified_criteria.length === 0)
    .map((rq) => ({
      rule: 8,
      ref: rq.code,
      title: `requirement ${rq.code} has no verified criterion`,
      needed:
        'this requirement has no verified acceptance criterion — implement it or link/verify a criterion (dropping needs human approval)',
      tool_to_call: 'req_link_task',
    }));

export default rule08;
