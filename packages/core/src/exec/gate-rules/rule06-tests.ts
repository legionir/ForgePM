import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 6 — no failing test; every not_run test needs a reason AND an item.
 *
 * "I did not run it" is allowed, but only with a written reason and an open
 * item that says so — otherwise a missing test is indistinguishable from a
 * test that was quietly deleted.
 */
const rule06: Rule = (ctx: GateContext): BlockedRef[] => {
  const out: BlockedRef[] = [];
  // A missing report is rule 1's business; this rule has nothing to say about it.
  const report = ctx.report;
  if (!report) return out;
  // Rule 1 reports malformed shape. Other rules still run to collect blockers,
  // so do not let an invalid report crash the gate while that blocker is built.
  if (!Array.isArray(report.tests_executed) || !Array.isArray(report.tests_not_run)) return out;
  for (const t of report.tests_executed) {
    if (t.result === 'fail')
      out.push({
        rule: 6,
        ref: t.name,
        title: `failing test ${t.name}`,
        needed: 'fix the failing test (do not weaken or delete it)',
        tool_to_call: 'ledger_add_open_item',
      });
  }
  for (const t of report.tests_not_run) {
    const linked = ctx.open_items.some(
      (i) => i.type === 'test_gap' && i.title.toLowerCase().includes(t.name.toLowerCase().slice(0, 40)),
    );
    if (!t.reason || t.reason.trim().length < 20) {
      out.push({
        rule: 6,
        ref: t.name,
        title: `test not run: ${t.name}`,
        needed: 'record why the test was not run (>= 20 chars) and add a matching open item',
        tool_to_call: 'ledger_add_open_item',
      });
    } else if (!linked) {
      out.push({
        rule: 6,
        ref: t.name,
        title: `test not run: ${t.name}`,
        needed: "add open_item(type='test_gap') for this not_run test",
        tool_to_call: 'ledger_add_open_item',
      });
    }
  }
  return out;
};

export default rule06;
