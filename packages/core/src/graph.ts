import type { StateCategory } from '@forgepm/shared';

/**
 * Blocking-cycle detection for work_item relations (plan §6.3). Pure so it can
 * be unit-tested exhaustively; the repository supplies edges so callers keep
 * SQL out of the algorithm.
 *
 * Edge semantics: an edge `from -> to` means "from blocks to" (from is a
 * blocker of to). Adding `A blocks B` then `B blocks A` creates a cycle.
 */
export function findCycle(edges: Iterable<[string, string]>, start: string): string[] | null {
  const adj = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = adj.get(from) ?? [];
    list.push(to);
    adj.set(from, list);
  }
  const path: string[] = [];
  const inPath = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): string[] | null => {
    if (inPath.has(node)) {
      const idx = path.indexOf(node);
      return [...path.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    inPath.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    inPath.delete(node);
    path.pop();
    return null;
  };

  return dfs(start);
}

export interface CategoryCounts {
  completed: number;
  canceled: number;
  total: number; // non-canceled work items
}

/** work_progress: completed / (total minus canceled). 0 when no items. */
export function workProgress(counts: CategoryCounts): number {
  const denom = counts.total - counts.canceled;
  if (denom <= 0) return 0;
  return Math.round((counts.completed / denom) * 100);
}

/** release_readiness: ticked acceptance criteria / all criteria. */
export function releaseReadiness(criteria: { done: boolean }[]): number {
  if (criteria.length === 0) return 0;
  const done = criteria.filter((c) => c.done).length;
  return Math.round((done / criteria.length) * 100);
}

export const TERMINAL_CATEGORIES: StateCategory[] = ['completed', 'canceled'];
