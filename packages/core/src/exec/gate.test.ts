import { describe, expect, it } from 'vitest';
import type { ExecPolicy } from '@forgepm/shared';
import { EXEC_POLICY_DEFAULT, GATE_VERSION } from './policy';
import {
  GATE_RULES,
  buildFinalReport,
  deriveStatusAfterFailure,
  evaluateGate,
  type GateContext,
} from './gate';

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    gate_version: GATE_VERSION,
    policy: EXEC_POLICY_DEFAULT as ExecPolicy,
    require_review: true,
    max_review_rounds: 2,
    task: { code: 'T-001', status: 'in_progress', children: [], depends_on: [], human_waivers: [] },
    criteria: [{ code: 'C-1', status: 'verified', evidence_count: 1, valid_evidence_count: 1, has_waiver_approval: false, req_code: 'REQ-1', text: 'login returns 401 on revoked token' }],
    open_items: [],
    decisions: [],
    questions: [],
    facts: [],
    requirements: [{ code: 'REQ-1', status: 'active', verified_criteria: ['C-1'] }],
    journal: [],
    review: { round: 1, verdict: 'pass', tree_hash: 'abc', open_blocking_findings: 0 },
    current_tree_hash: 'abc',
    scope: { available: true, files: [], tree_hash: 'abc' },
    baseline: { ran: true, unavailable_reason: null, human_waived: false, tests: [{ name: 'auth > logs in', result_at_start: 'pass' }], after: { present: ['auth > logs in'], results: { 'auth > logs in': 'pass' } } },
    report: { tests_executed: [{ name: 'auth > logs in', result: 'pass', evidence_ref: 'test:auth > logs in' }], tests_not_run: [], changed_files: ['packages/core/src/x.ts'] },
    ...over,
  };
}

describe('finalization gate (plan §C, acceptance C.1–C.12)', () => {
  it('C.1 exposes exactly 13 numbered rules, contiguous and stable', () => {
    expect(GATE_RULES.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(new Set(GATE_RULES.map((r) => r.name)).size).toBe(13);
  });

  it('a fully clean ledger passes and returns the deterministic counts', () => {
    const r = evaluateGate(ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.counts).toEqual({ criteria: 1, evidence: 1, decisions: 0, reviews: 1 });
      expect(r.gate_version).toBe(GATE_VERSION);
      expect(r.tree_hash).toBe('abc');
    }
  });

  it('C.2 rule 2: a blocking open item blocks with the item code and next tool', () => {
    const r = evaluateGate(ctx({ open_items: [{ code: 'OI-1', title: 'rate limit missing', type: 'defect', status: 'open', blocks_completion: true, source: 'agent' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const b = r.blocked_by.find((x) => x.rule === 2);
      expect(b?.ref).toBe('OI-1');
      expect(b?.tool_to_call).toBe('ledger_resolve_item');
    }
  });

  it('C.3 an accepted/deferred item does not block', () => {
    const r = evaluateGate(ctx({ open_items: [{ code: 'OI-1', title: 't', type: 'debt', status: 'deferred', blocks_completion: true, source: 'agent' }] }));
    expect(r.ok).toBe(true);
  });

  it('C.4 rule 3: a criterion with unverifiable evidence blocks; a waived one does not', () => {
    const bad = evaluateGate(ctx({ criteria: [{ ...ctx().criteria[0], status: 'pending', evidence_count: 2, valid_evidence_count: 0 }] }));
    expect(!bad.ok && bad.blocked_by.some((b) => b.rule === 3 && b.needed.includes('not verifiable'))).toBe(true);
    const waived = evaluateGate(ctx({ criteria: [{ ...ctx().criteria[0], status: 'waived', valid_evidence_count: 0 }] }));
    expect(waived.ok).toBe(true);
  });

  it('C.5 rule 4: a pending approval blocks; an approved-and-applied change does not', () => {
    const pending = evaluateGate(ctx({ decisions: [{ code: 'D-1', title: 'add column', touches: ['db_schema'], reversible: true, approval_state: 'pending', applied: true, status: 'active' }] }));
    expect(!pending.ok && pending.blocked_by.some((b) => b.rule === 4)).toBe(true);
    const approved = evaluateGate(ctx({ decisions: [{ code: 'D-1', title: 'add column', touches: ['db_schema'], reversible: true, approval_state: 'approved', applied: true, status: 'active' }] }));
    expect(approved.ok).toBe(true);
    const rejectedApplied = evaluateGate(ctx({ decisions: [{ code: 'D-1', title: 'x', touches: ['db_schema'], reversible: true, approval_state: 'rejected', applied: true, status: 'active' }] }));
    expect(!rejectedApplied.ok && rejectedApplied.blocked_by.some((b) => b.needed.includes('revert'))).toBe(true);
  });

  it('C.6 rule 5: an unanswered blocking question blocks, a non-blocking one does not', () => {
    const b = evaluateGate(ctx({ questions: [{ code: 'Q-1', blocking: true, status: 'open' }] }));
    expect(!b.ok && b.blocked_by.some((x) => x.rule === 5)).toBe(true);
    expect(evaluateGate(ctx({ questions: [{ code: 'Q-1', blocking: false, status: 'open' }] })).ok).toBe(true);
  });

  it('C.7 rule 6: a failing test blocks even if every criterion is green', () => {
    const r = evaluateGate(ctx({ report: { ...ctx().report, tests_executed: [{ name: 'cart > totals', result: 'fail', evidence_ref: 'test:cart > totals' }] } }));
    expect(!r.ok && r.blocked_by.some((x) => x.rule === 6 && x.needed.includes('weaken'))).toBe(true);
  });

  it('C.8 rule 6: a not_run test needs a reason AND a matching test_gap item', () => {
    const notRun = { name: 'e2e > checkout', result: 'not_run' as const, reason: 'docker is not available in this sandbox, so playwright cannot start' };
    const short = evaluateGate(ctx({ report: { ...ctx().report, tests_executed: [], tests_not_run: [{ name: notRun.name, reason: 'no docker' }] } }));
    expect(!short.ok && short.blocked_by.some((x) => x.needed.includes('>= 20 chars'))).toBe(true);
    const noItem = evaluateGate(ctx({ report: { ...ctx().report, tests_executed: [], tests_not_run: [{ name: notRun.name, reason: notRun.reason }] } }));
    expect(!noItem.ok && noItem.blocked_by.some((x) => x.needed.includes("type='test_gap'"))).toBe(true);
    const ok = evaluateGate(ctx({
      report: { tests_executed: [], tests_not_run: [{ name: notRun.name, reason: notRun.reason }], changed_files: [] },
      open_items: [{ code: 'OI-9', title: 'test_gap: e2e > checkout not executed', type: 'test_gap', status: 'accepted', blocks_completion: false, source: 'agent' }],
    }));
    expect(ok.ok).toBe(true);
  });

  it('C.9 rule 7: review missing, stale (tree hash) or failed all block', () => {
    expect(evaluateGate(ctx({ review: null })).ok).toBe(false);
    const stale = evaluateGate(ctx({ current_tree_hash: 'def' }));
    expect(!stale.ok && stale.blocked_by.some((b) => b.rule === 7 && b.needed.includes('diff changed'))).toBe(true);
    const failed = evaluateGate(ctx({ review: { round: 2, verdict: 'fail', tree_hash: 'abc', open_blocking_findings: 1 } }));
    expect(!failed.ok && failed.blocked_by.some((b) => b.needed.includes('round limit'))).toBe(true);
    const fixable = evaluateGate(ctx({ review: { round: 1, verdict: 'fail', tree_hash: 'abc', open_blocking_findings: 1 } }));
    expect(!fixable.ok && fixable.blocked_by.some((b) => b.tool_to_call === 'review_task')).toBe(true);
  });

  it('C.9b rule 7 is skipped when the project turns require_review off', () => {
    expect(evaluateGate(ctx({ require_review: false, review: null })).ok).toBe(true);
  });

  it('C.10 rule 8: a requirement with no verified criterion blocks (silent drop is impossible)', () => {
    const r = evaluateGate(ctx({ requirements: [{ code: 'REQ-1', status: 'active', verified_criteria: [] }, { code: 'REQ-2', status: 'dropped', verified_criteria: [] }] }));
    expect(!r.ok && r.blocked_by.filter((b) => b.rule === 8).map((b) => b.ref)).toEqual(['REQ-1']);
  });

  it('C.11 rule 9: undone children and unfinished dependencies block; a human cancel waiver passes', () => {
    const child = { code: 'T-002', title: 'sub', status: 'in_progress' as const, req_codes: ['REQ-1'], cancelled: false };
    const r = evaluateGate(ctx({ task: { ...ctx().task, children: [child], depends_on: [{ code: 'T-000', status: 'in_progress' as const }] } }));
    expect(!r.ok && r.blocked_by.filter((b) => b.rule === 9).map((b) => b.ref)).toEqual(['T-002', 'T-000']);
    const waived = evaluateGate(ctx({ task: { ...ctx().task, children: [{ ...child, cancelled: true }], human_waivers: ['cancel:T-002'] } }));
    expect(waived.ok).toBe(true);
  });

  it('C.12a rule 10: a stale fact feeding an active decision blocks', () => {
    const r = evaluateGate(ctx({ facts: [{ code: 'F-1', status: 'stale', active_dependent_decisions: ['D-1'] }] }));
    expect(!r.ok && r.blocked_by.some((b) => b.rule === 10 && b.tool_to_call === 'fact_verify')).toBe(true);
    expect(evaluateGate(ctx({ facts: [{ code: 'F-1', status: 'stale', active_dependent_decisions: [] }] })).ok).toBe(true);
  });

  it('rule 11: an unmeasurable scope blocks, a file outside allowed paths blocks', () => {
    const unmeasurable = evaluateGate(ctx({ scope: { available: false, files: [], tree_hash: null } }));
    expect(!unmeasurable.ok && unmeasurable.blocked_by.some((b) => b.rule === 11)).toBe(true);
    const outside = evaluateGate(ctx({ scope: { available: true, files: [{ path: 'infra/main.tf', in_allowed_paths: false, deleted: false }], tree_hash: 'abc' } }));
    expect(!outside.ok && outside.blocked_by.some((b) => b.rule === 11 && b.ref === 'infra/main.tf')).toBe(true);
  });

  it('rule 12: a passing baseline test that vanishes blocks; deleting tests never passes', () => {
    const gone = evaluateGate(ctx({ baseline: { ...ctx().baseline, after: { present: [], results: {} } } }));
    expect(!gone.ok && gone.blocked_by.some((b) => b.rule === 12 && b.needed.includes('disappeared'))).toBe(true);
    const nowFail = evaluateGate(ctx({ baseline: { ...ctx().baseline, after: { present: ['auth > logs in'], results: { 'auth > logs in': 'fail' } } } }));
    expect(!nowFail.ok && nowFail.blocked_by.some((b) => b.rule === 12)).toBe(true);
    const skipped = evaluateGate(ctx({ baseline: { ...ctx().baseline, after: { present: ['auth > logs in'], results: { 'auth > logs in': 'skip' } } } }));
    expect(skipped.ok).toBe(false);
    const noRun = evaluateGate(ctx({ baseline: { ran: false, unavailable_reason: 'RUNNER_UNAVAILABLE', human_waived: false, tests: [], after: null } }));
    expect(!noRun.ok && noRun.blocked_by.some((b) => b.needed.includes('RUNNER_UNAVAILABLE'))).toBe(true);
    expect(evaluateGate(ctx({ baseline: { ran: false, unavailable_reason: 'RUNNER_UNAVAILABLE', human_waived: true, tests: [], after: null } })).ok).toBe(true);
  });

  it('rule 13: an unsettled journal row blocks; failed-and-recorded does not', () => {
    expect(!evaluateGate(ctx({ journal: [{ code: 'AJ-1', action: 'exec_run_command', status: 'started', idempotent: false }] })).ok);
    expect(evaluateGate(ctx({ journal: [{ code: 'AJ-1', action: 'exec_run_command', status: 'failed', idempotent: false }] })).ok).toBe(true);
    const unknown = evaluateGate(ctx({ journal: [{ code: 'AJ-1', action: 'x', status: 'unknown', idempotent: false }] }));
    expect(!unknown.ok && unknown.blocked_by.some((b) => b.needed.includes('determine the real state'))).toBe(true);
  });

  it('no exit report blocks (rule 1) and a stale gate_version can never pass', () => {
    expect(evaluateGate(ctx({ report: undefined as never })).ok).toBe(false);
    expect(evaluateGate(ctx({ report: { tests_executed: 'nope' } as never })).ok).toBe(false);
    const stale = evaluateGate(ctx({ gate_version: GATE_VERSION - 1, report: undefined as never, review: null }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.blocked_by).toHaveLength(1); // short-circuit: nothing else is evaluated
  });

  it('status after failure: human-owned rules ⇒ awaiting_review, agent-owned ⇒ in_progress', () => {
    expect(deriveStatusAfterFailure(ctx(), [{ rule: 4, ref: 'D-1', needed: 'x' }])).toBe('awaiting_review');
    expect(deriveStatusAfterFailure(ctx(), [{ rule: 11, ref: 'p', needed: 'x' }])).toBe('awaiting_review');
    expect(deriveStatusAfterFailure(ctx(), [{ rule: 2, ref: 'OI-1', needed: 'x' }])).toBe('in_progress');
    expect(deriveStatusAfterFailure(ctx(), [{ rule: 3, ref: 'C-1', needed: 'x' }])).toBe('in_progress');
    expect(deriveStatusAfterFailure(ctx({ task: { ...ctx().task, status: 'blocked' } }), [{ rule: 3, ref: 'C-1', needed: 'x' }])).toBe('blocked');
  });

  it('the completion report is generated from the ledger, not from memory', () => {
    const r = buildFinalReport(
      ctx({
        decisions: [{ code: 'D-1', title: 'add column', touches: ['db_schema'], reversible: true, approval_state: 'approved', applied: true, status: 'needs_revisit' }],
        questions: [{ code: 'Q-1', blocking: true, status: 'answered' }],
        report_assumptions: ['A-1 assumption: CI logs are readable'],
        open_items: [{ code: 'OI-2', title: 'out_of_scope: no admin UI', type: 'out_of_scope', status: 'accepted', blocks_completion: false, source: 'agent' }],
      }),
      'implemented the gate',
      2,
    );
    expect(r.task).toBe('T-001');
    expect(r.completed).toEqual([{ criterion: 'login returns 401 on revoked token', evidence: 1 }]);
    expect(r.decisions[0]).toEqual({ code: 'D-1', title: 'add column', level: 'approval', approval_state: 'approved' });
    expect(r.needs_human_review.join(' |')).toContain('needs revisit');
    expect(r.needs_human_review.join(' |')).toContain('answered Q-1');
    expect(r.assumptions).toEqual(['A-1 assumption: CI logs are readable']);
    expect(r.out_of_scope).toEqual(['OI-2 out_of_scope: no admin UI']);
    expect(r.counts).toEqual({ criteria_verified: 1, criteria_pending: 0, open_blocking: 0, review_rounds: 2 });
  });
});
