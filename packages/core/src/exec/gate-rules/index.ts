import type { Rule } from '../gate-types';
import rule01 from './rule01-exit-report';
import rule02 from './rule02-blocking-items';
import rule03 from './rule03-criteria-evidence';
import rule04 from './rule04-approvals';
import rule05 from './rule05-questions';
import rule06 from './rule06-tests';
import rule07 from './rule07-review';
import rule08 from './rule08-requirements';
import rule09 from './rule09-plan';
import rule10 from './rule10-facts';
import rule11 from './rule11-scope';
import rule12 from './rule12-baseline';
import rule13 from './rule13-journal';

/**
 * The thirteen rules, in their fixed order (docs/EXECUTION_CONTROL_PLAN.md §8.2).
 *
 * The numbering is a public contract: the docs, the tests and the agents' own
 * error messages all cite it, so a rule may only be *added* at the end — never
 * renumbered, never reordered. `gate.test.ts` pins the list so an accidental
 * shuffle fails the build rather than changing what "rule 4" means.
 */
export const GATE_RULES: ReadonlyArray<{ n: number; name: string; run: Rule }> = [
  { n: 1, name: 'exit_report_valid', run: rule01 },
  { n: 2, name: 'no_blocking_open_items', run: rule02 },
  { n: 3, name: 'criteria_have_evidence', run: rule03 },
  { n: 4, name: 'no_pending_or_rejected_approvals', run: rule04 },
  { n: 5, name: 'no_unanswered_blocking_questions', run: rule05 },
  { n: 6, name: 'tests_pass_or_justified', run: rule06 },
  { n: 7, name: 'adversarial_review_current', run: rule07 },
  { n: 8, name: 'requirements_covered', run: rule08 },
  { n: 9, name: 'plan_children_and_deps_done', run: rule09 },
  { n: 10, name: 'no_stale_fact_dependency', run: rule10 },
  { n: 11, name: 'scope_respected', run: rule11 },
  { n: 12, name: 'baseline_intact', run: rule12 },
  { n: 13, name: 'journal_settled', run: rule13 },
];

export const GATE_RULE_NUMBERS = GATE_RULES.map((r) => r.n);
