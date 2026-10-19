/**
 * The one place that decides what "the ledger and the board disagree" means.
 *
 * C.9b: `exec_task_complete` is the only door to `status='done'`, so a task in
 * that state without a passing gate stamp was closed by hand (or by a bug).
 * The gate and `exec_ledger_status` must say the SAME thing about it, so the
 * wording lives here and both call it.
 */

export const DRIFT_STAMP_MISSING = 'drift: gate stamp missing';
export const DRIFT_STAMP_NOT_PASSING = 'drift: gate stamp not passing';

export interface DriftInput {
  /** The task's current status. */
  status: string;
  /** The newest gate stamp for the task, if there is one. */
  stamp: { ok: boolean; stamp_id: string | null } | null;
}

/**
 * The drift, or null when there is none. Only a task that claims to be done
 * can drift: an open task without a stamp is simply not finished yet.
 */
export function detectGateStampDrift(input: DriftInput): string | null {
  if (input.status !== 'done') return null;
  if (!input.stamp) return DRIFT_STAMP_MISSING;
  if (!input.stamp.ok) return DRIFT_STAMP_NOT_PASSING;
  return null;
}
