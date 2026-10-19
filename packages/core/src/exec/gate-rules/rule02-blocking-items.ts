import { blockingOpen } from '../open-items';
import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 2 — no active blocking open item.
 *
 * An accepted/deferred item does not block: only the *active* states
 * (open/blocked/awaiting_human) do, which is what `blockingOpen` means.
 */
const rule02: Rule = (ctx: GateContext): BlockedRef[] =>
  blockingOpen(ctx.open_items).map((i) => ({
    rule: 2,
    ref: i.code,
    title: i.title,
    needed: 'resolve with proof (note >= 20 chars) or ask the human — never defer it yourself',
    tool_to_call: 'ledger_resolve_item',
  }));

export default rule02;
