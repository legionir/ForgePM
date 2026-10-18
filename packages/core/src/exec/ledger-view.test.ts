import { describe, expect, it } from 'vitest';
import {
  buildLedgerStatus,
  type LedgerCriterionLite,
  type LedgerItemLite,
  type LedgerStatusInput,
} from './ledger-view';

/**
 * Acceptance A.1: the status answer comes from the ledger rows, not from what the
 * agent remembers. These cases pin the projection that `exec_ledger_status` (PE-2),
 * the REST route and the CLI all share — including "ready_to_submit", which is the
 * same question the Finalization Gate asks rule by rule.
 */
const base: LedgerStatusInput = {
  task: {
    code: 'T-001',
    title: 'PE-1 ledger services',
    status: 'in_progress',
    closed_at: null,
    start_ref: 'abc1234',
    tree_hash_start: 't'.repeat(40),
    allowed_paths: ['packages/core/src/exec/**'],
  },
  criteria: [{ code: 'C-1', text: 'create returns OI codes', requires_evidence: true }],
  evidence: [{ criterion_code: 'C-1', kind: 'test_output', ref: 'test:open-items-service', summary: '16 passed' }],
  items: [],
  questions: [],
  decisions: [],
};

describe('buildLedgerStatus', () => {
  it('says ready when nothing is outstanding', () => {
    const v = buildLedgerStatus(base);
    expect(v.ready_to_submit).toBe(true);
    expect(v.reasons_not_ready).toEqual([]);
    expect(v.counts).toMatchObject({ criteria: 1, criteria_with_evidence: 1, open_items: 0, blockers: 0 });
    expect(v.task).toEqual({ code: 'T-001', title: 'PE-1 ledger services', status: 'in_progress', closed_at: null });
  });

  it('names the blocking items and lists every open one', () => {
    const v = buildLedgerStatus({
      ...base,
      items: [
        { code: 'OI-002', title: 'b', type: 'bug', status: 'open', blocks_completion: true },
        { code: 'OI-001', title: 'a', type: 'risk', status: 'awaiting_human', blocks_completion: false },
        { code: 'OI-003', title: 'c', type: 'bug', status: 'resolved', blocks_completion: true },
      ],
    });
    expect(v.blockers).toEqual(['OI-002']);
    expect(v.open_item_codes).toEqual(['OI-001', 'OI-002']);
    expect(v.counts.open_items).toBe(2);
    expect(v.ready_to_submit).toBe(false);
    expect(v.reasons_not_ready[0]).toContain('OI-002');
  });

  it('treats a closed item as history, not as an open commitment', () => {
    const v = buildLedgerStatus({
      ...base,
      items: [{ code: 'OI-009', title: 'was blocking', type: 'bug', status: 'deferred', blocks_completion: true }],
    });
    expect(v.blockers).toEqual([]);
    expect(v.open_item_codes).toEqual([]);
  });

  it('reports a required criterion with no evidence, and dedups the refs it has', () => {
    const v = buildLedgerStatus({
      ...base,
      criteria: [
        { code: 'C-1', text: 'a', requires_evidence: true },
        { code: 'C-2', text: 'b', requires_evidence: true },
        { code: 'C-3', text: 'c', requires_evidence: false },
      ],
      evidence: [
        { criterion_code: 'C-1', kind: 'test_output', ref: 'test:a', summary: 'x' },
        { criterion_code: 'C-1', kind: 'test_output', ref: 'test:a', summary: 'x' },
        { criterion_code: 'C-1', kind: 'manual_check', ref: 'file:docs/X.md', summary: 'y' },
      ],
    });
    expect(v.criteria_without_evidence).toEqual(['C-2']);
    expect(v.counts.criteria_with_evidence).toBe(1);
    expect(v.criteria_evidence).toEqual([
      { code: 'C-1', kinds: ['manual_check', 'test_output'], refs: ['file:docs/X.md', 'test:a', 'test:a'] },
    ]);
    expect(v.reasons_not_ready.join()).toContain('C-2');
  });

  it('separates a blocking question from a merely open one', () => {
    const v = buildLedgerStatus({
      ...base,
      questions: [
        { code: 'Q-1', question: 'a', answered_at: null, blocking: true },
        { code: 'Q-2', question: 'b', answered_at: null, blocking: false },
        { code: 'Q-3', question: 'c', answered_at: '2026-10-18T00:00:00Z', blocking: true },
      ],
    });
    expect(v.questions_unanswered).toEqual(['Q-1', 'Q-2']);
    expect(v.blocking_questions).toEqual(['Q-1']);
    expect(v.ready_to_submit).toBe(false);
  });

  it('only waits for decisions that actually need an approval', () => {
    const v = buildLedgerStatus({
      ...base,
      decisions: [
        { code: 'D-047', title: 'a', approved: false, needs_approval: true },
        { code: 'D-048', title: 'b', approved: false, needs_approval: false },
        { code: 'D-046', title: 'c', approved: true, needs_approval: true },
      ],
    });
    expect(v.decisions_pending).toEqual(['D-047']);
    expect(v.reasons_not_ready.join()).toContain('D-047');
  });

  it('counts a requirement no task covers, and exempts dropped ones', () => {
    const v = buildLedgerStatus({
      ...base,
      requirements: [
        { code: 'REQ-1000', status: 'committed', covered_by_tasks: [] },
        { code: 'REQ-1001', status: 'committed', covered_by_tasks: ['T-001'] },
        { code: 'REQ-1002', status: 'dropped', covered_by_tasks: [] },
      ],
    });
    expect(v.requirements_uncovered).toEqual(['REQ-1000']);
    expect(v.ready_to_submit).toBe(false);
  });

  it('is deterministic: shuffled rows produce a byte-identical report', () => {
    const rows = {
      criteria: [
        { code: 'C-2', text: 'b', requires_evidence: true },
        { code: 'C-1', text: 'a', requires_evidence: true },
      ] satisfies LedgerCriterionLite[],
      items: [
        { code: 'OI-003', title: 'c', type: 'bug', status: 'open', blocks_completion: true },
        { code: 'OI-001', title: 'a', type: 'risk', status: 'blocked', blocks_completion: true },
      ] satisfies LedgerItemLite[],
      evidence: [] as LedgerStatusInput['evidence'],
    };
    const a = buildLedgerStatus({ ...base, ...rows });
    const b = buildLedgerStatus({
      ...base,
      ...rows,
      criteria: [...rows.criteria].reverse(),
      items: [...rows.items].reverse(),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.blockers).toEqual(['OI-001', 'OI-003']);
  });

  it('carries the baseline the gate compares against, paths sorted', () => {
    const v = buildLedgerStatus({
      ...base,
      task: { ...base.task, allowed_paths: ['packages/core/**', 'docs/**', 'apps/api/**'] },
    });
    expect(v.baseline.allowed_paths).toEqual(['apps/api/**', 'docs/**', 'packages/core/**']);
    expect(v.baseline).toMatchObject({ start_ref: 'abc1234', tree_hash_start: 't'.repeat(40) });
  });

  it('does not invent blockers when the ledger is empty', () => {
    const v = buildLedgerStatus({ ...base, criteria: [], evidence: [] });
    expect(v.ready_to_submit).toBe(true);
    expect(v.counts).toEqual({
      criteria: 0,
      criteria_with_evidence: 0,
      open_items: 0,
      blockers: 0,
      questions_unanswered: 0,
      decisions_pending: 0,
    });
  });
});
