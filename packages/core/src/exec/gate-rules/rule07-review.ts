import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 7 — the adversarial review of THIS version is done and its blockers closed.
 *
 * A review of an older tree does not count: the tree hash is the witness, so a
 * diff that changed after the review sends the task back to the reviewer
 * instead of closing on a stale verdict.
 */
const rule07: Rule = (ctx: GateContext): BlockedRef[] => {
  if (!ctx.require_review) return [];
  const out: BlockedRef[] = [];
  if (!ctx.review) {
    out.push({
      rule: 7,
      ref: 'review',
      title: 'the adversarial review of this version',
      needed: 'call review_task to run the adversarial reviewer on the current diff',
      tool_to_call: 'review_task',
    });
    return out;
  }
  if (!ctx.current_tree_hash) {
    out.push({
      rule: 7,
      ref: `review:r${ctx.review.round}`,
      title: `review round ${ctx.review.round} cannot be freshness-checked`,
      needed: 'the current worktree hash is unavailable — configure a valid start_ref and allowed review roots, or ask a human to inspect the task',
      tool_to_call: 'ledger_ask_human',
    });
  } else if (ctx.review.tree_hash !== ctx.current_tree_hash) {
    out.push({
      rule: 7,
      ref: `review:r${ctx.review.round}`,
      title: `review round ${ctx.review.round} is stale`,
      needed: 'the diff changed after the review — re-run review_task',
      tool_to_call: 'review_task',
    });
  }
  const arbitrationRef = `review-arbitration:${ctx.task.code}:r${ctx.review.round}:${ctx.review.tree_hash}`;
  const humanArbitrated = ctx.open_items.some((item) =>
    item.source === 'reviewer' &&
    item.type === 'risk' &&
    item.title.trim().toLowerCase().startsWith('human arbitration required') &&
    item.related_ref === arbitrationRef &&
    item.resolved_by === 'human' &&
    !['open', 'blocked', 'awaiting_human'].includes(item.status),
  );
  if ((ctx.review.verdict === 'fail' || ctx.review.open_blocking_findings > 0) && !humanArbitrated) {
    out.push({
      rule: 7,
      ref: `review:r${ctx.review.round}`,
      title: `review round ${ctx.review.round} did not pass`,
      needed:
        ctx.review.round >= ctx.max_review_rounds
          ? 'review round limit reached — a human must decide (fix, waive, or accept the finding)'
          : 'fix the blocking review findings and re-run review_task',
      tool_to_call: ctx.review.round >= ctx.max_review_rounds ? 'ledger_ask_human' : 'review_task',
    });
  }
  return out;
};

export default rule07;
