import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 5 — no unanswered blocking question.
 *
 * Silence is not approval: a blocking question that nobody answered keeps the
 * task shut, which is why the answer names the wait rather than the work.
 */
const rule05: Rule = (ctx: GateContext): BlockedRef[] =>
  ctx.questions
    .filter((q) => q.blocking && q.status === 'open')
    .map((q) => ({
      rule: 5,
      ref: q.code,
      title: `blocking question ${q.code}`,
      needed: 'waiting for a human answer (silence is not approval)',
      tool_to_call: 'ledger_list_open',
    }));

export default rule05;
