import { describe, expect, it } from 'vitest';
import { isReadOnly, journalWriteLock, openRows, resettleOnSessionStart } from './journal';

describe('action journal + resume (appendix §K, acceptance K.1–K.4)', () => {
  it('K.1 every still-running row becomes "unknown" on resume, never silently "done"', () => {
    const rows = [
      { code: 'AJ-1', task_id: 't', action: 'exec_run_command', idempotent: false, status: 'started' as const },
      { code: 'AJ-2', task_id: 't', action: 'ledger_add_open_item', idempotent: true, status: 'done' as const },
      { code: 'AJ-3', task_id: 't', action: 'exec_run_command', idempotent: false, status: 'failed' as const },
    ];
    expect(resettleOnSessionStart(rows).map((r) => r.status)).toEqual(['unknown', 'done', 'failed']);
    // a `failed` row is settled (the agent recorded the failure); only
    // `started`/`unknown` keep the write lock.
    expect(openRows(resettleOnSessionStart(rows)).map((r) => r.code)).toEqual(['AJ-1']);
  });

  it('K.2 non-read tools are blocked while a row is unsettled', () => {
    const v = journalWriteLock({
      tool: 'exec_run_command',
      actorType: 'agent',
      openRows: [{ code: 'AJ-1', action: 'git push', idempotent: false, status: 'unknown' }],
    });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('JOURNAL_UNRESOLVED');
    expect(v.blocking).toEqual(['AJ-1']);
    expect(v.needed_action).toContain('do NOT repeat a non-idempotent action');
    expect(v.needed_action).toContain('inspect the real state');
  });

  it('K.2b reading, settling and asking the human always stay available', () => {
    const open = [{ code: 'AJ-1', action: 'x', idempotent: true, status: 'started' as const }];
    for (const tool of [
      'exec_ledger_status',
      'session_start',
      'journal_done',
      'journal_fail',
      'ledger_ask_human',
      'exec_ledger_reconcile',
      'ledger_list_open',
    ]) {
      expect(journalWriteLock({ tool, actorType: 'agent', openRows: open }).allowed, tool).toBe(true);
    }
    expect(isReadOnly('exec_plan_view')).toBe(true);
  });

  it('K.3 once the rows are settled the block lifts; humans are never locked', () => {
    expect(
      journalWriteLock({
        tool: 'exec_run_command',
        actorType: 'agent',
        openRows: [{ code: 'AJ-1', action: 'x', idempotent: false, status: 'done' }],
      }).allowed,
    ).toBe(true);
    expect(
      journalWriteLock({
        tool: 'exec_run_command',
        actorType: 'human',
        openRows: [{ code: 'AJ-1', action: 'x', idempotent: false, status: 'unknown' }],
      }).allowed,
    ).toBe(true);
  });

  it('an idempotent open row gets the shorter instruction (safe to re-run)', () => {
    const v = journalWriteLock({
      tool: 'exec_run_command',
      actorType: 'agent',
      openRows: [{ code: 'AJ-1', action: 'x', idempotent: true, status: 'started' }],
    });
    expect(v.allowed).toBe(false);
    expect(v.needed_action).toBe('finish or fail the open actions with journal_done/journal_fail');
  });
});
