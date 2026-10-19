import type { DbLike } from '../db/unitOfWork';
import { loadGateContext } from './gate-context';
import { composeFinalReport } from './gate';
import type { FinalReport } from './gate-types';

/**
 * The completion report, built FROM THE LEDGER (plan §8.2).
 *
 * The agent's own summary is quoted as a quote — it is one row among many —
 * and every count, criterion, decision and open item in the report is read
 * back out of the database. A report that could be written from memory would
 * be worth nothing, which is the whole point of the gate.
 */
export async function buildFinalReport(tx: DbLike, taskId: string): Promise<FinalReport> {
  const loaded = await loadGateContext(tx, taskId);
  return composeFinalReport(loaded.ctx);
}
