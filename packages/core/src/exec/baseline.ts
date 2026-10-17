import { parseTestLog, type ParsedTestLog } from '@forgepm/shared';
import { matchPathGlob } from './scope';

/**
 * Baseline bookkeeping (appendix §J). The agent never types results: the code
 * runs (or reads CI) and stores the parsed outcome. Rule 12 of the gate then
 * compares "before" against "after".
 */

export interface BaselineRow {
  name: string;
  result: 'pass' | 'fail' | 'skip';
  assertions?: number;
  /** Where the row came from, recorded so a baseline can be audited. */
  source?: 'ci' | 'runner' | 'agent';
}

export type ParserCfg = { pass: string[]; fail: string[]; skip: string[]; test_line?: string };

export function baselineFromLog(log: string, parser: ParserCfg, source: 'ci' | 'runner'): { rows: BaselineRow[]; totals: ParsedTestLog['totals']; complete: boolean } {
  const p = parseTestLog(log, parser);
  const rows: BaselineRow[] = p.names.map((n) => ({
    name: n,
    result: p.failures.some((f) => f.includes(n.slice(0, 40))) ? 'fail' : p.skipped.some((k) => k.includes(n.slice(0, 40))) ? 'skip' : 'pass',
    source,
  }));
  return { rows, totals: p.totals, complete: p.complete };
}

export interface BaselineVerdict {
  ok: boolean;
  newly_failing: string[];
  vanished: string[];
  weakened: { path: string; delta: number; modifiers: string[] }[];
  /** Deleting or weakening a test always needs a human. */
  needs_human: boolean;
}

export function compareBaseline(
  before: readonly BaselineRow[],
  afterPresent: readonly string[],
  afterResults: Readonly<Record<string, 'pass' | 'fail' | 'skip'>>,
  weakening: readonly { path: string; delta: number; modifiers: string[] }[] = [],
): BaselineVerdict {
  const newly_failing: string[] = [];
  const vanished: string[] = [];
  for (const b of before) {
    if (b.result !== 'pass') continue;
    if (!afterPresent.includes(b.name)) vanished.push(b.name);
    else if (afterResults[b.name] && afterResults[b.name] !== 'pass') newly_failing.push(b.name);
  }
  const real = weakening.filter((w) => w.delta < 0 || w.modifiers.length > 0);
  return {
    ok: newly_failing.length === 0 && vanished.length === 0 && real.length === 0,
    newly_failing,
    vanished,
    weakened: real,
    needs_human: vanished.length > 0 || real.length > 0,
  };
}

/** The set of files a baseline is allowed to consider "test files". */
export function isProtectedTest(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchPathGlob(g, path));
}
