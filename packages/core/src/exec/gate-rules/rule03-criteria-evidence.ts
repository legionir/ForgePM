import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 3 — every criterion has valid evidence, or a human's waiver.
 *
 * "Valid" is stricter than "some evidence exists": an evidence row whose ref
 * cannot be read by an auditor does not count, and the answer says which of
 * the two problems it is so the agent fixes the right one.
 */
const rule03: Rule = (ctx: GateContext): BlockedRef[] =>
  ctx.criteria
    .filter((c) => c.status !== 'waived' && c.valid_evidence_count === 0)
    .map((c) => ({
      rule: 3,
      ref: c.code,
      title: c.text.slice(0, 120),
      needed:
        c.evidence_count > 0
          ? 'evidence exists but is not verifiable (ref missing or output empty) — add valid evidence'
          : 'add evidence',
      tool_to_call: 'ledger_add_evidence',
    }))
    .filter(Boolean) as BlockedRef[];

export default rule03;
