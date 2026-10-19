import type { BlockedRef, GateContext, Rule } from '../gate-types';
import { scopeIssueRef } from '../scope';

/**
 * Rule 11 — no file outside `allowed_paths` without a human's approval.
 *
 * An unmeasurable scope is itself a block: "I could not check" is not "the
 * check passed", and letting it through would make the rule a decoration.
 */
const rule11: Rule = (ctx: GateContext): BlockedRef[] => {
  // A missing report is rule 1's business — the scope is simply not measurable yet.
  if (!ctx.report) return [];
  if (!ctx.scope.available) {
    if (ctx.scope.human_waived) return [];
    return [
      {
        rule: 11,
        ref: 'scope',
        title: 'the scope cannot be measured',
        needed: `scope cannot be measured (${ctx.scope.unavailable_reason ?? 'no server-captured start reference or manifest'}) — restore a code-measured start_ref/manifest or ask the human to waive explicitly`,
        tool_to_call: 'scope_check',
      },
    ];
  }
  const out: BlockedRef[] = [];
  const active = new Set(['open', 'blocked', 'awaiting_human']);
  for (const f of ctx.scope.files) {
    if (f.transient || (f.in_allowed_paths && !f.deleted)) continue;
    const issueRef = scopeIssueRef(f.path, f.change);
    const approved = ctx.open_items.some(
      (item) =>
        item.source === 'hook' && item.type === 'out_of_scope' && item.related_ref === issueRef &&
        !active.has(item.status) && item.resolved_by === 'human',
    );
    if (approved) continue;
    out.push({
      rule: 11,
      ref: f.path,
      title: f.deleted ? `deleted file ${f.path}` : `changed file outside allowed_paths: ${f.path}`,
      needed: f.deleted
        ? 'this deletion needs explicit human approval: resolve the code-created blocking scope item, or restore the file'
        : 'outside allowed_paths: ask the human to expand scope or resolve the code-created blocking scope item, then retry',
      tool_to_call: 'ledger_list_open',
    });
  }
  return out;
};

export default rule11;
