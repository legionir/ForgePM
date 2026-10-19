import { describe, expect, it } from 'vitest';
import { fitsTokenBudget, remainingTokenBudget } from './budget';

describe('review token budget helpers', () => {
  it('preserves zero as the unlimited setting convention', () => {
    expect(remainingTokenBudget(0, 40)).toBeNull();
    expect(fitsTokenBudget(0, 40, 1_000_000)).toBe(true);
  });

  it('returns a non-negative remaining allowance and refuses exhausted budgets', () => {
    expect(remainingTokenBudget(100, 35)).toBe(65);
    expect(remainingTokenBudget(100, 120)).toBe(0);
    expect(remainingTokenBudget(100, -4)).toBe(100);
    expect(fitsTokenBudget(100, 35, 64)).toBe(true);
    expect(fitsTokenBudget(100, 35, 65)).toBe(false);
  });
});
