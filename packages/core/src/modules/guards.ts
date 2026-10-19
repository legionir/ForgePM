import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';

/**
 * Completion guards (docs/EXECUTION_CONTROL_PLAN.md §8.3, I-1).
 *
 * The core must not know about the exec module, so the coupling is an
 * interface and a tiny registry: a module registers a guard, the work-item
 * service asks the registry before a move to `category='completed'`.
 *
 * A guard exists because "the work item says done" and "the work is actually
 * done" are two different claims, and only the ledger can tell them apart.
 */
export interface CompletionGuardInput {
  work_item_id: string;
  /** The category of the state the item is moving to (`completed`, …). */
  target_category: string;
  organization_id: string;
  project_id: string;
}

export interface CompletionGuard {
  name: string;
  /** Throw to refuse the completion. */
  assert(input: CompletionGuardInput, db: DbLike): Promise<void>;
}

const guards = new Map<string, CompletionGuard>();

/** Registering twice replaces the guard — registration is idempotent. */
export function registerCompletionGuard(guard: CompletionGuard): void {
  guards.set(guard.name, guard);
}

export function unregisterCompletionGuard(name: string): void {
  guards.delete(name);
}

export function listCompletionGuards(): CompletionGuard[] {
  return [...guards.values()];
}

/**
 * Ask every registered guard whether this completion may happen.
 * The first refusal wins, and the refusal keeps the guard's own code so the
 * caller can tell "the gate said no" from "you may not do that".
 */
export async function assertCompletionAllowed(db: DbLike, input: CompletionGuardInput): Promise<void> {
  for (const guard of guards.values()) {
    try {
      await guard.assert(input, db);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('GATE_FAILED', `completion guard '${guard.name}' refused: ${String(err)}`);
    }
  }
}
