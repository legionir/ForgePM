import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 1 — the exit report is present, current and structurally valid.
 *
 * "Absent" is the common case (an agent that never submitted one) and it is
 * the only rule that may talk about the report's shape: the other twelve read
 * what the report produced, not the report itself.
 */
const rule01: Rule = (ctx: GateContext): BlockedRef[] => {
  if (!ctx.report)
    return [
      {
        rule: 1,
        ref: 'exit_report',
        title: 'the exit report is missing',
        needed: 'call exec_submit_exit_report with the full report',
        tool_to_call: 'exec_submit_exit_report',
      },
    ];
  if (!Array.isArray(ctx.report.tests_executed) || !Array.isArray(ctx.report.tests_not_run)) {
    return [
      {
        rule: 1,
        ref: 'exit_report',
        title: 'the exit report is malformed',
        needed: 'the report is malformed: tests_executed and tests_not_run must both be arrays (use [] for none)',
        tool_to_call: 'exec_submit_exit_report',
      },
    ];
  }
  return [];
};

export default rule01;
