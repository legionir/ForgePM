/**
 * Action journal + session write-lock (appendix §K). Deterministic so that a
 * crashed agent cannot repeat an irreversible action "just to be safe".
 */

export type JournalStatus = 'started' | 'done' | 'failed' | 'unknown';

export interface JournalRow {
  code: string;
  task_id: string;
  action: string;
  idempotent: boolean;
  status: JournalStatus;
}

/** On session start every still-open row is *unknown* until proven otherwise. */
export function resettleOnSessionStart(rows: readonly JournalRow[]): JournalRow[] {
  return rows.map((r) => (r.status === 'started' ? { ...r, status: 'unknown' } : r));
}

export function openRows(rows: readonly JournalRow[]): JournalRow[] {
  return rows.filter((r) => r.status === 'started' || r.status === 'unknown');
}

const ALWAYS_ALLOWED = new Set([
  'session_start',
  'journal_done',
  'journal_fail',
  'exec_ledger_reconcile',
  'ledger_ask_human',
  'ledger_list_open',
  'exec_ledger_status',
  'ledger_add_open_item',
]);

export interface WriteLockInput {
  tool: string;
  actorType: 'agent' | 'human' | 'system';
  openRows: readonly { code: string; action: string; idempotent: boolean; status: JournalStatus }[];
}

export interface WriteLockVerdict {
  allowed: boolean;
  code?: 'JOURNAL_UNRESOLVED';
  blocking?: string[];
  message?: string;
  needed_action?: string;
}

/** Reads and a small set of tools stay available; other writes are blocked. */
export function journalWriteLock(input: WriteLockInput): WriteLockVerdict {
  if (input.actorType !== 'agent') return { allowed: true };
  if (isReadOnly(input.tool) || ALWAYS_ALLOWED.has(input.tool)) return { allowed: true };
  const open = input.openRows.filter((r) => r.status === 'started' || r.status === 'unknown');
  if (!open.length) return { allowed: true };
  const nonIdempotent = open.filter((r) => !r.idempotent);
  return {
    allowed: false,
    code: 'JOURNAL_UNRESOLVED',
    blocking: open.map((r) => r.code),
    message: `${open.length} journalled action(s) are unsettled (${open.map((r) => `${r.code}:${r.status}`).join(', ')})`,
    needed_action: nonIdempotent.length
      ? `inspect the real state (git status / file presence / DB state) for ${nonIdempotent.map((r) => r.code).join(', ')} — do NOT repeat a non-idempotent action; then journal_done/journal_fail, or ledger_ask_human`
      : 'finish or fail the open actions with journal_done/journal_fail',
  };
}

export function isReadOnly(tool: string): boolean {
  return (
    tool.endsWith('_status') ||
    tool.startsWith('ledger_list') ||
    tool.startsWith('req_coverage') ||
    tool.startsWith('fact_query') ||
    tool.endsWith('_view') ||
    tool.startsWith('scope_check') ||
    tool.startsWith('policy_check') ||
    tool.startsWith('exec_policy_check')
  );
}
