import { describe, it, expect } from 'vitest';
import { validatePlan, similarity } from './validate';
import { planContentSchema } from '@forgepm/shared';

const feat = (key: string, items: Record<string, unknown>[]) => ({
  temp_id: key,
  key,
  title: `F ${key}`,
  acceptance_criteria: [{ text: 'ok', done: false }],
  work_items: items,
});
const wi = (temp_id: string, deps: string[] = []) => ({ temp_id, title: `item ${temp_id}`, type: 'task', depends_on: deps, acceptance_criteria: [] });

describe('validatePlan (plan §7.4)', () => {
  it('accepts a valid plan', () => {
    const content = planContentSchema.parse({ features: [feat('A', [wi('1'), wi('2', ['1'])])] });
    const r = validatePlan(content);
    expect(r.ok).toBe(true);
    expect(r.item_count).toBe(2);
    expect(r.cycles).toEqual([]);
  });

  it('detects a dependency cycle', () => {
    const content = planContentSchema.parse({ features: [feat('A', [wi('1', ['2']), wi('2', ['1'])])] });
    const r = validatePlan(content);
    expect(r.ok).toBe(false);
    expect(r.cycles.length).toBeGreaterThan(0);
  });

  it('flags duplicate temp_ids', () => {
    const content = planContentSchema.parse({ features: [feat('A', [wi('1'), wi('1')])] });
    const r = validatePlan(content);
    expect(r.ok).toBe(false);
    expect(r.duplicate_temp_ids).toContain('1');
  });

  it('enforces the item cap', () => {
    const items = Array.from({ length: 5 }, (_, i) => wi(`x${i}`));
    const content = planContentSchema.parse({ features: [feat('A', items)] });
    expect(validatePlan(content, 3).ok).toBe(false);
  });

  it('requires >=1 acceptance criterion per feature (warning)', () => {
    const bad = { temp_id: 'A', key: 'A', title: 'A', acceptance_criteria: [], work_items: [] };
    const content = planContentSchema.safeParse({ features: [bad] });
    expect(content.success).toBe(false); // schema min(1) enforces it
  });
});

describe('similarity (near-duplicate warning)', () => {
  it('near-identical titles score >= 0.85', () => {
    expect(similarity('Implement login form', 'Implement login form!')).toBeGreaterThanOrEqual(0.85);
  });
  it('unrelated titles score low', () => {
    expect(similarity('Implement login form', 'Rotate database backups nightly')).toBeLessThan(0.3);
  });
});
