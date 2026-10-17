import type { ExecPolicy } from '@forgepm/shared';
import { classify, GATE_VERSION } from './policy';
import { blockingOpen } from './open-items';

/**
 * Finalization Gate (docs/EXECUTION_CONTROL_PLAN.md §8, plan §C + appendix §1.2).
 * Deterministic: 13 numbered rules, each a pure function over a snapshot of the
 * ledger. Rule numbers are a public contract (tests and docs cite them), so a
 * rule may only be added at the end — never renumbered.
 */

export interface GateCriterion {
  code: string;
  status: 'pending' | 'verified' | 'waived';
  evidence_count: number;
  valid_evidence_count: number;
  has_waiver_approval: boolean;
  req_code: string | null;
  text: string;
}

export interface GateOpenItem {
  code: string;
  title: string;
  type: string;
  status: 'open' | 'resolved' | 'accepted' | 'deferred' | 'wont_fix' | 'blocked' | 'awaiting_human' | 'not_applicable';
  blocks_completion: boolean;
  source: string;
}

export interface GateDecision {
  code: string;
  title: string;
  touches: string[];
  reversible: boolean;
  approval_state: 'not_required' | 'pending' | 'approved' | 'rejected';
  applied: boolean;
  status: 'proposed' | 'active' | 'superseded' | 'needs_revisit';
}

export interface GateQuestion {
  code: string;
  blocking: boolean;
  status: 'open' | 'answered' | 'canceled';
}

export interface GateFact {
  code: string;
  status: 'active' | 'stale' | 'rejected' | 'superseded';
  active_dependent_decisions: string[];
}

export interface GateRequirement {
  code: string;
  status: 'active' | 'changed' | 'dropped';
  verified_criteria: string[];
}

export interface GateJournalRow {
  code: string;
  action: string;
  status: 'started' | 'done' | 'failed' | 'unknown';
  idempotent: boolean;
}

export interface GateBaselineRow {
  name: string;
  result_at_start: 'pass' | 'fail' | 'skip';
}

export interface GateReport {
  tests_executed: { name: string; result: 'pass' | 'fail' | 'not_run'; evidence_ref: string }[];
  tests_not_run: { name: string; reason?: string }[];
  changed_files: string[];
}

export interface GateExitReport {
  tests_executed: { name: string; result: 'pass' | 'fail'; evidence_ref: string }[];
  tests_not_run: { name: string; reason: string }[];
  incomplete: string[];
  assumptions: string[];
  risks_found: string[];
}

export interface GateReview {
  round: number;
  verdict: 'pass' | 'fail';
  tree_hash: string;
  open_blocking_findings: number;
}

export interface GateTask {
  code: string;
  status: 'not_started' | 'in_progress' | 'awaiting_review' | 'blocked' | 'done';
  children: { code: string; title: string; status: GateTask['status']; req_codes: string[]; cancelled: boolean }[];
  depends_on: { code: string; status: GateTask['status'] }[];
  human_waivers: string[];
}

export interface GateScope {
  available: boolean;
  files: { path: string; in_allowed_paths: boolean; deleted: boolean }[];
  tree_hash: string | null;
}

export interface GateBaseline {
  /** What the gate itself executed (never the agent's word). */
  ran: boolean;
  unavailable_reason: string | null;
  human_waived: boolean;
  tests: GateBaselineRow[];
  after: { present: string[]; results: Record<string, 'pass' | 'fail' | 'skip'> } | null;
}

export interface GateContext {
  gate_version: number;
  policy: ExecPolicy;
  require_review: boolean;
  max_review_rounds: number;
  task: GateTask;
  criteria: GateCriterion[];
  open_items: GateOpenItem[];
  decisions: GateDecision[];
  questions: GateQuestion[];
  facts: GateFact[];
  requirements: GateRequirement[];
  journal: GateJournalRow[];
  review: GateReview | null;
  current_tree_hash: string | null;
  scope: GateScope;
  baseline: GateBaseline;
  report: GateReport;
  /** Verbatim strings from the accepted exit report (already promoted to items). */
  report_assumptions?: string[];
}

export interface BlockedRef {
  rule: number;
  ref: string;
  title?: string;
  needed: string;
  tool_to_call?: string;
}

export type GateResult =
  | { ok: true; gate_version: number; tree_hash: string | null; counts: { criteria: number; evidence: number; decisions: number; reviews: number }; human_waivers: string[] }
  | { ok: false; gate_version: number; tree_hash: string | null; blocked_by: BlockedRef[] };

type Rule = (ctx: GateContext) => BlockedRef[];

/** rule 1 — exit report present, current and structurally valid. */
const rule01: Rule = (ctx) => {
  if (!ctx.report) return [{ rule: 1, ref: 'exit_report', needed: 'call exec_submit_exit_report with the full report', tool_to_call: 'exec_submit_exit_report' }];
  if (!Array.isArray(ctx.report.tests_executed) || !Array.isArray(ctx.report.tests_not_run)) {
    return [{ rule: 1, ref: 'exit_report', needed: 'the report is malformed: tests_executed and tests_not_run must both be arrays (use [] for none)', tool_to_call: 'exec_submit_exit_report' }];
  }
  return [];
};

/** rule 2 — no active blocking open item. */
const rule02: Rule = (ctx) =>
  blockingOpen(ctx.open_items).map((i) => ({
    rule: 2,
    ref: i.code,
    title: i.title,
    needed: 'resolve with proof (note >= 20 chars) or ask the human — never defer it yourself',
    tool_to_call: 'ledger_resolve_item',
  }));

/** rule 3 — every criterion has valid evidence or a human waiver. */
const rule03: Rule = (ctx) =>
  ctx.criteria
    .filter((c) => c.status !== 'waived' && c.valid_evidence_count === 0)
    .map((c) => ({
      rule: 3,
      ref: c.code,
      title: c.text.slice(0, 120),
      needed: c.evidence_count > 0 ? 'evidence exists but is not verifiable (ref missing or output empty) — add valid evidence' : 'add evidence',
      tool_to_call: 'ledger_add_evidence',
    }))
    .filter(Boolean) as BlockedRef[];

/** rule 4 — no pending/rejected approval whose change was already applied. */
const rule04: Rule = (ctx) => {
  const out: BlockedRef[] = [];
  for (const d of ctx.decisions) {
    const level = classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level;
    if (level === 'deny' && d.applied) {
      out.push({ rule: 4, ref: d.code, needed: 'the change is denied by policy — revert it and ask the human', tool_to_call: 'ledger_ask_human' });
      continue;
    }
    if (level !== 'approval' && level !== 'deny') continue;
    if (d.approval_state === 'pending') {
      out.push({ rule: 4, ref: d.code, needed: 'await human approval before closing', tool_to_call: 'ledger_ask_human' });
    } else if (d.approval_state === 'rejected' && d.applied) {
      out.push({ rule: 4, ref: d.code, needed: 'decision was rejected but the change is applied — revert it', tool_to_call: 'ledger_record_decision' });
    }
  }
  return out;
};

/** rule 5 — no unanswered blocking question. */
const rule05: Rule = (ctx) =>
  ctx.questions
    .filter((q) => q.blocking && q.status === 'open')
    .map((q) => ({ rule: 5, ref: q.code, needed: 'waiting for a human answer (silence is not approval)', tool_to_call: 'ledger_list_open' }));

/** rule 6 — no failed test; every not_run needs a reason and a matching item. */
const rule06: Rule = (ctx) => {
  const out: BlockedRef[] = [];
  // rule 1 already reports a missing report; this guard keeps the engine total
  // (a caller that builds a context by hand must never crash the gate).
  const report = Array.isArray(ctx.report?.tests_executed) && Array.isArray(ctx.report?.tests_not_run)
    ? ctx.report
    : { tests_executed: [], tests_not_run: [], changed_files: [] };
  for (const t of report.tests_executed) {
    if (t.result === 'fail') out.push({ rule: 6, ref: t.name, needed: 'fix the failing test (do not weaken or delete it)', tool_to_call: 'ledger_add_open_item' });
  }
  for (const t of report.tests_not_run) {
    const linked = ctx.open_items.some((i) => i.type === 'test_gap' && i.title.toLowerCase().includes(t.name.toLowerCase().slice(0, 40)));
    if (!t.reason || t.reason.trim().length < 20) {
      out.push({ rule: 6, ref: t.name, needed: 'record why the test was not run (>= 20 chars) and add a matching open item', tool_to_call: 'ledger_add_open_item' });
    } else if (!linked) {
      out.push({ rule: 6, ref: t.name, needed: "add open_item(type='test_gap') for this not_run test", tool_to_call: 'ledger_add_open_item' });
    }
  }
  return out;
};

/** rule 7 — adversarial review of THIS version is done and its blockers closed. */
const rule07: Rule = (ctx) => {
  if (!ctx.require_review) return [];
  const out: BlockedRef[] = [];
  if (!ctx.review) {
    out.push({ rule: 7, ref: 'review', needed: 'call review_task to run the adversarial reviewer on the current diff', tool_to_call: 'review_task' });
    return out;
  }
  if (ctx.current_tree_hash && ctx.review.tree_hash !== ctx.current_tree_hash) {
    out.push({ rule: 7, ref: `review:r${ctx.review.round}`, needed: 'the diff changed after the review — re-run review_task', tool_to_call: 'review_task' });
  }
  if (ctx.review.verdict === 'fail' || ctx.review.open_blocking_findings > 0) {
    out.push({
      rule: 7,
      ref: `review:r${ctx.review.round}`,
      needed:
        ctx.review.round >= ctx.max_review_rounds
          ? 'review round limit reached — a human must decide (fix, waive, or accept the finding)'
          : 'fix the blocking review findings and re-run review_task',
      tool_to_call: ctx.review.round >= ctx.max_review_rounds ? 'ledger_ask_human' : 'review_task',
    });
  }
  return out;
};

/** rule 8 — every linked requirement is covered by a verified criterion. */
const rule08: Rule = (ctx) =>
  ctx.requirements
    .filter((rq) => rq.status !== 'dropped')
    .filter((rq) => rq.verified_criteria.length === 0)
    .map((rq) => ({
      rule: 8,
      ref: rq.code,
      needed: 'this requirement has no verified acceptance criterion — implement it or link/verify a criterion (dropping needs human approval)',
      tool_to_call: 'req_link_task',
    }));

/** rule 9 — children done/cancelled-with-approval, dependencies done. */
const rule09: Rule = (ctx) => {
  const out: BlockedRef[] = [];
  for (const c of ctx.task.children) {
    if (c.status === 'done') continue;
    if (c.cancelled && (ctx.task.human_waivers.includes(`cancel:${c.code}`) || ctx.task.human_waivers.includes(`cancel:${c.code}:${c.req_codes.join(',')}`))) continue;
    out.push({ rule: 9, ref: c.code, title: c.title, needed: 'finish the subtask (or have a human cancel it)', tool_to_call: 'exec_plan_view' });
  }
  for (const d of ctx.task.depends_on) {
    if (d.status !== 'done') out.push({ rule: 9, ref: d.code, needed: `dependency is '${d.status}', not done`, tool_to_call: 'exec_plan_view' });
  }
  return out;
};

/** rule 10 — no stale/rejected fact feeding an active decision. */
const rule10: Rule = (ctx) =>
  ctx.facts
    .filter((f) => f.status === 'stale' || f.status === 'rejected')
    .filter((f) => f.active_dependent_decisions.length > 0)
    .map((f) => ({
      rule: 10,
      ref: f.code,
      needed: `re-verify the fact or revisit decision(s) ${f.active_dependent_decisions.join(', ')}`,
      tool_to_call: 'fact_verify',
    }));

/** rule 11 — no file outside allowed_paths without human approval. */
const rule11: Rule = (ctx) => {
  if (!ctx.scope.available) {
    return [{ rule: 11, ref: 'scope', needed: 'scope cannot be measured (no start_ref/manifest) — record start_ref or ask the human to waive', tool_to_call: 'scope_check' }];
  }
  const out: BlockedRef[] = [];
  for (const f of ctx.scope.files) {
    if (!f.in_allowed_paths) {
      out.push({ rule: 11, ref: f.path, needed: f.deleted ? 'deleted outside the allowed scope — needs human approval' : 'outside allowed_paths — ask the human for scope_expansion or revert', tool_to_call: 'ledger_ask_human' });
    }
  }
  return out;
};

/** rule 12 — the gate itself ran the tests: no baseline pass turned fail/skip/gone. */
const rule12: Rule = (ctx) => {
  if (ctx.baseline.human_waived) return [];
  if (!ctx.baseline.ran) {
    return [
      {
        rule: 12,
        ref: 'baseline',
        needed: ctx.baseline.unavailable_reason
          ? `baseline could not run (${ctx.baseline.unavailable_reason}) — fix the runner/CI source or have a human waive explicitly`
          : 'the gate must run exec.test_command before closing — enable a baseline source',
        tool_to_call: 'baseline_capture',
      },
    ];
  }
  const out: BlockedRef[] = [];
  const after = ctx.baseline.after;
  for (const b of ctx.baseline.tests) {
    if (b.result_at_start !== 'pass') continue;
    if (!after) continue;
    if (!after.present.includes(b.name)) {
      out.push({ rule: 12, ref: b.name, needed: 'a passing baseline test disappeared — restore it (deleting a test to go green is banned)', tool_to_call: 'ledger_resolve_item' });
    } else if (after.results[b.name] !== 'pass') {
      out.push({ rule: 12, ref: b.name, needed: `baseline test now reports '${after.results[b.name]}' — fix the cause, do not weaken the test`, tool_to_call: 'ledger_add_open_item' });
    }
  }
  return out;
};

/** rule 13 — no unfinished journal rows for this task. */
const rule13: Rule = (ctx) =>
  ctx.journal
    .filter((j) => j.status === 'started' || j.status === 'unknown')
    .map((j) => ({
      rule: 13,
      ref: j.code,
      title: j.action,
      needed: j.status === 'unknown' ? 'determine the real state first, then journal_done/journal_fail' : 'finish the action and call journal_done (or journal_fail with a note)',
      tool_to_call: 'journal_done',
    }));

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

export function evaluateGate(ctx: GateContext): GateResult {
  const blocked: BlockedRef[] = [];
  // gate_version is a public contract: a stale caller must not silently pass.
  if (ctx.gate_version !== GATE_VERSION) {
    return {
      ok: false,
      gate_version: GATE_VERSION,
      tree_hash: ctx.current_tree_hash,
      blocked_by: [{ rule: 1, ref: 'gate_version', needed: `caller gate_version ${ctx.gate_version} != engine ${GATE_VERSION}`, tool_to_call: 'exec_task_complete' }],
    };
  }
  for (const rule of GATE_RULES) blocked.push(...rule.run(ctx));
  if (blocked.length) {
    return { ok: false, gate_version: GATE_VERSION, tree_hash: ctx.current_tree_hash, blocked_by: blocked };
  }
  return {
    ok: true,
    gate_version: GATE_VERSION,
    tree_hash: ctx.current_tree_hash,
    counts: {
      criteria: ctx.criteria.length,
      evidence: ctx.criteria.reduce((a, c) => a + c.valid_evidence_count, 0),
      decisions: ctx.decisions.length,
      reviews: ctx.review ? ctx.review.round : 0,
    },
    human_waivers: ctx.task.human_waivers,
  };
}

/**
 * Status after a failed gate: anything the human must touch => awaiting_review,
 * otherwise the task stays in progress. Pure + tested (acceptance §C).
 */
export function deriveStatusAfterFailure(ctx: GateContext, blocked: BlockedRef[]): 'in_progress' | 'awaiting_review' | 'blocked' {
  const humanRules = new Set([4, 5, 7, 9, 11, 12]);
  if (blocked.some((b) => humanRules.has(b.rule))) return 'awaiting_review';
  if (ctx.task.status === 'blocked') return 'blocked';
  return 'in_progress';
}

/** The completion report is generated FROM THE LEDGER, never from memory. */
export interface FinalReport {
  task: string;
  summary: string;
  completed: { criterion: string; evidence: number }[];
  accepted_or_deferred: GateOpenItem[];
  decisions: { code: string; title: string; level: string; approval_state: string }[];
  needs_human_review: string[];
  assumptions: string[];
  out_of_scope: string[];
  counts: { criteria_verified: number; criteria_pending: number; open_blocking: number; review_rounds: number };
}

function outOfScope(ctx: GateContext): string[] {
  return ctx.open_items.filter((i) => i.type === 'out_of_scope').map((i) => `${i.code} ${i.title}`);
}

export function buildFinalReport(ctx: GateContext, summary: string, reviewRounds: number): FinalReport {
  const humanReview: string[] = [];
  for (const d of ctx.decisions) {
    const level = classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level;
    if (level === 'review' || d.approval_state !== 'not_required') {
      humanReview.push(`${d.code} ${level}/${d.approval_state}${d.status === 'needs_revisit' ? ' (needs revisit)' : ''}`);
    }
  }
  for (const w of ctx.task.human_waivers) humanReview.push(`waived: ${w}`);
  for (const q of ctx.questions.filter((x) => x.status === 'answered')) humanReview.push(`answered ${q.code}: confirm the implementation follows it`);
  return {
    task: ctx.task.code,
    summary,
    completed: ctx.criteria.filter((c) => c.status === 'verified').map((c) => ({ criterion: c.text, evidence: c.valid_evidence_count })),
    accepted_or_deferred: ctx.open_items.filter((i) => i.status === 'accepted' || i.status === 'deferred' || i.status === 'wont_fix' || i.status === 'not_applicable'),
    decisions: ctx.decisions.map((d) => ({ code: d.code, title: d.title, level: classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level, approval_state: d.approval_state })),
    needs_human_review: humanReview,
    assumptions: ctx.report_assumptions ?? [],
    out_of_scope: outOfScope(ctx),
    counts: {
      criteria_verified: ctx.criteria.filter((c) => c.status === 'verified').length,
      criteria_pending: ctx.criteria.filter((c) => c.status === 'pending').length,
      open_blocking: blockingOpen(ctx.open_items).length,
      review_rounds: reviewRounds,
    },
  };
}
