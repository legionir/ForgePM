import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 12 — exact-SHA CI evidence did not lose or weaken a baseline test.
 *
 * The "after" numbers come from the gate, never from the agent: ForgePM does
 * not run repo code itself, so the baseline is what CI recorded and the
 * comparison is arithmetic. Deleting a test to go green is never a pass.
 */
type CapturedAfter = NonNullable<GateContext['baseline']['after']>;

const rule12: Rule = (ctx: GateContext): BlockedRef[] => {
  if (!ctx.report) return [];
  if (!ctx.baseline.ran) return ctx.baseline.human_waived ? [] : [missingBaseline(ctx)];
  const after = ctx.baseline.after;
  if (!after || after.sha !== ctx.baseline.current_sha) return [missingCurrentRun()];
  return [...compareTestResults(ctx, after), ...testWeakening(ctx)];
};

function missingBaseline(ctx: GateContext): BlockedRef {
  return {
    rule: 12,
    ref: 'baseline',
    title: 'the CI baseline could not be verified for the exact commit SHAs',
    needed: `BASELINE_UNAVAILABLE${ctx.baseline.unavailable_reason ? `: ${ctx.baseline.unavailable_reason}` : ''} — capture CI logs matching the task start and current commit SHA, or have a human waive explicitly`,
    tool_to_call: 'baseline_capture',
  };
}

function missingCurrentRun(): BlockedRef {
  return {
    rule: 12,
    ref: 'baseline',
    title: 'the current CI results do not match the measured commit',
    needed: 'capture a CI log for the exact current commit SHA; exit-report test claims are ignored',
    tool_to_call: 'baseline_capture',
  };
}

function compareTestResults(ctx: GateContext, after: CapturedAfter): BlockedRef[] {
  const out: BlockedRef[] = [];
  for (const baseline of ctx.baseline.tests) {
    if (baseline.result_at_start !== 'pass') continue;
    if (!after.present.includes(baseline.name)) {
      out.push({
        rule: 12,
        ref: baseline.name,
        title: `baseline test ${baseline.name} disappeared`,
        needed: 'a passing baseline test disappeared — restore it, then capture CI for the new commit',
        tool_to_call: 'baseline_capture',
      });
    } else if (after.results[baseline.name] !== 'pass') {
      out.push({
        rule: 12,
        ref: baseline.name,
        title: `baseline test ${baseline.name} is no longer green`,
        needed: `the CI log for ${after.sha} reports '${after.results[baseline.name]}' — fix the cause and capture CI for the new commit`,
        tool_to_call: 'baseline_capture',
      });
    }
  }
  const baselineNames = new Set(ctx.baseline.tests.map((test) => test.name));
  for (const name of after.present) {
    if (baselineNames.has(name) || after.results[name] === 'pass') continue;
    out.push({
      rule: 12,
      ref: name,
      title: `new test ${name} is not green`,
      needed: `the CI log for ${after.sha} reports '${after.results[name]}' for a test not present in the baseline — fix it and capture CI for the new commit`,
      tool_to_call: 'baseline_capture',
    });
  }
  return out;
}

function testWeakening(ctx: GateContext): BlockedRef[] {
  return ctx.baseline.weakening
    .filter((finding) => finding.count_delta < 0 || finding.modifiers.length > 0)
    .map((finding): BlockedRef => ({
      rule: 12,
      ref: finding.path,
      title: `protected test file was weakened: ${finding.path}`,
      needed: `restore assertions and remove test modifiers (${finding.modifiers.join(', ') || 'assertion count decreased'}), then capture CI for the new commit`,
      tool_to_call: 'baseline_capture',
    }));
}

export default rule12;
