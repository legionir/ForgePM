import { describe, expect, it } from 'vitest';
import { isReadOnly, journalWriteLock, openRows, resettleOnSessionStart } from './journal';

const open = [
  {
    code: 'AJ-001',
    task_id: 'task-1',
    action: 'apply migration',
    target: 'DB-1',
    expected_effect: 'the schema is at version alpha',
    idempotent: false,
    status: 'unknown' as const,
  },
];

const exactRetry = {
  task_id: 'task-1',
  action: 'apply migration',
  target: 'DB-1',
  expected_effect: 'the schema is at version alpha',
  idempotent: true,
};

describe('action journal + resume (appendix §K, acceptance K.1–K.3)', () => {
  it('K.1 every still-running row becomes unknown on resume, never silently done', () => {
    const rows = [
      { ...open[0]!, status: 'started' as const },
      { ...open[0]!, code: 'AJ-002', status: 'done' as const },
      { ...open[0]!, code: 'AJ-003', status: 'failed' as const },
    ];
    expect(resettleOnSessionStart(rows).map((row) => row.status)).toEqual(['unknown', 'done', 'failed']);
    expect(openRows(resettleOnSessionStart(rows)).map((row) => row.code)).toEqual(['AJ-001']);
  });

  it('K.2 unresolved entries block agent writes with an actionable JOURNAL_UNRESOLVED verdict', () => {
    const verdict = journalWriteLock({ tool: 'ledger_add_open_item', actorType: 'agent', openRows: open });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('JOURNAL_UNRESOLVED');
    expect(verdict.blocking).toEqual(['AJ-001']);
    expect(verdict.needed_action).toContain('do NOT repeat a non-idempotent action');
    expect(verdict.needed_action).toContain('journal_done/journal_fail');
  });

  it('K.2b only the explicit recovery/read tools bypass the lock', () => {
    for (const tool of [
      'exec_ledger_status',
      'session_start',
      'journal_done',
      'journal_fail',
      'ledger_ask_human',
      'exec_ledger_reconcile',
      'ledger_list_open',
      'exec_plan_view',
      'fact_query',
    ]) {
      expect(journalWriteLock({ tool, actorType: 'agent', openRows: open }).allowed, tool).toBe(true);
    }
    expect(journalWriteLock({ tool: 'ledger_add_open_item', actorType: 'agent', openRows: open }).allowed).toBe(false);
    expect(journalWriteLock({ tool: 'fact_verify', actorType: 'agent', openRows: open }).allowed).toBe(false);
    expect(isReadOnly('exec_plan_view')).toBe(true);
    expect(isReadOnly('fact_query')).toBe(true);
  });

  it('K.3 refuses non-idempotent retries and logs a safe matching idempotent retry intent', () => {
    const unresolved = [{ ...open[0]!, idempotent: true }];
    const safeRetry = journalWriteLock({ tool: 'journal_start', actorType: 'agent', openRows: unresolved, retryIntent: exactRetry });
    expect(safeRetry).toMatchObject({ allowed: true, retry_of: ['AJ-001'] });

    const unsafeRetry = journalWriteLock({
      tool: 'journal_start',
      actorType: 'agent',
      openRows: open,
      retryIntent: exactRetry,
    });
    expect(unsafeRetry.allowed).toBe(false);

    const mismatchedTarget = journalWriteLock({
      tool: 'journal_start',
      actorType: 'agent',
      openRows: unresolved,
      retryIntent: { ...exactRetry, target: 'other-target' },
    });
    expect(mismatchedTarget.allowed).toBe(false);

    const mismatchedEffect = journalWriteLock({
      tool: 'journal_start',
      actorType: 'agent',
      openRows: unresolved,
      retryIntent: { ...exactRetry, expected_effect: 'the schema is changed in another way' },
    });
    expect(mismatchedEffect.allowed).toBe(false);
  });

  it('a policy-computed approval decision and a human recovery call remain available', () => {
    expect(
      journalWriteLock({ tool: 'ledger_record_decision', actorType: 'agent', openRows: open, approvalDecision: true }).allowed,
    ).toBe(true);
    expect(
      journalWriteLock({ tool: 'ledger_record_decision', actorType: 'agent', openRows: open, approvalDecision: false }).allowed,
    ).toBe(false);
    expect(journalWriteLock({ tool: 'ledger_add_open_item', actorType: 'human', openRows: open }).allowed).toBe(true);
  });
});
