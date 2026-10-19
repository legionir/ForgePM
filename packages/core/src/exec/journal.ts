import { AppError, type ExecJournalStatus } from '@forgepm/shared';

/**
 * Action journal + session write lock (appendix §K). Deterministic so a
 * crashed agent cannot repeat an irreversible action "just to be safe".
 */
export type JournalStatus = ExecJournalStatus;

export interface JournalRow {
  code: string;
  task_id: string;
  action: string;
  target?: string | null;
  expected_effect: string;
  idempotent: boolean;
  status: JournalStatus;
}

/** On session start every still-open row is *unknown* until proven otherwise. */
export function resettleOnSessionStart(rows: readonly JournalRow[]): JournalRow[] {
  return rows.map((row) => (row.status === 'started' ? { ...row, status: 'unknown' } : row));
}

export function openRows<T extends JournalRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status === 'started' || row.status === 'unknown');
}

/** Explicit recovery exceptions from appendix K.3. */
const ALWAYS_ALLOWED = new Set([
  'session_start',
  'journal_done',
  'journal_fail',
  'exec_ledger_reconcile',
  'ledger_ask_human',
]);

export interface JournalRetryIntent {
  task_id: string;
  action: string;
  target?: string | null;
  expected_effect: string;
  idempotent: boolean;
}

export interface WriteLockInput {
  tool: string;
  actorType: 'agent' | 'human' | 'system';
  openRows: readonly JournalRow[];
  /** Only a policy-computed approval decision is a recovery write exception. */
  approvalDecision?: boolean;
  /** A retry is allowed only for the exact unknown, idempotent action/target. */
  retryIntent?: JournalRetryIntent;
}

export interface WriteLockVerdict {
  allowed: boolean;
  code?: 'JOURNAL_UNRESOLVED';
  blocking?: string[];
  message?: string;
  needed_action?: string;
  retry_of?: string[];
}

/** Reads, journal settlement, human questions and safe retries stay available. */
export function isJournalLockException(tool: string): boolean {
  return isReadOnly(tool) || ALWAYS_ALLOWED.has(tool);
}

export function journalWriteLock(input: WriteLockInput): WriteLockVerdict {
  if (input.actorType !== 'agent') return { allowed: true };
  if (isJournalLockException(input.tool)) return { allowed: true };
  const open = openRows(input.openRows);
  if (!open.length) return { allowed: true };

  if (input.tool === 'ledger_record_decision' && input.approvalDecision === true) return { allowed: true };

  if (input.tool === 'journal_start' && input.retryIntent?.idempotent === true) {
    const intent = input.retryIntent;
    const retryable = open.filter(
      (row) =>
        row.status === 'unknown' &&
        row.idempotent &&
        row.task_id === intent.task_id &&
        row.action === intent.action &&
        (row.target ?? null) === (intent.target ?? null) &&
        row.expected_effect === intent.expected_effect,
    );
    // A single exact match is intentional. Duplicate or unrelated open actions
    // must be reconciled rather than hidden by starting another row.
    if (open.length === 1 && retryable.length === 1) return { allowed: true, retry_of: [retryable[0]!.code] };
  }

  const nonIdempotent = open.filter((row) => !row.idempotent);
  const blocking = open.map((row) => row.code);
  return {
    allowed: false,
    code: 'JOURNAL_UNRESOLVED',
    blocking,
    message: `${open.length} journalled action(s) are unsettled (${open.map((row) => `${row.code}:${row.status}`).join(', ')})`,
    needed_action: nonIdempotent.length
      ? `inspect the real state for ${nonIdempotent.map((row) => row.code).join(', ')}; do NOT repeat a non-idempotent action. Settle it with journal_done/journal_fail, ask the human with ledger_ask_human, or record a policy-computed approval decision`
      : 'settle the open action with journal_done/journal_fail; only an exact idempotent retry may start while status is unknown',
  };
}

export function throwIfJournalLocked(verdict: WriteLockVerdict): void {
  if (verdict.allowed) return;
  throw new AppError('JOURNAL_UNRESOLVED', verdict.message ?? 'an action journal row is unresolved', {
    blocking: verdict.blocking ?? [],
    needed_action: verdict.needed_action ?? 'inspect and settle every unresolved journal row',
  });
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
