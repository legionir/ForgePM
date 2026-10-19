import type { BlockedRef, GateContext } from './gate-types';

/**
 * R-13 behavior recall check (not a numbered gate rule — it is reported via
 * `ledger-cli stats` and BEHAVIOR_OBSERVATIONS.md, threshold 30%).
 * The gate may call this as an advisory; ledger-cli enforces exit 1 if <30%.
 */
const THRESHOLD = 0.3;

export function checkBehaviorRecall(ctx: Pick<GateContext, 'behaviorRecall'>): BlockedRef[] {
  const recall = ctx.behaviorRecall ?? 1;
  if (recall < THRESHOLD) {
    return [{
      rule: 14 as never, // advisory beyond the 13 numbered rules
      ref: 'behavior-recall',
      title: `behavior recall ${Math.round(recall * 100)}% below 30% threshold`,
      needed: 'record observed behaviors as criteria/open items (see docs/BEHAVIOR_OBSERVATIONS.md) — recall must be ≥30%',
      tool_to_call: 'ledger_add_open_item',
    }];
  }
  return [];
}
export const BEHAVIOR_RECALL_THRESHOLD = THRESHOLD;
