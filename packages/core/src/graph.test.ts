import { describe, it, expect } from 'vitest';
import { findCycle, workProgress, releaseReadiness } from './graph';

describe('findCycle (plan §6.3)', () => {
  it('detects a direct two-node cycle', () => {
    const edges: [string, string][] = [['A', 'B']];
    expect(findCycle(edges, 'B')).toBeNull(); // adding B->A would cycle
    const withCycle: [string, string][] = [['A', 'B'], ['B', 'A']];
    expect(findCycle(withCycle, 'B')).toEqual(['B', 'A', 'B']);
  });

  it('detects a three-node cycle', () => {
    const edges: [string, string][] = [['A', 'B'], ['B', 'C'], ['C', 'A']];
    expect(findCycle(edges, 'A')).toEqual(['A', 'B', 'C', 'A']);
  });

  it('returns null on a DAG', () => {
    const edges: [string, string][] = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']];
    expect(findCycle(edges, 'A')).toBeNull();
  });

  it('handles empty graph', () => {
    expect(findCycle([], 'X')).toBeNull();
  });
});

describe('workProgress + releaseReadiness (plan §6.4)', () => {
  it('completed/(total-canceled) with cancel excluded', () => {
    expect(workProgress({ completed: 3, canceled: 2, total: 10 })).toBe(38); // 3/8
    expect(workProgress({ completed: 2, canceled: 0, total: 2 })).toBe(100);
    expect(workProgress({ completed: 0, canceled: 0, total: 0 })).toBe(0);
  });

  it('acceptance criteria readiness', () => {
    expect(releaseReadiness([{ done: true }, { done: false }, { done: true }])).toBe(67);
    expect(releaseReadiness([{ done: true }, { done: true }])).toBe(100);
    expect(releaseReadiness([])).toBe(0);
  });
});
