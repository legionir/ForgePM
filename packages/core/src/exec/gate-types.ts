import type { ExecPolicy } from '@forgepm/shared';

/**
 * The gate's vocabulary (docs/EXECUTION_CONTROL_PLAN.md §8).
 *
 * These types were moved out of `gate.ts` when PE-3 split the thirteen rules
 * into `gate-rules/`: the file had to come back under the 400-line cap (C.11)
 * and the shapes are shared by the rules, the context loader and the report
 * builder. Nothing here decides anything — it only names what the rules read.
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
  related_ref?: string | null;
  /** Needed to distinguish an explicit human arbitration from an automatic pass. */
  resolved_by?: 'agent' | 'human' | null;
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
  /** A completed action may name the decision code it applied (for example D-001). */
  target?: string | null;
}

export interface GateBaselineRow {
  name: string;
  result_at_start: 'pass' | 'fail' | 'skip';
  source?: 'ci' | 'human';
}

export interface GateReport {
  summary?: string;
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
  basis: 'git' | 'manifest' | 'none';
  unavailable_reason: string | null;
  human_waived: boolean;
  files: {
    path: string;
    change: 'A' | 'M' | 'D' | 'R' | 'T';
    in_allowed_paths: boolean;
    deleted: boolean;
    transient: boolean;
  }[];
  tree_hash: string | null;
}

export interface GateBaseline {
  /** True only when CI logs for both exact commit SHAs were parsed successfully. */
  ran: boolean;
  unavailable_reason: string | null;
  human_waived: boolean;
  start_sha: string | null;
  current_sha: string | null;
  tests: GateBaselineRow[];
  after: {
    sha: string;
    run_id: string;
    job: string;
    present: string[];
    results: Record<string, 'pass' | 'fail' | 'skip'>;
  } | null;
  weakening: { path: string; count_delta: number; modifiers: string[] }[];
}

/**
 * The gate stamp (C.9b). `done` is only ever true when the newest stamp for the
 * task says `ok` and its `tree_hash` is the tree the task is being closed on —
 * a hand-written `status='done'` therefore has no stamp to point at.
 */
export interface GateStamp {
  stamp_id: string | null;
  ok: boolean;
  tree_hash: string | null;
  gate_version: number;
}

export interface GateContext {
  gate_version: number;
  policy: ExecPolicy;
  require_review: boolean;
  max_review_rounds: number;
  /** R-13: ledger recall of observed behaviors (0..1, threshold 0.3) */
  behaviorRecall?: number;
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
  /** The exit report, or null when the task never submitted one (rule 1). */
  report: GateReport | null;
  /** Verbatim strings from the accepted exit report (already promoted to items). */
  report_assumptions?: string[];
  /** The task's own gate stamp, for C.9b. */
  stamp?: GateStamp;
}

export interface BlockedRef {
  rule: number;
  /** What the block is about: an item code, a criterion code, a file, a test. */
  ref: string;
  /** One short line saying what is blocked — the same shape for every rule. */
  title: string;
  /** What has to happen before the task may close. */
  needed: string;
  /** The tool that can move it. */
  tool_to_call?: string;
}

/** A rule is a pure function over the snapshot: same rows in, same answer out. */
export type Rule = (ctx: GateContext) => BlockedRef[];

/**
 * The completion report (plan §8.2) — always generated FROM the ledger, never
 * from the agent's prose.
 */
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
