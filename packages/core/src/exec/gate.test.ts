import { describe, expect, it } from 'vitest';
import type { ExecPolicy } from '@forgepm/shared';
import { EXEC_POLICY_DEFAULT, GATE_VERSION } from './policy';
import {
  GATE_RULES,
  composeFinalReport,
  deriveStatus,
  deriveStatusAfterFailure,
  evaluateGate,
  type GateContext,
  type GateReport,
} from './gate';

const REPORT: GateReport = {
  tests_executed: [{ name: 'auth > logs in', result: 'pass', evidence_ref: 'test:auth > logs in' }],
  tests_not_run: [],
  changed_files: ['packages/core/src/x.ts'],
};

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    gate_version: GATE_VERSION,
    policy: EXEC_POLICY_DEFAULT as ExecPolicy,
    require_review: true,
    max_review_rounds: 2,
    task: { code: 'T-001', status: 'in_progress', children: [], depends_on: [], human_waivers: [] },
    criteria: [
      {
        code: 'C-1',
        status: 'verified',
        evidence_count: 1,
        valid_evidence_count: 1,
        has_waiver_approval: false,
        req_code: 'REQ-1',
        text: 'login returns 401 on revoked token',
      },
    ],
    open_items: [],
    decisions: [],
    questions: [],
    facts: [],
    requirements: [{ code: 'REQ-1', status: 'active', verified_criteria: ['C-1'] }],
    journal: [],
    review: { round: 1, verdict: 'pass', tree_hash: 'abc', open_blocking_findings: 0 },
    current_tree_hash: 'abc',
    scope: { available: true, basis: 'git', unavailable_reason: null, human_waived: false, files: [], tree_hash: 'abc' },
    baseline: {
      ran: true,
      unavailable_reason: null,
      human_waived: false,
      start_sha: 'a'.repeat(40),
      current_sha: 'b'.repeat(40),
      tests: [{ name: 'auth > logs in', result_at_start: 'pass', source: 'ci' }],
      after: {
        sha: 'b'.repeat(40),
        run_id: 'run-1',
        job: 'unit',
        present: ['auth > logs in'],
        results: { 'auth > logs in': 'pass' },
      },
      weakening: [],
    },
    report: REPORT,
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
    const r = evaluateGate(
      ctx({
        open_items: [
          {
            code: 'OI-1',
            title: 'rate limit missing',
            type: 'defect',
            status: 'open',
            blocks_completion: true,
            source: 'agent',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const b = r.blocked_by.find((x) => x.rule === 2);
      expect(b?.ref).toBe('OI-1');
      expect(b?.tool_to_call).toBe('ledger_resolve_item');
    }
  });

  it('C.1 one blocking open item is always ok:false — three different items, one answer', () => {
    // The criterion says "one blocking item ⇒ never close"; the shape of the
    // item must not matter, or the gate would be a shape detector, not a law.
    const items = [
      {
        code: 'OI-1',
        title: 'a missing rate limit',
        type: 'defect',
        status: 'open' as const,
        blocks_completion: true,
        source: 'agent',
      },
      {
        code: 'OI-2',
        title: 'a promise nobody kept',
        type: 'commitment',
        status: 'open' as const,
        blocks_completion: true,
        source: 'human',
      },
      {
        code: 'OI-3',
        title: 'a risk nobody owns',
        type: 'risk',
        status: 'open' as const,
        blocks_completion: true,
        source: 'agent',
      },
    ];
    for (const item of items) {
      const r = evaluateGate(ctx({ open_items: [item] }));
      expect(r.ok, item.code).toBe(false);
      if (!r.ok) {
        const b = r.blocked_by.find((x) => x.rule === 2);
        expect(b?.ref).toBe(item.code);
        expect(b?.tool_to_call).toBe('ledger_resolve_item');
      }
    }
    // and all three at once: the answer names every one of them
    const all = evaluateGate(ctx({ open_items: items }));
    expect(all.ok).toBe(false);
    if (!all.ok) {
      expect(all.blocked_by.filter((x) => x.rule === 2).map((x) => x.ref)).toEqual(['OI-1', 'OI-2', 'OI-3']);
    }
  });

  it('C.3 an accepted/deferred item does not block', () => {
    const r = evaluateGate(
      ctx({
        open_items: [
          { code: 'OI-1', title: 't', type: 'debt', status: 'deferred', blocks_completion: true, source: 'agent' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('C.4 rule 3: a criterion with unverifiable evidence blocks; a waived one does not', () => {
    const bad = evaluateGate(
      ctx({ criteria: [{ ...ctx().criteria[0], status: 'pending', evidence_count: 2, valid_evidence_count: 0 }] }),
    );
    expect(!bad.ok && bad.blocked_by.some((b) => b.rule === 3 && b.needed.includes('not verifiable'))).toBe(true);
    const waived = evaluateGate(
      ctx({ criteria: [{ ...ctx().criteria[0], status: 'waived', valid_evidence_count: 0 }] }),
    );
    expect(waived.ok).toBe(true);
  });

  it('F.3 a db_schema decision stays blocked while pending and clears after human approval', () => {
    const decision = {
      code: 'D-DB',
      title: 'add the migration column',
      touches: ['db_schema'],
      reversible: true,
      applied: false,
      status: 'active' as const,
    };
    const pending = evaluateGate(ctx({ decisions: [{ ...decision, approval_state: 'pending' }] }));
    expect(pending.ok).toBe(false);
    expect(pending.blocked_by.find((b) => b.rule === 4)).toMatchObject({
      ref: 'D-DB',
      needed: 'await human approval before closing',
    });

    const approved = evaluateGate(ctx({ decisions: [{ ...decision, approval_state: 'approved' }] }));
    expect(approved.blocked_by.some((b) => b.rule === 4)).toBe(false);
    expect(approved.ok).toBe(true);
  });

  it('C.5 rule 4: a pending approval blocks; an approved-and-applied change does not', () => {
    const pending = evaluateGate(
      ctx({
        decisions: [
          {
            code: 'D-1',
            title: 'add column',
            touches: ['db_schema'],
            reversible: true,
            approval_state: 'pending',
            applied: true,
            status: 'active',
          },
        ],
      }),
    );
    expect(!pending.ok && pending.blocked_by.some((b) => b.rule === 4)).toBe(true);
    const approved = evaluateGate(
      ctx({
        decisions: [
          {
            code: 'D-1',
            title: 'add column',
            touches: ['db_schema'],
            reversible: true,
            approval_state: 'approved',
            applied: true,
            status: 'active',
          },
        ],
      }),
    );
    expect(approved.ok).toBe(true);
    const rejectedApplied = evaluateGate(
      ctx({
        decisions: [
          {
            code: 'D-1',
            title: 'x',
            touches: ['db_schema'],
            reversible: true,
            approval_state: 'rejected',
            applied: true,
            status: 'active',
          },
        ],
      }),
    );
    expect(!rejectedApplied.ok && rejectedApplied.blocked_by.some((b) => b.needed.includes('revert'))).toBe(true);
  });

  it('F.8 a rejected approval with a done journal entry targeting its decision blocks rule 4', () => {
    const rejected = {
      code: 'D-REJECTED',
      title: 'the rejected schema change',
      touches: ['db_schema'],
      reversible: true,
      approval_state: 'rejected' as const,
      applied: false,
      status: 'active' as const,
    };
    const unrelated = evaluateGate(
      ctx({
        decisions: [rejected],
        journal: [{ code: 'AJ-OTHER', action: 'another task action', status: 'done', idempotent: false, target: 'D-OTHER' }],
      }),
    );
    expect(unrelated.blocked_by.some((b) => b.rule === 4)).toBe(false);

    const applied = evaluateGate(
      ctx({
        decisions: [rejected],
        journal: [{ code: 'AJ-1', action: 'apply rejected decision', status: 'done', idempotent: false, target: 'D-REJECTED' }],
      }),
    );
    expect(applied.ok).toBe(false);
    expect(applied.blocked_by.find((b) => b.rule === 4)).toMatchObject({
      ref: 'D-REJECTED',
      needed: 'decision was rejected but the change is applied — revert it',
    });
  });

  it('C.6 rule 5: an unanswered blocking question blocks, a non-blocking one does not', () => {
    const b = evaluateGate(ctx({ questions: [{ code: 'Q-1', blocking: true, status: 'open' }] }));
    expect(!b.ok && b.blocked_by.some((x) => x.rule === 5)).toBe(true);
    expect(evaluateGate(ctx({ questions: [{ code: 'Q-1', blocking: false, status: 'open' }] })).ok).toBe(true);
  });

  it('C.7 rule 6: a failing test blocks even if every criterion is green', () => {
    const r = evaluateGate(
      ctx({
        report: {
          ...REPORT,
          tests_executed: [{ name: 'cart > totals', result: 'fail', evidence_ref: 'test:cart > totals' }],
        },
      }),
    );
    expect(!r.ok && r.blocked_by.some((x) => x.rule === 6 && x.needed.includes('weaken'))).toBe(true);
  });

  it('C.8 rule 6: a not_run test needs a reason AND a matching test_gap item', () => {
    const notRun = {
      name: 'e2e > checkout',
      result: 'not_run' as const,
      reason: 'the CI run for this commit has not finished, so no log exists yet',
    };
    const short = evaluateGate(
      ctx({
        report: { ...REPORT, tests_executed: [], tests_not_run: [{ name: notRun.name, reason: 'not yet' }] },
      }),
    );
    expect(!short.ok && short.blocked_by.some((x) => x.needed.includes('>= 20 chars'))).toBe(true);
    const noItem = evaluateGate(
      ctx({
        report: { ...REPORT, tests_executed: [], tests_not_run: [{ name: notRun.name, reason: notRun.reason }] },
      }),
    );
    expect(!noItem.ok && noItem.blocked_by.some((x) => x.needed.includes("type='test_gap'"))).toBe(true);
    const ok = evaluateGate(
      ctx({
        report: {
          tests_executed: [],
          tests_not_run: [{ name: notRun.name, reason: notRun.reason }],
          changed_files: [],
        },
        open_items: [
          {
            code: 'OI-9',
            title: 'test_gap: e2e > checkout not executed',
            type: 'test_gap',
            status: 'accepted',
            blocks_completion: false,
            source: 'agent',
          },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it('C.9 rule 7: review missing, unmeasurable, stale (tree hash) or failed all block', () => {
    expect(evaluateGate(ctx({ review: null })).ok).toBe(false);
    const unmeasurable = evaluateGate(ctx({ current_tree_hash: null }));
    expect(!unmeasurable.ok && unmeasurable.blocked_by.some((b) => b.rule === 7 && b.needed.includes('current worktree hash is unavailable'))).toBe(true);
    const stale = evaluateGate(ctx({ current_tree_hash: 'def' }));
    expect(!stale.ok && stale.blocked_by.some((b) => b.rule === 7 && b.needed.includes('diff changed'))).toBe(true);
    const failed = evaluateGate(
      ctx({ review: { round: 2, verdict: 'fail', tree_hash: 'abc', open_blocking_findings: 1 } }),
    );
    expect(!failed.ok && failed.blocked_by.some((b) => b.needed.includes('round limit'))).toBe(true);
    const fixable = evaluateGate(
      ctx({ review: { round: 1, verdict: 'fail', tree_hash: 'abc', open_blocking_findings: 1 } }),
    );
    expect(!fixable.ok && fixable.blocked_by.some((b) => b.tool_to_call === 'review_task')).toBe(true);
  });

  it('human arbitration overrides only a failed verdict, never freshness or other blockers', () => {
    const arbitration = {
      code: 'OI-ARB',
      title: 'human arbitration required',
      type: 'risk',
      status: 'open' as const,
      blocks_completion: true,
      source: 'reviewer',
      related_ref: 'review-arbitration:T-001:r2:abc',
      resolved_by: null,
    };
    const humanResolved = { ...arbitration, status: 'resolved' as const, resolved_by: 'human' as const };
    const review = { round: 2, verdict: 'fail' as const, tree_hash: 'abc', open_blocking_findings: 1 };
    expect(evaluateGate(ctx({ review, open_items: [arbitration] })).ok).toBe(false);

    const arbitrated = evaluateGate(ctx({ review, open_items: [humanResolved] }));
    expect(arbitrated.ok).toBe(true);

    const unrelatedReviewerItem = evaluateGate(ctx({
      review,
      open_items: [{ ...humanResolved, related_ref: 'file:src/review.ts:1' }],
    }));
    expect(unrelatedReviewerItem.ok).toBe(false);
    if (!unrelatedReviewerItem.ok) {
      expect(unrelatedReviewerItem.blocked_by.some((item) => item.rule === 7 && item.title.includes('did not pass'))).toBe(true);
    }
    const olderArbitration = evaluateGate(ctx({
      review,
      open_items: [{ ...humanResolved, related_ref: 'review-arbitration:T-001:r1:abc' }],
    }));
    expect(olderArbitration.ok).toBe(false);
    const agentClosed = evaluateGate(ctx({
      review,
      open_items: [{ ...humanResolved, resolved_by: 'agent' as const }],
    }));
    expect(agentClosed.ok).toBe(false);

    const staleAfterArbitration = evaluateGate(ctx({
      review,
      current_tree_hash: 'def',
      open_items: [humanResolved],
    }));
    expect(staleAfterArbitration.ok).toBe(false);
    if (!staleAfterArbitration.ok) {
      expect(staleAfterArbitration.blocked_by.some((item) => item.rule === 7 && item.title.includes('stale'))).toBe(true);
      expect(staleAfterArbitration.blocked_by.some((item) => item.rule === 7 && item.title.includes('did not pass'))).toBe(false);
    }

    const activeBlocker = evaluateGate(ctx({
      review,
      open_items: [humanResolved, {
        code: 'OI-ACTIVE',
        title: 'an unrelated active blocker',
        type: 'bug',
        status: 'open',
        blocks_completion: true,
        source: 'agent',
      }],
    }));
    expect(activeBlocker.ok).toBe(false);
    if (!activeBlocker.ok) {
      expect(activeBlocker.blocked_by.some((item) => item.rule === 2 && item.ref === 'OI-ACTIVE')).toBe(true);
      expect(activeBlocker.blocked_by.some((item) => item.rule === 7)).toBe(false);
    }
  });

  it('C.9b rule 7 is skipped when the project turns require_review off', () => {
    expect(evaluateGate(ctx({ require_review: false, review: null })).ok).toBe(true);
  });

  it('C.10 rule 8: a requirement with no verified criterion blocks (silent drop is impossible)', () => {
    const r = evaluateGate(
      ctx({
        requirements: [
          { code: 'REQ-1', status: 'active', verified_criteria: [] },
          { code: 'REQ-2', status: 'dropped', verified_criteria: [] },
        ],
      }),
    );
    expect(!r.ok && r.blocked_by.filter((b) => b.rule === 8).map((b) => b.ref)).toEqual(['REQ-1']);
  });

  it('C.11 rule 9: undone children and unfinished dependencies block; a human cancel waiver passes', () => {
    const child = {
      code: 'T-002',
      title: 'sub',
      status: 'in_progress' as const,
      req_codes: ['REQ-1'],
      cancelled: false,
    };
    const r = evaluateGate(
      ctx({
        task: { ...ctx().task, children: [child], depends_on: [{ code: 'T-000', status: 'in_progress' as const }] },
      }),
    );
    expect(!r.ok && r.blocked_by.filter((b) => b.rule === 9).map((b) => b.ref)).toEqual(['T-002', 'T-000']);
    const waived = evaluateGate(
      ctx({ task: { ...ctx().task, children: [{ ...child, cancelled: true }], human_waivers: ['cancel:T-002'] } }),
    );
    expect(waived.ok).toBe(true);
  });

  it('C.12a rule 10: a stale fact feeding an active decision blocks', () => {
    const r = evaluateGate(ctx({ facts: [{ code: 'F-1', status: 'stale', active_dependent_decisions: ['D-1'] }] }));
    expect(!r.ok && r.blocked_by.some((b) => b.rule === 10 && b.tool_to_call === 'fact_verify')).toBe(true);
    expect(evaluateGate(ctx({ facts: [{ code: 'F-1', status: 'stale', active_dependent_decisions: [] }] })).ok).toBe(
      true,
    );
  });

  it('rule 11: an unmeasurable scope blocks, a file outside allowed paths blocks', () => {
    const unmeasurable = evaluateGate(ctx({ scope: { available: false, basis: 'none', unavailable_reason: 'no start_ref', human_waived: false, files: [], tree_hash: null } }));
    expect(!unmeasurable.ok && unmeasurable.blocked_by.some((b) => b.rule === 11)).toBe(true);
    const waivedUnknown = evaluateGate(
      ctx({ scope: { available: false, basis: 'none', unavailable_reason: 'no source', human_waived: true, files: [], tree_hash: null } }),
    );
    expect(waivedUnknown.ok).toBe(true);
    const outside = evaluateGate(
      ctx({
        report: { ...REPORT, changed_files: [] },
        scope: {
          available: true,
          basis: 'git',
          unavailable_reason: null,
          human_waived: true,
          files: [{ path: 'infra/main.tf', change: 'M', in_allowed_paths: false, deleted: false, transient: false }],
          tree_hash: 'abc',
        },
      }),
    );
    expect(!outside.ok && outside.blocked_by.some((b) => b.rule === 11 && b.ref === 'infra/main.tf')).toBe(true);
    const deletedInside = evaluateGate(
      ctx({
        report: { ...REPORT, changed_files: [] },
        scope: {
          available: true,
          basis: 'manifest',
          unavailable_reason: null,
          human_waived: true,
          files: [{ path: 'src/allowed.ts', change: 'D', in_allowed_paths: true, deleted: true, transient: false }],
          tree_hash: 'manifest-hash',
        },
      }),
    );
    expect(!deletedInside.ok && deletedInside.blocked_by.some((blocker) => blocker.rule === 11 && blocker.ref === 'src/allowed.ts')).toBe(true);
  });

  it('rule 12: a passing baseline test that vanishes blocks; deleting tests never passes', () => {
    const gone = evaluateGate(ctx({ baseline: { ...ctx().baseline, after: { ...ctx().baseline.after!, present: [], results: {} } } }));
    expect(!gone.ok && gone.blocked_by.some((b) => b.rule === 12 && b.needed.includes('disappeared'))).toBe(true);
    const nowFail = evaluateGate(
      ctx({
        baseline: {
          ...ctx().baseline,
          after: { ...ctx().baseline.after!, present: ['auth > logs in'], results: { 'auth > logs in': 'fail' } },
        },
      }),
    );
    expect(!nowFail.ok && nowFail.blocked_by.some((b) => b.rule === 12)).toBe(true);
    const skipped = evaluateGate(
      ctx({
        baseline: {
          ...ctx().baseline,
          after: { ...ctx().baseline.after!, present: ['auth > logs in'], results: { 'auth > logs in': 'skip' } },
        },
      }),
    );
    expect(skipped.ok).toBe(false);
    for (const modifier of ['.skip', '.only']) {
      const weakened = evaluateGate(
        ctx({
          baseline: {
            ...ctx().baseline,
            weakening: [{ path: 'packages/core/src/exec/example.test.ts', count_delta: 0, modifiers: [modifier] }],
          },
        }),
      );
      expect(weakened.blocked_by.some((blocker) => blocker.rule === 12 && blocker.title.includes('weakened'))).toBe(true);
    }
    const waivedButFailing = evaluateGate(
      ctx({
        baseline: {
          ...ctx().baseline,
          human_waived: true,
          after: { ...ctx().baseline.after!, present: ['auth > logs in'], results: { 'auth > logs in': 'fail' } },
        },
      }),
    );
    expect(!waivedButFailing.ok && waivedButFailing.blocked_by.some((b) => b.rule === 12)).toBe(true);
    const noRun = evaluateGate(
      ctx({
        baseline: {
          ran: false,
          unavailable_reason: 'BASELINE_UNAVAILABLE',
          human_waived: false,
          start_sha: null,
          current_sha: null,
          tests: [],
          after: null,
          weakening: [],
        },
      }),
    );
    expect(!noRun.ok && noRun.blocked_by.some((b) => b.needed.includes('BASELINE_UNAVAILABLE'))).toBe(true);
    expect(
      evaluateGate(
        ctx({
          baseline: {
            ran: false,
            unavailable_reason: 'BASELINE_UNAVAILABLE',
            human_waived: true,
            start_sha: null,
            current_sha: null,
            tests: [],
            after: null,
            weakening: [],
          },
        }),
      ).ok,
    ).toBe(true);
  });

  it('rule 13: an unsettled journal row blocks; failed-and-recorded does not', () => {
    expect(
      !evaluateGate(
        ctx({ journal: [{ code: 'AJ-1', action: 'exec_run_command', status: 'started', idempotent: false }] }),
      ).ok,
    );
    expect(
      evaluateGate(
        ctx({ journal: [{ code: 'AJ-1', action: 'exec_run_command', status: 'failed', idempotent: false }] }),
      ).ok,
    ).toBe(true);
    const unknown = evaluateGate(
      ctx({ journal: [{ code: 'AJ-1', action: 'x', status: 'unknown', idempotent: false }] }),
    );
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
    const b = (rule: number, ref: string) => ({ rule, ref, title: `blocked by rule ${rule}`, needed: 'x' });
    expect(deriveStatusAfterFailure(ctx(), [b(4, 'D-1')])).toBe('awaiting_review');
    expect(deriveStatusAfterFailure(ctx(), [b(11, 'p')])).toBe('awaiting_review');
    expect(deriveStatusAfterFailure(ctx(), [b(2, 'OI-1')])).toBe('in_progress');
    expect(deriveStatusAfterFailure(ctx(), [b(3, 'C-1')])).toBe('in_progress');
    expect(deriveStatusAfterFailure(ctx({ task: { ...ctx().task, status: 'blocked' } }), [b(3, 'C-1')])).toBe(
      'blocked',
    );
  });

  it('the completion report is generated from the ledger, not from memory', () => {
    const r = composeFinalReport(
      ctx({
        decisions: [
          {
            code: 'D-1',
            title: 'add column',
            touches: ['db_schema'],
            reversible: true,
            approval_state: 'approved',
            applied: true,
            status: 'needs_revisit',
          },
        ],
        questions: [{ code: 'Q-1', blocking: true, status: 'answered' }],
        report_assumptions: ['A-1 assumption: CI logs are readable'],
        open_items: [
          {
            code: 'OI-2',
            title: 'agent claimed out-of-scope: no admin UI',
            type: 'out_of_scope',
            status: 'accepted',
            blocks_completion: false,
            source: 'agent',
          },
          {
            code: 'OI-3',
            title: 'scope check requires human review: docs/admin.md',
            type: 'out_of_scope',
            status: 'open',
            blocks_completion: true,
            source: 'hook',
          },
        ],
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
    expect(r.out_of_scope).toEqual(['OI-3 scope check requires human review: docs/admin.md']);
    expect(r.counts).toEqual({ criteria_verified: 1, criteria_pending: 0, open_blocking: 1, review_rounds: 2 });
  });
});

/**
 * Acceptance C.10 — "the `blocked_by` output for each of the 13 rules is tested
 * with a separate fixture (13 unit tests)".
 *
 * One fixture per rule, and each case asserts the WHOLE answer: which rule
 * fired, which row it is about, what has to happen and which tool does it. A
 * gate that only says "no" teaches the agent to retry forever; a gate that
 * says "rule 6, the test `cart > totals` failed — fix it, do not weaken it"
 * is a gate that can be acted on.
 */
describe('C.10 — one fixture per rule, each with rule/ref/needed/tool_to_call', () => {
  const blockedOf = (n: number, over: Partial<GateContext> = {}) => {
    const r = evaluateGate(ctx(over));
    expect(r.ok, `rule ${n} did not block`).toBe(false);
    const b = r.blocked_by.find((x) => x.rule === n);
    expect(b, `rule ${n} did not report`).toBeDefined();
    return b!;
  };

  it('every entry has the same shape — rule, ref, title, needed, tool_to_call', () => {
    // The plan's answer shape is a contract: an agent that reads
    // `blocked_by[0].needed` must never find it missing on some rule and
    // present on another.
    const r = evaluateGate(
      ctx({
        open_items: [
          { code: 'OI-1', title: 'a bug', type: 'bug', status: 'open', blocks_completion: true, source: 'agent' },
        ],
        criteria: [
          {
            code: 'C-1',
            status: 'pending',
            evidence_count: 0,
            valid_evidence_count: 0,
            has_waiver_approval: false,
            req_code: null,
            text: 'a criterion nobody proved',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.blocked_by.length).toBeGreaterThan(1);
    for (const b of r.blocked_by) {
      expect(Object.keys(b).sort()).toEqual(['needed', 'ref', 'rule', 'title', 'tool_to_call']);
      expect(b.needed.length).toBeGreaterThan(10);
      expect(b.title.length).toBeGreaterThan(0);
    }
  });

  it('rule 1 — no exit report at all', () => {
    const b = blockedOf(1, { report: null });
    expect(b.ref).toBe('exit_report');
    expect(b.needed).toMatch(/exec_submit_exit_report/);
    expect(b.tool_to_call).toBe('exec_submit_exit_report');
  });

  it('rule 2 — a blocking open item', () => {
    const b = blockedOf(2, {
      open_items: [
        {
          code: 'OI-7',
          title: 'rate limit missing',
          type: 'bug',
          status: 'open',
          blocks_completion: true,
          source: 'agent',
        },
      ],
    });
    expect(b.ref).toBe('OI-7');
    expect(b.needed).toMatch(/resolve with proof/);
    expect(b.tool_to_call).toBe('ledger_resolve_item');
  });

  it('rule 3 — a criterion without valid evidence', () => {
    const b = blockedOf(3, {
      criteria: [{ ...ctx().criteria[0], status: 'pending', evidence_count: 0, valid_evidence_count: 0 }],
    });
    expect(b.ref).toBe('C-1');
    expect(b.needed).toMatch(/add evidence/);
    expect(b.tool_to_call).toBe('ledger_add_evidence');
  });

  it('rule 4 — a decision waiting for a human approval', () => {
    const b = blockedOf(4, {
      decisions: [
        {
          code: 'D-3',
          title: 'add a migration',
          touches: ['db_schema'],
          reversible: false,
          approval_state: 'pending',
          applied: true,
          status: 'active',
        },
      ],
    });
    expect(b.ref).toBe('D-3');
    expect(b.needed).toMatch(/await human approval/);
    expect(b.tool_to_call).toBe('ledger_ask_human');
  });

  it('rule 5 — an unanswered blocking question', () => {
    const b = blockedOf(5, {
      questions: [{ code: 'Q-4', blocking: true, status: 'open' }],
    });
    expect(b.ref).toBe('Q-4');
    expect(b.needed).toMatch(/silence is not approval/);
    expect(b.tool_to_call).toBe('ledger_list_open');
  });

  it('rule 6 — a failing test', () => {
    const b = blockedOf(6, {
      report: { ...REPORT, tests_executed: [{ name: 'cart > totals', result: 'fail', evidence_ref: 'test:cart' }] },
    });
    expect(b.ref).toBe('cart > totals');
    expect(b.needed).toMatch(/do not weaken or delete it/);
    expect(b.tool_to_call).toBe('ledger_add_open_item');
  });

  it('rule 7 — the adversarial review of this version is missing', () => {
    const b = blockedOf(7, { review: null });
    expect(b.ref).toBe('review');
    expect(b.needed).toMatch(/review_task/);
    expect(b.tool_to_call).toBe('review_task');
  });

  it('rule 8 — a linked requirement with no verified criterion', () => {
    const b = blockedOf(8, { requirements: [{ code: 'REQ-9', status: 'active', verified_criteria: [] }] });
    expect(b.ref).toBe('REQ-9');
    expect(b.needed).toMatch(/no verified acceptance criterion/);
    expect(b.tool_to_call).toBe('req_link_task');
  });

  it('rule 9 — a subtask that is not done', () => {
    const b = blockedOf(9, {
      task: {
        ...ctx().task,
        children: [{ code: 'T-002', title: 'subtask', status: 'in_progress', req_codes: [], cancelled: false }],
      },
    });
    expect(b.ref).toBe('T-002');
    expect(b.needed).toMatch(/finish the subtask/);
    expect(b.tool_to_call).toBe('exec_plan_view');
  });

  it('rule 10 — a stale fact an active decision still rests on', () => {
    const b = blockedOf(10, {
      facts: [{ code: 'F-1', status: 'stale', active_dependent_decisions: ['D-1'] }],
    });
    expect(b.ref).toBe('F-1');
    expect(b.needed).toMatch(/re-verify the fact/);
    expect(b.tool_to_call).toBe('fact_verify');
  });

  it('rule 11 — a file outside allowed_paths', () => {
    const b = blockedOf(11, {
      scope: {
        available: true,
        basis: 'git',
        unavailable_reason: null,
        human_waived: false,
        files: [{ path: 'apps/web/src/x.ts', change: 'M', in_allowed_paths: false, deleted: false, transient: false }],
        tree_hash: 'abc',
      },
    });
    expect(b.ref).toBe('apps/web/src/x.ts');
    expect(b.needed).toMatch(/outside allowed_paths/);
    expect(b.tool_to_call).toBe('ledger_list_open');
  });

  it('rule 12 — a passing baseline test that vanished', () => {
    const b = blockedOf(12, {
      baseline: {
        ran: true,
        unavailable_reason: null,
        human_waived: false,
        start_sha: 'a'.repeat(40),
        current_sha: 'b'.repeat(40),
        tests: [{ name: 'auth > logs in', result_at_start: 'pass', source: 'ci' }],
        after: { sha: 'b'.repeat(40), run_id: 'run-1', job: 'unit', present: [], results: {} },
        weakening: [],
      },
    });
    expect(b.ref).toBe('auth > logs in');
    expect(b.needed).toMatch(/disappeared/);
    expect(b.tool_to_call).toBe('baseline_capture');
  });

  it('rule 13 — a journal row that was never settled', () => {
    const b = blockedOf(13, {
      journal: [{ code: 'J-1', action: 'npm run migrate', status: 'started', idempotent: false }],
    });
    expect(b.ref).toBe('J-1');
    expect(b.needed).toMatch(/journal_done/);
    expect(b.tool_to_call).toBe('journal_done');
  });
});

describe('deriveStatus (plan §8.2) — the status the gate implies', () => {
  it('a passing gate means done, and nothing else does', () => {
    expect(deriveStatus(ctx(), { ok: true, blocked_by: [] })).toBe('done');
  });

  it('a human-owned rule means awaiting_review; an agent-owned rule means in_progress', () => {
    const b = (rule: number, ref: string) => ({ rule, ref, title: `blocked by rule ${rule}`, needed: 'x' });
    expect(deriveStatus(ctx(), { ok: false, blocked_by: [b(5, 'Q-1')] })).toBe('awaiting_review');
    expect(deriveStatus(ctx(), { ok: false, blocked_by: [b(3, 'C-1')] })).toBe('in_progress');
  });

  it('a task that was already blocked stays blocked', () => {
    const blocked = ctx({ task: { ...ctx().task, status: 'blocked' } });
    const b = (rule: number, ref: string) => ({ rule, ref, title: `blocked by rule ${rule}`, needed: 'x' });
    expect(deriveStatus(blocked, { ok: false, blocked_by: [b(3, 'C-1')] })).toBe('blocked');
  });
});

describe('C.9b — the drift between "the task says done" and "the gate says so"', () => {
  it('a done task without a stamp is drift, and the wording is the documented one', () => {
    const done = ctx({ task: { ...ctx().task, status: 'done' } });
    const r = evaluateGate(done);
    expect(r.ok).toBe(false);
    const drift = r.blocked_by.find((b) => b.ref.startsWith('drift:'));
    expect(drift?.ref).toBe('drift: gate stamp missing');
    expect(drift?.tool_to_call).toBe('exec_task_complete');
  });

  it('a done task WITH a passing stamp is not drift', () => {
    const done = ctx({
      task: { ...ctx().task, status: 'done' },
      stamp: { stamp_id: 'st-1', ok: true, tree_hash: 'abc', gate_version: GATE_VERSION },
    });
    expect(evaluateGate(done).ok).toBe(true);
  });

  it('a stamp that did not pass is a different drift, and still a drift', () => {
    const done = ctx({
      task: { ...ctx().task, status: 'done' },
      stamp: { stamp_id: 'st-2', ok: false, tree_hash: 'abc', gate_version: GATE_VERSION },
    });
    const r = evaluateGate(done);
    expect(r.ok).toBe(false);
    expect(r.blocked_by.some((b) => b.ref === 'drift: gate stamp not passing')).toBe(true);
  });

  it('an open task without a stamp is simply not finished — not drift', () => {
    expect(evaluateGate(ctx()).ok).toBe(true);
  });
});
