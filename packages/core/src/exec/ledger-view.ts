import type { ExecOpenItemStatus } from '@forgepm/shared';
import { detectGateStampDrift } from './drift';
import { blockingOpen, isActiveOpenItem } from './open-items';

/**
 * Ledger status projection (docs/EXECUTION_CONTROL_PLAN.md §6 acceptance A.1).
 *
 * `exec_ledger_status` must answer one question with no agent judgement
 * involved: "what is still open, and what is missing, for this task?" Loading the
 * rows is the repository's job; deciding what they mean is this pure function, so
 * the answer is identical whether it is asked over MCP, over REST or by the CLI,
 * and so that the rules are testable without a database.
 */

export interface LedgerTaskLite {
  code: string;
  title: string;
  status: string;
  closed_at: string | null;
  start_ref: string | null;
  tree_hash_start: string | null;
  allowed_paths: string[];
}

export interface LedgerCriterionLite {
  code: string;
  text: string;
  /** §7: a criterion is only satisfiable with evidence attached. */
  requires_evidence: boolean;
}

export interface LedgerEvidenceLite {
  criterion_code: string;
  kind: string;
  ref: string;
  summary: string;
}

export interface LedgerItemLite {
  code: string;
  title: string;
  type: string;
  status: ExecOpenItemStatus;
  blocks_completion: boolean;
}

export interface LedgerQuestionLite {
  code: string;
  question: string;
  answered_at: string | null;
  blocking: boolean;
}

export interface LedgerDecisionLite {
  code: string;
  title: string;
  approved: boolean;
  /** Decisions whose approval level is 'approval' still gate the task (§18 D-*). */
  needs_approval: boolean;
}

export interface LedgerRequirementCoverageLite {
  code: string;
  status: string;
  covered_by_tasks: string[];
}

export interface LedgerStatusInput {
  task: LedgerTaskLite;
  criteria: LedgerCriterionLite[];
  evidence: LedgerEvidenceLite[];
  items: LedgerItemLite[];
  questions: LedgerQuestionLite[];
  decisions: LedgerDecisionLite[];
  requirements?: LedgerRequirementCoverageLite[];
  /** The newest gate stamp for the task, if the gate has ever run on it. */
  gate_stamp?: { ok: boolean; stamp_id: string | null } | null;
}

export interface LedgerStatusView {
  task: { code: string; title: string; status: string; closed_at: string | null };
  baseline: { start_ref: string | null; tree_hash_start: string | null; allowed_paths: string[] };
  counts: {
    criteria: number;
    criteria_with_evidence: number;
    open_items: number;
    blockers: number;
    questions_unanswered: number;
    decisions_pending: number;
  };
  blockers: string[];
  open_item_codes: string[];
  /** Criteria that demand evidence and have none — the gate's rule 3 input. */
  criteria_without_evidence: string[];
  /** Criteria with evidence, by code, so a reviewer can follow each claim. */
  criteria_evidence: { code: string; kinds: string[]; refs: string[] }[];
  questions_unanswered: string[];
  blocking_questions: string[];
  decisions_pending: string[];
  requirements_uncovered: string[];
  /** C.9b: the task says done but the gate never stamped it. */
  drift: string | null;
  /** A single answer for whoever asked: can this task be finished right now? */
  ready_to_submit: boolean;
  reasons_not_ready: string[];
}

/**
 * Pure. Deterministic order (codes, ascending) so two runs on the same rows print
 * the same report — a status tool that reorders itself trains people to re-run it.
 */
export function buildLedgerStatus(input: LedgerStatusInput): LedgerStatusView {
  const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const items = [...input.items].sort(byCode);
  const openItems = items.filter((i) => isActiveOpenItem(i.status));
  const blockers = blockingOpen(items).map((i) => i.code);
  const criteria = [...input.criteria].sort(byCode);
  const evidenceByCriterion = new Map<string, LedgerEvidenceLite[]>();
  for (const ev of input.evidence) {
    const list = evidenceByCriterion.get(ev.criterion_code) ?? [];
    list.push(ev);
    evidenceByCriterion.set(ev.criterion_code, list);
  }
  const missing = criteria
    .filter((c) => c.requires_evidence && !(evidenceByCriterion.get(c.code)?.length ?? 0))
    .map((c) => c.code)
    .sort();
  const withEvidence = criteria.filter((c) => evidenceByCriterion.get(c.code)?.length ?? false);
  const questions = [...input.questions].sort(byCode);
  const unanswered = questions.filter((q) => !q.answered_at);
  const decisions = [...input.decisions].sort(byCode);
  const pendingDecisions = decisions.filter((d) => d.needs_approval && !d.approved).map((d) => d.code);
  const uncovered = (input.requirements ?? [])
    .filter((r) => r.status !== 'dropped' && r.covered_by_tasks.length === 0)
    .map((r) => r.code)
    .sort();

  const reasons: string[] = [];
  if (blockers.length) reasons.push(`${blockers.length} blocking open item(s): ${blockers.join(', ')}`);
  if (missing.length) reasons.push(`${missing.length} criterion/criteria without evidence: ${missing.join(', ')}`);
  if (unanswered.some((q) => q.blocking))
    reasons.push(
      `unanswered blocking question(s): ${unanswered
        .filter((q) => q.blocking)
        .map((q) => q.code)
        .join(', ')}`,
    );
  if (pendingDecisions.length) reasons.push(`decision(s) awaiting approval: ${pendingDecisions.join(', ')}`);
  if (uncovered.length) reasons.push(`requirement(s) no task covers: ${uncovered.join(', ')}`);
  const drift = detectGateStampDrift({ status: input.task.status, stamp: input.gate_stamp ?? null });
  if (drift) reasons.push(drift);

  return {
    task: {
      code: input.task.code,
      title: input.task.title,
      status: input.task.status,
      closed_at: input.task.closed_at,
    },
    baseline: {
      start_ref: input.task.start_ref,
      tree_hash_start: input.task.tree_hash_start,
      allowed_paths: [...input.task.allowed_paths].sort(),
    },
    counts: {
      criteria: criteria.length,
      criteria_with_evidence: withEvidence.length,
      open_items: openItems.length,
      blockers: blockers.length,
      questions_unanswered: unanswered.length,
      decisions_pending: pendingDecisions.length,
    },
    blockers,
    open_item_codes: openItems.map((i) => i.code),
    criteria_without_evidence: missing,
    criteria_evidence: withEvidence
      .map((c) => {
        const evs = evidenceByCriterion.get(c.code) ?? [];
        return { code: c.code, kinds: [...new Set(evs.map((e) => e.kind))].sort(), refs: evs.map((e) => e.ref).sort() };
      })
      .sort(byCode),
    questions_unanswered: unanswered.map((q) => q.code),
    blocking_questions: unanswered.filter((q) => q.blocking).map((q) => q.code),
    decisions_pending: pendingDecisions,
    requirements_uncovered: uncovered,
    drift,
    ready_to_submit: reasons.length === 0,
    reasons_not_ready: reasons,
  };
}
