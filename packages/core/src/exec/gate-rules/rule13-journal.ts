import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 13 — no journal row left in `started` or `unknown`.
 *
 * A row that was started and never finished means an action of unknown
 * outcome is still out there; `unknown` asks for the real state to be
 * determined first, because repeating a non-idempotent action is exactly the
 * damage the journal exists to prevent.
 */
const rule13: Rule = (ctx: GateContext): BlockedRef[] =>
  ctx.journal
    .filter((j) => j.status === 'started' || j.status === 'unknown')
    .map((j) => ({
      rule: 13,
      ref: j.code,
      title: j.action,
      needed:
        j.status === 'unknown'
          ? 'determine the real state first, then journal_done/journal_fail'
          : 'finish the action and call journal_done (or journal_fail with a note)',
      tool_to_call: 'journal_done',
    }));

export default rule13;
